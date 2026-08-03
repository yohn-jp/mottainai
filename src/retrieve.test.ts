import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryArtifactStore } from "./retrieve.js";

test("artifact store retrieves original text by ID with a bounded line window", () => {
  const store = new InMemoryArtifactStore({ createId: () => "test", maxEntries: 2 });
  const id = store.put({ content: [{ type: "text", text: "one\ntwo\nthree" }] });

  assert.equal(id, "mx_test");
  assert.deepEqual(store.retrieve(id, { startLine: 1, maxLines: 1 }), {
    id,
    text: "two",
    totalLines: 3,
    returnedStartLine: 2,
    returnedEndLine: 2,
    omittedLines: 2,
  });
});

test("artifact store returns a matching line with requested context", () => {
  const store = new InMemoryArtifactStore({ createId: () => "query" });
  const id = store.put({ content: [{ type: "text", text: "before\nok\nError: broken\nnext" }] });

  const result = store.retrieve(id, { query: "Error", contextLines: 1, maxLines: 2 });
  assert.equal(result?.text, "ok\nError: broken");
  assert.equal(result?.matchLine, 3);
});

test("artifact store keeps the matching line when context exceeds maxLines", () => {
  const store = new InMemoryArtifactStore({ createId: () => "match-window" });
  const id = store.put({ content: [{ type: "text", text: "one\ntwo\nError: broken\nfour" }] });

  const result = store.retrieve(id, { query: "Error", contextLines: 20, maxLines: 1 });
  assert.equal(result?.text, "Error: broken");
  assert.equal(result?.matchLine, 3);
  assert.equal(result?.returnedStartLine, 3);
});

test("artifact store expires entries at the configured TTL", () => {
  let now = 0;
  const store = new InMemoryArtifactStore({ ttlMs: 10, now: () => now, createId: () => "ttl" });
  const id = store.put({ content: [{ type: "text", text: "raw" }] });
  now = 10;

  assert.equal(store.retrieve(id), undefined);
});

test("artifact store evicts the least recently used entry at the configured maximum", () => {
  let sequence = 0;
  const store = new InMemoryArtifactStore({
    maxEntries: 2,
    createId: () => `${++sequence}`,
  });
  const first = store.put({ content: [{ type: "text", text: "first" }] });
  const second = store.put({ content: [{ type: "text", text: "second" }] });
  assert.equal(store.retrieve(first)?.text, "first");
  const third = store.put({ content: [{ type: "text", text: "third" }] });

  assert.equal(store.retrieve(first)?.text, "first");
  assert.equal(store.retrieve(second), undefined);
  assert.equal(store.retrieve(third)?.text, "third");
});

test("artifact store bounds oversized text instead of retaining unbounded output", () => {
  const store = new InMemoryArtifactStore({ createId: () => "bounded", maxBytes: 100 });
  const id = store.putArtifact({ text: "x".repeat(100), metadata: { operation: "test" } });
  const result = store.retrieve(id);
  assert.ok(result);
  assert.match(result.text, /artifact truncated bytes=100 max=100/);
});

test("artifact store truncates oversized UTF-8 text on character boundaries", () => {
  const store = new InMemoryArtifactStore({ createId: () => "utf8", maxBytes: 160 });
  const id = store.putArtifact({ text: "あ".repeat(100), metadata: { operation: "test" } });
  const result = store.retrieve(id);
  assert.ok(result);
  assert.match(result.text, /artifact truncated bytes=300 max=160/);
  assert.equal(result.text.includes("\uFFFD"), false);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 160);
});

test("artifact store bounds oversized stdout and stderr fields", () => {
  const store = new InMemoryArtifactStore({ createId: () => "streams", maxBytes: 160 });
  const id = store.putArtifact({
    text: "small",
    stdout: "あ".repeat(100),
    stderr: "b".repeat(1_000),
    metadata: { operation: "test" },
  });

  const stdout = store.retrieve(id, { stream: "stdout" });
  const stderr = store.retrieve(id, { stream: "stderr" });
  assert.ok(stdout);
  assert.ok(stderr);
  assert.ok(Buffer.byteLength(stdout.text, "utf8") <= 160);
  assert.ok(Buffer.byteLength(stderr.text, "utf8") <= 160);
  assert.ok(stdout.text.length < 100 || stderr.text.length < 1_000);
});

test("artifact store keeps metadata.operation discoverable even when oversized text forces metadata out", () => {
  const store = new InMemoryArtifactStore({ createId: () => "op-preserved", maxBytes: 200 });
  const id = store.putArtifact({
    text: `MARKER${"x".repeat(5_000)}`,
    metadata: { operation: "build", command: "npm test" },
  });

  const results = store.search("MARKER");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, id);
  assert.equal(results[0].operation, "build");
});

test("artifact store rejects invalid retention and byte limits", () => {
  assert.throws(() => new InMemoryArtifactStore({ ttlMs: Number.POSITIVE_INFINITY }), /ttlMs/);
  assert.throws(() => new InMemoryArtifactStore({ ttlMs: -1 }), /ttlMs/);
  assert.throws(() => new InMemoryArtifactStore({ maxEntries: Number.NaN }), /maxEntries/);
  assert.throws(() => new InMemoryArtifactStore({ maxEntries: 1.5 }), /maxEntries/);
  assert.throws(() => new InMemoryArtifactStore({ maxBytes: Number.POSITIVE_INFINITY }), /maxBytes/);
  assert.throws(() => new InMemoryArtifactStore({ maxBytes: 0 }), /maxBytes/);
});
