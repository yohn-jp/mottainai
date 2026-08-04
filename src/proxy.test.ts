import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCapabilityIndex } from "./adaptive/capabilities.js";
import { BUILTIN_POLICY } from "./adaptive/policy.js";
import { createTraceStore } from "./adaptive/trace.js";
import type { TraceStore } from "./adaptive/trace.js";
import type { AdaptiveToolContext } from "./adaptive/tools.js";
import { catalogToolId } from "./catalog.js";
import { resolveGatewayConfig } from "./config.js";
import type { ProfileConfig, ResolvedGatewayConfig } from "./config.js";
import { registerProxyHandlers } from "./proxy.js";
import { UpstreamRegistry } from "./upstream.js";
import type { UpstreamHandle } from "./upstream.js";
import type { Logger, LogRecord } from "./logging.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import { createTelemetrySink } from "./telemetry.js";
import type { TelemetrySink } from "./telemetry.js";
import { EXECUTION_PATHS } from "./execution.js";
import type { ExecutionPath } from "./execution.js";

function fakeHandle(
  name: string,
  tools: Tool[],
  callTool: UpstreamHandle["client"]["callTool"],
  config: Partial<UpstreamHandle["config"]> = {},
): UpstreamHandle {
  return {
    config: { name, command: "noop", ...config },
    client: { callTool } as unknown as UpstreamHandle["client"],
    tools,
  };
}

function registryFromHandles(handles: UpstreamHandle[]): UpstreamRegistry {
  const handlesByName = new Map(handles.map((handle) => [handle.config.name, handle]));
  return new UpstreamRegistry(handles.map((handle) => handle.config), async (config) => {
    const handle = handlesByName.get(config.name);
    if (!handle) throw new Error(`missing fake upstream: ${config.name}`);
    return handle;
  });
}

/** 記録内容を検証できる no-op logger。 */
function fakeLogger(): { logger: Logger; records: Array<Omit<LogRecord, "id" | "timestamp">> } {
  const records: Array<Omit<LogRecord, "id" | "timestamp">> = [];
  return {
    logger: {
      async log(record) {
        records.push(record);
      },
    },
    records,
  };
}

/** プロキシ Server を組み立て、テスト用 Client と in-memory transport で接続する。 */
async function connectedClient(
  upstreams: UpstreamRegistry | UpstreamHandle[],
  logger?: Logger,
  artifactStore?: InMemoryArtifactStore,
  adaptive?: Partial<AdaptiveToolContext>,
  options: { gateway?: ResolvedGatewayConfig; activeProfile?: ProfileConfig; telemetry?: TelemetrySink } = {},
): Promise<Client> {
  const server = new Server(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerProxyHandlers(
    server,
    upstreams instanceof UpstreamRegistry ? upstreams : registryFromHandles(upstreams),
    logger ?? fakeLogger().logger,
    artifactStore,
    options.gateway,
    adaptive ?? { traceStore: createTraceStore({ MOTTAINAI_TRACE: "0" }), loadPolicy: () => BUILTIN_POLICY },
    options.activeProfile,
    options.telemetry ?? createTelemetrySink({}),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function fallbackGateway(capabilityMap: Record<string, string[]>): ResolvedGatewayConfig {
  return resolveGatewayConfig({
    capabilityMap,
    toolMetadata: Object.fromEntries(Object.keys(capabilityMap).map((provider) => [
      `${provider}__explore`, { contract: "explore.v1" },
    ])),
  });
}

test("listTools prefixes each upstream's tool names with '<upstream>__'", async () => {
  const handles = [
    fakeHandle("codegraph", [{ name: "codegraph_explore", inputSchema: { type: "object" } }], async () => ({
      content: [],
    })),
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({ content: [] })),
  ];
  const client = await connectedClient(handles);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "codegraph__codegraph_explore", "fff__grep",
      "mottainai_exec", "mottainai_read", "mottainai_search", "mottainai_list",
      "mottainai_result_get", "mottainai_result_search", "mottainai_runtime_status", "mottainai_telemetry_summary",
      "mottainai_plan", "mottainai_review", "mottainai_execution_review", "mottainai_policy_stats", "mottainai_policy_propose",
      "mottainai_tool_search", "mottainai_tool_describe", "mottainai_tool_call",
      "mottainai_code_search", "mottainai_code_symbol",
      "mottainai_retrieve",
    ],
  );

  const brokerCall = tools.find((tool) => tool.name === "mottainai_tool_call");
  assert.equal(brokerCall?.description, "Run catalog tool by id. Applies same compression and raw-result retention as prefixed calls.");
  assert.equal(
    (brokerCall?.inputSchema as unknown as { properties: { arguments: { description: string } } }).properties.arguments.description,
    "Arguments matching schema from mottainai_tool_describe.",
  );

  await client.close();
});

test("listTools starts enabled registry upstreams and excludes disabled upstreams", async () => {
  const started: string[] = [];
  const registry = new UpstreamRegistry([
    { name: "enabled", command: "node" },
    { name: "disabled", command: "node", enabled: false },
  ], async (config) => {
    started.push(config.name);
    return fakeHandle(config.name, [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [] }));
  });
  const client = await connectedClient(registry);

  const { tools } = await client.listTools();

  assert.ok(tools.some((tool) => tool.name === "enabled__search"));
  assert.ok(!tools.some((tool) => tool.name === "disabled__search"));
  assert.deepEqual(started, ["enabled"]);
  await client.close();
});

test("listTools returns healthy upstream tools when another upstream fails to start", async () => {
  const registry = new UpstreamRegistry([
    { name: "failed", command: "node" },
    { name: "healthy", command: "node" },
  ], async (config) => {
    if (config.name === "failed") throw new Error("unavailable");
    return fakeHandle(config.name, [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [] }));
  });
  const client = await connectedClient(registry);

  const { tools } = await client.listTools();

  assert.ok(tools.some((tool) => tool.name === "healthy__search"));
  assert.ok(!tools.some((tool) => tool.name === "failed__search"));
  assert.equal(registry.state("failed"), "unhealthy");
  await client.close();
});

test("listTools compresses descriptions while preserving every non-description field", async () => {
  const upstreamTool: Tool = {
    name: "search",
    description: "Please search the files in order to find a result.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The query. You can use a literal.",
          minLength: 1,
          examples: ["foo bar", "a\nb"],
        },
        mode: {
          type: "string",
          enum: ["literal", "regex"],
          default: "literal",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
  const sourceSnapshot = structuredClone(upstreamTool);
  const client = await connectedClient([
    fakeHandle("finder", [upstreamTool], async () => ({ content: [] })),
  ]);

  const { tools } = await client.listTools();

  assert.equal(tools[0].name, "finder__search");
  assert.equal(tools[0].description, "search files to find result.");
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "query. use literal.",
        minLength: 1,
        examples: ["foo bar", "a\nb"],
      },
      mode: {
        type: "string",
        enum: ["literal", "regex"],
        default: "literal",
      },
    },
    required: ["query"],
    additionalProperties: false,
  });
  assert.deepEqual(upstreamTool, sourceSnapshot);

  await client.close();
});

test("callTool routes to the upstream named by the prefix, with the prefix stripped", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const handles = [
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async (params) => {
      calls.push(params as { name: string; arguments?: Record<string, unknown> });
      return { content: [{ type: "text", text: "ok" }] };
    }),
  ];
  const client = await connectedClient(handles);

  const result = await client.callTool({ name: "fff__grep", arguments: { query: "x" } });

  assert.deepEqual(calls, [{ name: "grep", arguments: { query: "x" } }]);
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });

  await client.close();
});

test("callTool starts only the requested registry upstream", async () => {
  const started: string[] = [];
  const registry = new UpstreamRegistry([
    { name: "target", command: "node" },
    { name: "other", command: "node" },
  ], async (config) => {
    started.push(config.name);
    return fakeHandle(config.name, [{ name: "run", inputSchema: { type: "object" } }], async () => ({ content: [] }));
  });
  const client = await connectedClient(registry);

  await client.callTool({ name: "target__run", arguments: {} });

  assert.deepEqual(started, ["target"]);
  await client.close();
});

test("local tools return schema-valid structured content through MCP", async () => {
  const client = await connectedClient([]);
  const result = await client.callTool({ name: "mottainai_list", arguments: { path: ".", depth: 0 } });
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  assert.equal(structured?.operation, "list");
  assert.equal(structured?.status, "success");
  assert.equal(typeof structured?.result_id, "string");
  await client.close();
});

test("callTool rejects a tool name with no recognizable upstream prefix", async () => {
  const client = await connectedClient([]);

  await assert.rejects(() => client.callTool({ name: "no_prefix_here" }));

  await client.close();
});

test("callTool compresses text content before returning it to the client", async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const rawJson = JSON.stringify({ items });
  const handles = [
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: rawJson }],
    })),
  ];
  const client = await connectedClient(handles);

  const result = await client.callTool({ name: "fff__grep", arguments: {} });

  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.notEqual(text, rawJson);
  const parsed = JSON.parse(text) as { items: unknown[] };
  assert.equal(parsed.items.length, 21); // 既定maxArrayItems(20) + 省略マーカー1件
  assert.deepEqual(parsed.items[15], {
    __truncated__: true,
    omittedCount: 30,
    totalCount: 50,
    omittedSha256: "e9b68a002a9b810456df51a9fc7db574e53ed5a2d0d56fbfaa0dcf44fc8be03b",
  });
  assert.deepEqual(parsed.items.slice(16), [45, 46, 47, 48, 49]);

  await client.close();
});

test("callTool applies known CLI compression when command argument exists", async () => {
  const client = await connectedClient([
    fakeHandle("shell", [{ name: "run", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "test unit::one ... ok\ntest result: ok. 1 passed" }],
    })),
  ]);

  const result = await client.callTool({ name: "shell__run", arguments: { command: "cargo test" } });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.equal(text, "⋯ 1 successful test lines omitted ⋯\ntest result: ok. 1 passed");

  await client.close();
});

test("compressed result exposes original text through mottainai_retrieve", async () => {
  const raw = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => i) });
  const store = new InMemoryArtifactStore({ createId: () => "original" });
  const client = await connectedClient([
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: raw }],
    })),
  ], undefined, store);

  const compressed = await client.callTool({ name: "fff__grep", arguments: {} });
  const marker = (compressed.content as Array<{ type: string; text: string }>)[1].text;
  assert.equal(marker, "[mottainai compression: original_id=mx_original; retrieve=mottainai_retrieve]");

  const retrieved = await client.callTool({
    name: "mottainai_retrieve",
    arguments: { id: "mx_original", query: '"items"', maxLines: 2 },
  });
  const payload = JSON.parse((retrieved.content as Array<{ text: string }>)[0].text) as { text: string };
  assert.equal(payload.text, raw);

  await client.close();
});

test("callTool passes non-text content through untouched", async () => {
  const handles = [
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
    })),
  ];
  const client = await connectedClient(handles);

  const result = await client.callTool({ name: "fff__grep", arguments: {} });

  assert.deepEqual(result.content, [{ type: "image", data: "base64data", mimeType: "image/png" }]);

  await client.close();
});

test("callTool logs the raw (pre-compression) result", async () => {
  const { logger, records } = fakeLogger();
  const handles = [
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "x".repeat(1000) }],
    })),
  ];
  const client = await connectedClient(handles, logger);

  await client.callTool({ name: "fff__grep", arguments: { q: "needle" } });

  assert.equal(records.length, 1);
  assert.equal(records[0].upstreamName, "fff");
  assert.equal(records[0].toolName, "grep");
  assert.deepEqual(records[0].arguments, { q: "needle" });
  const loggedText = (records[0].rawResult as { content: Array<{ text: string }> }).content[0].text;
  assert.equal(loggedText, "x".repeat(1000)); // 圧縮前の生データがそのまま記録されている

  await client.close();
});

function tracingContext(): { traceStore: TraceStore; adaptive: Partial<AdaptiveToolContext> } {
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-proxy-trace-")), "trace");
  const traceStore = createTraceStore({ MOTTAINAI_TRACE_DIR: directory });
  return {
    traceStore,
    adaptive: {
      traceStore,
      loadPolicy: () => BUILTIN_POLICY,
      capabilityIndex: buildCapabilityIndex([{ name: "codegraph", command: "codegraph", capabilities: ["callers"] }]),
    },
  };
}

function conformanceTraceStore(): TraceStore {
  return createTraceStore({ MOTTAINAI_TRACE_DIR: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-conformance-")), "trace") });
}

test("caller task metadata is traced and stripped before reaching the upstream", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async (params) => {
      calls.push(params as { name: string; arguments?: Record<string, unknown> });
      return { content: [{ type: "text", text: "hit" }] };
    }),
  ], undefined, undefined, adaptive);

  const result = await client.callTool({
    name: "codegraph__explore",
    arguments: {
      query: "compressText",
      _mottainai: {
        task: { category: "bug_investigation", intent: "locate_root_cause", confidence: 0.86 },
        requested_capabilities: ["definitions", "callers"],
      },
    },
  });

  // upstream の schema を壊さないため、予約キーは転送しない
  assert.deepEqual(calls, [{ name: "explore", arguments: { query: "compressText" } }]);

  const traces = traceStore.load();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].request.task_category, "bug_investigation");
  assert.equal(traces[0].request.task_intent, "locate_root_cause");
  assert.deepEqual(traces[0].request.caller_requested_capabilities, ["definitions", "callers"]);
  assert.deepEqual(traces[0].request.planned_capabilities.slice(0, 2), ["definitions", "callers"]);
  assert.deepEqual(traces[0].executions.map((execution) => [execution.provider, execution.capability, execution.status]), [
    ["codegraph", "callers", "success"],
  ]);

  const marker = (result.content as Array<{ text: string }>).at(-1)?.text;
  assert.equal(marker, `[mottainai trace: request_id=${traces[0].request.request_id}]`);

  await client.close();
});

test("mottainai_tool_call records the actual selected provider in trace, not the gateway tool name (issue #47/#48)", async () => {
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "hit" }],
    })),
  ], undefined, undefined, adaptive);

  const id = catalogToolId("codegraph", "explore");
  await client.callTool({
    name: "mottainai_tool_call",
    arguments: {
      id,
      arguments: { query: "x" },
      _mottainai: { task: { category: "bug_investigation" }, capability: "callers" },
    },
  });

  const traces = traceStore.load();
  assert.equal(traces.length, 1);
  // 修正前は gateway tool 名（"mottainai_tool_call"）から provider を推定し、常に "local" になっていた。
  assert.deepEqual(
    traces[0].executions.map((execution) => [execution.provider, execution.tool]),
    [["codegraph", "explore"]],
  );

  await client.close();
});

test("a request_id groups several evidence calls into one trace", async () => {
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "hit" }],
    })),
  ], undefined, undefined, adaptive);

  const first = await client.callTool({
    name: "codegraph__explore",
    arguments: { _mottainai: { task: { category: "symbol_lookup" } } },
  });
  const requestId = traceStore.load()[0].request.request_id;
  assert.equal((first.content as Array<{ text: string }>).at(-1)?.text, `[mottainai trace: request_id=${requestId}]`);

  await client.callTool({
    name: "mottainai_list",
    arguments: { path: ".", depth: 0, _mottainai: { request_id: requestId } },
  });

  const traces = traceStore.load();
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0].executions.map((execution) => `${execution.provider}:${execution.tool}:${execution.capability}`), [
    "codegraph:explore:callers",
    "local:mottainai_list:directory_structure",
  ]);

  await client.close();
});

test("local tool results carry the request_id in structured content", async () => {
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([], undefined, undefined, adaptive);

  const result = await client.callTool({
    name: "mottainai_list",
    arguments: { path: ".", depth: 0, _mottainai: { task: { category: "config_investigation" } } },
  });

  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.request_id, traceStore.load()[0].request.request_id);
  assert.equal(structured.operation, "list");

  await client.close();
});

test("a failed evidence call is recorded as a provider_error execution", async () => {
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => {
      throw new Error("upstream exploded");
    }),
  ], undefined, undefined, adaptive);

  await assert.rejects(() => client.callTool({
    name: "codegraph__explore",
    arguments: { _mottainai: { task: { category: "bug_investigation" }, capability: "callers" } },
  }));

  assert.deepEqual(traceStore.load()[0].executions.map((execution) => execution.status), ["provider_error"]);

  await client.close();
});

test("calls without caller metadata are neither traced nor altered", async () => {
  const { traceStore, adaptive } = tracingContext();
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "hit" }],
    })),
  ], undefined, undefined, adaptive);

  const result = await client.callTool({ name: "codegraph__explore", arguments: { query: "x" } });

  assert.deepEqual(result.content, [{ type: "text", text: "hit" }]);
  assert.deepEqual(traceStore.load(), []);
  assert.equal(fs.existsSync(traceStore.directory), false);

  await client.close();
});

test("invalid caller metadata is rejected before the upstream is called", async () => {
  const { adaptive } = tracingContext();
  let called = false;
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => {
      called = true;
      return { content: [] };
    }),
  ], undefined, undefined, adaptive);

  await assert.rejects(
    () => client.callTool({ name: "codegraph__explore", arguments: { _mottainai: { requested_capabilities: ["callers"] } } }),
    /requires task.category or request_id/,
  );
  assert.equal(called, false);

  await client.close();
});

test("runtime status reports upstream failures without stopping other upstreams", async () => {
  const registry = new UpstreamRegistry(
    [{ name: "healthy", command: "noop" }, { name: "broken", command: "missing" }],
    async (config) => {
      if (config.name === "broken") throw new Error("spawn missing ENOENT");
      return fakeHandle("healthy", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({ content: [] }));
    },
  );
  const client = await connectedClient(registry);

  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "healthy__grep"));
  assert.ok(!tools.some((tool) => tool.name.startsWith("broken__")));

  const result = await client.callTool({ name: "mottainai_runtime_status", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.status, "partial");
  assert.deepEqual(structured.metrics, { providers: 2, ready: 1, unhealthy: 1, disabled: 0 });
  assert.deepEqual(structured.diagnostics, [
    { severity: "error", message: "broken unhealthy: spawn missing ENOENT" },
  ]);
});

test("brokered search, describe and call reach an upstream tool without its prefixed name", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const explore: Tool = {
    name: "codegraph_explore",
    description: "Explore symbol definitions and callers.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "A long upstream description." } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  };
  const { logger, records } = fakeLogger();
  const store = new InMemoryArtifactStore({ createId: () => "brokered" });
  const client = await connectedClient(
    [fakeHandle("codegraph", [explore], async (request) => {
      calls.push(request as { name: string; arguments?: Record<string, unknown> });
      return { content: [{ type: "text", text: "hit\n".repeat(200) }] };
    })],
    logger,
    store,
    undefined,
    { gateway: resolveGatewayConfig({ capabilityMap: { codegraph__codegraph_explore: ["definitions"] } }) },
  );

  const search = await client.callTool({ name: "mottainai_tool_search", arguments: { capability: "definitions" } });
  const hits = (search.structuredContent as { facts: Array<Record<string, unknown>> }).facts;
  assert.equal(hits.length, 1);
  const id = hits[0].id as string;
  assert.equal(id, catalogToolId("codegraph", "codegraph_explore"));
  assert.equal(hits[0].risk, "read_only");
  // 検索結果には upstream の長い description を載せない。
  assert.deepEqual(hits[0].input_schema, {
    type: "object",
    properties: { query: { type: "string", required: true } },
    required: ["query"],
  });

  const described = await client.callTool({ name: "mottainai_tool_describe", arguments: { id } });
  const describedContent = described.structuredContent as Record<string, unknown>;
  // describe は元 schema を無変形で返す。圧縮も要約も通さない。
  assert.deepEqual(describedContent.input_schema, explore.inputSchema);
  assert.equal(describedContent.description, explore.description);

  const called = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: { query: "compressText" } } });
  assert.deepEqual(calls, [{ name: "codegraph_explore", arguments: { query: "compressText" } }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].toolName, "codegraph_explore");
  // prefix 経由と同じ圧縮・artifact 経路を通る。
  const text = (called.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  assert.match(text, /\[mottainai compression: original_id=mx_brokered; retrieve=mottainai_retrieve\]/);

  await assert.rejects(() => client.callTool({ name: "mottainai_tool_describe", arguments: { id: "tl_missing" } }), /unknown catalog tool/);
  await client.close();
});

test("an active profile narrows listTools but never hides the brokered tools", async () => {
  const handles = [
    fakeHandle("codegraph", [
      { name: "explore", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "reindex", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
    ], async () => ({ content: [] })),
    fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], async () => ({ content: [] })),
  ];
  const gateway = resolveGatewayConfig({
    capabilityMap: { codegraph: ["definitions"], fff: ["text_matches"] },
  });
  const client = await connectedClient(handles, undefined, undefined, undefined, {
    gateway,
    activeProfile: { includeCapabilities: ["definitions"], denyRisk: ["destructive"] },
  });

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("codegraph__explore"));
  assert.ok(!names.includes("codegraph__reindex"), "destructive tool is denied by risk");
  assert.ok(!names.includes("fff__grep"), "capability outside the profile is not published");
  for (const brokered of ["mottainai_tool_search", "mottainai_tool_describe", "mottainai_tool_call"]) {
    assert.ok(names.includes(brokered), `${brokered} stays reachable`);
  }

  // 目録は profile で絞らない。公開面が狭くても brokered 経由では到達できる。
  const search = await client.callTool({ name: "mottainai_tool_search", arguments: {} });
  const facts = (search.structuredContent as { facts: Array<Record<string, unknown>> }).facts;
  assert.deepEqual(facts.map((fact) => fact.tool).sort(), ["explore", "grep", "reindex"]);

  await client.close();
});

test("active profile authorization applies to direct and local execution, not only discovery", async () => {
  let upstreamCalls = 0;
  const client = await connectedClient([
    fakeHandle("codegraph", [{ name: "reindex", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } }], async () => {
      upstreamCalls += 1;
      return { content: [{ type: "text", text: "rebuilt" }] };
    }),
  ], undefined, undefined, undefined, { activeProfile: { denyRisk: ["destructive"] } });

  await assert.rejects(() => client.callTool({ name: "codegraph__reindex", arguments: {} }), /tool denied by active profile/);
  await assert.rejects(() => client.callTool({ name: "mottainai_exec", arguments: { command: "printf blocked" } }), /tool denied by active profile/);
  assert.equal(upstreamCalls, 0);

  await client.close();
});

test("rawToolAccess: restricted denies raw tool search/describe/call for tools the profile excludes (#26)", async () => {
  let upstreamCalls = 0;
  const handles = [
    fakeHandle("codegraph", [
      { name: "explore", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "reindex", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
    ], async () => {
      upstreamCalls += 1;
      return { content: [] };
    }),
  ];
  const gateway = resolveGatewayConfig({ capabilityMap: { codegraph__explore: ["definitions"] } });
  const client = await connectedClient(handles, undefined, undefined, undefined, {
    gateway,
    activeProfile: { includeCapabilities: ["definitions"], denyRisk: ["destructive"], rawToolAccess: "restricted" },
  });

  const search = await client.callTool({ name: "mottainai_tool_search", arguments: {} });
  const facts = (search.structuredContent as { facts: Array<Record<string, unknown>> }).facts;
  assert.deepEqual(facts.map((fact) => fact.tool), ["explore"], "reindex is destructive and excluded from search");

  const deniedId = catalogToolId("codegraph", "reindex");
  await assert.rejects(
    () => client.callTool({ name: "mottainai_tool_describe", arguments: { id: deniedId } }),
    /denied by active profile rawToolAccess/,
  );
  await assert.rejects(
    () => client.callTool({ name: "mottainai_tool_call", arguments: { id: deniedId, arguments: {} } }),
    /denied by active profile rawToolAccess/,
  );
  assert.equal(upstreamCalls, 0, "restricted raw calls reject before upstream execution");

  const allowedId = catalogToolId("codegraph", "explore");
  const described = await client.callTool({ name: "mottainai_tool_describe", arguments: { id: allowedId } });
  const describedFacts = (described.structuredContent as { facts: Array<Record<string, unknown>> }).facts;
  assert.equal(describedFacts[0].tool, "explore");
  const allowedCall = await client.callTool({ name: "mottainai_tool_call", arguments: { id: allowedId, arguments: {} } });
  assert.ok(!allowedCall.isError);
  assert.equal(upstreamCalls, 1);

  await client.close();
});

test("rawToolAccess left unset (open) keeps raw tool search/describe/call reachable even under a restrictive profile", async () => {
  const handles = [
    fakeHandle("codegraph", [
      { name: "reindex", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
    ], async () => ({ content: [] })),
  ];
  const gateway = resolveGatewayConfig({});
  const client = await connectedClient(handles, undefined, undefined, undefined, {
    gateway,
    activeProfile: { denyRisk: ["destructive"] },
  });

  const id = catalogToolId("codegraph", "reindex");
  const described = await client.callTool({ name: "mottainai_tool_describe", arguments: { id } });
  assert.ok(described.structuredContent);
  const called = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } });
  assert.ok(!called.isError);

  await client.close();
});

test("execution path conformance matrix covers every registered path (#58)", async () => {
  const payload = "result ".repeat(2_000);
  const budgetedGateway = resolveGatewayConfig({ tokenBudgets: { default: 128 } });
  const cases: Record<ExecutionPath, () => Promise<{
    result: Awaited<ReturnType<Client["callTool"]>>;
    provider: string;
    tool: string;
    fallback: boolean;
    localArtifact?: boolean;
    close: () => Promise<void>;
    traces: () => ReturnType<ReturnType<typeof createTraceStore>["load"]>;
  }>> = {
    prefixed: async () => {
      const traceStore = conformanceTraceStore();
      const client = await connectedClient([
        fakeHandle("direct", [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [{ type: "text", text: payload }] })),
      ], undefined, new InMemoryArtifactStore({ createId: () => "prefixed" }), { traceStore, loadPolicy: () => BUILTIN_POLICY }, { gateway: budgetedGateway });
      return {
        result: await client.callTool({ name: "direct__search", arguments: { _mottainai: { task: { category: "bug_investigation" } } } }),
        provider: "direct", tool: "search", fallback: false, close: () => client.close(), traces: () => traceStore.load(),
      };
    },
    brokered: async () => {
      const traceStore = conformanceTraceStore();
      const client = await connectedClient([
        fakeHandle("broker", [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [{ type: "text", text: payload }] })),
      ], undefined, new InMemoryArtifactStore({ createId: () => "brokered" }), { traceStore, loadPolicy: () => BUILTIN_POLICY }, { gateway: budgetedGateway });
      return {
        result: await client.callTool({ name: "mottainai_tool_call", arguments: {
          id: catalogToolId("broker", "search"), arguments: {}, _mottainai: { task: { category: "bug_investigation" } },
        } }),
        provider: "broker", tool: "search", fallback: false, close: () => client.close(), traces: () => traceStore.load(),
      };
    },
    logical: async () => {
      const traceStore = conformanceTraceStore();
      const client = await connectedClient([
        fakeHandle("logical", [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [{ type: "text", text: payload }] }), { capabilities: ["text_matches"] }),
      ], undefined, new InMemoryArtifactStore({ createId: () => "logical" }), { traceStore, loadPolicy: () => BUILTIN_POLICY }, { gateway: budgetedGateway });
      return {
        result: await client.callTool({ name: "mottainai_code_search", arguments: {
          pattern: "needle", _mottainai: { task: { category: "bug_investigation" } },
        } }),
        provider: "logical", tool: "logical__search", fallback: false, close: () => client.close(), traces: () => traceStore.load(),
      };
    },
    local: async () => {
      const traceStore = conformanceTraceStore();
      const client = await connectedClient([], undefined, new InMemoryArtifactStore({ createId: () => "local" }), { traceStore, loadPolicy: () => BUILTIN_POLICY }, { gateway: budgetedGateway });
      return {
        result: await client.callTool({ name: "mottainai_exec", arguments: {
          command: "yes data | head -n 1000", targetTokens: 128, _mottainai: { task: { category: "bug_investigation" } },
        } }),
        provider: "local", tool: "mottainai_exec", fallback: false, localArtifact: true, close: () => client.close(), traces: () => traceStore.load(),
      };
    },
    provider_fallback: async () => {
      const traceStore = conformanceTraceStore();
      const gateway = resolveGatewayConfig({
        toolMetadata: {
          first__search: { contract: "search.v1" },
          second__search: { contract: "search.v1" },
        },
        tokenBudgets: { default: 128 },
      });
      const client = await connectedClient([
        fakeHandle("first", [{ name: "search", inputSchema: { type: "object" } }], async () => { throw new Error("connection reset"); }, { capabilities: ["text_matches"] }),
        fakeHandle("second", [{ name: "search", inputSchema: { type: "object" } }], async () => ({ content: [{ type: "text", text: payload }] }), { capabilities: ["text_matches"] }),
      ], undefined, new InMemoryArtifactStore({ createId: () => "fallback" }), { traceStore, loadPolicy: () => BUILTIN_POLICY }, { gateway });
      return {
        result: await client.callTool({ name: "mottainai_tool_call", arguments: {
          id: catalogToolId("first", "search"), arguments: {}, _mottainai: { task: { category: "bug_investigation" } },
        } }),
        provider: "second", tool: "search", fallback: true, close: () => client.close(), traces: () => traceStore.load(),
      };
    },
  };

  assert.deepEqual(Object.keys(cases), EXECUTION_PATHS);
  for (const path of EXECUTION_PATHS) {
    const current = await cases[path]();
    try {
      const traces = current.traces();
      assert.equal(traces.length, 1, `${path} trace`);
      const execution = traces[0].executions[0];
      assert.deepEqual([execution.provider, execution.tool, execution.status], [current.provider, current.tool, "success"], `${path} normalized execution`);
      assert.equal(execution.attempts === undefined, !current.fallback, `${path} fallback trace`);
      if (current.localArtifact) {
        const structured = current.result.structuredContent as { result_id?: string; truncated?: boolean };
        assert.equal(structured.truncated, true);
        assert.equal(structured.result_id, "mx_local");
      } else {
        const structured = current.result.structuredContent as { request_id?: string } | undefined;
        const text = (current.result.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("\n");
        if (structured !== undefined) assert.match(structured.request_id ?? "", /^rq_/);
        else assert.match(text, /mottainai trace: request_id=/);
        assert.match(text, /mottainai routing: \{"budget":\{"target_tokens":128,/);
      }
    } finally {
      await current.close();
    }
  }
});

test("without a configured token budget, prefixed calls compress exactly as before (opt-in has no effect)", async () => {
  const bigText = Array.from({ length: 2000 }, (_, i) => `result line ${i}`).join("\n");
  const handles = [fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: bigText }],
  }))];
  const { logger } = fakeLogger();
  const store = new InMemoryArtifactStore({ createId: () => "nobudget" });
  const gateway = resolveGatewayConfig({});
  const client = await connectedClient(handles, logger, store, undefined, { gateway });

  const result = await client.callTool({ name: "codegraph__explore", arguments: {} });
  const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  // 行フィルタは既に上限2000行を超えないと発動しないので、budget 無しではここは無変化のまま。
  assert.ok(!text.includes("mottainai omitted"));
  assert.ok(!text.includes("original_id"));

  await client.close();
});

test("a configured tool-level token budget truncates a large prefixed result and stores the original", async () => {
  const bigText = Array.from({ length: 2000 }, (_, i) => `result line ${i}`).join("\n");
  const handles = [fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: bigText }],
  }))];
  const { logger } = fakeLogger();
  const store = new InMemoryArtifactStore({ createId: () => "budgeted" });
  const gateway = resolveGatewayConfig({ tokenBudgets: { tools: { "codegraph__explore": 300 } } });
  const client = await connectedClient(handles, logger, store, undefined, { gateway });

  const result = await client.callTool({ name: "codegraph__explore", arguments: {} });
  const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  assert.match(text, /⋯ mottainai omitted=\d+ lines sha256=[0-9a-f]{16}; use mottainai_result_get ⋯/);
  assert.match(text, /\[mottainai compression: original_id=mx_budgeted; retrieve=mottainai_result_get\]/);

  await client.close();
});

test("a capability-level token budget applies to brokered calls using the tool's declared capability", async () => {
  const bigText = Array.from({ length: 2000 }, (_, i) => `result line ${i}`).join("\n");
  const handles = [fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: bigText }],
  }))];
  const { logger } = fakeLogger();
  const store = new InMemoryArtifactStore({ createId: () => "brokered-budget" });
  const gateway = resolveGatewayConfig({
    capabilityMap: { "codegraph__explore": ["definitions"] },
    tokenBudgets: { capabilities: { definitions: 300 } },
  });
  const client = await connectedClient(handles, logger, store, undefined, { gateway });

  const id = catalogToolId("codegraph", "explore");
  const called = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } });
  const text = (called.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  assert.match(text, /⋯ mottainai omitted=\d+ lines sha256=[0-9a-f]{16}; use mottainai_result_get ⋯/);

  await client.close();
});

test("ordinary calls carry no routing metadata: no budget configured, or budget configured but not triggered", async () => {
  const smallText = "small result";
  const handles = [fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: smallText }],
  }))];
  const { logger } = fakeLogger();

  const noBudget = await connectedClient(handles, logger, new InMemoryArtifactStore(), undefined, { gateway: resolveGatewayConfig({}) });
  const resultNoBudget = await noBudget.callTool({ name: "codegraph__explore", arguments: {} });
  assert.deepEqual(resultNoBudget.content, [{ type: "text", text: smallText }]);
  await noBudget.close();

  const generousBudget = await connectedClient(handles, logger, new InMemoryArtifactStore(), undefined, {
    gateway: resolveGatewayConfig({ tokenBudgets: { tools: { "codegraph__explore": 10_000 } } }),
  });
  const resultWithUnusedBudget = await generousBudget.callTool({ name: "codegraph__explore", arguments: {} });
  assert.deepEqual(resultWithUnusedBudget.content, [{ type: "text", text: smallText }]);
  await generousBudget.close();
});

test("a truncating token budget attaches routing metadata alongside the compression metadata", async () => {
  const bigText = Array.from({ length: 2000 }, (_, i) => `result line ${i}`).join("\n");
  const handles = [fakeHandle("codegraph", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: bigText }],
  }))];
  const { logger } = fakeLogger();
  const store = new InMemoryArtifactStore({ createId: () => "routed" });
  const gateway = resolveGatewayConfig({ tokenBudgets: { tools: { "codegraph__explore": 300 } } });
  const client = await connectedClient(handles, logger, store, undefined, { gateway });

  const result = await client.callTool({ name: "codegraph__explore", arguments: {} });
  const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  const routingLine = text.split("\n").find((line) => line.startsWith("[mottainai routing: "));
  assert.ok(routingLine !== undefined);
  const decision = JSON.parse(routingLine!.slice("[mottainai routing: ".length, -1)) as Record<string, unknown>;
  assert.deepEqual(decision.budget, { target_tokens: 300, source: "tool", truncated: true });

  await client.close();
});

test("mottainai_tool_call falls back to another provider when the primary connection fails", async () => {
  const brokenCalls: Array<Record<string, unknown> | undefined> = [];
  const healthyCalls: Array<Record<string, unknown> | undefined> = [];
  const handles = [
    fakeHandle("broken", [{ name: "explore", inputSchema: { type: "object" } }], async (request) => {
      brokenCalls.push(request.arguments);
      throw new Error("connection reset");
    }),
    fakeHandle("healthy", [{ name: "explore", inputSchema: { type: "object" } }], async (request) => {
      healthyCalls.push(request.arguments);
      return { content: [{ type: "text", text: "ok" }] };
    }),
  ];
  const gateway = fallbackGateway({ broken: ["definitions"], healthy: ["definitions"] });
  const client = await connectedClient(handles, undefined, undefined, undefined, { gateway });

  const id = catalogToolId("broken", "explore");
  const result = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: { q: 1 } } });

  assert.deepEqual(brokenCalls, [{ q: 1 }]);
  assert.deepEqual(healthyCalls, [{ q: 1 }]);
  assert.equal((result.content as Array<{ text: string }>)[0]?.text, "ok");

  // fallback が起きたので routing metadata が付く。中身の検証は別テストで行う。
  const routingLine = (result.content as Array<{ text: string }>).find((part) => part.text.startsWith("[mottainai routing: "));
  assert.ok(routingLine !== undefined);

  await client.close();
});

test("mottainai_tool_call does not fall back when the tool itself returns isError", async () => {
  const healthyCalls: Array<Record<string, unknown> | undefined> = [];
  const handles = [
    fakeHandle("broken", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "bad argument" }], isError: true,
    })),
    fakeHandle("healthy", [{ name: "explore", inputSchema: { type: "object" } }], async (request) => {
      healthyCalls.push(request.arguments);
      return { content: [{ type: "text", text: "ok" }] };
    }),
  ];
  const gateway = fallbackGateway({ broken: ["definitions"], healthy: ["definitions"] });
  const client = await connectedClient(handles, undefined, undefined, undefined, { gateway });

  const id = catalogToolId("broken", "explore");
  const result = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } });

  assert.deepEqual(healthyCalls, [], "a tool-level error must not trigger a fallback attempt");
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "bad argument" }]);

  await client.close();
});

test("mottainai_tool_call does not fall back to a provider the active profile denies, and surfaces the original error", async () => {
  const healthyCalls: Array<Record<string, unknown> | undefined> = [];
  const handles = [
    fakeHandle("broken", [{ name: "explore", inputSchema: { type: "object" } }], async () => {
      throw new Error("connection reset");
    }),
    fakeHandle("healthy", [{ name: "explore", inputSchema: { type: "object" } }], async (request) => {
      healthyCalls.push(request.arguments);
      return { content: [{ type: "text", text: "ok" }] };
    }),
  ];
  const gateway = fallbackGateway({ broken: ["definitions"], healthy: ["definitions"] });
  // healthy 側だけ destructive 扱いにして denyRisk で落とす（annotations 未指定 = unknown = destructive 相当）。
  const client = await connectedClient(handles, undefined, undefined, undefined, {
    gateway, activeProfile: { denyRisk: ["destructive"] },
  });

  const id = catalogToolId("broken", "explore");
  await assert.rejects(
    () => client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } }),
    /connection reset/,
  );
  assert.deepEqual(healthyCalls, [], "a profile-denied candidate must never be attempted");

  await client.close();
});

test("mottainai_tool_call exhausts all fallback candidates and throws the last error", async () => {
  const handles = [
    fakeHandle("broken-a", [{ name: "explore", inputSchema: { type: "object" } }], async () => { throw new Error("a failed"); }),
    fakeHandle("broken-b", [{ name: "explore", inputSchema: { type: "object" } }], async () => { throw new Error("b failed"); }),
  ];
  const gateway = fallbackGateway({ "broken-a": ["definitions"], "broken-b": ["definitions"] });
  const client = await connectedClient(handles, undefined, undefined, undefined, { gateway });

  const id = catalogToolId("broken-a", "explore");
  await assert.rejects(
    () => client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } }),
    /b failed/,
  );

  await client.close();
});

test("a successful fallback attaches selected_provider, selected_tool and fallback_history", async () => {
  const handles = [
    fakeHandle("broken", [{ name: "explore", inputSchema: { type: "object" } }], async () => { throw new Error("connection reset"); }),
    fakeHandle("healthy", [{ name: "explore", inputSchema: { type: "object" } }], async () => ({
      content: [{ type: "text", text: "ok" }],
    })),
  ];
  const gateway = fallbackGateway({ broken: ["definitions"], healthy: ["definitions"] });
  const client = await connectedClient(handles, undefined, undefined, undefined, { gateway });

  const id = catalogToolId("broken", "explore");
  const result = await client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } });
  const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  const routingLine = text.split("\n").find((line) => line.startsWith("[mottainai routing: "));
  assert.ok(routingLine !== undefined);
  const decision = JSON.parse(routingLine!.slice("[mottainai routing: ".length, -1)) as Record<string, unknown>;
  assert.equal(decision.selected_provider, "healthy");
  assert.equal(decision.selected_tool, "explore");
  assert.deepEqual(decision.fallback_history, [{ provider: "broken", tool: "explore", error: "connection reset" }]);

  await client.close();
});

test("mottainai_tool_call does not fallback across different declared contracts", async () => {
  const healthyCalls: Array<Record<string, unknown> | undefined> = [];
  const handles = [
    fakeHandle("broken", [{ name: "explore", inputSchema: { type: "object" } }], async () => {
      throw new Error("connection reset");
    }),
    fakeHandle("healthy", [{ name: "explore", inputSchema: { type: "object" } }], async (request) => {
      healthyCalls.push(request.arguments);
      return { content: [{ type: "text", text: "ok" }] };
    }),
  ];
  const gateway = resolveGatewayConfig({
    capabilityMap: { broken: ["definitions"], healthy: ["definitions"] },
    toolMetadata: {
      "broken__explore": { contract: "explore.v1" },
      "healthy__explore": { contract: "other.v1" },
    },
  });
  const client = await connectedClient(handles, undefined, undefined, undefined, { gateway });

  const id = catalogToolId("broken", "explore");
  await assert.rejects(
    () => client.callTool({ name: "mottainai_tool_call", arguments: { id, arguments: {} } }),
    /connection reset/,
  );
  assert.deepEqual(healthyCalls, []);

  await client.close();
});

test("mottainai_telemetry_summary reports disabled state when telemetry is off, and aggregates calls/retrievals when enabled (#27)", async () => {
  const bigText = Array.from({ length: 2000 }, (_, i) => `result line ${i}`).join("\n");
  const handles = [fakeHandle("fff", [{ name: "grep", inputSchema: { type: "object" } }], async () => ({
    content: [{ type: "text", text: bigText }],
  }))];
  const gateway = resolveGatewayConfig({
    capabilityMap: { fff__grep: ["text_matches"] },
    tokenBudgets: { capabilities: { text_matches: 300 } },
  });

  const offClient = await connectedClient(handles, undefined, undefined, undefined, { gateway });
  await offClient.callTool({ name: "fff__grep", arguments: {} });
  const off = await offClient.callTool({ name: "mottainai_telemetry_summary", arguments: {} });
  assert.equal((off.structuredContent as Record<string, unknown>).enabled, false);
  await offClient.close();

  const telemetry = createTelemetrySink({ MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-telemetry-proxy-")), "summary.json") });
  const onClient = await connectedClient(handles, undefined, undefined, undefined, { gateway, telemetry });
  const called = await onClient.callTool({ name: "fff__grep", arguments: {} });
  const originalId = ((called.content as Array<{ text: string }>).map((p) => p.text).join("\n").match(/original_id=(\S+);/) ?? [])[1];
  assert.ok(originalId, "a large result should carry a retrievable original_id");
  await onClient.callTool({ name: "mottainai_result_get", arguments: { id: originalId } });

  const summary = await onClient.callTool({ name: "mottainai_telemetry_summary", arguments: {} });
  const content = summary.structuredContent as { enabled: boolean; totals: { calls: number; retrievals: number }; by_provider: Record<string, { calls: number }> };
  assert.equal(content.enabled, true);
  assert.equal(content.totals.calls, 1);
  assert.equal(content.totals.retrievals, 1);
  assert.equal(content.by_provider.fff.calls, 1);

  await onClient.close();
});
