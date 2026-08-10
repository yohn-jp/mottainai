import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalizeSnapshot, digestCanonicalValue } from "../ir/canonical.js";
import { serializeSnapshot } from "../ir/serialize.js";
import {
  createSnapshotManifest,
  createTypeScriptFactCacheIdentity,
  FileSystemSemanticFactCache,
  materializeFactSnapshot,
  MemorySemanticFactCache,
  toSharedFactSnapshot,
} from "./index.js";
import { CacheConflictError, type DerivedFactObject, type FactCacheKey, type SnapshotManifest } from "./types.js";
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

function runConcurrentWriter(cacheRoot: string, payloadPath: string, key: FactCacheKey): Promise<string> {
  const storeModule = new URL("./store.ts", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    const { FileSystemSemanticFactCache } = await import(${JSON.stringify(storeModule)});
    const cache = new FileSystemSemanticFactCache({ rootDir: ${JSON.stringify(cacheRoot)} });
    const result = cache.put(${JSON.stringify(key)}, JSON.parse(readFileSync(${JSON.stringify(payloadPath)}, "utf8")));
    process.stdout.write(result.status);
  `;
  return new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`concurrent cache writer failed (${code}): ${stderr}`));
    });
  });
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

    symlinkSync("missing-source.ts", join(root, "src", "broken.ts"));
    assert.equal(createTypeScriptFactCacheIdentity({ rootDir: root }).cacheable, false);
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

    const manuallySeeded = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
    assert.equal(manuallySeeded.cacheStatus, "hit");

    const objectPath = join(cacheRoot, "objects", `${identity.key.value}.json`);
    writeFileSync(objectPath, "{\"formatVersion\":1");
    const corrupted = cache.get(identity.key);
    assert.equal(corrupted.status, "corrupt");
    assert.match(corrupted.status === "corrupt" ? corrupted.reason : "", /JSON/u);

    const malformedKey = cache.get({ algorithm: "sha256", value: "../../outside" } as FactCacheKey);
    assert.equal(malformedKey.status, "corrupt");

    const manifest = cache.getManifest(identity.worktree.id);
    assert.equal(manifest.status, "hit");
    const manifestPath = join(cacheRoot, "manifests", `${digestCanonicalValue(identity.worktree.id).value}.json`);
    writeFileSync(manifestPath, JSON.stringify({ formatVersion: 1, worktree: { id: identity.worktree.id } }));
    const corruptedManifest = cache.getManifest(identity.worktree.id);
    assert.equal(corruptedManifest.status, "corrupt");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("separate processes publish one complete object under concurrent writes", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-process-race-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  const extracted = extractTypeScriptFacts({ rootDir: fixtureRoot });
  const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
  const object: DerivedFactObject = {
    kind: "typescript-fact-snapshot",
    snapshot: extracted.snapshot,
    counts: counts(extracted.snapshot),
  };
  const payloadPath = join(cacheRoot, "payload.json");
  writeFileSync(payloadPath, JSON.stringify(object));
  try {
    const results = await Promise.all([
      runConcurrentWriter(cacheRoot, payloadPath, identity.key),
      runConcurrentWriter(cacheRoot, payloadPath, identity.key),
    ]);
    assert.deepEqual(results.sort(), ["existing", "written"]);
    assert.equal(cache.get(identity.key).status, "hit");
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
    assert.ok((cold.benchmark.factExtractionMs ?? 0) >= 0);
    assert.ok((warm.benchmark.factExtractionMs ?? 0) >= 0);
    assert.equal(cold.query.getProject().project.id, warm.query.getProject().project.id);

    const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
    const manifest = cache.getManifest(identity.worktree.id);
    assert.equal(manifest.status, "hit");
    if (manifest.status === "hit") {
      assert.equal(manifest.value.repositoryId, cold.snapshot?.repositoryIdentity.id);
      assert.equal(manifest.value.factKey.value, identity.key.value);
      assert.equal(manifest.value.schemaVersion, cold.snapshot?.schemaVersion);
      assert.equal(manifest.value.sourceFingerprint.value, identity.sourceFingerprint.value);
      assert.equal(manifest.value.extractorFingerprint.value, identity.extractorFingerprint.value);
      assert.equal(manifest.value.declarationFingerprint.value, digestCanonicalValue(null).value);
    }

    rmSync(cacheRoot, { recursive: true, force: true });
    const rebuilt = compileRepositoryModel({ rootDir: fixtureRoot, cache: new FileSystemSemanticFactCache({ rootDir: cacheRoot }) });
    assert.equal(rebuilt.benchmark.cacheStatus, "miss");
    assert.equal(serializeSnapshot(cold.snapshot!), serializeSnapshot(rebuilt.snapshot!));
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

function initGitRepo(root: string, remote?: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Mottainai Test"], { cwd: root });
  if (remote !== undefined) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
}

test("cross-worktree reuse is not blocked by differing repository identity or revision", () => {
  const firstRoot = temporaryCopy("mottainai-semantic-cache-revision-a-");
  const secondRoot = temporaryCopy("mottainai-semantic-cache-revision-b-");
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-revision-store-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    // Distinct remotes (not an explicit repositoryName/packageName option,
    // which legitimately participates in the extractor's optionsFingerprint)
    // so repositoryFingerprint differs purely from automatically-derived git
    // identity.
    initGitRepo(firstRoot, "https://github.com/example/repo-a.git");
    initGitRepo(secondRoot, "https://github.com/example/repo-b.git");
    // Explicit distinct revisions: a rebase/amend/merge that leaves the tree
    // unchanged still moves the commit SHA, so this must not gate reuse.
    const firstOptions = { rootDir: firstRoot, revision: "revision-a" };
    const secondOptions = { rootDir: secondRoot, revision: "revision-b" };
    const firstIdentity = createTypeScriptFactCacheIdentity(firstOptions);
    const secondIdentity = createTypeScriptFactCacheIdentity(secondOptions);
    assert.notEqual(firstIdentity.repositoryFingerprint.value, secondIdentity.repositoryFingerprint.value);
    assert.notEqual(firstIdentity.revisionFingerprint.value, secondIdentity.revisionFingerprint.value);
    // Neither fingerprint is correctness-relevant to the shared fact object:
    // materializeFactSnapshot always overwrites repositoryIdentity,
    // revisionIdentity, and integrity.worktree with the caller's identity.
    assert.equal(firstIdentity.key.value, secondIdentity.key.value);

    const first = extractTypeScriptFacts({ ...firstOptions, cache });
    const second = extractTypeScriptFacts({ ...secondOptions, cache });
    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.deepEqual(first.snapshot.derived, second.snapshot.derived);
    assert.notEqual(first.snapshot.repositoryIdentity.id, second.snapshot.repositoryIdentity.id);
    assert.notEqual(first.snapshot.revisionIdentity?.id, second.snapshot.revisionIdentity?.id);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

function reverseLocaleCompare(this: string, other: string): number {
  return other < this ? -1 : other > this ? 1 : 0;
}

test("digest-relevant file ordering is independent of String.prototype.localeCompare", () => {
  const root = temporaryCopy("mottainai-semantic-cache-locale-");
  const original = String.prototype.localeCompare;
  try {
    const baseline = createTypeScriptFactCacheIdentity({ rootDir: root });
    // Simulate a locale/ICU environment whose collation disagrees with
    // code-unit order; the digest-relevant sort must be fully insensitive.
    String.prototype.localeCompare = reverseLocaleCompare;
    const underAdversarialLocale = createTypeScriptFactCacheIdentity({ rootDir: root });
    assert.equal(underAdversarialLocale.sourceFingerprint.value, baseline.sourceFingerprint.value);
    assert.equal(underAdversarialLocale.moduleResolutionFingerprint.value, baseline.moduleResolutionFingerprint.value);
    assert.equal(underAdversarialLocale.packageGraphFingerprint.value, baseline.packageGraphFingerprint.value);
    assert.equal(underAdversarialLocale.key.value, baseline.key.value);
  } finally {
    String.prototype.localeCompare = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dirty worktree whose git status output exceeds the buffer limit is still reported as dirty", () => {
  const root = temporaryCopy("mottainai-semantic-cache-large-dirty-");
  try {
    initGitRepo(root);
    // git status --porcelain output must exceed gitDirty's maxBuffer (64 KiB)
    // so the ENOBUFS path is exercised instead of a clean single-file diff.
    for (let index = 0; index < 6000; index += 1) {
      writeFileSync(join(root, `untracked-${index}.txt`), "");
    }
    const identity = createTypeScriptFactCacheIdentity({ rootDir: root });
    assert.equal(identity.worktree.dirty, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest persistence failure does not invalidate a valid cache hit", () => {
  const cache = new MemorySemanticFactCache();
  const cold = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
  assert.equal(cold.cacheStatus, "miss");

  const originalPutManifest = cache.putManifest.bind(cache);
  let putManifestAttempts = 0;
  cache.putManifest = (manifest: SnapshotManifest): void => {
    putManifestAttempts += 1;
    throw new Error("simulated manifest write failure");
  };
  try {
    const warm = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
    assert.equal(warm.cacheStatus, "hit");
    assert.equal(serializeSnapshot(warm.snapshot), serializeSnapshot(cold.snapshot));
    assert.ok(putManifestAttempts > 0);
  } finally {
    cache.putManifest = originalPutManifest;
  }
});

test("deleting a cache object or manifest between calls is a miss, not corruption", () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-deleted-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
    const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });

    const objectPath = join(cacheRoot, "objects", `${identity.key.value}.json`);
    rmSync(objectPath);
    assert.equal(cache.get(identity.key).status, "miss");

    const manifestPath = join(cacheRoot, "manifests", `${digestCanonicalValue(identity.worktree.id).value}.json`);
    rmSync(manifestPath);
    assert.equal(cache.getManifest(identity.worktree.id).status, "miss");

    const rebuilt = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
    assert.equal(rebuilt.cacheStatus, "miss");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("manifest validation rejects a degenerate empty worktree id", () => {
  const cache = new MemorySemanticFactCache();
  const extracted = extractTypeScriptFacts({ rootDir: fixtureRoot });
  const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
  const manifest = createSnapshotManifest(identity, extracted.snapshot, digestCanonicalValue(null));
  const degenerate: SnapshotManifest = {
    ...manifest,
    worktree: { ...manifest.worktree, id: "" as SnapshotManifest["worktree"]["id"] },
  };
  assert.throws(() => cache.putManifest(degenerate), TypeError);
});

test("shared and materialized fact snapshots stay canonically ordered even when the source object is shuffled", () => {
  const extracted = extractTypeScriptFacts({ rootDir: fixtureRoot });
  const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
  const canonicalIntegrity = canonicalizeSnapshot(extracted.snapshot).integrity;
  assert.ok(canonicalIntegrity.trackedFiles.length > 1);

  const shuffled = {
    ...extracted.snapshot,
    integrity: {
      ...extracted.snapshot.integrity,
      trackedFiles: [...extracted.snapshot.integrity.trackedFiles].reverse(),
      extractors: [...extracted.snapshot.integrity.extractors].reverse(),
    },
  };
  const shared = toSharedFactSnapshot(shuffled);
  assert.deepEqual(shared.integrity.trackedFiles.map((file) => file.path), canonicalIntegrity.trackedFiles.map((file) => file.path));
  assert.deepEqual(shared.integrity.extractors, canonicalIntegrity.extractors);

  const shuffledShared = {
    ...shared,
    integrity: {
      ...shared.integrity,
      trackedFiles: [...shared.integrity.trackedFiles].reverse(),
      extractors: [...shared.integrity.extractors].reverse(),
    },
  };
  const materialized = materializeFactSnapshot(shuffledShared, identity);
  assert.deepEqual(
    materialized.integrity.trackedFiles.map((file) => file.path),
    canonicalIntegrity.trackedFiles.map((file) => file.path),
  );
  assert.deepEqual(materialized.integrity.extractors, canonicalIntegrity.extractors);
});

test("extractor-only runs never inherit a stale declarationFingerprint from a previous compile", () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-declaration-"));
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  try {
    const baseline = extractTypeScriptFacts({ rootDir: fixtureRoot });
    const compiled = compileRepositoryModel({ rootDir: fixtureRoot, cache, declarations: baseline.snapshot.declarations });
    assert.equal(compiled.benchmark.cacheStatus, "miss");

    const identity = createTypeScriptFactCacheIdentity({ rootDir: fixtureRoot });
    const manifestAfterCompile = cache.getManifest(identity.worktree.id);
    assert.equal(manifestAfterCompile.status, "hit");
    if (manifestAfterCompile.status === "hit") {
      assert.notEqual(manifestAfterCompile.value.declarationFingerprint.value, digestCanonicalValue(null).value);
    }

    const extractorOnly = extractTypeScriptFacts({ rootDir: fixtureRoot, cache });
    assert.equal(extractorOnly.cacheStatus, "hit");
    assert.equal(extractorOnly.cacheManifest?.declarationFingerprint.value, digestCanonicalValue(null).value);

    const manifestAfterExtractorOnly = cache.getManifest(identity.worktree.id);
    assert.equal(manifestAfterExtractorOnly.status, "hit");
    if (manifestAfterExtractorOnly.status === "hit") {
      assert.equal(manifestAfterExtractorOnly.value.declarationFingerprint.value, digestCanonicalValue(null).value);
    }
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
