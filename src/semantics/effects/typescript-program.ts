import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { createSymbolId } from "../ir/ids.js";
import type { LogicalId } from "../ir/ids.js";
import type { RepositorySemanticSnapshot, SourceRange, SymbolLocator } from "../ir/types.js";
import type { EffectUnknown, ResolvedSymbolIdentity, TypeScriptEffectOptions } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const NODE_BUILTIN_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);
const FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

export interface TypeScriptEffectProgram {
  rootDir: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: readonly ts.SourceFile[];
  compilerOptions: ts.CompilerOptions;
  symbols: SymbolIdentityResolver;
  completenessUnknowns: readonly Omit<EffectUnknown, "subjectId">[];
}

function normalizePath(filePath: string): string {
  return resolve(filePath);
}

function toPosix(filePath: string): string {
  return filePath.split(sep).join("/");
}

function relativePath(rootDir: string, filePath: string): string {
  const value = toPosix(relative(rootDir, filePath));
  return value.length > 0 ? value : filePath;
}

function pathInside(rootDir: string, filePath: string): boolean {
  const value = relative(rootDir, filePath);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith("../"));
}

function moduleNameForFile(rootDir: string, filePath: string): string {
  let value = relativePath(rootDir, filePath);
  if (value.endsWith(".d.ts")) value = value.slice(0, -5);
  else value = value.replace(/\.[^.]+$/, "");
  return value;
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  const name = (node as ts.Declaration & { name?: ts.Node }).name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name;
  return undefined;
}

function isSupportedDeclaration(node: ts.Node): node is ts.Declaration {
  if (declarationNameNode(node) === undefined) return false;
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportSpecifier(node) ||
    ts.isNamespaceExport(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isBindingElement(node)
  );
}

function isFunctionLikeDeclaration(node: ts.Declaration): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function qualifiedDeclarationName(node: ts.Declaration): string {
  const ownName = declarationNameNode(node)?.getText() ?? "anonymous";
  const parentNames: string[] = [];
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (isSupportedDeclaration(current)) {
      const name = declarationNameNode(current)?.getText();
      if (name !== undefined) parentNames.unshift(name);
    }
    current = current.parent;
  }
  return [...parentNames, ownName].join(".");
}

function signatureText(checker: ts.TypeChecker, node: ts.Declaration): string | undefined {
  if (!isFunctionLikeDeclaration(node)) return undefined;
  try {
    const signature = checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
    return signature === undefined ? undefined : checker.signatureToString(signature, node, FORMAT_FLAGS);
  } catch {
    return undefined;
  }
}

function symbolKey(file: string, name: string, signature: string | undefined): string {
  return `${file}|${name}|${signature ?? ""}`;
}

function canonicalModule(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  return NODE_BUILTIN_MODULES.has(specifier) ? `node:${specifier}` : specifier;
}

function isRelativeModuleSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  );
}

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

function declarationForSymbol(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  return symbol?.declarations?.[0] ?? symbol?.valueDeclaration;
}

function isAmbientExternalModuleDeclaration(node: ts.Declaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) return true;
    current = current.parent;
  }
  return false;
}

function isTypeContainer(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  );
}

function identityExportPath(declaration: ts.Declaration): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = declaration;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (current === declaration || isTypeContainer(current)) {
      const name = declarationNameNode(current)?.getText();
      if (name !== undefined) names.unshift(name);
    }
    current = current.parent;
  }
  const fallback = declarationNameNode(declaration)?.getText();
  return names.length > 0 ? names : fallback === undefined ? [] : [fallback];
}

function nodeBuiltinModule(fileName: string): string | undefined {
  const normalized = toPosix(fileName);
  const marker = "/@types/node/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return undefined;
  let moduleName = normalized.slice(index + marker.length);
  moduleName = moduleName.replace(/^ts\d+(?:\.\d+)*\//u, "");
  if (moduleName.endsWith(".d.ts")) moduleName = moduleName.slice(0, -5);
  if (moduleName.endsWith("/index")) moduleName = moduleName.slice(0, -6);
  if (moduleName === "globals" || moduleName === "internal") return undefined;
  return `node:${moduleName}`;
}

function isNodeDeclarationFile(fileName: string): boolean {
  return toPosix(fileName).includes("/@types/node/");
}

function packageNameFromPath(fileName: string): string | undefined {
  const normalized = toPosix(fileName);
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return undefined;
  const rest = normalized.slice(index + marker.length);
  const parts = rest.split("/");
  if (parts[0] === undefined) return undefined;
  if (parts[0].startsWith("@") && parts[1] !== undefined) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function sourceIsGlobalLibrary(fileName: string): boolean {
  return /(^|[/\\])lib\.[^/\\]+\.d\.ts$/u.test(fileName);
}

function staticString(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

export class SymbolIdentityResolver {
  private readonly checker: ts.TypeChecker;
  private readonly rootDir: string;
  private readonly knownByKey = new Map<string, LogicalId>();
  private readonly declarationIds = new Map<ts.Declaration, LogicalId>();
  private readonly bindings = new Map<ts.Symbol, ResolvedSymbolIdentity>();

  constructor(
    rootDir: string,
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    snapshot: RepositorySemanticSnapshot,
  ) {
    this.rootDir = rootDir;
    this.checker = checker;
    for (const symbol of snapshot.derived.symbols) {
      if (symbol.locator.file === undefined) continue;
      this.knownByKey.set(symbolKey(symbol.locator.file, symbol.locator.symbol, symbol.locator.signature), symbol.id);
    }
    for (const sourceFile of sourceFiles) this.collectDeclarations(sourceFile);
    for (const sourceFile of sourceFiles) this.collectExports(sourceFile);
    for (const sourceFile of sourceFiles) this.collectImports(sourceFile);
    for (const sourceFile of sourceFiles) this.collectRequireBindings(sourceFile);
  }

  symbolIdForDeclaration(node: ts.Declaration): LogicalId | undefined {
    return this.declarationIds.get(node);
  }

  symbolIdForNode(node: ts.Node): LogicalId | undefined {
    let current: ts.Node | undefined = node;
    let fallback: LogicalId | undefined;
    while (current !== undefined) {
      if (isSupportedDeclaration(current)) {
        const id = this.declarationIds.get(current);
        if (id !== undefined) {
          fallback ??= id;
          if (isFunctionLikeDeclaration(current) || ts.isVariableDeclaration(current)) return id;
        }
      }
      current = current.parent;
    }
    return fallback;
  }

  identityForExpression(expression: ts.Expression): ResolvedSymbolIdentity | undefined {
    if (ts.isParenthesizedExpression(expression)) return this.identityForExpression(expression.expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const base = this.identityForExpression(expression.expression);
      const property = this.identityFromSymbol(this.checker.getSymbolAtLocation(expression.name));
      if (property?.kind === "project") return property;
      if (base?.kind === "project") return property ?? this.withProperty(base, expression.name.text, expression);
      if (property !== undefined && base === undefined) return property;
      if (base !== undefined) return this.withProperty(base, expression.name.text, expression);
      return property;
    }
    if (ts.isElementAccessExpression(expression)) {
      const base = this.identityForExpression(expression.expression);
      const property = staticString(expression.argumentExpression);
      const resolvedProperty = this.identityFromSymbol(this.checker.getSymbolAtLocation(expression));
      if (resolvedProperty?.kind === "project") return resolvedProperty;
      if (base?.kind === "project" && property !== undefined)
        return resolvedProperty ?? this.withProperty(base, property, expression);
      if (resolvedProperty !== undefined && base === undefined) return resolvedProperty;
      if (base !== undefined && property !== undefined) return this.withProperty(base, property, expression);
      return undefined;
    }
    if (ts.isCallExpression(expression) && this.isCommonJsRequire(expression.expression)) {
      const moduleName = staticString(expression.arguments[0]);
      if (moduleName !== undefined) return this.moduleIdentity(moduleName, []);
    }
    if (ts.isIdentifier(expression)) {
      const bound = this.bindingForSymbol(this.checker.getSymbolAtLocation(expression));
      if (bound !== undefined) return bound;
    }
    return this.identityFromSymbol(this.checker.getSymbolAtLocation(expression));
  }

  sourceLocation(node: ts.Node): { path: string; range: SourceRange } {
    const sourceFile = node.getSourceFile();
    return { path: relativePath(this.rootDir, sourceFile.fileName), range: sourceRange(sourceFile, node) };
  }

  isProjectIdentity(identity: ResolvedSymbolIdentity): boolean {
    return identity.kind === "project";
  }

  /** True only for the TypeScript-resolved Node CommonJS `require` binding. */
  isCommonJsRequire(expression: ts.Expression): boolean {
    if (!ts.isIdentifier(expression) || expression.text !== "require") return false;
    const symbol = this.checker.getSymbolAtLocation(expression);
    const resolved = symbol === undefined ? undefined : this.resolveAliasedSymbol(symbol);
    const declaration = declarationForSymbol(resolved);
    if (resolved === undefined || declaration === undefined) return false;
    const fileName = toPosix(declaration.getSourceFile().fileName);
    return resolved.name === "require" && isNodeDeclarationFile(fileName);
  }

  formatIdentity(identity: ResolvedSymbolIdentity): string {
    if (identity.module !== undefined)
      return `${identity.module}${identity.exportPath.length === 0 ? "" : `.${identity.exportPath.join(".")}`}`;
    return `${identity.kind}:${identity.exportPath.join(".") || identity.declarationName}`;
  }

  private collectDeclarations(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (isSupportedDeclaration(node)) {
        const name = declarationNameNode(node);
        if (name !== undefined) {
          const file = relativePath(this.rootDir, sourceFile.fileName);
          const id = this.knownByKey.get(
            symbolKey(file, qualifiedDeclarationName(node), signatureText(this.checker, node)),
          );
          if (id !== undefined) this.declarationIds.set(node, id);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private collectImports(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) this.collectImportDeclaration(node);
      else if (ts.isImportEqualsDeclaration(node)) this.collectImportEquals(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private collectExports(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node)) this.collectExportDeclaration(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private collectExportDeclaration(node: ts.ExportDeclaration): void {
    const moduleName = staticString(node.moduleSpecifier);
    if (moduleName === undefined || node.exportClause === undefined) return;
    const specifier = canonicalModule(moduleName);
    if (ts.isNamespaceExport(node.exportClause)) {
      const symbol = this.checker.getSymbolAtLocation(node.exportClause.name);
      if (symbol !== undefined) this.bindings.set(symbol, this.moduleIdentity(specifier, []));
      return;
    }
    if (!ts.isNamedExports(node.exportClause)) return;
    for (const element of node.exportClause.elements) {
      const symbol = this.checker.getSymbolAtLocation(element.name);
      if (symbol === undefined) continue;
      const identity = this.moduleIdentity(specifier, [element.propertyName?.text ?? element.name.text], symbol);
      this.bindings.set(symbol, identity);
      const resolved = this.resolveAliasedSymbol(symbol);
      if (resolved !== symbol && !this.bindings.has(resolved)) this.bindings.set(resolved, identity);
    }
  }

  private collectImportDeclaration(node: ts.ImportDeclaration): void {
    const moduleName = staticString(node.moduleSpecifier);
    if (moduleName === undefined || node.importClause === undefined) return;
    const specifier = canonicalModule(moduleName);
    const clause = node.importClause;
    if (clause.name !== undefined) this.bindImport(clause.name, specifier, ["default"]);
    if (clause.namedBindings === undefined) return;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      this.bindImport(clause.namedBindings.name, specifier, []);
      return;
    }
    for (const element of clause.namedBindings.elements) {
      this.bindImport(element.name, specifier, [element.propertyName?.text ?? element.name.text]);
    }
  }

  private collectImportEquals(node: ts.ImportEqualsDeclaration): void {
    if (!ts.isExternalModuleReference(node.moduleReference)) return;
    const moduleName = staticString(node.moduleReference.expression);
    if (moduleName !== undefined) this.bindImport(node.name, canonicalModule(moduleName), []);
  }

  private bindImport(node: ts.Node, moduleName: string, exportPath: readonly string[]): void {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol === undefined) return;
    const identity = this.moduleIdentity(moduleName, exportPath, symbol);
    this.bindings.set(symbol, identity);
    const resolved = this.resolveAliasedSymbol(symbol);
    if (resolved !== symbol && !this.bindings.has(resolved)) this.bindings.set(resolved, identity);
  }

  private collectRequireBindings(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const requireIdentity = this.identityForRequire(node.initializer);
        if (requireIdentity !== undefined) this.bindBindingPattern(node.name, requireIdentity);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private identityForRequire(expression: ts.Expression): ResolvedSymbolIdentity | undefined {
    if (ts.isCallExpression(expression) && this.isCommonJsRequire(expression.expression)) {
      const moduleName = staticString(expression.arguments[0]);
      return moduleName === undefined ? undefined : this.moduleIdentity(moduleName, []);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = this.identityForRequire(expression.expression);
      if (base === undefined) return undefined;
      const property = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : staticString(expression.argumentExpression);
      return property === undefined ? undefined : this.withProperty(base, property, expression);
    }
    return undefined;
  }

  private bindBindingPattern(name: ts.BindingName, base: ResolvedSymbolIdentity): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.checker.getSymbolAtLocation(name);
      if (symbol !== undefined) this.bindings.set(symbol, { ...base });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName === undefined ? element.name : element.propertyName;
      if (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) continue;
      const identity = this.withProperty(base, property.text, element);
      this.bindBindingPattern(element.name, identity);
    }
  }

  private bindingForSymbol(symbol: ts.Symbol | undefined): ResolvedSymbolIdentity | undefined {
    if (symbol === undefined) return undefined;
    return this.bindings.get(symbol) ?? this.bindings.get(this.resolveAliasedSymbol(symbol));
  }

  private resolveAliasedSymbol(symbol: ts.Symbol): ts.Symbol {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      return this.checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  private moduleIdentity(
    moduleName: string,
    exportPath: readonly string[],
    symbol?: ts.Symbol,
  ): ResolvedSymbolIdentity {
    const canonical = canonicalModule(moduleName);
    const resolvedSymbol = symbol === undefined ? undefined : this.resolveAliasedSymbol(symbol);
    const declaration = declarationForSymbol(resolvedSymbol);
    const declarationFile = declaration?.getSourceFile().fileName;
    const isProjectDeclaration =
      declaration !== undefined &&
      this.declarationIds.has(declaration) &&
      !isAmbientExternalModuleDeclaration(declaration);
    const kind = isRelativeModuleSpecifier(canonical)
      ? "project"
      : canonical.startsWith("node:")
        ? declarationFile !== undefined && isNodeDeclarationFile(declarationFile)
          ? "builtin"
          : isProjectDeclaration
            ? "project"
            : "unknown"
        : isProjectDeclaration
          ? "project"
          : "external";
    return {
      kind,
      module: canonical,
      package:
        kind === "external"
          ? canonical
              .split("/")
              .slice(0, canonical.startsWith("@") ? 2 : 1)
              .join("/")
          : undefined,
      exportPath: [...exportPath],
      declarationName:
        declaration === undefined
          ? (exportPath.at(-1) ?? canonical)
          : (declarationNameNode(declaration)?.getText() ?? exportPath.at(-1) ?? canonical),
      declarationFile,
      symbolName: resolvedSymbol?.name,
    };
  }

  private withProperty(base: ResolvedSymbolIdentity, property: string, expression: ts.Node): ResolvedSymbolIdentity {
    const symbol = this.checker.getSymbolAtLocation(expression);
    const declaration = declarationForSymbol(symbol);
    return {
      ...base,
      exportPath: [...base.exportPath, property],
      declarationName: declaration === undefined ? property : (declarationNameNode(declaration)?.getText() ?? property),
      declarationFile: declaration?.getSourceFile().fileName ?? base.declarationFile,
      symbolName: symbol?.name ?? property,
    };
  }

  private identityFromSymbol(symbol: ts.Symbol | undefined): ResolvedSymbolIdentity | undefined {
    if (symbol === undefined) return undefined;
    const bound = this.bindingForSymbol(symbol);
    if (bound !== undefined) return bound;
    const resolved = this.resolveAliasedSymbol(symbol);
    const declaration = declarationForSymbol(resolved);
    const declarationFile = declaration?.getSourceFile().fileName;
    if (declaration === undefined || declarationFile === undefined) return undefined;
    if (
      declaration !== undefined &&
      this.declarationIds.has(declaration) &&
      !isAmbientExternalModuleDeclaration(declaration)
    ) {
      return {
        kind: "project",
        exportPath: identityExportPath(declaration),
        declarationName: resolved.name,
        declarationFile,
        symbolName: resolved.name,
      };
    }
    const nodeModule = nodeBuiltinModule(declarationFile);
    if (nodeModule !== undefined) {
      return this.moduleIdentity(nodeModule, identityExportPath(declaration), resolved);
    }
    if (toPosix(declarationFile).endsWith("/globals.d.ts") && resolved.name === "process") {
      return this.moduleIdentity("node:process", [resolved.name], resolved);
    }
    if (toPosix(declarationFile).endsWith("/globals.d.ts") && resolved.name === "console") {
      return this.moduleIdentity("node:console", [resolved.name], resolved);
    }
    if (sourceIsGlobalLibrary(declarationFile)) {
      const exportPath = identityExportPath(declaration);
      const globalName = exportPath[0] ?? resolved.name;
      return {
        kind: "global",
        module: `global:${globalName}`,
        exportPath,
        declarationName: resolved.name,
        declarationFile,
        symbolName: resolved.name,
      };
    }
    return {
      kind: "external",
      package: packageNameFromPath(declarationFile),
      exportPath: identityExportPath(declaration),
      declarationName: resolved.name,
      declarationFile,
      symbolName: resolved.name,
    };
  }
}

export function createTypeScriptEffectProgram(
  options: TypeScriptEffectOptions,
  snapshot: RepositorySemanticSnapshot,
): TypeScriptEffectProgram {
  const rootDir = normalizePath(options.rootDir);
  const configPath = normalizePath(options.tsconfigPath ?? join(rootDir, "tsconfig.json"));
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  let configuredRootNames: string[] = [];
  const completenessUnknowns: Omit<EffectUnknown, "subjectId">[] = [];
  const addCompletenessUnknown = (
    code: EffectUnknown["code"],
    message: string,
    completeness: EffectUnknown["completeness"] = "partial",
  ): void => {
    completenessUnknowns.push({ code, message, completeness });
  };
  if (existsSync(configPath)) {
    const configFile = ts.readConfigFile(configPath, (fileName) => readFileSync(fileName, "utf8"));
    if (configFile.error === undefined) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
      );
      compilerOptions = parsed.options;
      configuredRootNames = parsed.fileNames;
      for (const diagnostic of parsed.errors) {
        addCompletenessUnknown(
          "tsconfig-diagnostic",
          `TypeScript configuration diagnostic: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        );
      }
    } else {
      addCompletenessUnknown(
        "tsconfig-diagnostic",
        `TypeScript configuration could not be read: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`,
      );
    }
  } else {
    addCompletenessUnknown(
      "tsconfig-diagnostic",
      `TypeScript configuration is missing: ${relativePath(rootDir, configPath)}`,
    );
  }
  const requestedRootNames =
    options.rootNames?.map((filePath) => normalizePath(resolve(rootDir, filePath))) ?? configuredRootNames;
  const droppedRootNames = requestedRootNames.filter((filePath) => !pathInside(rootDir, filePath));
  if (droppedRootNames.length > 0) {
    addCompletenessUnknown(
      "project-incomplete",
      `TypeScript project roots outside rootDir were not analyzed: ${droppedRootNames
        .map((filePath) => relativePath(rootDir, filePath))
        .sort()
        .join(", ")}`,
    );
  }
  if (options.rootNames !== undefined) {
    const configured = new Set(configuredRootNames);
    const requested = new Set(requestedRootNames);
    const omitted = [...configured].filter((filePath) => !requested.has(filePath));
    if (omitted.length > 0 || configured.size === 0) {
      addCompletenessUnknown(
        "project-incomplete",
        omitted.length > 0
          ? `Explicit rootNames omit ${omitted.length} file(s) declared by the TypeScript project`
          : "Explicit rootNames do not identify the complete TypeScript project",
      );
    }
  }
  const rootNames =
    requestedRootNames.length > 0
      ? [...new Set(requestedRootNames.filter((filePath) => pathInside(rootDir, filePath)))].sort()
      : ts.sys
          .readDirectory(rootDir, [...SOURCE_EXTENSIONS], undefined, undefined, undefined)
          .filter((filePath) => {
            const normalized = toPosix(filePath);
            return (
              !normalized.includes("/node_modules/") && !normalized.includes("/.git/") && !normalized.includes("/dist/")
            );
          })
          .sort();
  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        pathInside(rootDir, normalizePath(sourceFile.fileName)) &&
        SOURCE_EXTENSIONS.has(extname(sourceFile.fileName).toLowerCase()),
    )
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const loadedRootNames = new Set(
    program
      .getSourceFiles()
      .map((sourceFile) => normalizePath(sourceFile.fileName))
      .filter((filePath) => pathInside(rootDir, filePath)),
  );
  for (const rootName of rootNames) {
    if (!loadedRootNames.has(rootName) && SOURCE_EXTENSIONS.has(extname(rootName).toLowerCase())) {
      addCompletenessUnknown(
        "project-incomplete",
        `TypeScript project root was not loaded: ${relativePath(rootDir, rootName)}`,
      );
    }
  }
  for (const diagnostic of [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]) {
    addCompletenessUnknown(
      "compiler-diagnostic",
      `TypeScript program diagnostic: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
  const dedupedCompletenessUnknowns = completenessUnknowns.filter(
    (unknown, index, values) =>
      index ===
      values.findIndex(
        (candidate) => `${candidate.code}|${candidate.message}` === `${unknown.code}|${unknown.message}`,
      ),
  );
  const symbols = new SymbolIdentityResolver(rootDir, program.getTypeChecker(), sourceFiles, snapshot);
  return {
    rootDir,
    program,
    checker: program.getTypeChecker(),
    sourceFiles,
    compilerOptions,
    symbols,
    completenessUnknowns: dedupedCompletenessUnknowns,
  };
}

export function symbolLocatorForDeclaration(
  rootDir: string,
  packageName: string | undefined,
  node: ts.Declaration,
  checker: ts.TypeChecker,
): SymbolLocator {
  const sourceFile = node.getSourceFile();
  const file = relativePath(rootDir, sourceFile.fileName);
  const language = /\.(?:js|jsx)$/u.test(sourceFile.fileName) ? "javascript" : "typescript";
  return {
    kind: "symbol",
    language,
    ...(packageName === undefined ? {} : { package: packageName }),
    module: moduleNameForFile(rootDir, sourceFile.fileName),
    file,
    symbol: qualifiedDeclarationName(node),
    ...(signatureText(checker, node) === undefined ? {} : { signature: signatureText(checker, node) }),
  };
}

export function createFallbackSymbolId(
  rootDir: string,
  packageName: string | undefined,
  node: ts.Declaration,
  checker: ts.TypeChecker,
): string {
  return createSymbolId(symbolLocatorForDeclaration(rootDir, packageName, node, checker));
}
