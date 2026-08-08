import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveGatewayConfig } from "../config.js";
import { InMemoryArtifactStore } from "../retrieve.js";
import { finalizeToolResult } from "./adapter.js";
import { applyResponseBudget, MIN_RESPONSE_BUDGET, projectedBytes, resolveResponseBudget } from "./budget.js";
import { BurstBudgetController } from "./burst-budget.js";
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

function successResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      operation: "exec",
      status: "success",
      summary: `ran ${text}`,
      facts: [],
      diagnostics: [],
      metrics: { duration_ms: 5 },
      result_id: "",
      truncated: false,
      output: text.repeat(200),
    },
  };
}

test("finalizeToolResult: burst budget never discards tool execution or the retrievable full result", () => {
  const store = new InMemoryArtifactStore({ createId: () => "burst" });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const burst = new BurstBudgetController({
    mode: "enforce", maxConcurrentProjectedTokens: 1, rollingWindowMs: 1_000, rollingProjectedTokens: 1, rollingProjectedBytes: 1,
  });
  const finalized = finalizeToolResult(successResult("hello world"), config, store, burst);
  const structured = finalized.result.structuredContent as Record<string, unknown>;
  assert.equal(typeof structured.result_id, "string");
  assert.ok(String(structured.result_id).length > 0, "burst reduction must still leave a retrievable result_id");
  const retrieved = store.retrieve(String(structured.result_id));
  assert.ok(retrieved, "full result must remain retrievable even when burst-reduced");
  assert.match(retrieved!.text, /hello world/);
});

test("finalizeToolResult: burst-reduced response retains status/summary/result_id/truncated and burst_budget omission reason", () => {
  const store = new InMemoryArtifactStore({ createId: () => "burst2" });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const burst = new BurstBudgetController({
    mode: "enforce", maxConcurrentProjectedTokens: 1, rollingWindowMs: 1_000, rollingProjectedTokens: 1, rollingProjectedBytes: 1,
  });
  const finalized = finalizeToolResult(successResult("verbose output here"), config, store, burst);
  const structured = finalized.result.structuredContent as Record<string, unknown>;
  assert.equal(structured.operation, "exec");
  assert.equal(structured.status, "success");
  assert.equal(typeof structured.summary, "string");
  assert.equal(structured.truncated, true);
  const projection = structured.projection as { omissions: Array<{ field: string; reason: string }> };
  assert.ok(projection.omissions.some((omission) => omission.reason === "burst_budget"));
});

test("finalizeToolResult: mode off leaves responses unaffected by burst budget even under a starved policy", () => {
  const store = new InMemoryArtifactStore({ createId: () => "burst3" });
  const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
  const burst = new BurstBudgetController({
    mode: "off", maxConcurrentProjectedTokens: 1, rollingWindowMs: 1_000, rollingProjectedTokens: 1, rollingProjectedBytes: 1,
  });
  const withoutBurst = finalizeToolResult(successResult("hello world"), config, store);
  const withBurst = finalizeToolResult(successResult("hello world"), config, store, burst);
  assert.deepEqual(withBurst.result.structuredContent, withoutBurst.result.structuredContent);
});

test(
  "finalizeToolResult: a still in-flight failure's reserved priority squeezes a concurrently finalized verbose success",
  () => {
    const store = new InMemoryArtifactStore({ createId: () => "burst4" });
    const config = resolveGatewayConfig({ workspaceRoot: process.cwd() });
    const burst = new BurstBudgetController({
      mode: "enforce", maxConcurrentProjectedTokens: 200, rollingWindowMs: 1_000, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000,
    });
    // 失敗呼び出しはまだ finalize されていない（= 他 upstream からの応答待ちなどで in-flight）が、
    // envelope 分はすでに reserve 済み。この状態で並行する成功応答を finalize すると、
    // 失敗側の静的優先度（isBlocking）が成功側の optional projection を押し出す。
    const inFlightFailureReservation = burst.reserveEnvelope(true);
    const successFinalized = finalizeToolResult(successResult("verbose success payload".repeat(50)), config, store, burst);
    burst.release(inFlightFailureReservation);

    const successStructured = successFinalized.result.structuredContent as Record<string, unknown>;
    assert.equal(successStructured.truncated, true, "success response should be squeezed by the reserved failure priority");
    const projection = successStructured.projection as { omissions: Array<{ reason: string }> };
    assert.ok(projection.omissions.some((omission) => omission.reason === "burst_budget"));
  },
);
