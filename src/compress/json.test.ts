import assert from "node:assert/strict";
import { test } from "node:test";
import { compressJsonText, compressJsonValue, tryParseJson } from "./json.js";

test("tryParseJson returns the parsed value for valid JSON", () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
});

test("tryParseJson returns undefined for invalid JSON", () => {
  assert.equal(tryParseJson("not json"), undefined);
});

test("tryParseJson distinguishes JSON null from parse failure", () => {
  assert.equal(tryParseJson("null"), null);
});

test("compressJsonValue preserves array head and tail, and marks the omitted middle", () => {
  const value = [1, 2, 3, 4, 5];
  const out = compressJsonValue(value, { maxArrayItems: 3, tailArrayItems: 1 });
  assert.deepEqual(out, [
    1,
    2,
    {
      __truncated__: true,
      omittedCount: 2,
      totalCount: 5,
      omittedSha256: "8be6d66e9099c68d8feb52ce42478d2153cac2763b784174ae6ae96cd636b596",
    },
    5,
  ]);
});

test("compressJsonValue leaves short arrays untouched", () => {
  const value = [1, 2];
  assert.deepEqual(compressJsonValue(value, { maxArrayItems: 5 }), [1, 2]);
});

test("compressJsonValue truncates long strings", () => {
  const value = "x".repeat(10);
  assert.equal(compressJsonValue(value, { maxStringLength: 5 }), "xxxxx…(+5 chars)");
});

test("compressJsonValue preserves keys, booleans, null, and short strings", () => {
  const value = { keep: "ok", flag: true, empty: null, n: 42 };
  assert.deepEqual(compressJsonValue(value), value);
});

test("compressJsonValue truncates beyond maxDepth", () => {
  const value = { a: { b: { c: "deep" } } };
  const out = compressJsonValue(value, { maxDepth: 1 }) as { a: { b: unknown } };
  assert.equal(out.a.b, "[truncated: max depth exceeded]");
});

test("compressJsonText re-serializes a compressed JSON structure", () => {
  const input = JSON.stringify({ items: [1, 2, 3] });
  const out = compressJsonText(input, { maxArrayItems: 2, tailArrayItems: 1, indent: 0 });
  assert.deepEqual(JSON.parse(out), { items: [1, { __truncated__: true, omittedCount: 1, totalCount: 3, omittedSha256: "038966de9f6b9a901b20b4c6ca8b2a46009feebe031babc842d43690c0bc222b" }, 3] });
});

test("compressJsonText is a no-op on non-JSON input", () => {
  const input = "plain text, not json";
  assert.equal(compressJsonText(input), input);
});

test("compressJsonText honors indent option", () => {
  const input = JSON.stringify({ a: 1 });
  const out = compressJsonText(input, { indent: 2 });
  assert.equal(out, JSON.stringify({ a: 1 }, null, 2));
});
