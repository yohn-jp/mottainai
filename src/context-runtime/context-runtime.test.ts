import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGatewayConfig } from "../config.js";
import { InMemoryArtifactStore } from "../retrieve.js";
import { finalizeToolResult } from "./adapter.js";
import { applyResponseBudget, MIN_RESPONSE_BUDGET, projectedBytes, resolveResponseBudget } from "./budget.js";
import { projectResult, serializeProjectedResult } from "./project.js";
import type { ProjectedResult, ProjectionBudget } from "./types.js";

function projected(overrides: Record<string, unknown> = {}): ProjectedResult {
  return projectResult({
    structuredContent: {
      operation: "exec",
      status: "success",
      summary: "command completed",
      facts: [],
      diagnostics: [],
      metrics: { duration_ms: 10, returned_bytes: 100 },
      result_id: "mx_test",
      truncated: false,
      ...overrides,
    },
    content: [{ type: "text", text: "command completed" }],
  });
}

function assertRequired(result: ProjectedResult): void {
  const structured = serializeProjectedResult(result).structuredContent;
  assert.equal(typeof structured.operation, "string");
  assert.equal(typeof structured.status, "string");
  assert.equal(typeof structured.summary, "string");
  assert.ok(Array.isArray(structured.facts));
  assert.ok(Array.isArray(structured.diagnostics));
  assert.equal(typeof structured.metrics, "object");
  assert.equal(typeof structured.result_id, "string");
  assert.equal(typeof structured.truncated, "boolean");
  assert.equal(JSON.parse(JSON.stringify(structured)).operation, structured.operation);
}

const hardBudget: ProjectionBudget = { softTokens: 150, hardTokens: 300, hardBytes: 1_200 };

test("projection omits successful verbose output and records retrieval metadata", () => {
  const result = projectResult({
    structuredContent: {
      ...serializeProjectedResult(projected()).structuredContent,
      output: "verbose output",
    },
    content: [{ type: "text", text: "command completed" }],
  });
  assert.equal(
    result.fields.some((field) => field.key === "output"),
    false,
  );
  assert.deepEqual(result.omissions, [
    {
      field: "output",
      reason: "verbose successful output omitted by default",
      retrievalAvailable: true,
    },
  ]);
  assert.equal(result.truncated, true);
});

test("budget removes lower-priority fields before actionable data", () => {
  const result = applyResponseBudget(
    projected({
      failure_classification: "typescript",
      next_command: "mottainai_result_get id=mx_test",
      extra_verbose: "x".repeat(12_000),
    }),
    hardBudget,
  );
  const structured = serializeProjectedResult(result).structuredContent;
  assert.equal(structured.failure_classification, "typescript");
  assert.equal(structured.next_command, "mottainai_result_get id=mx_test");
  assert.equal("extra_verbose" in structured, false);
  assert.ok(result.omissions.some((omission) => omission.field === "extra_verbose"));
});

test("soft budget trims optional data while hard byte fallback remains authoritative", () => {
  const result = applyResponseBudget(
    projected({
      text: "medium output ".repeat(1_000),
      entries: Array.from({ length: 100 }, (_, index) => `entry-${index}`),
    }),
    hardBudget,
  );
  assert.ok(projectedBytes(result) <= hardBudget.hardBytes);
  assert.ok(projectedBytes(result) <= hardBudget.softTokens * 4 || result.truncated);
  assertRequired(result);
});

test("one giant optional field cannot break valid structured output", () => {
  const result = applyResponseBudget(projected({ giant: "巨大".repeat(100_000) }), hardBudget);
  const structured = serializeProjectedResult(result).structuredContent;
  assert.ok(projectedBytes(result) <= hardBudget.hardBytes);
  assert.equal("giant" in structured, false);
  assertRequired(result);
});

test("many medium fields are omitted deterministically", () => {
  const input = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, "value ".repeat(100)]));
  const first = applyResponseBudget(projected(input), hardBudget);
  const second = applyResponseBudget(projected(input), hardBudget);
  assert.deepEqual(serializeProjectedResult(first), serializeProjectedResult(second));
  assert.ok(projectedBytes(first) <= hardBudget.hardBytes);
  assertRequired(first);
});

test("blocking diagnostics and structured test results outrank verbose metrics", () => {
  const result = applyResponseBudget(
    projected({
      status: "failed",
      diagnostics: [
        { severity: "error", message: "root cause: " + "details ".repeat(2_000) },
        { severity: "info", message: "optional info" },
      ],
      metrics: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`metric_${index}`, "x".repeat(100)])),
      test_results: {
        format: "tap",
        total: 2,
        pass: 1,
        fail: 1,
        failures: [{ name: "failing test", diagnostic: "assertion failed" }],
        verbose: "x".repeat(20_000),
      },
      output: "failure excerpt\n".repeat(2_000),
    }),
    hardBudget,
  );
  const structured = serializeProjectedResult(result).structuredContent;
  const diagnostics = structured.diagnostics as Array<Record<string, unknown>>;
  assert.equal(diagnostics[0].severity, "error");
  assert.match(String(diagnostics[0].message), /root cause/);
  const tests = structured.test_results as Record<string, unknown>;
  assert.equal(tests.format, "tap");
  assert.equal(tests.fail, 1);
  assert.ok(projectedBytes(result) <= hardBudget.hardBytes);
});

test("smallest supported budget and invalid configuration are explicit", () => {
  assert.deepEqual(resolveResponseBudget(MIN_RESPONSE_BUDGET), MIN_RESPONSE_BUDGET);
  assert.throws(() => resolveResponseBudget({ softTokens: 127 }), /softTokens/);
  assert.throws(() => resolveResponseBudget({ hardTokens: 128 }), /hardTokens/);
  assert.throws(() => resolveResponseBudget({ softTokens: 400, hardTokens: 300 }), /softTokens/);
  assert.throws(() => resolveResponseBudget({ hardBytes: 1_023 }), /hardBytes/);
});

test("finalizer stores omitted raw evidence and preserves error semantics", () => {
  const store = new InMemoryArtifactStore({ createId: () => "context" });
  const config = resolveGatewayConfig({
    workspaceRoot: process.cwd(),
    responseBudget: { softTokens: 128, hardTokens: 256, hardBytes: 1_024 },
  });
  const raw: import("@modelcontextprotocol/sdk/types.js").CallToolResult = {
    content: [{ type: "text", text: "failure" }],
    isError: true,
    structuredContent: {
      operation: "exec",
      status: "failed",
      summary: "failure",
      facts: [],
      diagnostics: [{ severity: "error", message: "failure" }],
      metrics: {},
      result_id: "",
      truncated: false,
      giant: "raw evidence ".repeat(10_000),
    },
  };
  const finalized = finalizeToolResult(raw, config, store);
  assert.equal(finalized.result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(finalized.result), "utf8") <= 1_024);
  const structured = finalized.result.structuredContent as Record<string, unknown>;
  assert.match(String(structured.result_id), /^mx_context$/);
  const retrieved = store.retrieve(String(structured.result_id));
  assert.ok(retrieved);
  assert.match(retrieved.text, /raw evidence/);
  assert.equal(finalized.stats.omittedBytes > 0, true);
});
