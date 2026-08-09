import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeSnapshot, digestCanonicalValue, stableStringifyValue } from "../ir/canonical.js";
import { validateSnapshot } from "../ir/schema.js";
import type { ContentDigest, RepositorySemanticSnapshot } from "../ir/types.js";
import {
  CacheConflictError,
  DERIVED_FACT_CACHE_FORMAT_VERSION,
  type CacheLookup,
  type CachePutResult,
  type DerivedFactObject,
  type FactCacheKey,
  type SemanticFactCache,
  type SnapshotManifest,
} from "./types.js";

interface ObjectEnvelope {
  formatVersion: typeof DERIVED_FACT_CACHE_FORMAT_VERSION;
  key: FactCacheKey;
  payloadDigest: ContentDigest;
  payload: DerivedFactObject;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is { algorithm: string; value: string } {
  return isRecord(value) && typeof value.algorithm === "string" && typeof value.value === "string" && value.value.length > 0;
}

function validateFactObject(value: unknown): value is DerivedFactObject {
  if (!isRecord(value) || value.kind !== "typescript-fact-snapshot") return false;
  const counts = value.counts;
  if (!isRecord(counts)) return false;
  const snapshot = value.snapshot as RepositorySemanticSnapshot | undefined;
  const validation = snapshot === undefined ? undefined : validateSnapshot(snapshot);
  if (validation === undefined || !validation.ok) return false;
  return ["files", "symbols", "relations", "facts", "externalPackages", "externalApis", "unknowns", "diagnostics"]
    .every((field) => typeof counts[field] === "number" && Number.isFinite(counts[field]));
}

function canonicalFactObject(value: DerivedFactObject): DerivedFactObject {
  const validation = validateSnapshot(value.snapshot);
  if (!validation.ok) {
    throw new Error(`cannot cache invalid derived snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`);
  }
  return {
    kind: "typescript-fact-snapshot",
    snapshot: canonicalizeSnapshot(validation.snapshot),
    counts: { ...value.counts },
  };
}

function envelopeBytes(key: FactCacheKey, value: DerivedFactObject): Buffer {
  const payload = canonicalFactObject(value);
  const envelope: ObjectEnvelope = {
    formatVersion: DERIVED_FACT_CACHE_FORMAT_VERSION,
    key,
    payloadDigest: digestCanonicalValue(payload),
    payload,
  };
  return Buffer.from(stableStringifyValue(envelope), "utf8");
}

function parseObjectEnvelope(raw: Buffer, expectedKey: FactCacheKey): CacheLookup<DerivedFactObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    return { status: "corrupt", reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed) || parsed.formatVersion !== DERIVED_FACT_CACHE_FORMAT_VERSION) {
    return { status: "corrupt", reason: "unsupported or missing cache format version" };
  }
  if (!isDigest(parsed.key) || parsed.key.algorithm !== expectedKey.algorithm || parsed.key.value !== expectedKey.value) {
    return { status: "corrupt", reason: "cache key does not match the requested object" };
  }
  if (!isDigest(parsed.payloadDigest) || !validateFactObject(parsed.payload)) {
    return { status: "corrupt", reason: "cache payload failed snapshot validation" };
  }
  const payloadDigest = digestCanonicalValue(parsed.payload).value;
  if (payloadDigest !== parsed.payloadDigest.value) {
    return { status: "corrupt", reason: "cache payload digest mismatch" };
  }
  return { status: "hit", value: clone(canonicalFactObject(parsed.payload)) };
}

function isSnapshotManifest(value: unknown, expectedWorktreeId: string): value is SnapshotManifest {
  if (!isRecord(value) || value.formatVersion !== DERIVED_FACT_CACHE_FORMAT_VERSION) return false;
  if (!isRecord(value.worktree) || value.worktree.id !== expectedWorktreeId) return false;
  if (!isDigest(value.repositoryFingerprint) || !isDigest(value.revisionFingerprint)) return false;
  if (!isDigest(value.extractorFingerprint) || !isDigest(value.declarationFingerprint)) return false;
  if (!isDigest(value.sourceFingerprint) || !isDigest(value.moduleResolutionFingerprint)) return false;
  if (!isDigest(value.packageGraphFingerprint) || !isDigest(value.factKey) || !isDigest(value.snapshotDigest)) return false;
  return typeof value.repositoryId === "string"
    && typeof value.schemaVersion === "number"
    && typeof value.modelVersion === "string"
    && Array.isArray(value.extractors)
    && Array.isArray(value.trackedFiles);
}

function parseManifest(raw: Buffer, expectedWorktreeId: string): CacheLookup<SnapshotManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    return { status: "corrupt", reason: `invalid manifest JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isSnapshotManifest(parsed, expectedWorktreeId)) {
    return { status: "corrupt", reason: "manifest failed identity or fingerprint validation" };
  }
  return { status: "hit", value: clone(parsed) };
}

function temporaryPath(target: string): string {
  return `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
}

function writeExclusiveAtomically(target: string, bytes: Buffer): CachePutResult {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // link() publishes a complete temporary file without allowing a concurrent
    // writer to replace an object for the same content key.
    linkSync(temporary, target);
    return { status: "written" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: Buffer;
    try {
      existing = readFileSync(target);
    } catch (readError) {
      throw new CacheConflictError(`existing cache object cannot be read: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
    if (existing.equals(bytes)) return { status: "existing" };
    throw new CacheConflictError(`cache object already exists with different bytes: ${target}`);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort cleanup; the published object is already safe.
    }
  }
}

function writeAtomically(target: string, bytes: Buffer): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename normally removed it.
    }
  }
}

export interface FileSystemSemanticFactCacheOptions {
  rootDir: string;
}

/** Default disposable backend. Its directory layout is deliberately private. */
export class FileSystemSemanticFactCache implements SemanticFactCache {
  private readonly objectsDir: string;
  private readonly manifestsDir: string;

  constructor(options: FileSystemSemanticFactCacheOptions) {
    const root = resolve(options.rootDir);
    this.objectsDir = join(root, "objects");
    this.manifestsDir = join(root, "manifests");
  }

  get(key: FactCacheKey): CacheLookup<DerivedFactObject> {
    const target = join(this.objectsDir, `${key.value}.json`);
    if (!existsSync(target)) return { status: "miss" };
    try {
      return parseObjectEnvelope(readFileSync(target), key);
    } catch (error) {
      return { status: "corrupt", reason: `cache object cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  put(key: FactCacheKey, value: DerivedFactObject): CachePutResult {
    return writeExclusiveAtomically(join(this.objectsDir, `${key.value}.json`), envelopeBytes(key, value));
  }

  getManifest(worktreeId: SnapshotManifest["worktree"]["id"]): CacheLookup<SnapshotManifest> {
    const manifestDigest = digestCanonicalValue(worktreeId).value;
    const target = join(this.manifestsDir, `${manifestDigest}.json`);
    if (!existsSync(target)) return { status: "miss" };
    try {
      return parseManifest(readFileSync(target), worktreeId);
    } catch (error) {
      return { status: "corrupt", reason: `manifest cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  putManifest(manifest: SnapshotManifest): void {
    const manifestDigest = digestCanonicalValue(manifest.worktree.id).value;
    writeAtomically(join(this.manifestsDir, `${manifestDigest}.json`), Buffer.from(stableStringifyValue(manifest), "utf8"));
  }
}

/** In-memory backend used by focused tests and callers that want disposable process-local caching. */
export class MemorySemanticFactCache implements SemanticFactCache {
  private readonly objects = new Map<string, DerivedFactObject>();
  private readonly manifests = new Map<string, SnapshotManifest>();

  get(key: FactCacheKey): CacheLookup<DerivedFactObject> {
    const value = this.objects.get(key.value);
    return value === undefined ? { status: "miss" } : { status: "hit", value: clone(value) };
  }

  put(key: FactCacheKey, value: DerivedFactObject): CachePutResult {
    const canonical = canonicalFactObject(value);
    const existing = this.objects.get(key.value);
    if (existing === undefined) {
      this.objects.set(key.value, clone(canonical));
      return { status: "written" };
    }
    if (stableStringifyValue(existing) === stableStringifyValue(canonical)) return { status: "existing" };
    throw new CacheConflictError(`cache object already exists with different bytes: ${key.value}`);
  }

  getManifest(worktreeId: SnapshotManifest["worktree"]["id"]): CacheLookup<SnapshotManifest> {
    const value = this.manifests.get(worktreeId);
    return value === undefined ? { status: "miss" } : { status: "hit", value: clone(value) };
  }

  putManifest(manifest: SnapshotManifest): void {
    this.manifests.set(manifest.worktree.id, clone(manifest));
  }
}
