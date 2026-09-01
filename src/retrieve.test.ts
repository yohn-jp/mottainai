import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryArtifactStore } from "./retrieve.js";

function serializedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ text }), "utf8");
}

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

test("artifact store reports coherent ranges at the first line, last line, and EOF", () => {
  const store = new InMemoryArtifactStore({ createId: () => "line-bounds" });
  const id = store.put({ content: [{ type: "text", text: "one\ntwo\nthree" }] });

  assert.deepEqual(store.retrieve(id, { startLine: 0, maxLines: 1 }), {
    id,
    text: "one",
    totalLines: 3,
    returnedStartLine: 1,
    returnedEndLine: 1,
    omittedLines: 2,
  });
  assert.deepEqual(store.retrieve(id, { startLine: 2, maxLines: 1 }), {
    id,
    text: "three",
    totalLines: 3,
    returnedStartLine: 3,
    returnedEndLine: 3,
    omittedLines: 2,
  });
  for (const startLine of [3, 100]) {
    assert.deepEqual(store.retrieve(id, { startLine }), {
      id,
      text: "",
      totalLines: 3,
      returnedStartLine: 0,
      returnedEndLine: 0,
      omittedLines: 3,
    });
  }
});

test("artifact store keeps empty artifact range metadata coherent", () => {
  const store = new InMemoryArtifactStore({ createId: () => "empty" });
  const id = store.putArtifact({ text: "" });

  assert.deepEqual(store.retrieve(id), {
    id,
    text: "",
    totalLines: 1,
    returnedStartLine: 1,
    returnedEndLine: 1,
    omittedLines: 0,
  });
  assert.deepEqual(store.retrieve(id, { startLine: 1 }), {
    id,
    text: "",
    totalLines: 1,
    returnedStartLine: 0,
    returnedEndLine: 0,
    omittedLines: 1,
  });
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

test("artifact store keeps unrelated entries when replacing an existing ID at the entry limit", () => {
  const store = new InMemoryArtifactStore({ maxEntries: 2 });
  store.putArtifact({ text: "a" }, "a");
  store.putArtifact({ text: "b" }, "b");
  assert.equal(store.retrieve("a")?.text, "a");

  store.putArtifact({ text: "replacement" }, "a");

  assert.equal(store.retrieve("b")?.text, "b");
  assert.equal(store.retrieve("a")?.text, "replacement");
});

test("artifact store retains exactly the aggregate serialized-byte budget and evicts by LRU when exceeded", () => {
  const budget = serializedTextBytes("first") + serializedTextBytes("second");
  let sequence = 0;
  const store = new InMemoryArtifactStore({
    aggregateByteBudget: budget,
    createId: () => `${++sequence}`,
  });
  const first = store.putArtifact({ text: "first" });
  const second = store.putArtifact({ text: "second" });

  assert.equal(store.retrieve(first)?.text, "first");
  assert.equal(store.retrieve(second)?.text, "second");

  const third = store.putArtifact({ text: "third" });
  assert.equal(store.retrieve(first), undefined);
  assert.equal(store.retrieve(second)?.text, "second");
  assert.equal(store.retrieve(third)?.text, "third");
});

test("artifact store accounts for replacement growth and shrink without changing serialized-byte totals", () => {
  const largeText = "large".repeat(20);
  const budget = serializedTextBytes(largeText);
  const store = new InMemoryArtifactStore({ aggregateByteBudget: budget });

  store.putArtifact({ text: "first" }, "first");
  store.putArtifact({ text: "second" }, "second");
  store.putArtifact({ text: largeText }, "first");

  assert.equal(store.retrieve("first")?.text, largeText);
  assert.equal(store.retrieve("second"), undefined);

  store.putArtifact({ text: "small" }, "first");
  store.putArtifact({ text: "second" }, "second");
  assert.equal(store.retrieve("first")?.text, "small");
  assert.equal(store.retrieve("second")?.text, "second");
});

test("artifact store does not evict unrelated entries when replacement preserves the byte budget", () => {
  const budget = serializedTextBytes("first") + serializedTextBytes("second");
  const store = new InMemoryArtifactStore({ aggregateByteBudget: budget, maxEntries: 2 });

  store.putArtifact({ text: "first" }, "first");
  store.putArtifact({ text: "second" }, "second");
  assert.equal(store.retrieve("first")?.text, "first");

  store.putArtifact({ text: "first" }, "first");

  assert.equal(store.retrieve("second")?.text, "second");
  assert.equal(store.retrieve("first")?.text, "first");
});

test("artifact store treats an expired replacement ID as an ordinary insertion", () => {
  let now = 0;
  const store = new InMemoryArtifactStore({ maxEntries: 2, ttlMs: 10, now: () => now });
  store.putArtifact({ text: "expired" }, "expired");
  now = 5;
  store.putArtifact({ text: "current" }, "current");
  now = 10;

  store.putArtifact({ text: "replacement" }, "expired");

  assert.equal(store.retrieve("current")?.text, "current");
  assert.equal(store.retrieve("expired")?.text, "replacement");
});

test("artifact store removes expired serialized bytes before the next insertion", () => {
  let now = 0;
  const store = new InMemoryArtifactStore({
    aggregateByteBudget: serializedTextBytes("new"),
    ttlMs: 10,
    now: () => now,
  });
  const expired = store.putArtifact({ text: "old" }, "old");
  now = 10;

  assert.deepEqual(store.search("old"), []);
  const current = store.putArtifact({ text: "new" }, "new");
  assert.equal(store.retrieve(expired), undefined);
  assert.equal(store.retrieve(current)?.text, "new");
});

test("artifact store combines count and aggregate-byte pressure with deterministic LRU eviction", () => {
  const budget = serializedTextBytes("a") + serializedTextBytes("b");
  const store = new InMemoryArtifactStore({ aggregateByteBudget: budget, maxEntries: 2 });
  const first = store.putArtifact({ text: "a" }, "first");
  const second = store.putArtifact({ text: "b" }, "second");
  assert.equal(store.retrieve(first)?.text, "a");

  const third = store.putArtifact({ text: "c" }, "third");
  assert.equal(store.retrieve(second), undefined);
  assert.equal(store.retrieve(first)?.text, "a");
  assert.equal(store.retrieve(third)?.text, "c");

  const fourth = store.putArtifact({ text: "dddd" }, "fourth");
  assert.equal(store.retrieve(first), undefined);
  assert.equal(store.retrieve(third), undefined);
  assert.equal(store.retrieve(fourth)?.text, "dddd");
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

test("artifact store keeps large bounded payloads within their exact serialized byte limit", () => {
  const maxBytes = 4 * 1024;
  const inputBytes = 1024 * 1024;
  const escapedUnit = '"\\';
  const cases = [
    { name: "ascii", createText: () => "a".repeat(inputBytes) },
    {
      name: "escaped",
      createText: () => escapedUnit.repeat(Math.ceil(inputBytes / escapedUnit.length)).slice(0, inputBytes),
    },
    { name: "utf8", createText: () => "あ".repeat(Math.floor(inputBytes / 3)) + "x".repeat(inputBytes % 3) },
  ];

  for (const { name, createText } of cases) {
    const metadata = { operation: "large-boundary" };
    const marker = `MARKER-${name}`;
    const store = new InMemoryArtifactStore({ createId: () => name, maxBytes });
    const id = store.putArtifact({ text: `${marker}${createText()}`, metadata });
    const result = store.retrieve(id);
    assert.ok(result, name);
    assert.ok(result.text.includes("artifact truncated"), name);
    assert.equal(result.text.includes("\uFFFD"), false, name);
    assert.ok(Buffer.byteLength(JSON.stringify({ text: result.text, metadata }), "utf8") <= maxBytes, name);
    assert.equal(store.search(marker)[0]?.operation, metadata.operation, name);
  }
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
  assert.throws(
    () => new InMemoryArtifactStore({ aggregateByteBudget: Number.POSITIVE_INFINITY }),
    /aggregateByteBudget/,
  );
  assert.throws(() => new InMemoryArtifactStore({ aggregateByteBudget: 0 }), /aggregateByteBudget/);
});
