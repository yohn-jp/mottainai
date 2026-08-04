import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolMetadataOverride, resolveRisk, resolveToolAttributes } from "./metadata.js";

test("resolveToolAttributes falls back to the unknown (heaviest) side when nothing is configured", () => {
  const resolved = resolveToolAttributes(undefined, undefined);
  assert.deepEqual(resolved, { cost: "high", latency: "slow", outputSize: "large", workspace: false, network: true });
});

test("resolveToolAttributes prefers the tool-level override over the upstream-level one", () => {
  const resolved = resolveToolAttributes(
    { cost: "low", workspace: true },
    { cost: "medium", latency: "fast", workspace: false, network: false },
  );
  // cost/workspace はツール単位が勝つ。latency/network はツール単位に無いので upstream 単位を継承する。
  assert.deepEqual(resolved, { cost: "low", latency: "fast", outputSize: "large", workspace: true, network: false });
});

test("resolveToolAttributes falls back to upstream-level values field by field", () => {
  const resolved = resolveToolAttributes(undefined, { cost: "low", outputSize: "small" });
  assert.deepEqual(resolved, { cost: "low", latency: "slow", outputSize: "small", workspace: false, network: true });
});

test("resolveRisk prefers tool-level, then upstream-level, then the annotation-derived value", () => {
  assert.equal(resolveRisk("destructive", undefined, undefined), "destructive");
  assert.equal(resolveRisk("destructive", undefined, { risk: "mutating" }), "mutating");
  assert.equal(resolveRisk("destructive", { risk: "read_only" }, { risk: "mutating" }), "read_only");
});

test("normalizeToolMetadataOverride accepts known values and rejects unknown ones", () => {
  assert.deepEqual(
    normalizeToolMetadataOverride({ contract: "search.v1", risk: "read_only", cost: "low", latency: "fast", outputSize: "small", workspace: true, network: false }, "field"),
    { contract: "search.v1", risk: "read_only", cost: "low", latency: "fast", outputSize: "small", workspace: true, network: false },
  );
  assert.deepEqual(normalizeToolMetadataOverride({}, "field"), {
    contract: undefined, risk: undefined, cost: undefined, latency: undefined, outputSize: undefined, workspace: undefined, network: undefined,
  });

  assert.throws(() => normalizeToolMetadataOverride({ risk: "catastrophic" }, "upstream.metadata"), /invalid tool metadata: upstream\.metadata\.risk/);
  assert.throws(() => normalizeToolMetadataOverride({ cost: "extreme" }, "field"), /invalid tool metadata: field\.cost/);
  assert.throws(() => normalizeToolMetadataOverride({ latency: "instant" }, "field"), /invalid tool metadata: field\.latency/);
  assert.throws(() => normalizeToolMetadataOverride({ outputSize: "huge" }, "field"), /invalid tool metadata: field\.outputSize/);
  assert.throws(() => normalizeToolMetadataOverride({ workspace: "yes" }, "field"), /invalid tool metadata: field\.workspace/);
  assert.throws(() => normalizeToolMetadataOverride({ network: "yes" }, "field"), /invalid tool metadata: field\.network/);
  assert.throws(() => normalizeToolMetadataOverride({ contract: "" }, "field"), /invalid tool metadata: field\.contract/);
  assert.throws(() => normalizeToolMetadataOverride("not-an-object", "field"), /invalid tool metadata: field/);
  assert.throws(() => normalizeToolMetadataOverride(["array"], "field"), /invalid tool metadata: field/);
});
