import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseBlankLines,
  collapseDuplicateLines,
  filterLines,
  truncateExcessLines,
  truncateLongLines,
} from "./lines.js";

test("collapseDuplicateLines keeps up to maxConsecutive and adds a marker", () => {
  const input = ["a", "a", "a", "a", "b"].join("\n");
  const out = collapseDuplicateLines(input, 1);
  assert.equal(out, ["a", "⋯ 3 duplicate lines omitted ⋯", "b"].join("\n"));
});

test("collapseDuplicateLines is a no-op when no run exceeds the limit", () => {
  const input = ["a", "b", "c"].join("\n");
  assert.equal(collapseDuplicateLines(input, 1), input);
});

test("collapseDuplicateLines exact-boundary run does not emit a marker", () => {
  const input = ["a", "a", "b"].join("\n");
  assert.equal(collapseDuplicateLines(input, 2), input);
});

test("collapseBlankLines keeps up to maxConsecutive blank lines", () => {
  const input = ["a", "", "", "", "b"].join("\n");
  assert.equal(collapseBlankLines(input, 1), ["a", "", "b"].join("\n"));
});

test("truncateLongLines truncates lines longer than the limit", () => {
  const input = "x".repeat(10);
  assert.equal(truncateLongLines(input, 5), "xxxxx…(+5 chars)");
});

test("truncateLongLines leaves lines at or under the limit untouched", () => {
  const input = "x".repeat(5);
  assert.equal(truncateLongLines(input, 5), input);
});

test("truncateExcessLines keeps head/tail and omits the middle", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
  const input = lines.join("\n");
  const out = truncateExcessLines(input, 3, 2, 5);
  assert.equal(out, ["L0", "L1", "L2", "⋯ 5 lines omitted ⋯", "L8", "L9"].join("\n"));
});

test("truncateExcessLines is a no-op when under the limit", () => {
  const input = ["a", "b"].join("\n");
  assert.equal(truncateExcessLines(input, 3, 2, 5), input);
});

test("filterLines applies rules in order: duplicates, blanks, length, total", () => {
  const lines = ["dup", "dup", "dup", "", "", "x".repeat(20)];
  const input = lines.join("\n");
  const out = filterLines(input, {
    maxConsecutiveDuplicates: 1,
    maxConsecutiveBlankLines: 1,
    maxLineLength: 10,
    maxTotalLines: 100,
    headLines: 70,
    tailLines: 30,
  });
  assert.equal(
    out,
    [
      "dup",
      "⋯ 2 duplicate lines omitted ⋯",
      "",
      "⋯ 1 duplicate lines omitted ⋯",
      "x".repeat(10) + "…(+10 chars)",
    ].join("\n"),
  );
});
