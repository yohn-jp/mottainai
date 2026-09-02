import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify } from "../src/lib/canonical-json.mjs";

test("key order in the source object does not affect output", () => {
  const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 });
  assert.equal(a, b);
});

test("array order is preserved", () => {
  const output = canonicalStringify({ items: [3, 1, 2] });
  assert.match(output, /"items": \[\n\s+3,\n\s+1,\n\s+2\n\s+\]/u);
});

test("undefined values are omitted rather than becoming null", () => {
  const output = canonicalStringify({ a: 1, b: undefined });
  assert.ok(!output.includes("null"));
  assert.ok(!output.includes('"b"'));
});
