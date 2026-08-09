import type { LogicalId } from "../ir/ids.js";
import type {
  ContentDigest,
  ExtractorFingerprint,
  ModelVersion,
  RepositorySemanticSnapshot,
  RevisionIdentity,
  SchemaVersion,
  TrackedFileFingerprint,
  WorktreeIdentity,
} from "../ir/types.js";
import type { TypeScriptFactCounts } from "../extractors/types.js";

/** Increment when the private on-disk representation or cache semantics change. */
export const DERIVED_FACT_CACHE_FORMAT_VERSION = 1 as const;

export type DerivedFactCacheStatus =
  | "disabled"
  | "miss"
  | "hit"
  | "corrupt"
  | "conflict"
  | "unavailable";

/** Opaque content key; it is not a Repository Semantics logical ID. */
export interface FactCacheKey extends ContentDigest {
  algorithm: "sha256";
}

export type CacheLookup<T> =
  | { status: "miss" }
  | { status: "hit"; value: T }
  | { status: "corrupt"; reason: string };

export interface CachePutResult {
  status: "written" | "existing";
}

export class CacheConflictError extends Error {
  readonly code = "cache-conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "CacheConflictError";
  }
}

/** Shared immutable output of the TypeScript derived-fact producer. */
export interface DerivedFactObject {
  kind: "typescript-fact-snapshot";
  snapshot: RepositorySemanticSnapshot;
  counts: TypeScriptFactCounts;
}

/** Mutable only at this manifest path; the referenced fact object is immutable. */
export interface SnapshotManifest {
  formatVersion: typeof DERIVED_FACT_CACHE_FORMAT_VERSION;
  repositoryId: LogicalId;
  repositoryFingerprint: ContentDigest;
  worktree: WorktreeIdentity;
  revision?: RevisionIdentity;
  revisionFingerprint: ContentDigest;
  schemaVersion: SchemaVersion;
  modelVersion: ModelVersion;
  extractors: ExtractorFingerprint[];
  extractorFingerprint: ContentDigest;
  declarationFingerprint: ContentDigest;
  sourceFingerprint: ContentDigest;
  moduleResolutionFingerprint: ContentDigest;
  packageGraphFingerprint: ContentDigest;
  factKey: FactCacheKey;
  trackedFiles: TrackedFileFingerprint[];
  snapshotDigest: ContentDigest;
}

/** Cache API intentionally exposes no paths, filenames, or backend-specific handles. */
export interface SemanticFactCache {
  get(key: FactCacheKey): CacheLookup<DerivedFactObject>;
  put(key: FactCacheKey, value: DerivedFactObject): CachePutResult;
  getManifest(worktreeId: LogicalId): CacheLookup<SnapshotManifest>;
  putManifest(manifest: SnapshotManifest): void;
}
