import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DERIVED_FACT_CACHE_FORMAT_VERSION } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Bounded retention policy for the on-disk semantic fact cache.
 *
 * The cache is content-addressed and disposable (see store.ts): every entry
 * can always be recomputed on a miss. Retention therefore never needs to be
 * exact — it only needs to (a) never delete something the currently-active
 * generation of any tracked worktree still points at, and (b) keep the
 * on-disk footprint within the configured bounds over time.
 *
 * "Currently-active generation" is: for every worktree that still has a
 * manifest file (manifests are overwritten in place by putManifest, so at
 * most one manifest exists per worktree at any time), the object referenced
 * by that manifest's factKey. A manifest becomes eligible for eviction only
 * once it has aged out or the worktree count exceeds the configured cap
 * (oldest-by-mtime evicted first); the object it references only becomes
 * eligible for eviction once no surviving manifest references it anymore.
 */
export interface SemanticFactCacheRetentionPolicy {
  /** Manifests (i.e. worktrees) unused for longer than this are dropped. Default 30 days. */
  readonly maxManifestAgeMs: number;
  /** Maximum number of worktree manifests kept; oldest-by-mtime excess is dropped. Default 200. */
  readonly maxManifestCount: number;
  /** Orphaned (unreferenced) objects older than this are dropped. Default 14 days. */
  readonly maxObjectAgeMs: number;
  /** Soft cap, in bytes, on the total size of orphaned objects. Default 1 GiB. */
  readonly maxTotalObjectBytes: number;
  /** Soft cap on the number of orphaned objects. Default 10,000. */
  readonly maxOrphanObjectCount: number;
  /**
   * Grace period during which a freshly-written, still-unreferenced object is
   * protected from eviction regardless of the other thresholds. This closes
   * the window between a producer's `cache.put(key, object)` and its
   * following `cache.putManifest(...)` (see extractor.ts / compiler.ts): a GC
   * pass that runs in between must not treat the not-yet-linked object as
   * garbage. Default 5 minutes.
   */
  readonly orphanGraceMs: number;
}

export const DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY: SemanticFactCacheRetentionPolicy = Object.freeze({
  maxManifestAgeMs: 30 * DAY_MS,
  maxManifestCount: 200,
  maxObjectAgeMs: 14 * DAY_MS,
  maxTotalObjectBytes: 1024 * 1024 * 1024,
  maxOrphanObjectCount: 10_000,
  orphanGraceMs: 5 * 60 * 1000,
});

export interface SemanticFactCacheInspection {
  readonly manifestCount: number;
  readonly manifestBytes: number;
  readonly objectCount: number;
  readonly objectBytes: number;
  readonly reachableObjectCount: number;
  readonly reachableObjectBytes: number;
  readonly orphanObjectCount: number;
  readonly orphanObjectBytes: number;
}

export type SemanticFactCacheEvictionReason = "corrupt" | "age" | "count" | "size";

export interface SemanticFactCacheEvictionEntry {
  readonly kind: "manifest" | "object";
  /** Manifest: on-disk file name (digest of worktree id). Object: sha256 hex hash. */
  readonly id: string;
  readonly reason: SemanticFactCacheEvictionReason;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface SemanticFactCacheGcReport {
  readonly dryRun: boolean;
  readonly policy: SemanticFactCacheRetentionPolicy;
  readonly before: SemanticFactCacheInspection;
  readonly after: SemanticFactCacheInspection;
  readonly evicted: readonly SemanticFactCacheEvictionEntry[];
  readonly bytesReclaimed: number;
}

export interface RunSemanticFactCacheGcOptions {
  readonly rootDir: string;
  readonly policy?: Partial<SemanticFactCacheRetentionPolicy>;
  /** When true (the default for `inspectSemanticFactCache`), compute and report the plan without deleting anything. */
  readonly dryRun?: boolean;
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  readonly now?: number;
}

interface ManifestEntry {
  readonly file: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  readonly worktreeId?: string;
  readonly factHash?: string;
  readonly corrupt: boolean;
}

interface ObjectEntry {
  readonly file: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  readonly hash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDirSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Deliberately lenient: this only needs `worktree.id` and `factKey.value` to
 * compute reachability. Full structural validation stays store.ts's job on
 * the read path; a manifest that fails even this minimal shape check cannot
 * protect any object and is itself reported as corrupt (evicted unconditionally).
 */
function readManifestReachability(path: string): { worktreeId?: string; factHash?: string; corrupt: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { corrupt: true };
  }
  if (!isRecord(parsed) || parsed.formatVersion !== DERIVED_FACT_CACHE_FORMAT_VERSION) return { corrupt: true };
  const worktree = parsed.worktree;
  if (!isRecord(worktree) || typeof worktree.id !== "string" || worktree.id.length === 0) return { corrupt: true };
  const factKey = parsed.factKey;
  if (!isRecord(factKey) || factKey.algorithm !== "sha256" || typeof factKey.value !== "string" || !SHA256_HEX.test(factKey.value)) {
    return { corrupt: true };
  }
  return { worktreeId: worktree.id, factHash: factKey.value, corrupt: false };
}

function listManifestEntries(manifestsDir: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const file of readDirSafe(manifestsDir)) {
    if (!file.endsWith(".json")) continue; // skips in-flight `*.tmp` publish targets
    const path = join(manifestsDir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // vanished under a concurrent writer/GC; not this pass's concern
    }
    if (!stat.isFile()) continue;
    const reachability = readManifestReachability(path);
    entries.push({
      file,
      path,
      mtimeMs: stat.mtimeMs,
      bytes: stat.size,
      worktreeId: reachability.worktreeId,
      factHash: reachability.factHash,
      corrupt: reachability.corrupt,
    });
  }
  return entries;
}

function listObjectEntries(objectsDir: string): ObjectEntry[] {
  const entries: ObjectEntry[] = [];
  for (const file of readDirSafe(objectsDir)) {
    if (!file.endsWith(".json")) continue;
    const hash = file.slice(0, -".json".length);
    if (!SHA256_HEX.test(hash)) continue; // ignore anything not shaped like our own objects
    const path = join(objectsDir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({ file, path, mtimeMs: stat.mtimeMs, bytes: stat.size, hash });
  }
  return entries;
}

function sumBytes(entries: readonly { bytes: number }[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function resolvePolicy(policy: Partial<SemanticFactCacheRetentionPolicy> | undefined): SemanticFactCacheRetentionPolicy {
  return { ...DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY, ...policy };
}

/**
 * Plans (and, unless `dryRun`, executes) one garbage-collection pass over the
 * filesystem cache rooted at `options.rootDir`.
 *
 * Safety under concurrency: deletion is a single `unlinkSync` per file, the
 * same operation `get`/`getManifest` already treat as a normal, race-safe
 * "this became a miss" outcome (see store.ts) rather than corruption. GC
 * therefore introduces no new failure mode for concurrent readers/writers —
 * it only removes files that are (a) not referenced by any manifest this
 * pass keeps, and (b) outside the freshness grace period, so a producer's
 * `put()` → `putManifest()` sequence can never be caught mid-flight.
 */
export function runSemanticFactCacheGc(options: RunSemanticFactCacheGcOptions): SemanticFactCacheGcReport {
  const policy = resolvePolicy(options.policy);
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Date.now();
  const root = resolve(options.rootDir);
  const manifestsDir = join(root, "manifests");
  const objectsDir = join(root, "objects");

  const manifestEntries = listManifestEntries(manifestsDir);
  const objectEntries = listObjectEntries(objectsDir);

  const evicted: SemanticFactCacheEvictionEntry[] = [];

  const corrupt = manifestEntries.filter((entry) => entry.corrupt);
  const usable = manifestEntries.filter((entry) => !entry.corrupt);
  for (const entry of corrupt) {
    evicted.push({ kind: "manifest", id: entry.file, reason: "corrupt", bytes: entry.bytes, mtimeMs: entry.mtimeMs });
  }

  const withinAge = usable.filter((entry) => now - entry.mtimeMs <= policy.maxManifestAgeMs);
  const aged = usable.filter((entry) => now - entry.mtimeMs > policy.maxManifestAgeMs);
  for (const entry of aged) {
    evicted.push({ kind: "manifest", id: entry.file, reason: "age", bytes: entry.bytes, mtimeMs: entry.mtimeMs });
  }

  let keptManifests = withinAge;
  if (withinAge.length > policy.maxManifestCount) {
    const newestFirst = [...withinAge].sort((left, right) => right.mtimeMs - left.mtimeMs);
    keptManifests = newestFirst.slice(0, policy.maxManifestCount);
    for (const entry of newestFirst.slice(policy.maxManifestCount)) {
      evicted.push({ kind: "manifest", id: entry.file, reason: "count", bytes: entry.bytes, mtimeMs: entry.mtimeMs });
    }
  }

  // Reachability: the union of factKey hashes referenced by every manifest
  // this pass keeps. These objects are never evicted, regardless of age or
  // budget, no matter how the remaining thresholds below are configured.
  const reachable = new Set(keptManifests.map((entry) => entry.factHash).filter((hash): hash is string => hash !== undefined));

  const reachableObjects = objectEntries.filter((entry) => reachable.has(entry.hash));
  const orphans = objectEntries.filter((entry) => !reachable.has(entry.hash));

  const protectedByGrace = orphans.filter((entry) => now - entry.mtimeMs < policy.orphanGraceMs);
  const evictable = orphans.filter((entry) => now - entry.mtimeMs >= policy.orphanGraceMs);

  const withinObjectAge = evictable.filter((entry) => now - entry.mtimeMs <= policy.maxObjectAgeMs);
  const agedOrphans = evictable.filter((entry) => now - entry.mtimeMs > policy.maxObjectAgeMs);
  for (const entry of agedOrphans) {
    evicted.push({ kind: "object", id: entry.hash, reason: "age", bytes: entry.bytes, mtimeMs: entry.mtimeMs });
  }

  // Budget enforcement: keep the newest orphans first (most likely to become
  // reachable again soon) until both the count and byte budgets are
  // satisfied; the rest, oldest first, is evicted.
  const newestOrphansFirst = [...withinObjectAge].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const survivingOrphans: ObjectEntry[] = [];
  let survivingBytes = 0;
  for (const entry of newestOrphansFirst) {
    const wouldCount = survivingOrphans.length + 1;
    const wouldBytes = survivingBytes + entry.bytes;
    if (wouldCount <= policy.maxOrphanObjectCount && wouldBytes <= policy.maxTotalObjectBytes) {
      survivingOrphans.push(entry);
      survivingBytes = wouldBytes;
    } else {
      const reason: SemanticFactCacheEvictionReason = wouldCount > policy.maxOrphanObjectCount ? "count" : "size";
      evicted.push({ kind: "object", id: entry.hash, reason, bytes: entry.bytes, mtimeMs: entry.mtimeMs });
    }
  }

  const before: SemanticFactCacheInspection = {
    manifestCount: manifestEntries.length,
    manifestBytes: sumBytes(manifestEntries),
    objectCount: objectEntries.length,
    objectBytes: sumBytes(objectEntries),
    reachableObjectCount: reachableObjects.length,
    reachableObjectBytes: sumBytes(reachableObjects),
    orphanObjectCount: orphans.length,
    orphanObjectBytes: sumBytes(orphans),
  };

  const remainingObjectCount = reachableObjects.length + survivingOrphans.length + protectedByGrace.length;
  const remainingObjectBytes = sumBytes(reachableObjects) + sumBytes(survivingOrphans) + sumBytes(protectedByGrace);
  const after: SemanticFactCacheInspection = {
    manifestCount: keptManifests.length,
    manifestBytes: sumBytes(keptManifests),
    objectCount: remainingObjectCount,
    objectBytes: remainingObjectBytes,
    reachableObjectCount: reachableObjects.length,
    reachableObjectBytes: sumBytes(reachableObjects),
    orphanObjectCount: survivingOrphans.length + protectedByGrace.length,
    orphanObjectBytes: sumBytes(survivingOrphans) + sumBytes(protectedByGrace),
  };

  const bytesReclaimed = sumBytes(evicted);

  if (!dryRun) {
    for (const entry of evicted) {
      const path = entry.kind === "manifest" ? join(manifestsDir, entry.id) : join(objectsDir, `${entry.id}.json`);
      try {
        unlinkSync(path);
      } catch (error) {
        // Already gone (another GC pass, or the entry was never actually
        // materialized) is a benign race, not a failure of this pass.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return { dryRun, policy, before, after, evicted, bytesReclaimed };
}

/** Dry-run metrics/inspection surface: current size/count plus what a GC pass with `policy` would evict. */
export function inspectSemanticFactCache(
  options: Omit<RunSemanticFactCacheGcOptions, "dryRun">,
): SemanticFactCacheGcReport {
  return runSemanticFactCacheGc({ ...options, dryRun: true });
}
