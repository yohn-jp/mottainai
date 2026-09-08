import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileRepositoryModel } from "../model/compiler.js";
import { createTypeScriptFactCacheIdentity } from "./identity.js";
import {
  DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY,
  inspectSemanticFactCache,
  runSemanticFactCacheGc,
  type SemanticFactCacheRetentionPolicy,
} from "./retention.js";
import { FileSystemSemanticFactCache } from "./store.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/typescript");
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_NOW = Date.parse("2026-01-01T00:00:00.000Z");

function hashOf(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function tempCacheRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeManifest(root: string, fileName: string, worktreeId: string, factHash: string, mtimeMs: number): string {
  const manifestsDir = join(root, "manifests");
  mkdirSync(manifestsDir, { recursive: true });
  const path = join(manifestsDir, fileName);
  writeFileSync(path, JSON.stringify({ formatVersion: 1, worktree: { id: worktreeId }, factKey: { algorithm: "sha256", value: factHash } }));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function writeObject(root: string, hash: string, mtimeMs: number, bytes = 16): string {
  const objectsDir = join(root, "objects");
  mkdirSync(objectsDir, { recursive: true });
  const path = join(objectsDir, `${hash}.json`);
  writeFileSync(path, "x".repeat(bytes));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function listFileNames(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

test("a reachable object referenced by a kept manifest is never evicted, even far outside age/size budgets", () => {
  const root = tempCacheRoot("mottainai-retention-reachable-");
  try {
    const hash = hashOf("reachable-object");
    writeManifest(root, "active.json", "w1", hash, BASE_NOW);
    writeObject(root, hash, BASE_NOW - 365 * DAY_MS, 4096);

    const report = runSemanticFactCacheGc({
      rootDir: root,
      now: BASE_NOW,
      dryRun: false,
      policy: { maxObjectAgeMs: 1, maxTotalObjectBytes: 0, maxOrphanObjectCount: 0, orphanGraceMs: 0 },
    });

    assert.equal(report.evicted.some((entry) => entry.id === hash), false);
    assert.deepEqual(listFileNames(join(root, "objects")), [`${hash}.json`]);
    assert.equal(report.after.reachableObjectCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphaned objects older than maxObjectAgeMs are evicted; younger orphans survive", () => {
  const root = tempCacheRoot("mottainai-retention-age-");
  try {
    const stale = hashOf("stale-orphan");
    const fresh = hashOf("fresh-orphan");
    writeObject(root, stale, BASE_NOW - 20 * DAY_MS);
    writeObject(root, fresh, BASE_NOW - 1 * DAY_MS);

    const report = runSemanticFactCacheGc({
      rootDir: root,
      now: BASE_NOW,
      dryRun: false,
      policy: { maxObjectAgeMs: 14 * DAY_MS, orphanGraceMs: 0 },
    });

    assert.deepEqual(
      report.evicted.map((entry) => ({ id: entry.id, reason: entry.reason })),
      [{ id: stale, reason: "age" }],
    );
    assert.deepEqual(listFileNames(join(root, "objects")), [`${fresh}.json`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the orphan grace period protects a just-written, not-yet-linked object from an aggressive sweep", () => {
  const root = tempCacheRoot("mottainai-retention-grace-");
  try {
    // Simulates the window between a producer's cache.put(key, value) and its
    // following cache.putManifest(...): the object exists but nothing
    // references it yet.
    const hash = hashOf("in-flight-object");
    writeObject(root, hash, BASE_NOW);

    const report = runSemanticFactCacheGc({
      rootDir: root,
      now: BASE_NOW,
      dryRun: false,
      policy: { maxObjectAgeMs: 0, maxTotalObjectBytes: 0, maxOrphanObjectCount: 0, orphanGraceMs: DEFAULT_SEMANTIC_FACT_CACHE_RETENTION_POLICY.orphanGraceMs },
    });

    assert.equal(report.evicted.length, 0);
    assert.deepEqual(listFileNames(join(root, "objects")), [`${hash}.json`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excess manifests beyond maxManifestCount are evicted oldest-first by mtime", () => {
  const root = tempCacheRoot("mottainai-retention-count-");
  try {
    const h1 = hashOf("worktree-1");
    const h2 = hashOf("worktree-2");
    const h3 = hashOf("worktree-3");
    writeManifest(root, "m1.json", "w1", h1, BASE_NOW - 3 * DAY_MS);
    writeManifest(root, "m2.json", "w2", h2, BASE_NOW - 2 * DAY_MS);
    writeManifest(root, "m3.json", "w3", h3, BASE_NOW - 1 * DAY_MS);
    writeObject(root, h1, BASE_NOW - 3 * DAY_MS);
    writeObject(root, h2, BASE_NOW - 2 * DAY_MS);
    writeObject(root, h3, BASE_NOW - 1 * DAY_MS);

    const report = runSemanticFactCacheGc({
      rootDir: root,
      now: BASE_NOW,
      dryRun: false,
      policy: { maxManifestCount: 2 },
    });

    assert.deepEqual(
      report.evicted.map((entry) => ({ kind: entry.kind, id: entry.id, reason: entry.reason })),
      [{ kind: "manifest", id: "m1.json", reason: "count" }],
    );
    assert.deepEqual(listFileNames(join(root, "manifests")), ["m2.json", "m3.json"].sort());
    // h1's object is orphaned by the manifest eviction above but survives this
    // same pass under the (generous, default) object age/size budget — GC
    // does not need two passes to be safe, but it also does not need to be
    // instantaneous about reclaiming newly-orphaned space.
    assert.deepEqual(listFileNames(join(root, "objects")), [`${h1}.json`, `${h2}.json`, `${h3}.json`].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan objects beyond the size/count budget are evicted oldest-first once past the grace period", () => {
  const root = tempCacheRoot("mottainai-retention-budget-");
  try {
    const oldest = hashOf("budget-oldest");
    const middle = hashOf("budget-middle");
    const newest = hashOf("budget-newest");
    writeObject(root, oldest, BASE_NOW - 3 * DAY_MS, 100);
    writeObject(root, middle, BASE_NOW - 2 * DAY_MS, 100);
    writeObject(root, newest, BASE_NOW - 1 * DAY_MS, 100);

    const report = runSemanticFactCacheGc({
      rootDir: root,
      now: BASE_NOW,
      dryRun: false,
      policy: { maxOrphanObjectCount: 2, orphanGraceMs: 0 },
    });

    assert.deepEqual(
      report.evicted.map((entry) => ({ id: entry.id, reason: entry.reason })),
      [{ id: oldest, reason: "count" }],
    );
    assert.deepEqual(listFileNames(join(root, "objects")), [`${middle}.json`, `${newest}.json`].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a structurally invalid manifest is evicted unconditionally as corrupt", () => {
  const root = tempCacheRoot("mottainai-retention-corrupt-");
  try {
    const manifestsDir = join(root, "manifests");
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(join(manifestsDir, "broken.json"), "{ not json");
    writeFileSync(join(manifestsDir, "missing-fields.json"), JSON.stringify({ formatVersion: 1 }));

    const report = runSemanticFactCacheGc({ rootDir: root, now: BASE_NOW, dryRun: false });

    assert.deepEqual(
      report.evicted.map((entry) => entry.id).sort(),
      ["broken.json", "missing-fields.json"],
    );
    assert.ok(report.evicted.every((entry) => entry.reason === "corrupt"));
    assert.deepEqual(listFileNames(manifestsDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry run / inspect reports the plan without deleting anything", () => {
  const root = tempCacheRoot("mottainai-retention-dryrun-");
  try {
    const stale = hashOf("dryrun-stale-orphan");
    writeObject(root, stale, BASE_NOW - 20 * DAY_MS);

    const inspection = inspectSemanticFactCache({ rootDir: root, now: BASE_NOW, policy: { maxObjectAgeMs: 14 * DAY_MS, orphanGraceMs: 0 } });

    assert.equal(inspection.dryRun, true);
    assert.equal(inspection.evicted.length, 1);
    assert.equal(inspection.evicted[0]?.id, stale);
    // Nothing was actually removed.
    assert.deepEqual(listFileNames(join(root, "objects")), [`${stale}.json`]);

    const committed = runSemanticFactCacheGc({ rootDir: root, now: BASE_NOW, dryRun: false, policy: { maxObjectAgeMs: 14 * DAY_MS, orphanGraceMs: 0 } });
    assert.equal(committed.dryRun, false);
    assert.deepEqual(listFileNames(join(root, "objects")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnJsonScript(script: string): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout });
      else rejectPromise(new Error(`concurrent reader failed (${code}): ${stderr}`));
    });
  });
}

test("GC running alongside an active reader never corrupts the cache or evicts the entry the reader is using", async () => {
  const cacheRoot = tempCacheRoot("mottainai-retention-concurrent-");
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    // Populate one real, reachable manifest+object pair the way the model
    // compiler actually does (#53's only caller of this cache).
    compileRepositoryModel({ rootDir: fixtureRoot, cache });
    const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
    assert.equal(cache.get(identity.key).status, "hit");
    assert.equal(cache.getManifest(identity.worktree.id).status, "hit");

    // Seed old, unreferenced objects so a real GC pass has genuine work to do
    // concurrently with the reader, instead of a no-op sweep.
    const orphanHashes: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const hash = hashOf(`concurrent-orphan-${index}`);
      writeObject(cacheRoot, hash, Date.now() - 40 * DAY_MS);
      orphanHashes.push(hash);
    }

    const storeModuleUrl = new URL("./store.ts", import.meta.url).href;
    const readerScript = `
      const { FileSystemSemanticFactCache } = await import(${JSON.stringify(storeModuleUrl)});
      const cache = new FileSystemSemanticFactCache({ rootDir: ${JSON.stringify(cacheRoot)} });
      const key = ${JSON.stringify(identity.key)};
      const worktreeId = ${JSON.stringify(identity.worktree.id)};
      const until = Date.now() + 700;
      const badStatuses = [];
      let iterations = 0;
      while (Date.now() < until) {
        const objectResult = cache.get(key);
        const manifestResult = cache.getManifest(worktreeId);
        iterations += 1;
        if (objectResult.status !== "hit") badStatuses.push({ kind: "object", status: objectResult.status });
        if (manifestResult.status !== "hit") badStatuses.push({ kind: "manifest", status: manifestResult.status });
      }
      process.stdout.write(JSON.stringify({ iterations, badStatuses }));
    `;

    const readerPromise = spawnJsonScript(readerScript);

    const gcPolicy: Partial<SemanticFactCacheRetentionPolicy> = {
      maxObjectAgeMs: 1 * DAY_MS,
      orphanGraceMs: 0,
    };
    const deadline = Date.now() + 700;
    let gcPasses = 0;
    while (Date.now() < deadline) {
      runSemanticFactCacheGc({ rootDir: cacheRoot, dryRun: false, policy: gcPolicy });
      gcPasses += 1;
    }

    const { stdout } = await readerPromise;
    const readerReport = JSON.parse(stdout) as { iterations: number; badStatuses: unknown[] };

    assert.equal(readerReport.badStatuses.length, 0, JSON.stringify(readerReport.badStatuses));
    assert.ok(readerReport.iterations > 0);
    assert.ok(gcPasses > 0);

    // The actively-referenced entry survived every concurrent GC pass.
    assert.equal(cache.get(identity.key).status, "hit");
    assert.equal(cache.getManifest(identity.worktree.id).status, "hit");

    // GC still did real, useful work: the stale orphans are gone.
    const remainingObjects = listFileNames(join(cacheRoot, "objects"));
    for (const hash of orphanHashes) {
      assert.equal(remainingObjects.includes(`${hash}.json`), false);
    }
    assert.deepEqual(remainingObjects, [`${identity.key.value}.json`]);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
