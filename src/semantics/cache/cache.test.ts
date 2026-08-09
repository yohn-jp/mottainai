import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serializeSnapshot } from "../ir/serialize.js";
import { createTypeScriptFactCacheIdentity, FileSystemSemanticFactCache, MemorySemanticFactCache } from "./index.js";
import { CacheConflictError, type DerivedFactObject } from "./types.js";
import { extractTypeScriptFacts } from "../extractors/typescript/index.js";
import { compileRepositoryModel } from "../model/compiler.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/typescript");

function counts(snapshot: ReturnType<typeof extractTypeScriptFacts>["snapshot"]): DerivedFactObject["counts"] {
  return {
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
}

function temporaryCopy(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

test("cache hit preserves #53 output and cached objects are immutable", () => {
  const cache = new MemorySemanticFactCache();
  const cold = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
  const warm = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });

  assert.equal(cold.cacheStatus, "miss");
  assert.equal(warm.cacheStatus, "hit");
  assert.equal(serializeSnapshot(cold.snapshot), serializeSnapshot(warm.snapshot));

  const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
  const object = cache.get(identity.key);
  assert.equal(object.status, "hit");
  if (object.status === "hit") {
    object.value.snapshot.derived.facts.length = 0;
    const reread = cache.get(identity.key);
    assert.equal(reread.status, "hit");
    if (reread.status === "hit") assert.ok(reread.value.snapshot.derived.facts.length > 0);
  }
});

test("source, dirty/untracked content, TypeScript options, and package graph changes invalidate deterministically", () => {
  const root = temporaryCopy("mottainai-semantic-cache-input-");
  const cache = new MemorySemanticFactCache();
  try {
    const first = extractTypeScriptFacts({ rootDir: root, cache });
    assert.equal(first.cacheStatus, "miss");

    writeFileSync(join(root, "src", "untracked.ts"), "export const untracked = 1;\n");
    const untracked = extractTypeScriptFacts({ rootDir: root, cache });
    assert.equal(untracked.cacheStatus, "miss");

    writeFileSync(join(root, "src", "untracked.ts"), "export const untracked = 2;\n");
    const changed = extractTypeScriptFacts({ rootDir: root, cache });
    assert.equal(changed.cacheStatus, "miss");

    const optionChanged = extractTypeScriptFacts({ rootDir: root, cache, rootNames: ["src/consumer.ts"] });
    assert.equal(optionChanged.cacheStatus, "miss");

    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    packageJson.version = "1.0.1";
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const packageChanged = extractTypeScriptFacts({ rootDir: root, cache });
    assert.equal(packageChanged.cacheStatus, "miss");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical inputs share facts while worktree manifests stay isolated", () => {
  const firstRoot = temporaryCopy("mottainai-semantic-cache-worktree-a-");
  const secondRoot = temporaryCopy("mottainai-semantic-cache-worktree-b-");
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-store-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    const first = extractTypeScriptFacts({ rootDir: firstRoot, cache });
    const second = extractTypeScriptFacts({ rootDir: secondRoot, cache });
    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.deepEqual(first.snapshot.derived, second.snapshot.derived);
    assert.deepEqual(first.snapshot.graph, second.snapshot.graph);
    assert.notEqual(first.snapshot.integrity.worktree.id, second.snapshot.integrity.worktree.id);
    assert.notEqual(first.snapshot.integrity.worktree.root, second.snapshot.integrity.worktree.root);

    const firstIdentity = createTypeScriptFactCacheIdentity({ rootDir: firstRoot });
    const secondIdentity = createTypeScriptFactCacheIdentity({ rootDir: secondRoot });
    assert.equal(firstIdentity.key.value, secondIdentity.key.value);
    assert.equal(cache.getManifest(firstIdentity.worktree.id).status, "hit");
    assert.equal(cache.getManifest(secondIdentity.worktree.id).status, "hit");
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("filesystem objects are atomic/idempotent and corruption is detected", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-atomic-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    const extracted = extractTypeScriptFacts({ rootDir: fixtureRoot });
    const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
    const object: DerivedFactObject = { kind: "typescript-fact-snapshot", snapshot: extracted.snapshot, counts: counts(extracted.snapshot) };
    const writers = await Promise.all([
      Promise.resolve().then(() => cache.put(identity.key, object)),
      Promise.resolve().then(() => cache.put(identity.key, object)),
    ]);
    assert.deepEqual(writers.map((result) => result.status).sort(), ["existing", "written"]);

    const conflicting = { ...object, counts: { ...object.counts, files: object.counts.files + 1 } };
    assert.throws(() => cache.put(identity.key, conflicting), CacheConflictError);

    const objectPath = join(cacheRoot, "objects", `${identity.key.value}.json`);
    writeFileSync(objectPath, "{\"formatVersion\":1");
    const corrupted = cache.get(identity.key);
    assert.equal(corrupted.status, "corrupt");
    assert.match(corrupted.status === "corrupt" ? corrupted.reason : "", /JSON/u);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("model compiler consumes cache optionally and deletion returns to an equivalent cold rebuild", () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-model-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    const cold = compileRepositoryModel({ rootDir: fixtureRoot, cache });
    const warm = compileRepositoryModel({ rootDir: fixtureRoot, cache });
    assert.equal(cold.benchmark.cacheStatus, "miss");
    assert.equal(warm.benchmark.cacheStatus, "hit");
    assert.equal(warm.benchmark.cacheHit, true);
    assert.equal(cold.query.getProject().project.id, warm.query.getProject().project.id);

    rmSync(cacheRoot, { recursive: true, force: true });
    const rebuilt = compileRepositoryModel({ rootDir: fixtureRoot, cache: new FileSystemSemanticFactCache({ rootDir: cacheRoot }) });
    assert.equal(rebuilt.benchmark.cacheStatus, "miss");
    assert.equal(serializeSnapshot(cold.snapshot!), serializeSnapshot(rebuilt.snapshot!));
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
