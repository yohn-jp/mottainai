import path from "node:path";
import {
  DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY,
  inspectSemanticFactCache,
  runSemanticFactCacheGc,
  type SemanticFactCacheRetentionPolicy,
} from "../src/semantics/cache/index.js";

/**
 * Manual inspect/GC entry point for the semantic fact cache (#874).
 *
 * The cache itself never evicts anything on the read/write path (`get`/`put`/
 * `getManifest`/`putManifest` stay additive) — this script is the only place
 * retention actually runs, so operators (and CI hygiene jobs) can reclaim
 * space on demand without touching the library's runtime behavior.
 */

const USAGE = `usage:
  pnpm run cache:gc inspect [--root dir] [--json]        report current size/count and what a GC pass would evict
  pnpm run cache:gc run [--root dir] [--json]             actually evict per policy (dry-run unless --commit)
    --commit                       perform the eviction (default is a dry run, same as inspect)
    --max-manifest-age-days <n>    default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.maxManifestAgeMs / 86_400_000}
    --max-manifest-count <n>       default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.maxManifestCount}
    --max-object-age-days <n>      default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.maxObjectAgeMs / 86_400_000}
    --max-object-bytes <n>         default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.maxTotalObjectBytes}
    --max-orphan-count <n>         default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.maxOrphanObjectCount}
    --grace-minutes <n>            default ${DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.orphanGraceMs / 60_000}
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number, got: ${raw}`);
  return value;
}

function resolveDefaultCacheRoot(): string {
  return process.env.MOTTAINAI_SEMANTIC_CACHE_DIR ?? path.join(process.cwd(), ".mottainai", "semantics", "cache");
}

function policyFromArgv(argv: string[]): Partial<SemanticFactCacheRetentionPolicy> {
  const policy: Partial<SemanticFactCacheRetentionPolicy> = {};
  const maxManifestAgeDays = numberFlag(argv, "max-manifest-age-days");
  if (maxManifestAgeDays !== undefined) policy.maxManifestAgeMs = maxManifestAgeDays * 86_400_000;
  const maxManifestCount = numberFlag(argv, "max-manifest-count");
  if (maxManifestCount !== undefined) policy.maxManifestCount = maxManifestCount;
  const maxObjectAgeDays = numberFlag(argv, "max-object-age-days");
  if (maxObjectAgeDays !== undefined) policy.maxObjectAgeMs = maxObjectAgeDays * 86_400_000;
  const maxObjectBytes = numberFlag(argv, "max-object-bytes");
  if (maxObjectBytes !== undefined) policy.maxTotalObjectBytes = maxObjectBytes;
  const maxOrphanCount = numberFlag(argv, "max-orphan-count");
  if (maxOrphanCount !== undefined) policy.maxOrphanObjectCount = maxOrphanCount;
  const graceMinutes = numberFlag(argv, "grace-minutes");
  if (graceMinutes !== undefined) policy.orphanGraceMs = graceMinutes * 60_000;
  return policy;
}

function printHuman(report: ReturnType<typeof runSemanticFactCacheGc>, root: string): void {
  const { before, after, evicted, bytesReclaimed, dryRun } = report;
  console.log(`semantic fact cache: ${root}`);
  console.log(dryRun ? "mode: dry run (no files removed)" : "mode: committed eviction");
  console.log(`manifests: ${before.manifestCount} -> ${after.manifestCount}`);
  console.log(`objects:   ${before.objectCount} -> ${after.objectCount} (${before.objectBytes} -> ${after.objectBytes} bytes)`);
  console.log(`  reachable (protected): ${before.reachableObjectCount} objects / ${before.reachableObjectBytes} bytes`);
  console.log(`  orphaned:              ${before.orphanObjectCount} objects / ${before.orphanObjectBytes} bytes`);
  console.log(`${dryRun ? "would evict" : "evicted"}: ${evicted.length} entries, ${bytesReclaimed} bytes`);
  for (const entry of evicted) {
    console.log(`  - ${entry.kind} ${entry.id} (${entry.reason}, ${entry.bytes}B)`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "inspect" && command !== "run") {
    process.stderr.write(USAGE);
    process.exitCode = command === undefined ? 1 : 2;
    return;
  }
  const root = path.resolve(flag(rest, "root") ?? resolveDefaultCacheRoot());
  const asJson = has(rest, "json");
  const policy = policyFromArgv(rest);

  const report =
    command === "inspect"
      ? inspectSemanticFactCache({ rootDir: root, policy })
      : runSemanticFactCacheGc({ rootDir: root, policy, dryRun: !has(rest, "commit") });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report, root);
  }
}

main();
