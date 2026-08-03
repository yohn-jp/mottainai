import assert from "node:assert/strict";
import { test } from "node:test";
import { output } from "./envelope.js";

test("output keeps envelope fields authoritative and accepts typed optional fields", () => {
  const result = output("read", "failed", "operation failed", "mx_result", {
    operation: "spoofed",
    status: "success",
    summary: "spoofed",
    result_id: "spoofed",
    facts: ["fact"],
    diagnostics: [{ message: "detail" }],
    metrics: { attempts: 2 },
    truncated: true,
    test_results: { passed: 1 },
    extension: "kept",
  });
  const structured = result.structuredContent as Record<string, unknown>;

  assert.equal(structured.operation, "read");
  assert.equal(structured.status, "failed");
  assert.equal(structured.summary, "operation failed");
  assert.equal(structured.result_id, "mx_result");
  assert.deepEqual(structured.facts, ["fact"]);
  assert.deepEqual(structured.diagnostics, [{ message: "detail" }]);
  assert.deepEqual(structured.metrics, { attempts: 2 });
  assert.equal(structured.truncated, true);
  assert.deepEqual(structured.test_results, { passed: 1 });
  assert.equal(structured.extension, "kept");
});

test("output falls back to typed defaults for invalid reserved details", () => {
  const result = output("read", "success", "ok", "mx_result", {
    facts: "invalid",
    diagnostics: null,
    metrics: [],
    truncated: "true",
    test_results: [],
  });
  const structured = result.structuredContent as Record<string, unknown>;

  assert.deepEqual(structured.facts, []);
  assert.deepEqual(structured.diagnostics, []);
  assert.deepEqual(structured.metrics, {});
  assert.equal(structured.truncated, false);
  assert.equal("test_results" in structured, false);
});

test("output preserves the error flag independently of details", () => {
  const result = output("read", "failed", "failed", "mx_result", {}, true);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as Record<string, unknown>).isError, undefined);
});

test("output does not let details.isError leak into structuredContent", () => {
  const result = output("read", "success", "ok", "mx_result", { isError: true });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as Record<string, unknown>).isError, undefined);
});
