import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCatalog, catalogToolId, minimalInputSchema, profileAllows, riskOf } from "./catalog.js";
import type { UpstreamHandle } from "./upstream.js";

function handle(name: string, tools: Tool[]): UpstreamHandle {
  return { config: { name, command: "noop" }, client: {} as UpstreamHandle["client"], tools };
}

const codegraphTools: Tool[] = [
  {
    name: "codegraph_explore",
    description: "Explore symbol definitions and callers.\nSecond line is dropped from the summary.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Long upstream description that should not reach search results." },
        depth: { type: "integer", minimum: 1 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "codegraph_reindex",
    description: "Rebuild the index.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const fffTools: Tool[] = [
  { name: "grep", description: "Literal text search.", inputSchema: { type: "object", properties: {} } },
];

function catalog() {
  return buildCatalog(
    [handle("codegraph", codegraphTools), handle("fff", fffTools)],
    [
      { name: "codegraph", command: "noop", capabilities: ["definitions"] },
      { name: "fff", command: "noop", capabilities: ["code.search"] },
    ],
    { codegraph__codegraph_explore: ["definitions", "callers"] },
  );
}

test("catalog ids are stable and derived from provider and tool name", () => {
  assert.equal(catalogToolId("codegraph", "codegraph_explore"), catalogToolId("codegraph", "codegraph_explore"));
  assert.notEqual(catalogToolId("codegraph", "grep"), catalogToolId("fff", "grep"));
  assert.match(catalogToolId("fff", "grep"), /^tl_[0-9a-f]{12}$/);

  const entry = catalog().tools().find((tool) => tool.tool === "grep");
  assert.equal(entry?.id, catalogToolId("fff", "grep"));
  // upstream 名は識別子として露出しない。
  assert.equal(entry?.id.includes("fff"), false);
});

test("risk falls back to destructive when annotations are missing or ambiguous", () => {
  assert.equal(riskOf(undefined), "unknown");
  assert.equal(riskOf({ readOnlyHint: true }), "read_only");
  assert.equal(riskOf({ readOnlyHint: false, destructiveHint: false }), "mutating");
  assert.equal(riskOf({ readOnlyHint: false }), "destructive");
  assert.equal(riskOf({ readOnlyHint: false, destructiveHint: true }), "destructive");
});

test("tool-level capability declarations win over upstream-level ones", () => {
  const entries = catalog().tools();
  const explore = entries.find((tool) => tool.tool === "codegraph_explore");
  const reindex = entries.find((tool) => tool.tool === "codegraph_reindex");
  assert.deepEqual(explore?.capabilities, ["definitions", "callers"]);
  assert.deepEqual(reindex?.capabilities, ["definitions"]);
  // config の別名は正準形へ寄せる。
  assert.deepEqual(entries.find((tool) => tool.tool === "grep")?.capabilities, ["text_matches"]);
});

test("search ranks by capability, name, tag and summary and stays deterministic", () => {
  const index = catalog();

  const byName = index.search({ query: "grep" });
  assert.deepEqual(byName.map((hit) => hit.tool.tool), ["grep"]);
  assert.deepEqual(byName[0].matched, ["name:grep"]);

  const byCapability = index.search({ capability: "callers" });
  assert.deepEqual(byCapability.map((hit) => hit.tool.tool), ["codegraph_explore"]);

  // config の別名で引いても正準形に寄せて一致する。
  assert.deepEqual(index.search({ capability: "code.search" }).map((hit) => hit.tool.tool), ["grep"]);

  const bySummary = index.search({ query: "rebuild" });
  assert.deepEqual(bySummary.map((hit) => hit.tool.tool), ["codegraph_reindex"]);

  const noMatch = index.search({ query: "nothing-matches-this" });
  assert.deepEqual(noMatch, []);

  assert.deepEqual(index.search({ query: "codegraph" }), index.search({ query: "codegraph" }));
});

test("search filters by risk and provider without a query", () => {
  const index = catalog();
  assert.deepEqual(index.search({ risk: "read_only" }).map((hit) => hit.tool.tool), ["codegraph_explore"]);
  assert.deepEqual(index.search({ risk: "unknown" }).map((hit) => hit.tool.tool), ["grep"]);
  assert.deepEqual(index.search({ provider: "codegraph" }).map((hit) => hit.tool.tool), ["codegraph_explore", "codegraph_reindex"]);
  assert.equal(index.search({ limit: 1 }).length, 1);
});

test("minimal input schema keeps types and required flags but drops descriptions", () => {
  const explore = catalog().tools().find((tool) => tool.tool === "codegraph_explore");
  assert.deepEqual(minimalInputSchema(explore!.definition.inputSchema), {
    type: "object",
    properties: { query: { type: "string", required: true }, depth: { type: "integer" } },
    required: ["query"],
  });
});

test("describe-level definitions stay byte-identical to the upstream tool", () => {
  const explore = catalog().tools().find((tool) => tool.tool === "codegraph_explore");
  assert.equal(explore?.definition, codegraphTools[0]);
  assert.equal(explore?.summary, "Explore symbol definitions and callers.");
});

test("profile filtering drops tools it cannot judge", () => {
  const readOnlyTool = { capabilities: ["definitions"], risk: "read_only" as const };
  const unknownRisk = { capabilities: ["definitions"], risk: "unknown" as const };
  const noCapabilities = { capabilities: [], risk: "read_only" as const };

  assert.equal(profileAllows(readOnlyTool, undefined), true);
  assert.equal(profileAllows(readOnlyTool, { includeCapabilities: ["definitions"] }), true);
  assert.equal(profileAllows(readOnlyTool, { includeCapabilities: ["text_matches"] }), false);
  assert.equal(profileAllows(noCapabilities, { includeCapabilities: ["definitions"] }), false);
  assert.equal(profileAllows(noCapabilities, { denyRisk: ["destructive"] }), true);

  // risk 不明は destructive として扱う。判断できないものを通すと profile の意味が消える。
  assert.equal(profileAllows(unknownRisk, { denyRisk: ["destructive"] }), false);
  assert.equal(profileAllows({ capabilities: [], risk: "destructive" }, { denyRisk: ["destructive"] }), false);

  // config の別名でも正準形に寄せて判定する。
  assert.equal(profileAllows({ capabilities: ["text_matches"], risk: "read_only" }, { includeCapabilities: ["code.search"] }), true);
});

test("catalog entries default to the unknown side of every optional attribute", () => {
  const entries = catalog().tools();
  const grep = entries.find((tool) => tool.tool === "grep");
  assert.deepEqual(
    { cost: grep?.cost, latency: grep?.latency, outputSize: grep?.outputSize, workspace: grep?.workspace, network: grep?.network },
    { cost: "high", latency: "slow", outputSize: "large", workspace: false, network: true },
  );
});

test("tool-level toolMetadata wins over upstream-level metadata and annotation-derived risk", () => {
  const index = buildCatalog(
    [handle("codegraph", codegraphTools)],
    [{
      name: "codegraph",
      command: "noop",
      capabilities: ["definitions"],
      metadata: { cost: "medium", latency: "moderate", risk: "mutating" },
    }],
    {},
    {
      // tool 単位はキーを provider__tool にする。
      codegraph__codegraph_explore: { cost: "low", workspace: true },
    },
  );
  const explore = index.get(catalogToolId("codegraph", "codegraph_explore"));
  const reindex = index.get(catalogToolId("codegraph", "codegraph_reindex"));

  // explore: tool 単位の cost/workspace が勝ち、latency/risk は upstream 単位を継承する。
  assert.equal(explore?.cost, "low");
  assert.equal(explore?.workspace, true);
  assert.equal(explore?.latency, "moderate");
  assert.equal(explore?.risk, "mutating");

  // reindex: tool 単位の上書きが無いので upstream 単位がそのまま効く。annotations の destructive を上書きする。
  assert.equal(reindex?.cost, "medium");
  assert.equal(reindex?.risk, "mutating");
});
