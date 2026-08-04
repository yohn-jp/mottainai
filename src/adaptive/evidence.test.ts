import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { evidenceCount, summarizeExecution } from "./evidence.js";

function result(overrides: Partial<CallToolResult>): CallToolResult {
  return { content: [], ...overrides };
}

test("summarizeExecution treats structured-only results (empty content, non-empty facts) as non-empty success", () => {
  const summary = summarizeExecution(result({
    content: [],
    structuredContent: { facts: [{ id: 1 }, { id: 2 }] },
  }));
  assert.equal(summary.status, "success");
  assert.equal(summary.result_count, 2);
});

test("summarizeExecution treats structured-only results with metrics.result_count as non-empty success", () => {
  const summary = summarizeExecution(result({
    content: [],
    structuredContent: { metrics: { result_count: 7 } },
  }));
  assert.equal(summary.status, "success");
  assert.equal(summary.result_count, 7);
});

test("summarizeExecution treats an explicit empty facts array as empty, not a fallback to content", () => {
  const summary = summarizeExecution(result({
    content: [],
    structuredContent: { facts: [] },
  }));
  assert.equal(summary.status, "empty");
  assert.equal(summary.result_count, 0);
});

test("summarizeExecution still reports empty when there is no structured content at all", () => {
  const summary = summarizeExecution(result({ content: [] }));
  assert.equal(summary.status, "empty");
  assert.equal(summary.result_count, 0);
});

test("summarizeExecution ignores non-empty content when structured metrics.result_count says zero", () => {
  const summary = summarizeExecution(result({
    content: [{ type: "text", text: "some evidence" }],
    structuredContent: { metrics: { result_count: 0 } },
  }));
  assert.equal(summary.status, "success");
});

test("evidenceCount rejects invalid metrics.result_count (negative, fractional, NaN) and falls back", () => {
  assert.equal(
    evidenceCount(result({ content: [{ type: "text", text: "a" }], structuredContent: { metrics: { result_count: -1 } } })),
    1,
  );
  assert.equal(
    evidenceCount(result({ content: [{ type: "text", text: "a" }], structuredContent: { metrics: { result_count: 1.5 } } })),
    1,
  );
  assert.equal(
    evidenceCount(result({ content: [{ type: "text", text: "a" }], structuredContent: { metrics: { result_count: Number.NaN } } })),
    1,
  );
});

test("evidenceCount prefers a valid metrics.result_count over facts length", () => {
  assert.equal(
    evidenceCount(result({ structuredContent: { metrics: { result_count: 3 }, facts: [1, 2] } })),
    3,
  );
});

test("evidenceCount falls back to parsing a single JSON array text block when structured data is absent", () => {
  assert.equal(evidenceCount(result({ content: [{ type: "text", text: "[1, 2, 3]" }] })), 3);
});
