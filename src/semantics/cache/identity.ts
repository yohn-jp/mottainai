import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { canonicalizeSnapshot, computeIntegrityDigestsFromValidated, digestCanonicalValue } from "../ir/canonical.js";
import { createRepositoryId, createRevisionId, createWorktreeId } from "../ir/ids.js";
import { validateSnapshot } from "../ir/schema.js";
import {
  CURRENT_SCHEMA_VERSION,
  MODEL_VERSION,
  type ContentDigest,
  type ExtractorFingerprint,
  type GitIdentity,
  type RepositorySemanticSnapshot,
  type RepositoryIdentity,
  type RevisionIdentity,
  type TrackedFileFingerprint,
  type WorktreeIdentity,
} from "../ir/types.js";
import {
  TYPESCRIPT_FACT_PROVIDER_ID,
  TYPESCRIPT_FACT_PROVIDER_VERSION,
  type TypeScriptExtractorOptions,
} from "../extractors/types.js";
import {
  DERIVED_FACT_CACHE_FORMAT_VERSION,
  type FactCacheKey,
  type SnapshotManifest,
} from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const LOCKFILE_NAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json"]);
const IGNORED_DIRECTORIES = new Set([".git", ".mottainai", ".codegraph", ".worktrees", "coverage", "dist"]);
const SHARED_WORKTREE_ID = createWorktreeId("cache-shared-derived-facts");

interface InputFile {
  path: string;
  category: "source" | "module-resolution" | "package-graph";
  digest: ContentDigest;
}

interface GitState {
  revision?: string;
  tree?: string;
  commonDir?: string;
  branch?: string;
  dirty?: boolean;
  remote?: string;
}

export interface TypeScriptFactCacheIdentity {
  cacheable: boolean;
  key: FactCacheKey;
  repository: RepositoryIdentity;
  repositoryFingerprint: ContentDigest;
  revision?: RevisionIdentity;
  revisionFingerprint: ContentDigest;
  git?: GitIdentity;
  worktree: WorktreeIdentity;
  extractor: ExtractorFingerprint;
  extractorFingerprint: ContentDigest;
  sourceFingerprint: ContentDigest;
  moduleResolutionFingerprint: ContentDigest;
  packageGraphFingerprint: ContentDigest;
  trackedFiles: TrackedFileFingerprint[];
}

function sha256Bytes(bytes: Buffer): ContentDigest {
  return { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
}

function stableLocalId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._~+/@#:%-]*$/.test(value) && !/\s/u.test(value)
    ? value
    : `sha256-${digestCanonicalValue(value).value.slice(0, 32)}`;
}

function git(rootDir: string, args: string[]): string | undefined {
  try {
    const result = execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return result.length === 0 ? undefined : result;
  } catch {
    return undefined;
  }
}

function gitDirty(rootDir: string): boolean | undefined {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch {
    return undefined;
  }
}

function remoteRepositoryName(remote: string | undefined): string | undefined {
  if (remote === undefined) return undefined;
  const normalized = remote.replace(/\.git$/u, "").replace(/^git@github\.com:/u, "https://github.com/");
  return normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/u)?.[1];
}

function readJsonName(filePath: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function relativePath(rootDir: string, filePath: string): string {
  const value = relative(rootDir, filePath).split("\\").join("/");
  return value.length === 0 ? basename(filePath) : value;
}

function isTsConfigName(name: string): boolean {
  return /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(name);
}

function isModuleResolutionFile(name: string): boolean {
  return name === "package.json" || LOCKFILE_NAMES.has(name) || isTsConfigName(name);
}

function addInputFile(rootDir: string, filePath: string, category: InputFile["category"], output: Map<string, InputFile>): boolean {
  try {
    lstatSync(filePath);
  } catch (error) {
    // A package manifest that does not exist is not an unreadable input; it is
    // a normal package-layout case. Any other failure must fail closed.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const normalized = realpathSync(filePath);
    const path = relativePath(rootDir, normalized);
    const existing = output.get(path);
    const input: InputFile = { path, category, digest: sha256Bytes(readFileSync(normalized)) };
    if (existing === undefined || existing.category !== "package-graph") output.set(path, input);
    return true;
  } catch {
    // An unreadable input is represented by cacheable=false below; it must not
    // accidentally turn a failed read into a reusable cache hit.
    return false;
  }
}

function collectPackageManifests(directory: string, rootDir: string, output: Map<string, InputFile>): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return false;
  }
  let readable = true;
  for (const entry of entries) {
    if (entry.name === ".bin") continue;
    const filePath = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      let scopedEntries;
      try {
        scopedEntries = readdirSync(filePath, { withFileTypes: true });
      } catch {
        readable = false;
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          readable = addInputFile(rootDir, join(filePath, scopedEntry.name, "package.json"), "package-graph", output) && readable;
        }
      }
      continue;
    }
    readable = addInputFile(rootDir, join(filePath, "package.json"), "package-graph", output) && readable;
  }
  return readable;
}

function collectInputFiles(rootDir: string): { files: InputFile[]; cacheable: boolean } {
  const output = new Map<string, InputFile>();
  let cacheable = true;
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      cacheable = false;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === "node_modules") {
        cacheable = collectPackageManifests(join(directory, entry.name), rootDir, output) && cacheable;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        visit(join(directory, entry.name));
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(extension)) {
        cacheable = addInputFile(rootDir, join(directory, entry.name), "source", output) && cacheable;
      } else if (isModuleResolutionFile(entry.name)) {
        cacheable = addInputFile(rootDir, join(directory, entry.name), "module-resolution", output) && cacheable;
      }
    }
  };
  visit(rootDir);
  return { files: [...output.values()].sort((left, right) => left.path.localeCompare(right.path)), cacheable };
}

function inputDigest(files: readonly InputFile[], category: InputFile["category"]): ContentDigest {
  return digestCanonicalValue(files.filter((file) => file.category === category).map((file) => [file.path, file.digest]));
}

function normalizedRootNames(rootDir: string, rootNames: readonly string[] | undefined): string[] | undefined {
  return rootNames?.map((filePath) => {
    const absolute = resolve(rootDir, filePath);
    return relativePath(rootDir, absolute);
  }).sort();
}

function currentGitState(rootDir: string): GitState {
  const revision = git(rootDir, ["rev-parse", "HEAD"]);
  const tree = git(rootDir, ["rev-parse", "HEAD^{tree}"]);
  const commonDirRaw = git(rootDir, ["rev-parse", "--git-common-dir"]);
  const commonDir = commonDirRaw === undefined ? undefined : resolve(rootDir, commonDirRaw);
  const branch = git(rootDir, ["symbolic-ref", "--short", "HEAD"]);
  return {
    revision,
    tree,
    commonDir,
    branch,
    dirty: gitDirty(rootDir),
    remote: git(rootDir, ["remote", "get-url", "origin"]),
  };
}

export function createTypeScriptFactCacheIdentity(options: TypeScriptExtractorOptions): TypeScriptFactCacheIdentity {
  const rootDir = realpathSync(resolve(options.rootDir));
  const { files, cacheable: filesCacheable } = collectInputFiles(rootDir);
  const sourceFingerprint = inputDigest(files, "source");
  const moduleResolutionFiles = files.filter((file) => file.category === "module-resolution");
  const moduleResolutionFingerprint = digestCanonicalValue({
    files: moduleResolutionFiles.map((file) => [file.path, file.digest]),
    tsconfigPath: options.tsconfigPath === undefined ? undefined : relativePath(rootDir, resolve(rootDir, options.tsconfigPath)),
    rootNames: normalizedRootNames(rootDir, options.rootNames),
    typescriptVersion: ts.version,
  });
  const packageGraphFingerprint = inputDigest(files, "package-graph");
  const gitState = currentGitState(rootDir);
  const packagePath = join(rootDir, "package.json");
  const packageName = existsSync(packagePath) ? readJsonName(packagePath) : undefined;
  const canonicalName = options.repositoryName ?? remoteRepositoryName(gitState.remote) ?? packageName ?? basename(rootDir);
  const repository: RepositoryIdentity = {
    id: createRepositoryId(stableLocalId(canonicalName)),
    canonicalName,
    ...(gitState.remote === undefined ? {} : { remote: gitState.remote }),
  };
  const repositoryFingerprint = digestCanonicalValue(repository);
  const fallbackRevision = `working-${sourceFingerprint.value.slice(0, 32)}`;
  const revisionValue = options.revision ?? gitState.revision ?? fallbackRevision;
  const revision: RevisionIdentity = {
    id: createRevisionId(stableLocalId(revisionValue)),
    revision: revisionValue,
    ...(gitState.tree === undefined ? {} : { tree: gitState.tree }),
    kind: gitState.revision === undefined ? "workspace" : "git",
  };
  const revisionFingerprint = digestCanonicalValue({ revision, git: gitState.revision === undefined ? undefined : { revision: gitState.revision, tree: gitState.tree } });
  const worktree: WorktreeIdentity = {
    id: createWorktreeId(`sha256-${digestCanonicalValue({ root: rootDir, commonDir: gitState.commonDir }).value.slice(0, 32)}`),
    root: rootDir,
    ...(gitState.branch === undefined ? {} : { branch: gitState.branch }),
    ...(gitState.commonDir === undefined ? {} : { gitCommonDir: gitState.commonDir }),
    ...(gitState.dirty === undefined ? {} : { dirty: gitState.dirty }),
  };
  const extractor: ExtractorFingerprint = {
    id: TYPESCRIPT_FACT_PROVIDER_ID,
    version: TYPESCRIPT_FACT_PROVIDER_VERSION,
    optionsFingerprint: digestCanonicalValue({
      rootNames: normalizedRootNames(rootDir, options.rootNames),
      repositoryName: options.repositoryName,
      packageName: options.packageName,
      tsconfigPath: options.tsconfigPath === undefined ? undefined : relativePath(rootDir, resolve(rootDir, options.tsconfigPath)),
      moduleResolutionFingerprint,
      packageGraphFingerprint,
    }),
  };
  const extractorFingerprint = digestCanonicalValue({ extractor, typescriptVersion: ts.version });
  const trackedFiles: TrackedFileFingerprint[] = files
    .filter((file) => file.category === "source")
    .map((file) => ({ path: file.path, physicalFingerprint: file.digest }));
  const key: FactCacheKey = {
    algorithm: "sha256",
    value: digestCanonicalValue({
      cacheFormatVersion: DERIVED_FACT_CACHE_FORMAT_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      modelVersion: MODEL_VERSION,
      repositoryFingerprint,
      revisionFingerprint,
      sourceFingerprint,
      moduleResolutionFingerprint,
      packageGraphFingerprint,
      extractorFingerprint,
    }).value,
  };
  return {
    cacheable: filesCacheable,
    key,
    repository,
    repositoryFingerprint,
    revision,
    revisionFingerprint,
    ...(gitState.revision === undefined ? {} : { git: { revision: gitState.revision, ...(gitState.tree === undefined ? {} : { tree: gitState.tree }) } }),
    worktree,
    extractor,
    extractorFingerprint,
    sourceFingerprint,
    moduleResolutionFingerprint,
    packageGraphFingerprint,
    trackedFiles,
  };
}

export function toSharedFactSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new Error(`cannot cache invalid snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  const shared: RepositorySemanticSnapshot = {
    ...canonicalizeSnapshot(validation.snapshot),
    integrity: {
      ...validation.snapshot.integrity,
      worktree: { id: SHARED_WORKTREE_ID, dirty: false },
      status: "fresh",
      statusReason: undefined,
    },
  };
  return { ...shared, integrity: { ...shared.integrity, ...computeIntegrityDigestsFromValidated(shared) } };
}

export function materializeFactSnapshot(
  sharedSnapshot: RepositorySemanticSnapshot,
  identity: TypeScriptFactCacheIdentity,
): RepositorySemanticSnapshot {
  const validation = validateSnapshot(sharedSnapshot);
  if (!validation.ok) throw new Error(`cached snapshot is invalid: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  const snapshot: RepositorySemanticSnapshot = {
    ...canonicalizeSnapshot(validation.snapshot),
    repositoryIdentity: identity.repository,
    revisionIdentity: identity.revision,
    integrity: {
      ...validation.snapshot.integrity,
      repositoryId: identity.repository.id,
      ...(identity.git === undefined ? {} : { git: identity.git }),
      worktree: identity.worktree,
      status: "fresh",
      statusReason: undefined,
    },
  };
  // Worktree metadata participates in snapshotDigest. Recompute the integrity
  // digests before asking #84's schema validator to serve the materialized
  // snapshot; validating the old shared digest would reject a valid worktree
  // projection as stale.
  const refreshed: RepositorySemanticSnapshot = {
    ...snapshot,
    integrity: {
      ...snapshot.integrity,
      semanticStateDigest: digestCanonicalValue("pending-semantic-state"),
      modelDigest: digestCanonicalValue("pending-model"),
      snapshotDigest: digestCanonicalValue("pending-snapshot"),
    },
  };
  const finalValidation = validateSnapshot({
    ...refreshed,
    integrity: { ...refreshed.integrity, ...computeIntegrityDigestsFromValidated(refreshed) },
  });
  if (!finalValidation.ok) throw new Error(`cached snapshot failed identity materialization: ${finalValidation.diagnostics.map((item) => item.code).join(",")}`);
  return {
    ...finalValidation.snapshot,
    integrity: { ...finalValidation.snapshot.integrity, ...computeIntegrityDigestsFromValidated(finalValidation.snapshot) },
  };
}

export function createSnapshotManifest(
  identity: TypeScriptFactCacheIdentity,
  snapshot: RepositorySemanticSnapshot,
  declarationFingerprint: ContentDigest,
): SnapshotManifest {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new Error(`cannot create manifest for invalid snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  return {
    formatVersion: DERIVED_FACT_CACHE_FORMAT_VERSION,
    repositoryId: identity.repository.id,
    repositoryFingerprint: identity.repositoryFingerprint,
    worktree: structuredClone(identity.worktree),
    ...(identity.revision === undefined ? {} : { revision: structuredClone(identity.revision) }),
    revisionFingerprint: identity.revisionFingerprint,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    extractors: structuredClone(validation.snapshot.integrity.extractors),
    extractorFingerprint: identity.extractorFingerprint,
    declarationFingerprint,
    sourceFingerprint: identity.sourceFingerprint,
    moduleResolutionFingerprint: identity.moduleResolutionFingerprint,
    packageGraphFingerprint: identity.packageGraphFingerprint,
    factKey: identity.key,
    trackedFiles: structuredClone(validation.snapshot.integrity.trackedFiles),
    snapshotDigest: validation.snapshot.integrity.snapshotDigest,
  };
}
