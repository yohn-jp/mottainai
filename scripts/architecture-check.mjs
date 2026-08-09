import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const RULE_IDS = Object.freeze({
  importExtension: "ARCH-IMPORT-EXTENSION",
  unresolvedImport: "ARCH-IMPORT-UNRESOLVED",
  importCycle: "ARCH-IMPORT-CYCLE",
  dependencyDirection: "ARCH-DEPENDENCY-DIRECTION",
  protocolStdout: "ARCH-PROTOCOL-STDOUT",
  importTimeSideEffect: "ARCH-IMPORT-TIME-SIDE-EFFECT",
  processBoundary: "ARCH-PROCESS-BOUNDARY",
  unsafeTypeEscape: "ARCH-UNSAFE-TYPE-ESCAPE",
  localToolSchema: "ARCH-LOCAL-TOOL-SCHEMA",
  localToolAnnotations: "ARCH-LOCAL-TOOL-ANNOTATIONS",
});

const sourceExtensions = new Set([".ts", ".mts", ".cts", ".mjs"]);
const runtimeImportExtensions = new Set([".js", ".mjs", ".json"]);
const ignoredDirectories = new Set([".git", ".codegraph", ".mottainai", "coverage", "dist", "node_modules"]);
const testFilePattern = /\.(?:test|spec)\.[^.]+$/u;
const annotationNames = new Set(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
const envelopeFields = new Set([
  "operation",
  "status",
  "summary",
  "facts",
  "diagnostics",
  "metrics",
  "result_id",
  "truncated",
]);

// src/test-support/ と src/e2e/ はテスト専用の横断ユーティリティ。全レイヤの
// production コードを fixture として組み立てる必要がある一方、production 側から
// 依存されることはない（entry と同じ「最上位」扱い）。
const layerRules = Object.freeze({
  entry: new Set(["entry", "upstream", "adaptive", "compression", "persistence", "shared", "utility"]),
  upstream: new Set(["upstream", "adaptive", "compression", "persistence", "shared", "utility"]),
  adaptive: new Set(["adaptive", "compression", "persistence", "shared", "utility"]),
  compression: new Set(["compression", "persistence", "shared", "utility"]),
  persistence: new Set(["persistence", "shared", "utility"]),
  shared: new Set(["shared", "utility"]),
  utility: new Set(["utility"]),
  testInfrastructure: new Set([
    "testInfrastructure",
    "entry",
    "upstream",
    "adaptive",
    "compression",
    "persistence",
    "shared",
    "utility",
  ]),
});

const allowedSpecialEdges = new Set(["shared->adaptive:src/adaptive/metadata.ts"]);

const stdoutBoundaryFiles = new Set([
  "src/cli.ts",
  "src/index.ts",
  "src/workflow/domain/identity-resolve-worker.mjs",
  "src/workflow/domain/task-start-worker.mjs",
]);

const processExitBoundaryFiles = new Set([
  "src/cli.ts",
  "src/index.ts",
  "src/workflow/domain/identity-resolve-worker.mjs",
]);

const signalBoundaryFiles = new Set(["src/index.ts", "src/server.ts"]);

const argvBoundaryFiles = new Set([
  "src/cli.ts",
  "src/index.ts",
  "src/workflow/domain/identity-resolve-worker.mjs",
  "src/workflow/domain/task-start-worker.mjs",
]);

// これらは呼び出し側から環境を注入できる既存の設定境界。新規追加は理由をdocsへ記載する。
const environmentBoundaryFiles = new Set([
  "src/adaptive/policy.ts",
  "src/adaptive/trace.ts",
  "src/cli.ts",
  "src/commands/doctor.ts",
  "src/compress/config.ts",
  "src/config.ts",
  "src/index.ts",
  "src/init.ts",
  "src/logging.ts",
  "src/state/paths.ts",
  "src/state/sqlite-store.ts",
  "src/telemetry.ts",
  "src/workflow/git/worktree.ts",
  "src/upstream.ts",
  "src/workflow/state/sqlite-store.ts",
  // テスト間でHOME/TZ/LANG等を一時的に差し替え、実行後に必ず復元する隔離境界（docs/testing.md）。
  "src/test-support/env.ts",
  // developer machineのglobal/system git設定から隔離したenvを組み立てるための境界（docs/testing.md）。
  "src/test-support/tmp-git-repo.ts",
]);

const pureTopLevelConstructors = new Set(["Date", "Map", "RegExp", "Set", "TextEncoder", "URL"]);
const pureTopLevelCalls = new Set([
  "Array.from",
  "buildCapabilityIndex",
  "Math.round",
  "Object.create",
  "Object.entries",
  "snapshot",
  "Object.freeze",
  "Object.fromEntries",
  "Object.keys",
  "Object.values",
]);

const compilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  resolveJsonModule: true,
  target: ts.ScriptTarget.ES2022,
};

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function absolutePath(root, relativePath) {
  return path.resolve(root, relativePath);
}

function relativePath(root, fileName) {
  return normalizePath(path.relative(root, fileName));
}

function collectFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, output);
      continue;
    }
    const relative = relativePath(root, fullPath);
    if (!relative.startsWith("src/")) continue;
    if (!sourceExtensions.has(path.extname(entry.name))) continue;
    if (testFilePattern.test(entry.name)) continue;
    output.push(fullPath);
  }
  return output.sort();
}

function parseSource(fileName, text) {
  const scriptKind = fileName.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
}

function getNodePosition(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function makeDiagnostic(ruleId, sourceFile, node, message, correction, root) {
  const position = getNodePosition(sourceFile, node);
  return {
    correction,
    file: relativePath(root, sourceFile.fileName),
    line: position.line,
    column: position.column,
    message,
    ruleId,
  };
}

function diagnosticWithoutNode(ruleId, file, message, correction) {
  return { correction, file, line: 1, column: 1, message, ruleId };
}

function isRelativeModule(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function moduleReferences(sourceFile) {
  const references = [];
  function add(node, moduleSpecifier, runtime = true) {
    if (!ts.isStringLiteralLike(moduleSpecifier)) return;
    const specifier = moduleSpecifier.text;
    if (isRelativeModule(specifier)) references.push({ node: moduleSpecifier, runtime, specifier });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const importClause = node.importClause;
      const runtime =
        importClause === undefined ||
        (!importClause.isTypeOnly &&
          (importClause.name !== undefined ||
            importClause.namedBindings === undefined ||
            ts.isNamespaceImport(importClause.namedBindings) ||
            importClause.namedBindings.elements.some((element) => !element.isTypeOnly)));
      add(node, node.moduleSpecifier, runtime);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, node.moduleSpecifier, !node.isTypeOnly);
    if (ts.isImportEqualsDeclaration(node) && node.moduleReference.kind === ts.SyntaxKind.ExternalModuleReference) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) add(node, expression);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

function resolveRelativeImport(sourceFile, specifier, root, resolutionCache) {
  const result = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    { ...compilerOptions, baseUrl: root },
    ts.sys,
    resolutionCache,
  ).resolvedModule;
  if (!result) return undefined;
  return path.resolve(result.resolvedFileName);
}

function layerForFile(relative) {
  if (relative.startsWith("src/test-support/") || relative.startsWith("src/e2e/")) return "testInfrastructure";
  if (
    relative === "src/index.ts" ||
    relative === "src/cli.ts" ||
    relative === "src/init.ts" ||
    relative.startsWith("src/commands/")
  )
    return "entry";
  if (
    relative === "src/server.ts" ||
    relative === "src/proxy.ts" ||
    relative === "src/local-tools.ts" ||
    relative === "src/broker.ts" ||
    relative === "src/catalog.ts" ||
    relative === "src/code-search.ts" ||
    relative === "src/execution.ts"
  )
    return "upstream";
  if (relative === "src/upstream.ts" || relative === "src/upstream-call.ts" || relative === "src/auth.ts")
    return "upstream";
  if (relative.startsWith("src/adaptive/") || relative.startsWith("src/read-governor/")) return "adaptive";
  if (relative.startsWith("src/compress/")) return "compression";
  if (relative.startsWith("src/state/") || relative.startsWith("src/workflow/") || relative === "src/retrieve.ts")
    return "persistence";
  if (
    relative === "src/config.ts" ||
    relative === "src/envelope.ts" ||
    relative === "src/logging.ts" ||
    relative === "src/telemetry.ts"
  )
    return "shared";
  if (relative === "src/subprocess.ts" || relative === "src/boundary.ts") return "utility";
  return "shared";
}

export function isDependencyAllowed(sourceLayer, targetLayer, targetPath = "") {
  if (sourceLayer === targetLayer) return true;
  if (allowedSpecialEdges.has(`${sourceLayer}->${targetLayer}:${targetPath}`)) return true;
  return layerRules[sourceLayer]?.has(targetLayer) ?? true;
}

const markerSearchLeadingLines = 1;
const markerSearchTrailingLines = 1;

function hasRuleMarker(sourceFile, node, ruleName, boundaryLine) {
  const pattern = new RegExp(`architecture-check\\s+allow:\\s*${ruleName}\\s+--\\s+[^\\n\\r]+`, "u");
  const text = sourceFile.getFullText();
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  const lastLine = sourceFile.getLineAndCharacterOfPosition(text.length).line;
  const maxTrailingLine = boundaryLine === undefined ? lastLine : Math.min(boundaryLine - 1, lastLine);
  const searchFromLine = Math.max(startLine - markerSearchLeadingLines, 0);
  const searchToLine = Math.max(Math.min(endLine + markerSearchTrailingLines, maxTrailingLine), searchFromLine);
  const rangeStart = sourceFile.getPositionOfLineAndCharacter(searchFromLine, 0);
  const rangeEndLineStart = sourceFile.getPositionOfLineAndCharacter(searchToLine, 0);
  const rangeEnd = text.indexOf("\n", rangeEndLineStart);
  const searchText = text.slice(rangeStart, rangeEnd === -1 ? text.length : rangeEnd);
  return pattern.test(searchText);
}

function processAccess(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const expression = node.expression;
  if (!ts.isIdentifier(expression) || expression.text !== "process") return undefined;
  const property = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  return property;
}

function propertyAccess(node, objectName, propertyName) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === objectName &&
    node.name.text === propertyName
  );
}

function isSignalRegistration(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (!new Set(["addListener", "on", "once", "prependListener"]).has(method)) return false;
  return (
    propertyAccess(node.expression.expression, "process", "on") ||
    propertyAccess(node.expression.expression, "process", "once") ||
    propertyAccess(node.expression.expression, "process", "addListener") ||
    propertyAccess(node.expression.expression, "process", "prependListener") ||
    (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process")
  );
}

function isStdoutWriter(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (propertyAccess(node.expression.expression, "process", "stdout") && method === "write") return true;
  return (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console" &&
    new Set(["debug", "dir", "group", "info", "log", "table", "time", "trace"]).has(method)
  );
}

function isPureConstructor(node) {
  return (
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) && pureTopLevelConstructors.has(node.expression.text)
  );
}

function hasImportTimeExecution(node) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current)) return;
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText();
      const pure =
        pureTopLevelCalls.has(callee) ||
        callee.endsWith(".join") ||
        callee.startsWith("z.") ||
        /^create[A-Z]\w*Id$/u.test(callee) ||
        /\.(?:array|default|describe|extend|length|max|min|nonempty|nullable|optional|passthrough|refine|strict|superRefine)$/u.test(
          callee,
        );
      if (!pure) found = true;
      return;
    }
    if (ts.isNewExpression(current)) {
      if (!isPureConstructor(current)) found = true;
      return;
    }
    if (ts.isAwaitExpression(current) || ts.isDeleteExpression(current) || ts.isYieldExpression(current)) {
      found = true;
      return;
    }
    if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(current) && ts.isAssignmentOperator(current.operatorToken.kind)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function checkTopLevelExecution(sourceFile, root, diagnostics) {
  const file = relativePath(root, sourceFile.fileName);
  const boundary =
    file === "src/index.ts" ||
    file === "src/workflow/domain/identity-resolve-worker.mjs" ||
    file === "src/workflow/domain/task-start-worker.mjs";
  if (boundary) return;
  const statements = sourceFile.statements;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const nextStatement = statements[index + 1];
    const boundaryLine = nextStatement
      ? sourceFile.getLineAndCharacterOfPosition(nextStatement.getStart(sourceFile)).line
      : undefined;
    if (hasRuleMarker(sourceFile, statement, "import-time-side-effect", boundaryLine)) continue;
    if (ts.isImportDeclaration(statement) && !statement.importClause) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.importTimeSideEffect,
          sourceFile,
          statement,
          "side-effect-only import executes during module initialization",
          "move the effect behind an exported function or the executable entry boundary",
          root,
        ),
      );
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && hasImportTimeExecution(declaration.initializer)) {
          diagnostics.push(
            makeDiagnostic(
              RULE_IDS.importTimeSideEffect,
              sourceFile,
              declaration.initializer,
              "top-level initializer executes code during module import",
              "keep top-level values declarative and move execution into a function or entry boundary",
              root,
            ),
          );
        }
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      !ts.isStringLiteral(statement.expression) &&
      hasImportTimeExecution(statement.expression)
    ) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.importTimeSideEffect,
          sourceFile,
          statement.expression,
          "top-level expression executes code during module import",
          "move the expression into an exported function or the executable entry boundary",
          root,
        ),
      );
      continue;
    }
    if (
      ts.isIfStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isTryStatement(statement) ||
      ts.isSwitchStatement(statement) ||
      ts.isThrowStatement(statement) ||
      ts.isReturnStatement(statement) ||
      ts.isDebuggerStatement(statement)
    ) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.importTimeSideEffect,
          sourceFile,
          statement,
          "top-level control flow executes during module import",
          "move executable control flow into a function or the executable entry boundary",
          root,
        ),
      );
    }
  }
}

function checkProcessBoundaries(sourceFile, root, diagnostics) {
  const file = relativePath(root, sourceFile.fileName);
  function visit(node) {
    const access = processAccess(node);
    if (access === "exit" || access === "exitCode") {
      if (!processExitBoundaryFiles.has(file))
        diagnostics.push(
          makeDiagnostic(
            RULE_IDS.processBoundary,
            sourceFile,
            node,
            `direct process.${access} access is outside the executable boundary`,
            "return a status or error to the boundary module; keep process termination in index/CLI code",
            root,
          ),
        );
    } else if (access === "argv" && !argvBoundaryFiles.has(file)) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.processBoundary,
          sourceFile,
          node,
          "global process.argv interpretation is outside the CLI boundary",
          "pass parsed arguments into the module as data from index.ts or cli.ts",
          root,
        ),
      );
    } else if (access === "env" && !environmentBoundaryFiles.has(file)) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.processBoundary,
          sourceFile,
          node,
          "direct process.env interpretation is outside a documented environment boundary",
          "inject ProcessEnv or add a narrowly justified boundary entry to the documented allowlist",
          root,
        ),
      );
    }
    if (isSignalRegistration(node) && !signalBoundaryFiles.has(file)) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.processBoundary,
          sourceFile,
          node,
          "signal registration is outside the runtime lifecycle boundary",
          "register signals in server.ts or index.ts and call an injected shutdown function",
          root,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function checkProtocolStdout(sourceFile, root, diagnostics) {
  const file = relativePath(root, sourceFile.fileName);
  if (stdoutBoundaryFiles.has(file)) return;
  function visit(node) {
    if (isStdoutWriter(node))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.protocolStdout,
          sourceFile,
          node,
          "non-protocol stdout writer in an MCP runtime module",
          "send diagnostics to stderr or route intentional CLI output through src/cli.ts",
          root,
        ),
      );
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function checkUnsafeTypes(sourceFile, root, diagnostics) {
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword && !hasRuleMarker(sourceFile, node, "any")) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.unsafeTypeEscape,
          sourceFile,
          node,
          "broad any type escape in production code",
          "use unknown plus a runtime guard, or add one local architecture-check allow marker with a reason",
          root,
        ),
      );
    }
    if (
      ts.isAsExpression(node) &&
      (ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression)) &&
      !hasRuleMarker(sourceFile, node, "double-assertion")
    ) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.unsafeTypeEscape,
          sourceFile,
          node,
          "unchecked double type assertion",
          "narrow through a runtime check or add one local architecture-check allow marker with a reason",
          root,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const text = sourceFile.getFullText();
  const directivePattern = /^\s*\/\/\s*@ts-(?:ignore|nocheck|expect-error)\b([^\r\n]*)/gmu;
  for (const match of text.matchAll(directivePattern)) {
    const reason = match[1]?.trim() ?? "";
    if (!reason.includes("--")) {
      const position = sourceFile.getLineAndCharacterOfPosition(match.index ?? 0);
      diagnostics.push({
        correction: "remove the directive or append `-- reason` describing the narrow interop boundary",
        file: relativePath(root, sourceFile.fileName),
        line: position.line + 1,
        column: position.character + 1,
        message: "ignored TypeScript error has no documented reason",
        ruleId: RULE_IDS.unsafeTypeEscape,
      });
    }
  }
}

function getPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function objectProperty(object, name) {
  return object.properties.find((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    return getPropertyName(property.name) === name;
  });
}

function objectPropertyValue(object, name) {
  const property = objectProperty(object, name);
  if (!property) return undefined;
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

function isBooleanLiteral(node) {
  return node?.kind === ts.SyntaxKind.TrueKeyword || node?.kind === ts.SyntaxKind.FalseKeyword;
}

function checkAnnotations(object, sourceFile, root, diagnostics) {
  const property = objectProperty(object, "annotations");
  if (!property) {
    diagnostics.push(
      makeDiagnostic(
        RULE_IDS.localToolAnnotations,
        sourceFile,
        object,
        "local tool has no annotations describing read-only and destructive behavior",
        "add readOnlyHint, destructiveHint, idempotentHint, and openWorldHint",
        root,
      ),
    );
    return;
  }
  let value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  if (ts.isIdentifier(value)) {
    const declaration = sourceFile.statements
      .flatMap((statement) => (ts.isVariableStatement(statement) ? statement.declarationList.declarations : []))
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === value.text);
    value = declaration?.initializer;
  }
  if (!value || !ts.isObjectLiteralExpression(value)) {
    diagnostics.push(
      makeDiagnostic(
        RULE_IDS.localToolAnnotations,
        sourceFile,
        property,
        "local tool annotations are not statically inspectable",
        "use an object literal or a local const object with four boolean annotation fields",
        root,
      ),
    );
    return;
  }
  const names = new Set();
  for (const annotation of value.properties) {
    const name = getPropertyName(annotation.name);
    if (
      !name ||
      !annotationNames.has(name) ||
      !ts.isPropertyAssignment(annotation) ||
      !isBooleanLiteral(annotation.initializer)
    ) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.localToolAnnotations,
          sourceFile,
          annotation,
          "local tool annotation must be one of the four boolean MCP hints",
          "use only readOnlyHint, destructiveHint, idempotentHint, and openWorldHint with boolean values",
          root,
        ),
      );
      continue;
    }
    names.add(name);
  }
  for (const name of annotationNames) {
    if (!names.has(name))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.localToolAnnotations,
          sourceFile,
          value,
          `local tool annotations omit ${name}`,
          "declare all four behavior hints so metadata cannot drift from implementation",
          root,
        ),
      );
  }
}

function checkToolObject(object, sourceFile, root, diagnostics) {
  const required = ["name", "inputSchema", "outputSchema", "annotations"];
  for (const name of required) {
    if (!objectProperty(object, name))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.localToolSchema,
          sourceFile,
          object,
          `local tool omits ${name}`,
          `add the ${name} field to the Tool definition`,
          root,
        ),
      );
  }
  const nameValue = objectPropertyValue(object, "name");
  if (!nameValue || !ts.isStringLiteralLike(nameValue))
    diagnostics.push(
      makeDiagnostic(
        RULE_IDS.localToolSchema,
        sourceFile,
        object,
        "local tool name is not a static string",
        "use a literal MCP tool name",
        root,
      ),
    );
  const outputSchema = objectPropertyValue(object, "outputSchema");
  if (!outputSchema || !ts.isIdentifier(outputSchema) || outputSchema.text !== "OUTPUT_SCHEMA")
    diagnostics.push(
      makeDiagnostic(
        RULE_IDS.localToolSchema,
        sourceFile,
        object,
        "local tool does not use the shared OUTPUT_SCHEMA",
        "set outputSchema: OUTPUT_SCHEMA so every gateway tool keeps the common envelope",
        root,
      ),
    );
  checkAnnotations(object, sourceFile, root, diagnostics);
}

function checkLocalToolDefinitions(sourceFile, root, diagnostics) {
  if (relativePath(root, sourceFile.fileName) !== "src/local-tools.ts") return;
  const declarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  );
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (declaration.name.text === "localTools" && ts.isArrayLiteralExpression(declaration.initializer)) {
      for (const element of declaration.initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) checkToolObject(element, sourceFile, root, diagnostics);
      }
    }
    if (
      ["worktreeNewTool", "issueViewTool"].includes(declaration.name.text) &&
      ts.isObjectLiteralExpression(declaration.initializer)
    ) {
      checkToolObject(declaration.initializer, sourceFile, root, diagnostics);
    }
  }
}

function checkOutputSchema(sourceFile, root, diagnostics) {
  if (relativePath(root, sourceFile.fileName) !== "src/envelope.ts") return;
  let schema;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "OUTPUT_SCHEMA" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      schema = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!schema) return;
  const properties = objectPropertyValue(schema, "properties");
  const required = objectPropertyValue(schema, "required");
  const propertyNames =
    properties && ts.isObjectLiteralExpression(properties)
      ? new Set(properties.properties.map((property) => getPropertyName(property.name)).filter(Boolean))
      : new Set();
  const requiredNames =
    required && ts.isArrayLiteralExpression(required)
      ? new Set(required.elements.filter(ts.isStringLiteralLike).map((element) => element.text))
      : new Set();
  for (const field of envelopeFields) {
    if (!propertyNames.has(field) || !requiredNames.has(field))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.localToolSchema,
          sourceFile,
          schema,
          `OUTPUT_SCHEMA does not require the shared ${field} field`,
          "keep the shared output envelope fields in both properties and required",
          root,
        ),
      );
  }
}

function checkImports(sourceFile, root, sourceByFile, graph, diagnostics, resolutionCache) {
  const source = relativePath(root, sourceFile.fileName);
  const sourceLayer = layerForFile(source);
  const references = moduleReferences(sourceFile);
  const edges = graph.get(sourceFile.fileName) ?? new Set();
  graph.set(sourceFile.fileName, edges);
  for (const reference of references) {
    const extension = path.posix.extname(reference.specifier);
    if (!runtimeImportExtensions.has(extension))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.importExtension,
          sourceFile,
          reference.node,
          `relative import ${reference.specifier} has no explicit runtime extension`,
          "use a .js extension for TypeScript runtime imports (or .mjs/.json for those runtime assets)",
          root,
        ),
      );
    const resolved = resolveRelativeImport(sourceFile, reference.specifier, root, resolutionCache);
    if (!resolved) {
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.unresolvedImport,
          sourceFile,
          reference.node,
          `relative import ${reference.specifier} cannot be resolved by NodeNext module resolution`,
          "fix the path or add the target file before merging",
          root,
        ),
      );
      continue;
    }
    if (!sourceByFile.has(resolved)) continue;
    if (!reference.runtime) continue;
    edges.add(resolved);
    const target = relativePath(root, resolved);
    const targetLayer = layerForFile(target);
    const special = `${sourceLayer}->${targetLayer}:${target}`;
    if (!isDependencyAllowed(sourceLayer, targetLayer, target))
      diagnostics.push(
        makeDiagnostic(
          RULE_IDS.dependencyDirection,
          sourceFile,
          reference.node,
          `dependency ${sourceLayer} -> ${targetLayer} (${target}) points upward or across a forbidden layer edge`,
          "move the dependency downward, introduce a shared boundary, or update the documented exception with a reason",
          root,
        ),
      );
    if (allowedSpecialEdges.has(special)) continue;
  }
}

function checkCycles(graph, sourceByFile, root, diagnostics) {
  const visiting = new Set();
  const visited = new Set();
  const reported = new Set();
  const stack = [];
  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file].map((entry) => relativePath(root, entry));
      const key = [...new Set(cycle)].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push(
          diagnosticWithoutNode(
            RULE_IDS.importCycle,
            cycle[0],
            `circular production import: ${cycle.join(" -> ")}`,
            "break the cycle through a lower-level interface or move shared types to a dependency-neutral module",
          ),
        );
      }
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) if (sourceByFile.has(target)) visit(target);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
}

function validateSources(root, sourceEntries) {
  const diagnostics = [];
  const sourceByFile = new Map(sourceEntries.map((entry) => [entry.fileName, entry.sourceFile]));
  const graph = new Map();
  const resolutionCache = ts.createModuleResolutionCache(root, (value) => value, compilerOptions);
  for (const entry of sourceEntries) {
    checkImports(entry.sourceFile, root, sourceByFile, graph, diagnostics, resolutionCache);
    checkProtocolStdout(entry.sourceFile, root, diagnostics);
    checkProcessBoundaries(entry.sourceFile, root, diagnostics);
    checkTopLevelExecution(entry.sourceFile, root, diagnostics);
    checkUnsafeTypes(entry.sourceFile, root, diagnostics);
    checkLocalToolDefinitions(entry.sourceFile, root, diagnostics);
    checkOutputSchema(entry.sourceFile, root, diagnostics);
  }
  checkCycles(graph, sourceByFile, root, diagnostics);
  return diagnostics.sort((left, right) =>
    `${left.file}:${left.line}:${left.column}:${left.ruleId}`.localeCompare(
      `${right.file}:${right.line}:${right.column}:${right.ruleId}`,
    ),
  );
}

// checkImports は resolved import 先が sourceByFile（渡した entries 由来）に無いと
// isDependencyAllowed へ到達せず continue する。単一 entry だけの検証では、その entry
// 自身以外への import は依存方向チェックを一切通らない（レイヤ違反があっても検出できない）。
// 複数ファイル間の依存方向を検証するテストは validateSourceTexts を使うこと。
export function validateSourceTexts(entries, options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const resolvedEntries = entries.map(({ sourceText, fileName }) => {
    const absolute = path.isAbsolute(fileName) ? fileName : absolutePath(root, fileName);
    return {
      fileName: absolute,
      relative: relativePath(root, absolute),
      sourceFile: parseSource(absolute, sourceText),
    };
  });
  return validateSources(root, resolvedEntries);
}

export function validateSourceText(sourceText, fileName, options = {}) {
  return validateSourceTexts([{ sourceText, fileName }], options);
}

export function validateProject(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const entries = collectFiles(resolvedRoot).map((fileName) => ({
    fileName,
    relative: relativePath(resolvedRoot, fileName),
    sourceFile: parseSource(fileName, fs.readFileSync(fileName, "utf8")),
  }));
  return { diagnostics: validateSources(resolvedRoot, entries), filesChecked: entries.length };
}

export function formatDiagnostic(diagnostic) {
  return `${diagnostic.ruleId} ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} Fix: ${diagnostic.correction}`;
}

export function runArchitectureCheck(root = process.cwd()) {
  const result = validateProject(root);
  if (result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) console.error(formatDiagnostic(diagnostic));
    console.error(
      `architecture: ${result.diagnostics.length} failure(s) across ${result.filesChecked} production file(s)`,
    );
    return 1;
  }
  console.log(`architecture: ${result.filesChecked} production file(s) passed`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runArchitectureCheck(process.argv[2] ?? process.cwd());
}
