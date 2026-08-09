import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { computeIntegrityDigestsFromValidated, digestCanonicalValue } from "../../ir/canonical.js";
import {
  createEdgeId,
  createExternalApiId,
  createExternalDependencyId,
  createFactId,
  createNodeId,
  createPackageId,
  createProjectId,
  createRepositoryId,
  createRevisionId,
  createSymbolId,
  createWorktreeId,
} from "../../ir/ids.js";
import type {
  AnalysisUnknown,
  ContentDigest,
  ExternalApiEntity,
  ExternalDependencyEntity,
  FileEntity,
  PackageEntity,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticFact,
  SemanticRelation,
  SourceRange,
  SymbolEntity,
  SymbolLocator,
  TrackedFileFingerprint,
} from "../../ir/types.js";
import {
  TYPESCRIPT_FACT_PROVIDER_ID,
  TYPESCRIPT_FACT_PROVIDER_VERSION,
  type TypeScriptExtractorOptions,
  type TypeScriptFactCounts,
  type TypeScriptFactProvider,
  type TypeScriptFactResult,
} from "../types.js";
import { validateSnapshot } from "../../ir/schema.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const CONFIG_FILES = new Set(["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json"]);
const BUILTIN_MODULE_PREFIX = "node:";
const FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

interface JsonObject {
  [key: string]: unknown;
}

interface DependencyDeclaration {
  version?: string;
  dependencyType: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
}

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies: Map<string, DependencyDeclaration>;
}

interface PackageUsage {
  name: string;
  version?: string;
  declared: boolean;
  declarationType?: DependencyDeclaration["dependencyType"];
  resolved: boolean;
  imported: boolean;
  used: boolean;
  resolvedFile?: string;
  importedApiIds: Set<string>;
  usedApiIds: Set<string>;
}

interface SymbolMetrics {
  lines: number;
  cyclomaticComplexity: number;
  references: number;
  calls: number;
}

interface FileMetrics {
  lines: number;
  cyclomaticComplexity: number;
  symbolCount: number;
  imports: number;
  exports: number;
  references: number;
  calls: number;
}

interface ProjectContext {
  rootDir: string;
  configPath?: string;
  compilerOptions: ts.CompilerOptions;
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
  projectPaths: Set<string>;
  configErrors: readonly ts.Diagnostic[];
  packageManifest: PackageManifest;
  rootPackageName: string;
  repositoryName: string;
  remote?: string;
  revision: string;
  tree?: string;
  gitRevision?: string;
  gitDirty?: boolean;
  inputPaths: string[];
}

interface SymbolRecord {
  id: ReturnType<typeof createSymbolId>;
  entity: SymbolEntity;
  declaration: ts.Declaration;
  nameNode: ts.Node;
  sourceFile: ts.SourceFile;
  compilerSymbol: ts.Symbol;
  qualifiedName: string;
  declarationKind: string;
  signature?: string;
  typeText: string;
  exported: boolean;
  visibility: string;
  fileId: ReturnType<typeof createProjectId>;
}

interface ExternalApiRecord {
  id: ReturnType<typeof createExternalApiId>;
  entity: ExternalApiEntity;
  packageName: string;
  imported: boolean;
  used: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(filePath: string): string {
  return resolve(filePath);
}

function toPosix(filePath: string): string {
  return filePath.split(sep).join("/");
}

function pathInside(rootDir: string, filePath: string): boolean {
  const path = relative(rootDir, filePath);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolutePath(path));
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(filePath);
}

function relativePath(rootDir: string, filePath: string): string {
  const value = toPosix(relative(rootDir, filePath));
  return value.length > 0 ? value : basename(filePath);
}

function fileLanguage(filePath: string): string | undefined {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return undefined;
}

function moduleNameForFile(rootDir: string, filePath: string): string {
  let value = relativePath(rootDir, filePath);
  if (value.endsWith(".d.ts")) value = value.slice(0, -5);
  else value = value.replace(/\.[^.]+$/, "");
  return value;
}

function stableLocalId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._~+/@#:%-]*$/.test(value) && !/\s/.test(value)) return value;
  return `sha256-${sha256Text(value).slice(0, 32)}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): ContentDigest {
  return { algorithm: "sha256", value: createHash("sha256").update(value).digest("hex") };
}

function readJsonObject(filePath: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readManifest(filePath: string): PackageManifest {
  const value = readJsonObject(filePath);
  const dependencies = new Map<string, DependencyDeclaration>();
  const sections: Array<DependencyDeclaration["dependencyType"]> = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  for (const dependencyType of sections) {
    const entries = value?.[dependencyType];
    if (!isObject(entries)) continue;
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version === "string") dependencies.set(name, { version, dependencyType });
    }
  }
  return {
    name: typeof value?.name === "string" ? value.name : undefined,
    version: typeof value?.version === "string" ? value.version : undefined,
    dependencies,
  };
}

function gitOutput(rootDir: string, args: string[]): string | undefined {
  try {
    const result = execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = result.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function remoteRepositoryName(remote: string | undefined): string | undefined {
  if (remote === undefined) return undefined;
  const value = remote.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  const match = value.match(/github\.com[/:]([^/]+\/[^/]+)$/);
  return match?.[1];
}

function discoverSourceFiles(rootDir: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    try {
      const entries = readdirSync(directory, { encoding: "utf8", withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".mottainai") {
          continue;
        }
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) visit(filePath);
        else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) result.push(normalizePath(filePath));
      }
    } catch {
      return;
    }
  };
  visit(rootDir);
  return result.sort();
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

function diagnosticPath(diagnostic: ts.Diagnostic, rootDir: string): string | undefined {
  return diagnostic.file === undefined ? undefined : relativePath(rootDir, diagnostic.file.fileName);
}

function loadProject(options: TypeScriptExtractorOptions): ProjectContext {
  const rootDir = normalizePath(options.rootDir);
  const configPathCandidate = normalizePath(options.tsconfigPath ?? join(rootDir, "tsconfig.json"));
  let configPath: string | undefined;
  let compilerOptions: ts.CompilerOptions;
  let configErrors: readonly ts.Diagnostic[] = [];
  let configuredFileNames: string[];

  if (existsSync(configPathCandidate)) {
    configPath = configPathCandidate;
    const config = ts.readConfigFile(configPathCandidate, ts.sys.readFile);
    if (config.error !== undefined) {
      configErrors = [config.error];
      compilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
      };
      configuredFileNames = discoverSourceFiles(rootDir);
    } else {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPathCandidate), undefined, configPathCandidate);
      compilerOptions = parsed.options;
      configErrors = parsed.errors;
      configuredFileNames = parsed.fileNames.map(normalizePath);
    }
  } else {
    compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
    };
    configuredFileNames = discoverSourceFiles(rootDir);
  }

  const requestedRootNames = options.rootNames?.map((filePath) => normalizePath(resolve(rootDir, filePath))) ?? configuredFileNames;
  const rootNames = [...new Set(requestedRootNames)].sort();
  const projectPaths = new Set([...configuredFileNames, ...rootNames].filter((filePath) => pathInside(rootDir, filePath)));
  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => projectPaths.has(normalizePath(sourceFile.fileName)))
    .filter((sourceFile) => SOURCE_EXTENSIONS.has(extname(sourceFile.fileName).toLowerCase()))
    .sort((left, right) => normalizePath(left.fileName).localeCompare(normalizePath(right.fileName)));

  const packageManifest = readManifest(join(rootDir, "package.json"));
  const remote = gitOutput(rootDir, ["remote", "get-url", "origin"]);
  const repositoryName = options.repositoryName ?? remoteRepositoryName(remote) ?? packageManifest.name ?? basename(rootDir);
  const rootPackageName = options.packageName ?? packageManifest.name ?? basename(rootDir);
  const gitRevision = gitOutput(rootDir, ["rev-parse", "HEAD"]);
  const gitTree = gitOutput(rootDir, ["rev-parse", "HEAD^{tree}"]);
  const gitStatus = gitOutput(rootDir, ["status", "--porcelain"]);
  const inputPaths = [
    ...sourceFiles.map((sourceFile) => normalizePath(sourceFile.fileName)),
    ...(configPath === undefined ? [] : [configPath]),
    ...[...CONFIG_FILES]
      .map((fileName) => join(rootDir, fileName))
      .filter((filePath) => existsSync(filePath)),
  ].sort();
  const contentDigest = digestCanonicalValue(
    inputPaths.map((filePath) => {
      try {
        return [relativePath(rootDir, filePath), sha256Bytes(readFileSync(filePath))];
      } catch {
        return [relativePath(rootDir, filePath), "unreadable"];
      }
    }),
  ).value;
  const revision = options.revision ?? gitRevision ?? `working-${contentDigest.slice(0, 32)}`;

  return {
    rootDir,
    configPath,
    compilerOptions,
    program,
    checker: program.getTypeChecker(),
    sourceFiles,
    projectPaths,
    configErrors,
    packageManifest,
    rootPackageName,
    repositoryName,
    remote,
    revision,
    tree: gitTree ?? contentDigest,
    gitRevision,
    gitDirty: gitStatus !== undefined,
    inputPaths,
  };
}

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
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

function declarationKind(node: ts.Declaration): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node) || ts.isEnumMember(node)) return "enum";
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.ModifierFlags.Const)) return "constant";
    return "variable";
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return "alias";
  if (ts.isExportSpecifier(node)) return "re-export";
  if (ts.isModuleDeclaration(node)) return "module";
  if (ts.isBindingElement(node)) return "binding";
  return "symbol";
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

function hasModifier(node: ts.Node, flag: ts.ModifierFlags): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & flag) !== 0;
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

function visibilityOf(node: ts.Declaration, exported: boolean): string {
  if (hasModifier(node, ts.ModifierFlags.Private)) return "private";
  if (hasModifier(node, ts.ModifierFlags.Protected)) return "protected";
  if (hasModifier(node, ts.ModifierFlags.Public)) return "public";
  if (exported) return "public";
  return "internal";
}

function isExportedDeclaration(checker: ts.TypeChecker, node: ts.Declaration, symbol: ts.Symbol): boolean {
  if (hasModifier(node, ts.ModifierFlags.Export) || hasModifier(node, ts.ModifierFlags.Default)) return true;
  if (ts.isExportSpecifier(node)) return true;
  const variableStatement = ts.isVariableDeclaration(node) ? node.parent.parent : undefined;
  if (variableStatement !== undefined && ts.isVariableStatement(variableStatement)) {
    if (hasModifier(variableStatement, ts.ModifierFlags.Export)) return true;
  }
  const sourceFile = node.getSourceFile();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) return false;
  try {
    return checker.getExportsOfModule(moduleSymbol).some((exportedSymbol) => {
      const target = (exportedSymbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exportedSymbol) : exportedSymbol;
      return target === symbol;
    });
  } catch {
    return false;
  }
}

function typeText(checker: ts.TypeChecker, node: ts.Node): string {
  try {
    return checker.typeToString(checker.getTypeAtLocation(node), node, FORMAT_FLAGS);
  } catch {
    return "unknown";
  }
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

function branchCount(node: ts.Node): number {
  let count = 0;
  const visit = (current: ts.Node): void => {
    if (
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isCatchClause(current)
    ) {
      count += 1;
    } else if (ts.isCaseClause(current) && current.parent.clauses[0] !== current) {
      count += 1;
    } else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      count += 1;
    }
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return count;
}

function linesForNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  const range = sourceRange(sourceFile, node);
  return Math.max(1, range.end === undefined ? range.start.line : range.end.line - range.start.line + 1);
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith(BUILTIN_MODULE_PREFIX) || specifier.startsWith("#")) return undefined;
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)) {
    return undefined;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0];
}

function isStaticImportArgument(node: ts.Expression): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isAnyType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

function isTypeScriptLibraryFile(filePath: string): boolean {
  return /(^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(filePath);
}

export class TypeScriptFactExtractor implements TypeScriptFactProvider {
  extract(options: TypeScriptExtractorOptions): TypeScriptFactResult {
    const startedAt = Date.now();
    const context = loadProject(options);
    const collector = new FactCollector(context, options);
    const snapshot = collector.collect();
    const counts: TypeScriptFactCounts = {
      files: snapshot.derived.files.length,
      symbols: snapshot.derived.symbols.length,
      relations: snapshot.graph.relations.length,
      facts: snapshot.derived.facts.length,
      externalPackages: snapshot.derived.externalDependencies.length,
      externalApis: snapshot.derived.externalApis.length,
      unknowns: snapshot.analysis.unknowns.length,
      diagnostics: snapshot.analysis.diagnostics.length,
      partial: snapshot.analysis.health.status !== "healthy",
    };
    return { snapshot, elapsedMs: Date.now() - startedAt, counts };
  }
}

export function extractTypeScriptFacts(options: TypeScriptExtractorOptions): TypeScriptFactResult {
  return new TypeScriptFactExtractor().extract(options);
}

class FactCollector {
  private readonly context: ProjectContext;
  private readonly options: TypeScriptExtractorOptions;
  private readonly repositoryId;
  private readonly revisionId;
  private readonly projectId;
  private readonly projectPackageId;
  private readonly provenanceBase: Provenance;
  private readonly fileIds = new Map<string, ReturnType<typeof createProjectId>>();
  private readonly sourceFileByPath = new Map<string, ts.SourceFile>();
  private readonly records: SymbolRecord[] = [];
  private readonly declarationRecords = new Map<ts.Node, SymbolRecord>();
  private readonly symbolRecords = new Map<ts.Symbol, SymbolRecord[]>();
  private readonly declarationNameNodes = new Set<ts.Node>();
  private readonly symbolFileIds = new Map<string, ReturnType<typeof createProjectId>>();
  private readonly symbolMetrics = new Map<string, SymbolMetrics>();
  private readonly fileMetrics = new Map<string, FileMetrics>();
  private readonly facts = new Map<string, SemanticFact>();
  private readonly relations = new Map<string, SemanticRelation>();
  private readonly files: FileEntity[] = [];
  private readonly externalDependencies = new Map<string, PackageUsage>();
  private readonly externalApis = new Map<string, ExternalApiRecord>();
  private readonly externalSymbolPackages = new Map<ts.Symbol, { packageName: string; specifier: string | undefined }>();
  private readonly unknowns: AnalysisUnknown[] = [];
  private readonly diagnostics: SemanticDiagnostic[] = [];
  private readonly unknownKeys = new Set<string>();
  private readonly diagnosticKeys = new Set<string>();
  private readonly importedModuleKeys = new Set<string>();

  constructor(context: ProjectContext, options: TypeScriptExtractorOptions) {
    this.context = context;
    this.options = options;
    this.repositoryId = createRepositoryId(stableLocalId(context.repositoryName));
    this.revisionId = createRevisionId(stableLocalId(context.revision));
    this.projectId = createProjectId(stableLocalId(context.repositoryName));
    this.projectPackageId = createPackageId(stableLocalId(context.rootPackageName));
    this.provenanceBase = {
      kind: "derived",
      producer: { name: TYPESCRIPT_FACT_PROVIDER_ID, version: TYPESCRIPT_FACT_PROVIDER_VERSION },
      sourceRevision: { repositoryId: this.repositoryId, revisionId: this.revisionId },
    };
  }

  collect(): RepositorySemanticSnapshot {
    this.addConfigurationDiagnostics();
    this.createFileEntities();
    this.collectDeclarations();
    this.processImportsAndExports();
    this.processHeritageRelations();
    this.processReferencesAndCalls();
    this.addPackageEntitiesAndFacts();
    this.addMetricsFacts();
    const snapshot = this.buildSnapshot();
    const validation = validateSnapshot(snapshot);
    if (!validation.ok) {
      throw new Error(
        `TypeScript extractor produced invalid IR: ${validation.diagnostics.map((item) => `${item.code}:${item.message}`).join(";")}`,
      );
    }
    return validation.snapshot;
  }

  private addConfigurationDiagnostics(): void {
    for (const diagnostic of this.context.configErrors) {
      this.addDiagnostic("tsconfig_diagnostic", "error", diagnosticText(diagnostic), diagnosticPath(diagnostic, this.context.rootDir));
    }
    const resolution = this.context.compilerOptions.moduleResolution;
    const supportedResolution = new Set<number>([
      ts.ModuleResolutionKind.Classic,
      ts.ModuleResolutionKind.Node10,
      ts.ModuleResolutionKind.Node16,
      ts.ModuleResolutionKind.NodeNext,
      ts.ModuleResolutionKind.Bundler,
    ]);
    if (resolution !== undefined && !supportedResolution.has(resolution)) {
      this.addUnknown("unsupported_module_resolution", `Unsupported TypeScript module resolution mode: ${resolution}`);
    }
    const moduleKind = this.context.compilerOptions.module;
    const knownModuleKinds = new Set<number>([
      ts.ModuleKind.None,
      ts.ModuleKind.CommonJS,
      ts.ModuleKind.AMD,
      ts.ModuleKind.UMD,
      ts.ModuleKind.System,
      ts.ModuleKind.ES2015,
      ts.ModuleKind.ES2020,
      ts.ModuleKind.ES2022,
      ts.ModuleKind.ESNext,
      ts.ModuleKind.Node16,
      ts.ModuleKind.NodeNext,
      ts.ModuleKind.Preserve,
    ]);
    if (moduleKind !== undefined && !knownModuleKinds.has(moduleKind)) {
      this.addUnknown("unsupported_module_mode", `Unsupported TypeScript module mode: ${moduleKind}`);
    }
    for (const diagnostic of this.context.program.getOptionsDiagnostics()) {
      this.addDiagnostic("compiler_options_diagnostic", "error", diagnosticText(diagnostic), diagnosticPath(diagnostic, this.context.rootDir));
    }
    for (const diagnostic of this.context.program.getSyntacticDiagnostics()) {
      this.addDiagnostic("typescript_syntax_diagnostic", "error", diagnosticText(diagnostic), diagnosticPath(diagnostic, this.context.rootDir));
    }
    for (const diagnostic of this.context.program.getSemanticDiagnostics()) {
      this.addDiagnostic("typescript_semantic_diagnostic", "warning", diagnosticText(diagnostic), diagnosticPath(diagnostic, this.context.rootDir));
    }
  }

  private createFileEntities(): void {
    const allPaths = [...new Set(this.context.inputPaths)].sort();
    for (const filePath of allPaths) {
      const relativeFile = relativePath(this.context.rootDir, filePath);
      const id = createNodeId("file", `sha256-${sha256Text(relativeFile).slice(0, 32)}`);
      this.fileIds.set(normalizePath(filePath), id);
      const entity: FileEntity = {
        id,
        name: relativeFile,
        authority: "derived",
        provenance: this.provenance(),
        kind: "file",
        path: relativeFile,
        ...(fileLanguage(filePath) === undefined ? {} : { language: fileLanguage(filePath) }),
        tracked: this.isGitTracked(relativeFile),
      };
      this.files.push(entity);
      const bytes = this.readBytes(filePath);
      this.addFact(id, "file.content_fingerprint", bytes === undefined ? "unavailable" : bytes);
      if (fileLanguage(filePath) !== undefined) this.addFact(id, "file.language", fileLanguage(filePath) ?? "unknown");
      const sourceFile = this.sourceFileByPath.get(normalizePath(filePath));
      if (sourceFile !== undefined) {
        this.addFact(id, "file.module", moduleNameForFile(this.context.rootDir, filePath));
      }
    }
    for (const sourceFile of this.context.sourceFiles) {
      const path = normalizePath(sourceFile.fileName);
      this.sourceFileByPath.set(path, sourceFile);
      const fileId = this.fileIdForPath(path);
      this.addFact(fileId, "file.module", moduleNameForFile(this.context.rootDir, path));
      this.fileMetrics.set(fileId, {
        lines: Math.max(1, sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1),
        cyclomaticComplexity: 1 + branchCount(sourceFile),
        symbolCount: 0,
        imports: 0,
        exports: 0,
        references: 0,
        calls: 0,
      });
    }
    for (const sourceFile of this.context.sourceFiles) {
      const fileId = this.fileIdForPath(normalizePath(sourceFile.fileName));
      const metrics = this.fileMetrics.get(fileId);
      if (metrics === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) metrics.imports += 1;
        if (ts.isExportAssignment(node)) metrics.exports += 1;
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private collectDeclarations(): void {
    for (const sourceFile of this.context.sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (isSupportedDeclaration(node)) this.addSymbolRecord(node, sourceFile);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private addSymbolRecord(node: ts.Declaration, sourceFile: ts.SourceFile): void {
    const nameNode = declarationNameNode(node);
    if (nameNode === undefined) return;
    const compilerSymbol = this.context.checker.getSymbolAtLocation(nameNode);
    if (compilerSymbol === undefined) {
      this.addUnknown("symbol_unresolved", `TypeChecker did not resolve declaration ${nameNode.getText()}`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    const qualifiedName = qualifiedDeclarationName(node);
    const signature = signatureText(this.context.checker, node);
    const moduleName = moduleNameForFile(this.context.rootDir, sourceFile.fileName);
    const relativeFile = relativePath(this.context.rootDir, sourceFile.fileName);
    const locator: SymbolLocator = {
      kind: "symbol",
      language: fileLanguage(sourceFile.fileName) === "javascript" ? "javascript" : "typescript",
      package: this.context.rootPackageName,
      module: moduleName,
      file: relativeFile,
      symbol: qualifiedName,
      ...(signature === undefined ? {} : { signature }),
      range: sourceRange(sourceFile, node),
    };
    const id = createSymbolId(locator);
    const previous = this.records.find((record) => record.id === id);
    if (previous !== undefined) {
      if (previous.compilerSymbol === compilerSymbol) {
        this.declarationRecords.set(node, previous);
        this.declarationNameNodes.add(nameNode);
        return;
      }
      this.addUnknown(
        "ambiguous_symbol_identity",
        `Multiple declarations share logical coordinates for ${qualifiedName}`,
        [previous.id],
        relativeFile,
      );
      return;
    }
    const exported = isExportedDeclaration(this.context.checker, node, compilerSymbol);
    const visibility = visibilityOf(node, exported);
    const declarationType = declarationKind(node);
    const entity: SymbolEntity = {
      id,
      name: qualifiedName,
      authority: "derived",
      provenance: this.provenance(),
      kind: "symbol",
      locator,
      classification: "shared",
      metadata: { ownership: "not-inferred", declarationKind: declarationType },
    };
    const record: SymbolRecord = {
      id,
      entity,
      declaration: node,
      nameNode,
      sourceFile,
      compilerSymbol,
      qualifiedName,
      declarationKind: declarationType,
      signature,
      typeText: typeText(this.context.checker, nameNode),
      exported,
      visibility,
      fileId: this.fileIdForPath(normalizePath(sourceFile.fileName)),
    };
    this.records.push(record);
    this.declarationRecords.set(node, record);
    this.declarationNameNodes.add(nameNode);
    const symbolRecords = this.symbolRecords.get(compilerSymbol) ?? [];
    symbolRecords.push(record);
    this.symbolRecords.set(compilerSymbol, symbolRecords);
    this.symbolFileIds.set(record.id, record.fileId);
    this.symbolMetrics.set(record.id, {
      lines: linesForNode(sourceFile, node),
      cyclomaticComplexity: 1 + branchCount(node),
      references: 0,
      calls: 0,
    });
    const fileMetrics = this.fileMetrics.get(record.fileId);
    if (fileMetrics !== undefined) {
      fileMetrics.symbolCount += 1;
      if (exported) fileMetrics.exports += 1;
    }
    this.addRelation("defines", record.fileId, record.id, { declarationKind: declarationType });
    this.addFact(record.id, "symbol.kind", declarationType);
    this.addFact(record.id, "symbol.type", record.typeText);
    this.addFact(record.id, "symbol.visibility", visibility);
    this.addFact(record.id, "symbol.exported", exported);
    this.addFact(record.id, "symbol.module", moduleName);
    this.addFact(record.id, "symbol.source_range", locator.range ?? { start: { line: 1, column: 1 } });
    if (signature !== undefined) this.addFact(record.id, "symbol.signature", signature);
  }

  private processImportsAndExports(): void {
    for (const sourceFile of this.context.sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) this.processImportDeclaration(sourceFile, node);
        else if (ts.isExportDeclaration(node)) this.processExportDeclaration(sourceFile, node);
        else if (ts.isImportEqualsDeclaration(node)) this.processImportEquals(sourceFile, node);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private processImportDeclaration(sourceFile: ts.SourceFile, node: ts.ImportDeclaration): void {
    const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    if (specifier === undefined) return;
    const resolvedFile = this.resolveModule(specifier, sourceFile);
    const packageName = packageNameFromSpecifier(specifier);
    const fileId = this.fileIdForPath(normalizePath(sourceFile.fileName));
    this.registerModuleImport(specifier, resolvedFile, packageName, fileId, sourceFile, false);
    const clause = node.importClause;
    if (clause === undefined) return;
    if (clause.name !== undefined) this.processAlias(clause, clause.name, packageName, specifier, false, sourceFile);
    if (clause.namedBindings === undefined) return;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      this.processAlias(clause.namedBindings, clause.namedBindings.name, packageName, specifier, false, sourceFile);
      return;
    }
    for (const element of clause.namedBindings.elements) {
      this.processAlias(element, element.name, packageName, specifier, false, sourceFile);
    }
  }

  private processExportDeclaration(sourceFile: ts.SourceFile, node: ts.ExportDeclaration): void {
    const specifier = node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    const packageName = specifier === undefined ? undefined : packageNameFromSpecifier(specifier);
    const fileId = this.fileIdForPath(normalizePath(sourceFile.fileName));
    const resolvedFile = specifier === undefined ? undefined : this.resolveModule(specifier, sourceFile);
    if (specifier !== undefined) this.registerModuleImport(specifier, resolvedFile, packageName, fileId, sourceFile, true);
    if (node.exportClause === undefined) {
      if (specifier !== undefined) this.processModuleExports(sourceFile, specifier, packageName, resolvedFile, true);
      return;
    }
    if (ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        this.processAlias(element, element.name, packageName, specifier, true, sourceFile, element.propertyName);
      }
    } else if (ts.isNamespaceExport(node.exportClause)) {
      const record = this.declarationRecords.get(node.exportClause);
      if (record !== undefined && specifier !== undefined) {
        this.processAlias(node.exportClause, node.exportClause.name, packageName, specifier, true, sourceFile);
      }
    }
  }

  private processImportEquals(sourceFile: ts.SourceFile, node: ts.ImportEqualsDeclaration): void {
    const moduleReference = node.moduleReference;
    const specifier = ts.isExternalModuleReference(moduleReference) && ts.isStringLiteral(moduleReference.expression)
      ? moduleReference.expression.text
      : undefined;
    const packageName = specifier === undefined ? undefined : packageNameFromSpecifier(specifier);
    const resolvedFile = specifier === undefined ? undefined : this.resolveModule(specifier, sourceFile);
    const fileId = this.fileIdForPath(normalizePath(sourceFile.fileName));
    if (specifier !== undefined) this.registerModuleImport(specifier, resolvedFile, packageName, fileId, sourceFile, false);
    this.processAlias(node, node.name, packageName, specifier, false, sourceFile);
  }

  private processAlias(
    declaration: ts.Node,
    aliasName: ts.Node,
    packageName: string | undefined,
    specifier: string | undefined,
    reExport: boolean,
    sourceFile: ts.SourceFile,
    propertyName?: ts.Node,
  ): void {
    const aliasRecord = this.declarationRecords.get(declaration);
    const rawSymbol = this.context.checker.getSymbolAtLocation(propertyName ?? aliasName);
    if (rawSymbol === undefined) {
      this.addUnknown("alias_unresolved", `TypeChecker did not resolve alias ${aliasName.getText()}`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    const targetSymbol = this.resolveAliasedSymbol(rawSymbol);
    if (packageName !== undefined) {
      if (!this.externalSymbolPackages.has(rawSymbol)) this.externalSymbolPackages.set(rawSymbol, { packageName, specifier });
      if (!this.externalSymbolPackages.has(targetSymbol)) this.externalSymbolPackages.set(targetSymbol, { packageName, specifier });
    }
    const targetRecords = this.recordsForSymbol(targetSymbol);
    if (targetRecords.length > 0) {
      for (const targetRecord of targetRecords) {
        if (aliasRecord !== undefined) this.addRelation("imports", aliasRecord.id, targetRecord.id, { reExport });
        this.addRelation("imports", this.fileIdForPath(normalizePath(sourceFile.fileName)), targetRecord.id, { reExport });
      }
      if (aliasRecord !== undefined) {
        this.addFact(aliasRecord.id, "symbol.alias_target", targetRecords.map((record) => record.id));
        if (reExport) this.addFact(aliasRecord.id, "symbol.reexported", true);
      }
      return;
    }
    const moduleSourceFile = this.moduleSourceFileForSymbol(targetSymbol);
    if (moduleSourceFile !== undefined) {
      const moduleFileId = this.fileIds.get(normalizePath(moduleSourceFile.fileName));
      if (moduleFileId === undefined) {
        const apiRecords = this.externalApiRecordsForSymbol(targetSymbol, packageName, specifier);
        for (const api of apiRecords) {
          api.imported = true;
          if (aliasRecord !== undefined) this.addRelation("imports_api", aliasRecord.id, api.id, { reExport, usage: "imported" });
          this.addRelation("imports_api", this.fileIdForPath(normalizePath(sourceFile.fileName)), api.id, { reExport, usage: "imported" });
        }
        return;
      }
      if (aliasRecord !== undefined) this.addRelation("imports", aliasRecord.id, moduleFileId, { reExport, namespace: true });
      this.addRelation("imports", this.fileIdForPath(normalizePath(sourceFile.fileName)), moduleFileId, { reExport, namespace: true });
      this.processModuleSymbolExports(targetSymbol, packageName, aliasRecord, sourceFile, reExport);
      return;
    }
    const apiRecords = this.externalApiRecordsForSymbol(targetSymbol, packageName, specifier);
    if (apiRecords.length > 0) {
      for (const api of apiRecords) {
        api.imported = true;
        if (aliasRecord !== undefined) this.addRelation("imports_api", aliasRecord.id, api.id, { reExport, usage: "imported" });
        this.addRelation("imports_api", this.fileIdForPath(normalizePath(sourceFile.fileName)), api.id, { reExport, usage: "imported" });
      }
      if (aliasRecord !== undefined) {
        this.addFact(aliasRecord.id, "symbol.alias_target", apiRecords.map((api) => api.id));
        if (reExport) this.addFact(aliasRecord.id, "symbol.reexported", true);
      }
      return;
    }
    if (packageName !== undefined) {
      this.addUnknown("alias_target_ambiguous", `Alias ${aliasName.getText()} has no unique TypeChecker target`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
    }
  }

  private processModuleExports(
    sourceFile: ts.SourceFile,
    specifier: string,
    packageName: string | undefined,
    resolvedFile: string | undefined,
    reExport: boolean,
  ): void {
    const moduleSymbol = this.moduleSymbolForImport(sourceFile, specifier);
    if (moduleSymbol !== undefined) this.processModuleSymbolExports(moduleSymbol, packageName, undefined, sourceFile, reExport);
    else if (resolvedFile === undefined) this.addUnknown("module_exports_unresolved", `Unable to resolve exports for ${specifier}`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
  }

  private processModuleSymbolExports(
    moduleSymbol: ts.Symbol,
    packageName: string | undefined,
    aliasRecord: SymbolRecord | undefined,
    sourceFile: ts.SourceFile,
    reExport: boolean,
  ): void {
    let exports: ts.Symbol[];
    try {
      exports = this.context.checker.getExportsOfModule(moduleSymbol);
    } catch {
      this.addUnknown("module_exports_ambiguous", "TypeChecker could not enumerate module exports", aliasRecord === undefined ? undefined : [aliasRecord.id]);
      return;
    }
    const fileId = this.fileIdForPath(normalizePath(sourceFile.fileName));
    for (const exportedSymbol of exports.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = this.resolveAliasedSymbol(exportedSymbol);
      const records = this.recordsForSymbol(target);
      if (records.length > 0) {
        for (const record of records) {
          if (aliasRecord !== undefined) this.addRelation("imports", aliasRecord.id, record.id, { reExport, namespace: true });
          this.addRelation("imports", fileId, record.id, { reExport, namespace: true });
        }
      } else {
        for (const api of this.externalApiRecordsForSymbol(target, packageName, undefined)) {
          api.imported = true;
          if (aliasRecord !== undefined) this.addRelation("imports_api", aliasRecord.id, api.id, { reExport, usage: "imported" });
          this.addRelation("imports_api", fileId, api.id, { reExport, usage: "imported" });
        }
      }
    }
  }

  private registerModuleImport(
    specifier: string,
    resolvedFile: string | undefined,
    packageName: string | undefined,
    from: ReturnType<typeof createProjectId>,
    sourceFile: ts.SourceFile,
    reExport: boolean,
  ): void {
    const key = `${sourceFile.fileName}|${specifier}|${reExport ? "reexport" : "import"}`;
    if (this.importedModuleKeys.has(key)) return;
    this.importedModuleKeys.add(key);
    if (packageName !== undefined) {
      const dependency = this.ensureDependency(packageName, resolvedFile);
      dependency.imported = true;
      this.addRelation("imports", from, this.externalPackageId(packageName), { module: specifier, reExport, usage: "imported" });
      if (resolvedFile === undefined) this.addUnknown("module_unresolved", `Module ${specifier} could not be resolved`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    if (resolvedFile !== undefined) {
      const targetPath = normalizePath(resolvedFile);
      const targetFileId = this.fileIds.get(targetPath);
      if (targetFileId !== undefined) this.addRelation("imports", from, targetFileId, { module: specifier, reExport, usage: "imported" });
      else if (!isTypeScriptLibraryFile(targetPath)) this.addUnknown("module_outside_project", `Resolved module ${specifier} is outside the project file set`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
    } else {
      this.addUnknown("module_unresolved", `Module ${specifier} could not be resolved`, undefined, relativePath(this.context.rootDir, sourceFile.fileName));
    }
  }

  private processHeritageRelations(): void {
    for (const sourceFile of this.context.sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
          const owner = this.declarationRecords.get(node);
          if (owner !== undefined) {
            for (const clause of node.heritageClauses ?? []) {
              const relationKind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
              for (const heritageType of clause.types) {
                const symbol = this.context.checker.getSymbolAtLocation(heritageType.expression);
                if (symbol === undefined) {
                  this.addUnknown("heritage_target_unresolved", `Unable to resolve ${relationKind} target`, [owner.id], relativePath(this.context.rootDir, sourceFile.fileName));
                  continue;
                }
                const target = this.resolveAliasedSymbol(symbol);
                const targets = this.recordsForSymbol(target);
                if (targets.length === 0) {
                  if (!isTypeScriptLibraryFile(target.declarations?.[0]?.getSourceFile().fileName ?? "")) {
                    this.addUnknown("heritage_target_external", `${relationKind} target is outside the project fact set`, [owner.id], relativePath(this.context.rootDir, sourceFile.fileName));
                  }
                  continue;
                }
                for (const targetRecord of targets) this.addRelation(relationKind, owner.id, targetRecord.id);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private processReferencesAndCalls(): void {
    for (const sourceFile of this.context.sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) this.processDynamicImport(sourceFile, node);
          else this.processCall(node, sourceFile);
        } else if (ts.isNewExpression(node)) {
          this.processCall(node, sourceFile);
        }
        if (ts.isIdentifier(node) && !this.declarationNameNodes.has(node) && !this.isImportExportSyntax(node)) {
          this.processReference(node, sourceFile);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private processDynamicImport(sourceFile: ts.SourceFile, node: ts.CallExpression): void {
    const argument = node.arguments[0];
    if (argument === undefined || !isStaticImportArgument(argument)) {
      this.addUnknown("dynamic_import_unresolved", "Dynamic import target is not a static module specifier", undefined, relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    const specifier = argument.text;
    const resolvedFile = this.resolveModule(specifier, sourceFile);
    const packageName = packageNameFromSpecifier(specifier);
    const owner = this.ownerForNode(node, sourceFile);
    this.registerModuleImport(specifier, resolvedFile, packageName, owner, sourceFile, false);
  }

  private processCall(node: ts.CallExpression | ts.NewExpression, sourceFile: ts.SourceFile): void {
    const owner = this.ownerForNode(node, sourceFile);
    const expression = node.expression;
    let expressionType: ts.Type | undefined;
    try {
      expressionType = this.context.checker.getTypeAtLocation(expression);
    } catch {
      expressionType = undefined;
    }
    if (expressionType !== undefined && isAnyType(expressionType)) {
      this.addUnknown("any_mediated_target", "Any-typed call target prevents deterministic resolution", this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    const signature = this.context.checker.getResolvedSignature(node);
    const declaration = signature?.declaration;
    if (declaration !== undefined) {
      const record = this.declarationRecords.get(declaration);
      if (record !== undefined) {
        this.addRelation("calls", owner, record.id);
        this.addRelation("references", owner, record.id);
        return;
      }
      const targetSymbol = this.context.checker.getSymbolAtLocation(expression);
      if (targetSymbol !== undefined) {
        const target = this.resolveAliasedSymbol(targetSymbol);
        const candidates = this.recordsForSymbol(target);
        if (candidates.length === 1) {
          this.addRelation("calls", owner, candidates[0]!.id);
          this.addRelation("references", owner, candidates[0]!.id);
          return;
        }
        if (candidates.length > 1) {
          this.addUnknown("ambiguous_call_target", "Call signature has multiple project declarations", this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
          return;
        }
        const identity = this.externalIdentityForSymbol(target);
        const apiRecords = this.externalApiRecordsForSymbol(target, identity.packageName, identity.specifier);
        if (apiRecords.length > 0) {
          for (const api of apiRecords) this.recordExternalUse(owner, api);
          return;
        }
        if (this.isLibrarySymbol(target)) return;
      }
    }
    const rawSymbol = this.context.checker.getSymbolAtLocation(expression);
    if (rawSymbol !== undefined) {
      const target = this.resolveAliasedSymbol(rawSymbol);
      const candidates = this.recordsForSymbol(target);
      if (candidates.length === 1) {
        this.addRelation("calls", owner, candidates[0]!.id);
        this.addRelation("references", owner, candidates[0]!.id);
        return;
      }
      if (candidates.length > 1) {
        this.addUnknown("ambiguous_call_target", "Call target has multiple project declarations", this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
        return;
      }
      const identity = this.externalIdentityForSymbol(target);
      const apiRecords = this.externalApiRecordsForSymbol(target, identity.packageName, identity.specifier);
      if (apiRecords.length > 0) {
        for (const api of apiRecords) this.recordExternalUse(owner, api);
        return;
      }
      if (this.isLibrarySymbol(target)) return;
    }
    if (ts.isElementAccessExpression(expression) && !isStaticImportArgument(expression.argumentExpression ?? ts.factory.createStringLiteral(""))) {
      this.addUnknown("dynamic_call_target", "Computed property call target is not statically resolvable", this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
    } else {
      this.addUnknown("unresolved_direct_call", "TypeChecker did not resolve a unique direct call target", this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
    }
  }

  private processReference(node: ts.Identifier, sourceFile: ts.SourceFile): void {
    if (
      (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) &&
      node.parent.expression === node
    ) {
      return;
    }
    const rawSymbol = this.context.checker.getSymbolAtLocation(node);
    if (rawSymbol === undefined) return;
    const target = this.resolveAliasedSymbol(rawSymbol);
    const records = this.recordsForSymbol(target);
    const owner = this.ownerForNode(node, sourceFile);
    if (records.length === 1) {
      this.addRelation("references", owner, records[0]!.id);
      return;
    }
    if (records.length > 1) {
      this.addUnknown("ambiguous_reference_target", `Reference ${node.getText()} has multiple project declarations`, this.symbolIdSubject(owner), relativePath(this.context.rootDir, sourceFile.fileName));
      return;
    }
    const identity = this.externalIdentityForSymbol(target);
    const apiRecords = this.externalApiRecordsForSymbol(target, identity.packageName, identity.specifier);
    if (apiRecords.length > 0) {
      for (const api of apiRecords) this.recordExternalUse(owner, api);
    }
  }

  private isImportExportSyntax(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isNamespaceExport(parent)
    );
  }

  private addPackageEntitiesAndFacts(): void {
    for (const dependencyName of this.context.packageManifest.dependencies.keys()) this.ensureDependency(dependencyName, undefined);
    for (const dependency of this.externalDependencies.values()) {
      const id = this.externalDependencyId(dependency.name);
      const packageId = this.externalPackageId(dependency.name);
      const declared = this.context.packageManifest.dependencies.get(dependency.name);
      const packageEntity: PackageEntity = {
        id: packageId,
        name: dependency.name,
        authority: "derived",
        provenance: this.provenance(),
        kind: "package",
        packageName: dependency.name,
        dependencyType: "external",
        ...(dependency.version === undefined ? {} : { version: dependency.version }),
      };
      this.packageEntities.push(packageEntity);
      const entity: ExternalDependencyEntity = {
        id,
        name: dependency.name,
        authority: "derived",
        provenance: this.provenance(),
        kind: "external_dependency",
        packageName: dependency.name,
        ...(dependency.version === undefined ? {} : { version: dependency.version }),
        metadata: {
          declared: dependency.declared,
          resolved: dependency.resolved,
          imported: dependency.imported,
          used: dependency.used,
          ...(declared?.dependencyType === undefined ? {} : { declarationType: declared.dependencyType }),
        },
      };
      this.externalDependencyEntities.push(entity);
      this.addFact(packageId, "package.declared", dependency.declared);
      this.addFact(packageId, "package.resolved", dependency.resolved);
      this.addFact(packageId, "package.imported", dependency.imported);
      this.addFact(packageId, "package.used", dependency.used);
      this.addFact(packageId, "package.external_api_count", dependency.usedApiIds.size);
      if (dependency.version !== undefined) this.addFact(packageId, "package.version", dependency.version);
      this.addFact(id, "package.declared", dependency.declared);
      this.addFact(id, "package.resolved", dependency.resolved);
      this.addFact(id, "package.imported", dependency.imported);
      this.addFact(id, "package.used", dependency.used);
      this.addFact(id, "package.external_api_count", dependency.usedApiIds.size);
      if (dependency.version !== undefined) this.addFact(id, "package.version", dependency.version);
      this.addRelation("depends_on", this.projectPackageId, packageId, {
        declared: dependency.declared,
        resolved: dependency.resolved,
        used: dependency.used,
      });
    }
    const rootPackage: PackageEntity = {
      id: this.projectPackageId,
      name: this.context.rootPackageName,
      authority: "derived",
      provenance: this.provenance(),
      kind: "package",
      packageName: this.context.rootPackageName,
      dependencyType: "internal",
      ...(this.context.packageManifest.version === undefined ? {} : { version: this.context.packageManifest.version }),
    };
    this.packageEntities.push(rootPackage);
    this.addFact(this.projectPackageId, "package.declared", true);
    this.addFact(this.projectPackageId, "package.resolved", true);
    this.addFact(this.projectPackageId, "package.imported", false);
    this.addFact(this.projectPackageId, "package.used", false);
    const lockfiles = this.context.inputPaths
      .filter((filePath) => CONFIG_FILES.has(basename(filePath)) && basename(filePath) !== "package.json")
      .map((filePath) => relativePath(this.context.rootDir, filePath));
    if (lockfiles.length > 0) this.addFact(this.projectPackageId, "package.lockfiles", lockfiles);
  }

  private addMetricsFacts(): void {
    for (const file of this.files) {
      const metrics = this.fileMetrics.get(file.id);
      if (metrics !== undefined) this.addFact(file.id, "file.metrics", metrics);
    }
    for (const record of this.records) {
      const metrics = this.symbolMetrics.get(record.id);
      if (metrics !== undefined) this.addFact(record.id, "symbol.metrics", metrics);
    }
    for (const api of this.externalApis.values()) {
      this.addFact(api.id, "external_api.imported", api.imported);
      this.addFact(api.id, "external_api.used", api.used);
    }
  }

  private buildSnapshot(): RepositorySemanticSnapshot {
    const complete = this.unknowns.length === 0 && !this.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    const completeness = complete ? "complete" : "partial";
    this.finalizeProvenance(completeness);
      const declarations: RepositorySemanticSnapshot["declarations"] = {
      project: {
        id: this.projectId,
        name: this.context.repositoryName,
        authority: "declared",
        provenance: { ...this.provenance(), kind: "declared", completeness },
        kind: "project",
        canonicalName: this.context.repositoryName,
        responsibility: "No architectural responsibility inferred; TypeScript implementation facts container",
        stability: "experimental",
        reviewLevel: "L1",
      },
      components: [],
      capabilities: [],
      contracts: [],
      invariants: [],
      decisions: [],
      rationales: [],
      constraints: [],
      facts: [],
      effectPolicies: [],
      dependencyPolicies: [],
      reviewGuidance: [],
      stability: [],
      terminology: [],
      decisionLinks: [],
      commentPolicy: {
        canonicalLanguage: "en",
        canonicalForm: "formal-english",
        humanLocalization: "projection",
        llmTokenCompression: "projection",
        sourceCodeSemantics: "implementation-only",
        semanticCommentKinds: [],
        inlineDirectives: [],
        jsdoc: "projection",
      },
    };
    const observed: RepositorySemanticSnapshot["observed"] = { evidences: [], tests: [], facts: [] };
    const analysis: RepositorySemanticSnapshot["analysis"] = {
      health: {
        status: complete ? "healthy" : "partial",
        score: Math.max(0, 100 - this.unknowns.length * 5 - this.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length * 20),
        staleEvidence: 0,
        modelGaps: this.unknowns.length,
      },
      reviewLevel: complete ? "L1" : "L2",
      semanticDelta: { version: 1, intent: "semantic-neutral", entries: [], unauthorized: false },
      facts: [],
      claims: [],
      unknowns: this.unknowns,
      recommendedSourceReads: [],
      diagnostics: this.diagnostics,
    };
    const trackedFiles = this.trackedFileFingerprints();
    const snapshot: RepositorySemanticSnapshot = {
      schemaVersion: 2,
      modelVersion: "symbol-first-v1",
      repositoryIdentity: {
        id: this.repositoryId,
        canonicalName: this.context.repositoryName,
        ...(this.context.remote === undefined ? {} : { remote: this.context.remote }),
      },
      revisionIdentity: {
        id: this.revisionId,
        revision: this.context.revision,
        ...(this.context.tree === undefined ? {} : { tree: this.context.tree }),
        kind: this.context.gitRevision === undefined ? "workspace" : "git",
      },
      declarations,
      derived: {
        files: this.files,
        symbols: this.records.map((record) => record.entity),
        packages: this.packageEntities,
        externalDependencies: this.externalDependencyEntities,
        externalApis: [...this.externalApis.values()].map((api) => api.entity),
        facts: [...this.facts.values()],
      },
      observed,
      analysis,
      integrity: {
        repositoryId: this.repositoryId,
        ...(this.context.gitRevision === undefined ? {} : { git: { revision: this.context.gitRevision, tree: this.context.tree } }),
        worktree: {
          id: createWorktreeId(stableLocalId(this.context.repositoryName)),
          ...(this.context.gitDirty === undefined ? {} : { dirty: this.context.gitDirty }),
        },
        trackedFiles,
        extractors: [
          {
            id: TYPESCRIPT_FACT_PROVIDER_ID,
            version: TYPESCRIPT_FACT_PROVIDER_VERSION,
            optionsFingerprint: this.optionsFingerprint(),
          },
        ],
        schemaVersion: 2,
        semanticStateDigest: digestCanonicalValue("pending-semantic-state"),
        modelDigest: digestCanonicalValue("pending-model"),
        snapshotDigest: digestCanonicalValue("pending-snapshot"),
        status: "fresh",
      },
      graph: { relations: [...this.relations.values()] },
    };
    const digests = computeIntegrityDigestsFromValidated(snapshot);
    const completeSnapshot: RepositorySemanticSnapshot = {
      ...snapshot,
      integrity: { ...snapshot.integrity, ...digests },
    };
    return completeSnapshot;
  }

  private readonly packageEntities: PackageEntity[] = [];
  private readonly externalDependencyEntities: ExternalDependencyEntity[] = [];

  private trackedFileFingerprints(): TrackedFileFingerprint[] {
    const fileIds = new Set(this.files.map((file) => file.id));
    const symbolsByFile = new Map<string, string[]>();
    for (const record of this.records) {
      const symbols = symbolsByFile.get(record.fileId) ?? [];
      symbols.push(record.id);
      symbolsByFile.set(record.fileId, symbols);
    }
    const factsByFile = new Map<string, SemanticFact[]>();
    for (const fact of this.facts.values()) {
      if (fact.predicate === "file.content_fingerprint") continue;
      const fileId = this.symbolFileIds.get(fact.subject) ?? (fileIds.has(fact.subject) ? fact.subject : undefined);
      if (fileId === undefined) continue;
      const facts = factsByFile.get(fileId) ?? [];
      facts.push(fact);
      factsByFile.set(fileId, facts);
    }
    const relationsByFile = new Map<string, SemanticRelation[]>();
    for (const relation of this.relations.values()) {
      const fileId = this.symbolFileIds.get(relation.from) ?? (fileIds.has(relation.from) ? relation.from : undefined);
      if (fileId === undefined) continue;
      const relations = relationsByFile.get(fileId) ?? [];
      relations.push(relation);
      relationsByFile.set(fileId, relations);
    }
    const extractorFingerprint = this.optionsFingerprint();
    return this.files.map((file) => {
      const bytes = this.readBytes(join(this.context.rootDir, file.path));
      const physicalFingerprint = bytes ?? digestCanonicalValue("unavailable");
      const semanticFingerprint = digestCanonicalValue({
        symbols: symbolsByFile.get(file.id) ?? [],
        facts: factsByFile.get(file.id) ?? [],
        relations: relationsByFile.get(file.id) ?? [],
      });
      return {
        path: file.path,
        physicalFingerprint,
        semanticFingerprint,
        extractorFingerprint,
      };
    });
  }

  private optionsFingerprint(): ContentDigest {
    const options = this.context.compilerOptions;
    return digestCanonicalValue({
      provider: TYPESCRIPT_FACT_PROVIDER_ID,
      version: TYPESCRIPT_FACT_PROVIDER_VERSION,
      tsconfig: this.context.configPath === undefined ? undefined : relativePath(this.context.rootDir, this.context.configPath),
      rootNames: this.context.sourceFiles.map((sourceFile) => relativePath(this.context.rootDir, sourceFile.fileName)).sort(),
      compilerOptions: {
        target: options.target,
        module: options.module,
        moduleResolution: options.moduleResolution,
        jsx: options.jsx,
        strict: options.strict,
        allowJs: options.allowJs,
        baseUrl: options.baseUrl === undefined ? undefined : relativePath(this.context.rootDir, options.baseUrl),
        paths: options.paths,
      },
      requestedRootNames: this.options.rootNames?.map((filePath) => relativePath(this.context.rootDir, resolve(this.context.rootDir, filePath))).sort(),
    });
  }

  private readBytes(filePath: string): ContentDigest | undefined {
    try {
      return sha256Bytes(readFileSync(filePath));
    } catch {
      this.addDiagnostic("file_unreadable", "warning", "Unable to fingerprint file contents", relativePath(this.context.rootDir, filePath));
      return undefined;
    }
  }

  private isGitTracked(filePath: string): boolean {
    if (gitOutput(this.context.rootDir, ["rev-parse", "--is-inside-work-tree"]) === undefined) return true;
    return gitOutput(this.context.rootDir, ["ls-files", "--error-unmatch", "--", filePath]) !== undefined;
  }

  private fileIdForPath(filePath: string): ReturnType<typeof createProjectId> {
    const normalized = normalizePath(filePath);
    const existing = this.fileIds.get(normalized);
    if (existing !== undefined) return existing;
    const relativeFile = relativePath(this.context.rootDir, normalized);
    const id = createNodeId("file", `sha256-${sha256Text(relativeFile).slice(0, 32)}`);
    this.fileIds.set(normalized, id);
    return id;
  }

  private resolveModule(specifier: string, sourceFile: ts.SourceFile): string | undefined {
    try {
      return ts.resolveModuleName(specifier, sourceFile.fileName, this.context.compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    } catch {
      return undefined;
    }
  }

  private moduleSymbolForImport(sourceFile: ts.SourceFile, specifier: string): ts.Symbol | undefined {
    const resolved = this.resolveModule(specifier, sourceFile);
    if (resolved === undefined) return undefined;
    const imported = this.context.program.getSourceFile(resolved);
    return imported === undefined ? undefined : this.context.checker.getSymbolAtLocation(imported);
  }

  private moduleSourceFileForSymbol(symbol: ts.Symbol): ts.SourceFile | undefined {
    return symbol.declarations?.find((declaration) => ts.isSourceFile(declaration))?.getSourceFile();
  }

  private resolveAliasedSymbol(symbol: ts.Symbol): ts.Symbol {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      return this.context.checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  private recordsForSymbol(symbol: ts.Symbol): SymbolRecord[] {
    const direct = this.symbolRecords.get(symbol) ?? [];
    if (direct.length > 0) return [...direct].sort((left, right) => left.id.localeCompare(right.id));
    const records: SymbolRecord[] = [];
    for (const declaration of symbol.declarations ?? []) {
      const record = this.declarationRecords.get(declaration);
      if (record !== undefined && !records.some((item) => item.id === record.id)) records.push(record);
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  private packageForSymbol(symbol: ts.Symbol): string | undefined {
    return this.externalIdentityForSymbol(symbol).packageName;
  }

  private externalIdentityForSymbol(symbol: ts.Symbol): { packageName: string | undefined; specifier: string | undefined } {
    const known = this.externalSymbolPackages.get(symbol) ?? this.externalSymbolPackages.get(this.resolveAliasedSymbol(symbol));
    if (known !== undefined) return known;
    const declarationFile = (symbol.declarations?.[0] ?? symbol.valueDeclaration)?.getSourceFile().fileName;
    if (declarationFile === undefined) return { packageName: undefined, specifier: undefined };
    if (isTypeScriptLibraryFile(declarationFile)) return { packageName: undefined, specifier: undefined };
    const normalizedDeclarationFile = normalizePath(declarationFile);
    if (this.context.projectPaths.has(normalizedDeclarationFile)) return { packageName: undefined, specifier: undefined };
    const manifest = this.findNearestManifest(declarationFile);
    if (manifest?.name === this.context.rootPackageName && pathInside(this.context.rootDir, normalizedDeclarationFile)) {
      return { packageName: undefined, specifier: undefined };
    }
    return { packageName: manifest?.name, specifier: undefined };
  }

  private findNearestManifest(filePath: string): PackageManifest | undefined {
    let directory = dirname(filePath);
    while (true) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) return readManifest(manifestPath);
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  private ensureDependency(name: string, resolvedFile: string | undefined): PackageUsage {
    const existing = this.externalDependencies.get(name);
    const declared = this.context.packageManifest.dependencies.get(name);
    const manifest = resolvedFile === undefined ? undefined : this.findNearestManifest(resolvedFile);
    if (existing !== undefined) {
      existing.resolved ||= resolvedFile !== undefined;
      if (existing.version === undefined) existing.version = declared?.version ?? manifest?.version;
      if (existing.resolvedFile === undefined) existing.resolvedFile = resolvedFile;
      return existing;
    }
    const value: PackageUsage = {
      name,
      version: declared?.version ?? manifest?.version,
      declared: declared !== undefined,
      declarationType: declared?.dependencyType,
      resolved: resolvedFile !== undefined,
      imported: false,
      used: false,
      resolvedFile,
      importedApiIds: new Set(),
      usedApiIds: new Set(),
    };
    this.externalDependencies.set(name, value);
    return value;
  }

  private externalDependencyId(name: string): ReturnType<typeof createExternalDependencyId> {
    return createExternalDependencyId(stableLocalId(name));
  }

  private externalPackageId(name: string): ReturnType<typeof createPackageId> {
    return createPackageId(stableLocalId(name));
  }

  private isLibrarySymbol(symbol: ts.Symbol): boolean {
    const declarationFile = (symbol.declarations?.[0] ?? symbol.valueDeclaration)?.getSourceFile().fileName;
    return declarationFile === undefined || isTypeScriptLibraryFile(declarationFile);
  }

  private externalApiRecordsForSymbol(symbol: ts.Symbol, packageHint: string | undefined, specifier: string | undefined): ExternalApiRecord[] {
    const packageName = packageHint ?? this.packageForSymbol(symbol);
    if (packageName === undefined) {
      const declarationPath = (symbol.declarations?.[0] ?? symbol.valueDeclaration)?.getSourceFile().fileName;
      if (declarationPath !== undefined && this.context.projectPaths.has(normalizePath(declarationPath))) return [];
      if (declarationPath !== undefined && !isTypeScriptLibraryFile(declarationPath)) {
        this.addUnknown("opaque_external_symbol", `External symbol ${symbol.name} has no resolvable package identity`);
      }
      return [];
    }
    const dependency = this.ensureDependency(packageName, symbol.declarations?.[0]?.getSourceFile().fileName);
    const declarations = symbol.declarations ?? [];
    const candidates = declarations.length > 0 ? declarations : [symbol.valueDeclaration].filter((value): value is ts.Declaration => value !== undefined);
    const records: ExternalApiRecord[] = [];
    if (candidates.length === 0) {
      const api = this.createExternalApi(symbol, packageName, specifier, undefined);
      if (api !== undefined) records.push(api);
      return records;
    }
    for (const declaration of candidates) {
      const api = this.createExternalApi(symbol, packageName, specifier, declaration);
      if (api !== undefined && !records.some((item) => item.id === api.id)) records.push(api);
    }
    return records;
  }

  private createExternalApi(
    symbol: ts.Symbol,
    packageName: string,
    specifier: string | undefined,
    declaration: ts.Declaration | undefined,
  ): ExternalApiRecord | undefined {
    const apiName = `${specifier ?? packageName}.${symbol.name}`;
    const declarationType = declaration === undefined ? "symbol" : declarationKind(declaration);
    const signature = declaration === undefined ? undefined : signatureText(this.context.checker, declaration);
    const key = `${packageName}|${apiName}|${signature ?? ""}|${declarationType}`;
    const existing = this.externalApis.get(key);
    if (existing !== undefined) return existing;
    const dependency = this.ensureDependency(packageName, declaration?.getSourceFile().fileName);
    const id = createExternalApiId(`${stableLocalId(packageName)}-${sha256Text(key).slice(0, 32)}`);
    const entity: ExternalApiEntity = {
      id,
      name: apiName,
      authority: "derived",
      provenance: this.provenance(),
      kind: "external_api",
      packageId: this.externalPackageId(packageName),
      apiName,
      ...(dependency.version === undefined ? {} : { version: dependency.version }),
      metadata: {
        ...(specifier === undefined ? {} : { module: specifier }),
        declarationKind: declarationType,
        ...(signature === undefined ? {} : { signature }),
      },
    };
    const record: ExternalApiRecord = { id, entity, packageName, imported: false, used: false };
    this.externalApis.set(key, record);
    return record;
  }

  private recordExternalUse(owner: ReturnType<typeof createProjectId>, api: ExternalApiRecord): void {
    api.used = true;
    const dependency = this.ensureDependency(api.packageName, undefined);
    dependency.used = true;
    dependency.usedApiIds.add(api.id);
    this.addRelation("imports_api", owner, api.id, { usage: "used" });
    this.addRelation("uses_package", owner, this.externalPackageId(api.packageName), { usage: "used" });
  }

  private ownerForNode(node: ts.Node, sourceFile: ts.SourceFile): ReturnType<typeof createProjectId> {
    let current: ts.Node | undefined = node;
    let fallback: ReturnType<typeof createProjectId> | undefined;
    while (current !== undefined) {
      const record = this.declarationRecords.get(current);
      if (record !== undefined) {
        fallback ??= record.id;
        if (isFunctionLikeDeclaration(record.declaration)) return record.id;
      }
      current = current.parent;
    }
    return fallback ?? this.fileIdForPath(normalizePath(sourceFile.fileName));
  }

  private symbolIdSubject(id: ReturnType<typeof createProjectId>): ReturnType<typeof createProjectId>[] | undefined {
    return this.symbolFileIds.has(id) ? [id] : undefined;
  }

  private addFact(subject: ReturnType<typeof createProjectId>, predicate: string, value: unknown): void {
    const digest = digestCanonicalValue(value).value;
    const id = createFactId(`${sha256Text(`${subject}|${predicate}|${digest}`).slice(0, 48)}`);
    const fact: SemanticFact = {
      id,
      subject,
      predicate,
      value: value as SemanticFact["value"],
      authority: "derived",
      provenance: this.provenance(),
    };
    this.facts.set(id, fact);
  }

  private addRelation(
    kind: string,
    from: ReturnType<typeof createProjectId>,
    to: ReturnType<typeof createProjectId>,
    metadata?: Record<string, unknown>,
  ): void {
    const relationKey = digestCanonicalValue({ kind, from, to, metadata }).value;
    const id = createEdgeId(`typescript-${relationKey.slice(0, 48)}`);
    const relation: SemanticRelation = {
      id,
      kind,
      from,
      to,
      authority: "derived",
      provenance: this.provenance(),
      ...(metadata === undefined ? {} : { metadata: metadata as SemanticRelation["metadata"] }),
    };
    this.relations.set(id, relation);
    if (kind === "references" || kind === "calls") {
      const symbolMetric = this.symbolMetrics.get(from);
      if (symbolMetric !== undefined) {
        if (kind === "references") symbolMetric.references += 1;
        else symbolMetric.calls += 1;
      }
      const fileId = this.symbolFileIds.get(from) ?? from;
      const fileMetric = this.fileMetrics.get(fileId);
      if (fileMetric !== undefined) {
        if (kind === "references") fileMetric.references += 1;
        else fileMetric.calls += 1;
      }
    }
  }

  private addUnknown(code: string, message: string, subjects?: ReturnType<typeof createProjectId>[], path?: string): void {
    const key = `${code}|${message}|${subjects?.join(",") ?? ""}|${path ?? ""}`;
    if (this.unknownKeys.has(key)) return;
    this.unknownKeys.add(key);
    const unknown: AnalysisUnknown = { code, message, ...(subjects === undefined ? {} : { subjects }) };
    this.unknowns.push(unknown);
    this.addDiagnostic(code, "warning", message, path, subjects?.[0]);
  }

  private addDiagnostic(
    code: string,
    severity: SemanticDiagnostic["severity"],
    message: string,
    path?: string,
    subject?: ReturnType<typeof createProjectId>,
    details?: SemanticDiagnostic["details"],
  ): void {
    const key = `${code}|${severity}|${message}|${path ?? ""}|${subject ?? ""}`;
    if (this.diagnosticKeys.has(key)) return;
    this.diagnosticKeys.add(key);
    this.diagnostics.push({
      code,
      severity,
      message,
      ...(path === undefined ? {} : { path }),
      ...(subject === undefined ? {} : { subject }),
      ...(details === undefined ? {} : { details }),
    });
  }

  private provenance(): Provenance {
    return { ...this.provenanceBase };
  }

  private finalizeProvenance(completeness: "complete" | "partial"): void {
    const finalize = (provenance: Provenance): Provenance => ({ ...provenance, completeness });
    for (const file of this.files) file.provenance = finalize(file.provenance);
    for (const record of this.records) record.entity.provenance = finalize(record.entity.provenance);
    for (const fact of this.facts.values()) fact.provenance = finalize(fact.provenance);
    for (const relation of this.relations.values()) relation.provenance = finalize(relation.provenance);
    for (const entity of this.packageEntities) entity.provenance = finalize(entity.provenance);
    for (const entity of this.externalDependencyEntities) entity.provenance = finalize(entity.provenance);
    for (const api of this.externalApis.values()) api.entity.provenance = finalize(api.entity.provenance);
  }
}

export const typeScriptFactProvider: TypeScriptFactProvider = {
  extract: extractTypeScriptFacts,
};
