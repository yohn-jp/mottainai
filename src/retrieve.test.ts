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
  const store = new InMemoryArtifactStore({ createId: () => "bounded", maxBytes: 16 });
  const id = store.putArtifact({ text: "x".repeat(100), metadata: { operation: "test" } });
  const result = store.retrieve(id);
  assert.ok(result);
  assert.match(result.text, /artifact truncated bytes=100 max=16/);
});
