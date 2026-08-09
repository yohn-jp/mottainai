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
import { CURRENT_SCHEMA_VERSION, MODEL_VERSION, type ContentDigest, type RepositorySemanticSnapshot } from "../ir/types.js";
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

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is ContentDigest {
  return isRecord(value) && value.algorithm === "sha256" && typeof value.value === "string" && SHA256_HEX.test(value.value);
}

function assertFactCacheKey(key: FactCacheKey): void {
  if (!isDigest(key)) throw new TypeError("cache key must be a sha256 digest");
}

function objectTarget(objectsDir: string, key: FactCacheKey): string {
  assertFactCacheKey(key);
  return join(objectsDir, `${key.value}.json`);
}

function validateFactObject(value: unknown): value is DerivedFactObject {
  if (!isRecord(value) || value.kind !== "typescript-fact-snapshot") return false;
  const counts = value.counts;
  if (!isRecord(counts)) return false;
  const snapshot = value.snapshot as RepositorySemanticSnapshot | undefined;
  const validation = snapshot === undefined ? undefined : validateSnapshot(snapshot);
  if (validation === undefined || !validation.ok) return false;
  const countFields = ["files", "symbols", "relations", "facts", "externalPackages", "externalApis", "unknowns", "diagnostics"];
  return countFields.every(
    (field) => typeof counts[field] === "number" && Number.isSafeInteger(counts[field]) && counts[field] >= 0,
  ) && typeof counts.partial === "boolean";
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
  if (value.worktree.root !== undefined && typeof value.worktree.root !== "string") return false;
  if (value.worktree.branch !== undefined && typeof value.worktree.branch !== "string") return false;
  if (value.worktree.gitCommonDir !== undefined && typeof value.worktree.gitCommonDir !== "string") return false;
  if (value.worktree.dirty !== undefined && typeof value.worktree.dirty !== "boolean") return false;
  if (value.revision !== undefined && (!isRecord(value.revision) || typeof value.revision.id !== "string" || typeof value.revision.revision !== "string")) return false;
  if (!isDigest(value.repositoryFingerprint) || !isDigest(value.revisionFingerprint)) return false;
  if (!isDigest(value.extractorFingerprint) || !isDigest(value.declarationFingerprint)) return false;
  if (!isDigest(value.sourceFingerprint) || !isDigest(value.moduleResolutionFingerprint)) return false;
  if (!isDigest(value.packageGraphFingerprint) || !isDigest(value.factKey) || !isDigest(value.snapshotDigest)) return false;
  if (value.factKey.algorithm !== "sha256") return false;
  if (typeof value.repositoryId !== "string" || value.repositoryId.length === 0) return false;
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION || value.modelVersion !== MODEL_VERSION) return false;
  if (!Array.isArray(value.extractors) || value.extractors.some((extractor) => {
    if (!isRecord(extractor) || typeof extractor.id !== "string" || extractor.id.length === 0) return true;
    if (typeof extractor.version !== "string" || extractor.version.length === 0) return true;
    return extractor.optionsFingerprint !== undefined && !isDigest(extractor.optionsFingerprint);
  })) return false;
  return Array.isArray(value.trackedFiles) && value.trackedFiles.every((file) => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.length === 0) return false;
    return isDigest(file.physicalFingerprint)
      && (file.semanticFingerprint === undefined || isDigest(file.semanticFingerprint))
      && (file.extractorFingerprint === undefined || isDigest(file.extractorFingerprint));
  });
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
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort cleanup; no target has been published.
    }
    throw error;
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
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
    let target: string;
    try {
      target = objectTarget(this.objectsDir, key);
    } catch (error) {
      return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) };
    }
    if (!existsSync(target)) return { status: "miss" };
    try {
      return parseObjectEnvelope(readFileSync(target), key);
    } catch (error) {
      return { status: "corrupt", reason: `cache object cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  put(key: FactCacheKey, value: DerivedFactObject): CachePutResult {
    return writeExclusiveAtomically(objectTarget(this.objectsDir, key), envelopeBytes(key, value));
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
    if (!isSnapshotManifest(manifest, manifest.worktree.id)) throw new TypeError("manifest failed identity or fingerprint validation");
    const manifestDigest = digestCanonicalValue(manifest.worktree.id).value;
    writeAtomically(join(this.manifestsDir, `${manifestDigest}.json`), Buffer.from(stableStringifyValue(manifest), "utf8"));
  }
}

/** In-memory backend used by focused tests and callers that want disposable process-local caching. */
export class MemorySemanticFactCache implements SemanticFactCache {
  private readonly objects = new Map<string, DerivedFactObject>();
  private readonly manifests = new Map<string, SnapshotManifest>();

  get(key: FactCacheKey): CacheLookup<DerivedFactObject> {
    try {
      assertFactCacheKey(key);
    } catch (error) {
      return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) };
    }
    const value = this.objects.get(key.value);
    return value === undefined ? { status: "miss" } : { status: "hit", value: clone(value) };
  }

  put(key: FactCacheKey, value: DerivedFactObject): CachePutResult {
    assertFactCacheKey(key);
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
    if (!isSnapshotManifest(manifest, manifest.worktree.id)) throw new TypeError("manifest failed identity or fingerprint validation");
    this.manifests.set(manifest.worktree.id, clone(manifest));
  }
}
