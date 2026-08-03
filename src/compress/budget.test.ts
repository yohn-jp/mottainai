import assert from "node:assert/strict";
import test from "node:test";
import { compactToBudget } from "./budget.js";

test("compactToBudget does not shorten text that already fits the budget", () => {
  const text = "line one\nline two\nline three";
  assert.equal(compactToBudget(text, 1_000, Buffer.byteLength(text)), text);
});

test("compactToBudget shortens text that exceeds the budget, keeping head and tail lines", () => {
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
  const text = lines.join("\n");
  const compacted = compactToBudget(text, 256, Buffer.byteLength(text));

  assert.notEqual(compacted, text);
  assert.match(compacted, /^line 0\n/);
  assert.match(compacted, /line 499$/);
  assert.match(compacted, /⋯ mottainai omitted=\d+ lines sha256=[0-9a-f]{16}; use mottainai_result_get ⋯/);
});
