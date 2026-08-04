import assert from "node:assert/strict";
import test from "node:test";
import type { UpstreamConfig } from "../config.js";
import { UNSPECIFIED_CAPABILITY, buildCapabilityIndex } from "./capabilities.js";

const upstreams: UpstreamConfig[] = [
  { name: "codegraph", command: "codegraph", capabilities: ["code.search", "callers"], priority: 10 },
  { name: "slow", command: "slow", capabilities: ["callers"], priority: 1 },
  { name: "off", command: "off", capabilities: ["callers"], enabled: false },
];

test("providers for a capability come back in priority order", () => {
  const index = buildCapabilityIndex(upstreams);
  assert.deepEqual(index.providersFor("callers").map((entry) => entry.provider), ["codegraph", "slow"]);
});

test("disabled upstreams never appear as providers", () => {
  const index = buildCapabilityIndex(upstreams);
  assert.equal(index.providersFor("callers").some((entry) => entry.provider === "off"), false);
});

test("config capability aliases resolve to the canonical capability", () => {
  const index = buildCapabilityIndex(upstreams);
  assert.deepEqual(index.providersFor("text_matches").map((entry) => entry.provider), ["codegraph", "local"]);
});

test("capabilityMap adds tool-level providers without touching upstream config", () => {
  const index = buildCapabilityIndex(upstreams, { "codegraph__find_definition": ["definitions"] });
  assert.deepEqual(index.providersFor("definitions"), [
    { provider: "codegraph", tool: "codegraph__find_definition", priority: 10, source: "capability_map" },
  ]);
  assert.equal(index.capabilityForCall({ toolName: "codegraph__find_definition" }), "definitions");
});

test("capabilityMap registers a provider-level entry under the matching upstream", () => {
  const index = buildCapabilityIndex(upstreams, { codegraph: ["codebase_map"] });
  assert.deepEqual(index.providersFor("codebase_map"), [
    { provider: "codegraph", tool: undefined, priority: 10, source: "capability_map" },
  ]);
});

test("capabilityMap excludes a provider-level entry for a disabled upstream", () => {
  const index = buildCapabilityIndex(upstreams, { off: ["codebase_map"] });
  assert.deepEqual(index.providersFor("codebase_map"), []);
});

test("exec commands map to the capability they actually produce", () => {
  const index = buildCapabilityIndex([]);
  const capability = (command: string) => index.capabilityForCall({ toolName: "mottainai_exec", arguments: { command } });
  assert.equal(capability("git blame src/proxy.ts"), "ownership");
  assert.equal(capability("git log -n 5 -- src"), "recent_changes");
  assert.equal(capability("pnpm test"), "tests");
  assert.equal(capability("pnpm run typecheck"), "diagnostics");
  assert.equal(capability("node dist/index.js --help"), "runtime_state");
});

test("read mode decides between file content and symbols", () => {
  const index = buildCapabilityIndex([]);
  assert.equal(index.capabilityForCall({ toolName: "mottainai_read", arguments: { path: "a.ts" } }), "file_content");
  assert.equal(index.capabilityForCall({ toolName: "mottainai_read", arguments: { path: "a.ts", mode: "outline" } }), "symbols");
});

test("caller declared capability wins over inference", () => {
  const index = buildCapabilityIndex([]);
  assert.equal(
    index.capabilityForCall({ toolName: "mottainai_exec", arguments: { command: "pnpm test" }, declared: "runtime" }),
    "runtime_state",
  );
});

test("multi-capability upstreams record unspecified instead of guessing", () => {
  const index = buildCapabilityIndex(upstreams);
  assert.equal(index.capabilityForCall({ toolName: "codegraph__explore" }), UNSPECIFIED_CAPABILITY);
  assert.equal(index.capabilityForCall({ toolName: "slow__find" }), "callers");
  assert.equal(index.providerForTool("codegraph__explore"), "codegraph");
  assert.equal(index.providerForTool("mottainai_search"), "local");
});

test("rankProviders orders by priority and provider name when no task category is given", () => {
  const index = buildCapabilityIndex(upstreams);
  const ranked = index.rankProviders("callers");
  assert.deepEqual(ranked.map((entry) => ({ provider: entry.provider, rank: entry.rank })), [
    { provider: "codegraph", rank: 1 },
    { provider: "slow", rank: 2 },
  ]);
  assert.ok(ranked.every((entry) => entry.eligible_for_fallback === false));
});

test("rankProviders is deterministic across repeated calls", () => {
  const index = buildCapabilityIndex(upstreams);
  const first = index.rankProviders("callers", { taskCategory: "bug_investigation" });
  const second = index.rankProviders("callers", { taskCategory: "bug_investigation" });
  assert.deepEqual(first, second);
});

test("rankProviders lets preferredFor beat priority", () => {
  const withPreference: UpstreamConfig[] = [
    { name: "codegraph", command: "codegraph", capabilities: ["callers"], priority: 10 },
    { name: "slow", command: "slow", capabilities: ["callers"], priority: 1, preferredFor: ["bug_investigation"] },
  ];
  const index = buildCapabilityIndex(withPreference);
  const ranked = index.rankProviders("callers", { taskCategory: "bug_investigation" });
  assert.deepEqual(ranked.map((entry) => entry.provider), ["slow", "codegraph"]);
  assert.deepEqual(ranked[0].reasons[0], { rule: "preferredFor", value: "bug_investigation" });

  // 該当しないタスク分類では効かず、priority 順に戻る。
  const other = index.rankProviders("callers", { taskCategory: "refactor" });
  assert.deepEqual(other.map((entry) => entry.provider), ["codegraph", "slow"]);
});

test("rankProviders breaks priority ties using source before provider name", () => {
  const index = buildCapabilityIndex(upstreams, { "codegraph__find_definition": ["callers"] });
  const ranked = index.rankProviders("callers");
  // capability_map エントリ（priority 10、codegraph 由来）は config エントリと priority が同じなら source で勝つ。
  const capabilityMapEntry = ranked.find((entry) => entry.source === "capability_map");
  const configEntry = ranked.find((entry) => entry.source === "config" && entry.provider === "codegraph");
  assert.ok(capabilityMapEntry !== undefined && configEntry !== undefined);
  assert.ok(ranked.indexOf(capabilityMapEntry) < ranked.indexOf(configEntry));
});

test("rankProviders sinks fallbackFor-only providers to the end and flags them", () => {
  const withFallback: UpstreamConfig[] = [
    { name: "codegraph", command: "codegraph", capabilities: ["callers"], priority: 10, fallbackFor: ["bug_investigation"] },
    { name: "slow", command: "slow", capabilities: ["callers"], priority: 1 },
  ];
  const index = buildCapabilityIndex(withFallback);
  const ranked = index.rankProviders("callers", { taskCategory: "bug_investigation" });
  assert.deepEqual(ranked.map((entry) => entry.provider), ["slow", "codegraph"]);
  assert.equal(ranked.find((entry) => entry.provider === "codegraph")?.eligible_for_fallback, true);
  assert.equal(ranked.find((entry) => entry.provider === "slow")?.eligible_for_fallback, false);
  // fallbackFor は比較器で priority より先に評価されるため、reasons でも priority より前に来る。
  const codegraphReasons = ranked.find((entry) => entry.provider === "codegraph")?.reasons;
  assert.deepEqual(codegraphReasons?.map((reason) => reason.rule), ["fallbackFor", "priority", "source", "provider"]);

  // タスク分類を指定しない呼び出しでは fallbackFor を評価しない。priority 順のまま。
  const noTask = index.rankProviders("callers");
  assert.deepEqual(noTask.map((entry) => entry.provider), ["codegraph", "slow"]);
  assert.ok(noTask.every((entry) => entry.eligible_for_fallback === false));
});
