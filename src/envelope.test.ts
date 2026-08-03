import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapabilityIndex } from "./adaptive/capabilities.js";
import { BUILTIN_POLICY } from "./adaptive/policy.js";
import { adaptiveTools, callAdaptiveTool } from "./adaptive/tools.js";
import { createTraceStore } from "./adaptive/trace.js";
import { brokerTools, callBrokerTool } from "./broker.js";
import { buildCatalog } from "./catalog.js";
import { resolveGatewayConfig } from "./config.js";
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

test("all local tools return the required result envelope", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-envelope-"));
  fs.writeFileSync(path.join(directory, "fixture.txt"), "needle\n");
  const config = resolveGatewayConfig({ workspaceRoot: directory }, directory);
  const store = new InMemoryArtifactStore();
  const exec = await callLocalTool("mottainai_exec", { command: "printf envelope" }, config, store);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["mottainai_exec", { command: "printf envelope" }],
    ["mottainai_read", { path: "fixture.txt" }],
    ["mottainai_search", { query: "needle" }],
    ["mottainai_list", { path: ".", depth: 0 }],
    ["mottainai_result_get", { id: (exec.structuredContent as Record<string, string>).result_id }],
    ["mottainai_result_search", { query: "envelope" }],
    ["mottainai_runtime_status", {}],
    ["mottainai_telemetry_summary", {}],
  ];
  for (const [name, args] of cases) assertEnvelope(await callLocalTool(name, args, config, store), name);
  assert.deepEqual(
    cases.map(([name]) => name).sort(),
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
