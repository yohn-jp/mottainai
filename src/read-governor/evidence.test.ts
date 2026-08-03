import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryEvidenceStore } from "./evidence.js";

function baseInput() {
  return {
    repositoryId: "repo-1",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    provider: "codegraph",
    path: "src/foo.ts",
    startLine: 10,
    endLine: 40,
    reason: "codegraph_explore located definition",
  };
}

test("issue() assigns an id, createdAt, and expiresAt", () => {
  const store = new InMemoryEvidenceStore({ now: () => 1000 });
  const evidence = store.issue(baseInput());
  assert.match(evidence.evidenceId, /^rev_/);
  assert.equal(evidence.createdAt, 1000);
  assert.ok(evidence.expiresAt > evidence.createdAt);
});

test("get() returns a previously issued evidence record", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = store.issue(baseInput());
  assert.deepEqual(store.get(evidence.evidenceId), evidence);
});

test("get() returns undefined for an unknown id", () => {
  const store = new InMemoryEvidenceStore();
  assert.equal(store.get("rev_does-not-exist"), undefined);
});

test("get() still returns an expired record so callers can distinguish expired from not-found", () => {
  const store = new InMemoryEvidenceStore({ now: () => 1000, ttlMs: 10 });
  const evidence = store.issue(baseInput());
  assert.equal(store.get(evidence.evidenceId)?.evidenceId, evidence.evidenceId);
  assert.ok(evidence.expiresAt <= 1000 + 10);
});

test("issue() rejects a startLine below 1", () => {
  assert.throws(() => new InMemoryEvidenceStore().issue({ ...baseInput(), startLine: 0 }));
});

test("issue() rejects an endLine before startLine", () => {
  assert.throws(() => new InMemoryEvidenceStore().issue({ ...baseInput(), startLine: 40, endLine: 10 }));
});

test("issue() evicts the oldest entry once maxEntries is reached", () => {
  const store = new InMemoryEvidenceStore({ maxEntries: 1 });
  const first = store.issue(baseInput());
  const second = store.issue({ ...baseInput(), path: "src/bar.ts" });
  assert.equal(store.get(first.evidenceId), undefined);
  assert.equal(store.get(second.evidenceId)?.path, "src/bar.ts");
});

test("constructor rejects invalid retention limits", () => {
  assert.throws(() => new InMemoryEvidenceStore({ ttlMs: Number.POSITIVE_INFINITY }), /ttlMs/);
  assert.throws(() => new InMemoryEvidenceStore({ ttlMs: -1 }), /ttlMs/);
  assert.throws(() => new InMemoryEvidenceStore({ maxEntries: Number.NaN }), /maxEntries/);
  assert.throws(() => new InMemoryEvidenceStore({ maxEntries: 1.5 }), /maxEntries/);
  assert.throws(() => new InMemoryEvidenceStore({ maxEntries: 0 }), /maxEntries/);
});

test("issue() and get() return copies instead of exposing stored evidence", () => {
  const store = new InMemoryEvidenceStore();
  const issued = store.issue(baseInput());
  issued.path = "tampered.ts";
  issued.expiresAt = 0;

  const stored = store.get(issued.evidenceId);
  assert.equal(stored?.path, "src/foo.ts");
  assert.notEqual(stored?.expiresAt, 0);

  if (stored !== undefined) stored.path = "mutated-again.ts";
  assert.equal(store.get(issued.evidenceId)?.path, "src/foo.ts");
});
