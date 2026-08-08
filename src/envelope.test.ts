import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCapabilityIndex } from "./adaptive/capabilities.js";
import { BUILTIN_POLICY } from "./adaptive/policy.js";
import { adaptiveTools, callAdaptiveTool } from "./adaptive/tools.js";
import { createTraceStore } from "./adaptive/trace.js";
import { brokerTools, callBrokerTool } from "./broker.js";
import { buildCatalog } from "./catalog.js";
import { resolveGatewayConfig } from "./config.js";
import { ProcessRegistry } from "./context-runtime/process-registry.js";
import { output } from "./envelope.js";
import { callLocalTool, localTools } from "./local-tools.js";
import { InMemoryArtifactStore } from "./retrieve.js";

const requiredTypes = { operation: "string", status: "string", summary: "string", facts: "array", diagnostics: "array", metrics: "object", result_id: "string", truncated: "boolean" } as const;

function assertEnvelope(result: Awaited<ReturnType<typeof callLocalTool>>, toolName: string): void {
  const content = result.structuredContent as Record<string, unknown>;
  const tool = [...localTools, ...adaptiveTools, ...brokerTools].find((candidate) => candidate.name === toolName);
  assert.ok(tool, `${toolName} missing`);
  assert.deepEqual(tool.outputSchema?.required, Object.keys(requiredTypes));
  for (const [key, expected] of Object.entries(requiredTypes)) {
    const value = content[key];
    assert.notEqual(value, undefined, `${key} missing`);
    assert.equal(Array.isArray(value) ? "array" : typeof value, expected, `${key} type`);
  }
}

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

test("all local tools return the required result envelope", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-envelope-"));
  fs.writeFileSync(path.join(directory, "fixture.txt"), "needle\n");
  const config = resolveGatewayConfig({ workspaceRoot: directory }, directory);
  const store = new InMemoryArtifactStore();
  const processes = new ProcessRegistry();
  const exec = await callLocalTool("mottainai_exec", { command: "printf envelope" }, config, store);
  const started = await callLocalTool("mottainai_exec_start", { command: "printf envelope" }, config, store, undefined, undefined, processes);
  assertEnvelope(started, "mottainai_exec_start");
  const handle = (started.structuredContent as Record<string, string>).handle;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["mottainai_exec", { command: "printf envelope" }],
    ["mottainai_exec_await", { handle }],
    ["mottainai_read", { path: "fixture.txt" }],
    ["mottainai_search", { query: "needle" }],
    ["mottainai_list", { path: ".", depth: 0 }],
    ["mottainai_result_get", { id: (exec.structuredContent as Record<string, string>).result_id }],
    ["mottainai_result_search", { query: "envelope" }],
    ["mottainai_runtime_status", {}],
    ["mottainai_telemetry_summary", {}],
  ];
  for (const [name, args] of cases) {
    assertEnvelope(await callLocalTool(name, args, config, store, undefined, undefined, processes), name);
  }
  assert.deepEqual(
    [...cases.map(([name]) => name), "mottainai_exec_start"].sort(),
    localTools.map((tool) => tool.name).sort(),
    "every local tool needs an envelope case",
  );
});

test("all adaptive routing tools return the required result envelope", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-envelope-adaptive-"));
  const context = {
    traceStore: createTraceStore({ MOTTAINAI_TRACE_DIR: path.join(directory, "trace") }),
    capabilityIndex: buildCapabilityIndex([]),
    loadPolicy: () => BUILTIN_POLICY,
    policyDir: path.join(directory, "policy"),
    artifactStore: new InMemoryArtifactStore(),
  };
  const plan = await callAdaptiveTool("mottainai_plan", { task: { category: "bug_investigation" } }, context);
  assertEnvelope(plan, "mottainai_plan");
  const requestId = (plan.structuredContent as Record<string, string>).request_id;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["mottainai_review", { request_id: requestId, expected_found: true, sufficient: true }],
    ["mottainai_execution_review", { request_id: requestId, execution_id: "ex_missing", useful: false }],
    ["mottainai_policy_stats", {}],
    ["mottainai_policy_propose", { write: false }],
  ];
  for (const [name, args] of cases) assertEnvelope(await callAdaptiveTool(name, args, context), name);
});

test("brokered search and describe return the required result envelope", async () => {
  const catalog = buildCatalog(
    [{
      config: { name: "codegraph", command: "noop" },
      client: {} as never,
      tools: [{ name: "explore", description: "Explore symbols.", inputSchema: { type: "object" } }],
    }],
    [{ name: "codegraph", command: "noop", capabilities: ["definitions"] }],
  );
  const context = {
    catalog: async () => catalog, upstreams: {} as never, logger: {} as never, artifactStore: new InMemoryArtifactStore(),
    gatewayConfig: resolveGatewayConfig(undefined),
  };

  assertEnvelope(await callBrokerTool("mottainai_tool_search", { query: "explore" }, context), "mottainai_tool_search");
  const id = catalog.tools()[0].id;
  assertEnvelope(await callBrokerTool("mottainai_tool_describe", { id }, context), "mottainai_tool_describe");

  // brokered call は upstream 結果をそのまま返すため envelope 対象外。outputSchema も持たない。
  assert.equal(brokerTools.find((tool) => tool.name === "mottainai_tool_call")?.outputSchema, undefined);
});
