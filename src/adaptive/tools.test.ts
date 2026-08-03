import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryArtifactStore } from "../retrieve.js";
import { buildCapabilityIndex } from "./capabilities.js";
import { loadActivePolicy, approvePolicy } from "./policy.js";
import { callAdaptiveTool } from "./tools.js";
import type { AdaptiveToolContext } from "./tools.js";
import { createTraceStore } from "./trace.js";

function context(): AdaptiveToolContext & { policyDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-adaptive-tools-"));
  const policyDir = path.join(root, "policy");
  return {
    traceStore: createTraceStore({ MOTTAINAI_TRACE_DIR: path.join(root, "trace") }),
    capabilityIndex: buildCapabilityIndex([
      { name: "codegraph", command: "codegraph", capabilities: ["callers", "definitions"], priority: 5 },
    ]),
    loadPolicy: () => loadActivePolicy({ MOTTAINAI_POLICY_DIR: policyDir }),
    policyDir,
    artifactStore: new InMemoryArtifactStore(),
  };
}

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>, ctx: AdaptiveToolContext): Promise<Record<string, unknown>> {
  return structured(await callAdaptiveTool(name, args, ctx));
}

test("plan returns a request_id and maps capabilities to available providers", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", {
    task: { category: "symbol_lookup", intent: "find_definition", confidence: 0.9 },
    requested_capabilities: ["code.search"],
  }, ctx);

  assert.match(String(plan.request_id), /^rq_[0-9a-f]{16}$/);
  assert.equal(plan.policy_version, "builtin-1");
  assert.deepEqual(plan.added_by_policy, ["definitions", "references", "callers"]);
  const facts = plan.facts as Array<Record<string, unknown>>;
  assert.deepEqual(facts.map((fact) => fact.capability), ["text_matches", "definitions", "references", "callers"]);
  assert.deepEqual(facts[1].providers, [{
    provider: "codegraph", tool: undefined, source: "config",
    rank: 1, eligible_for_fallback: false,
    reasons: [
      { rule: "priority", value: 5 },
      { rule: "source", value: "config" },
      { rule: "provider", value: "codegraph" },
    ],
  }]);
  assert.deepEqual(plan.unsatisfied_capabilities, ["references"]);
});

test("unsatisfied capabilities are recorded as unavailable executions", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", { task: { category: "ui_investigation" } }, ctx);
  const trace = ctx.traceStore.load({ requestId: String(plan.request_id) })[0];
  assert.deepEqual(
    trace.executions.map((execution) => `${execution.capability}:${execution.status}`),
    ["dom:unavailable", "styles:unavailable", "screenshots:unavailable"],
  );
});

test("execution reviews stay separate and provider gaps remain visible", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", { task: { category: "ui_investigation" } }, ctx);
  const trace = ctx.traceStore.load({ requestId: String(plan.request_id) })[0];
  const review = await call("mottainai_execution_review", {
    request_id: plan.request_id,
    execution_id: trace.executions[0].execution_id,
    expected_found: false,
    useful: false,
    sufficient_for_capability: false,
  }, ctx);

  assert.equal(review.recorded, true);
  const inspected = await call("mottainai_policy_stats", { request_id: plan.request_id }, ctx);
  const inspectedTrace = inspected.trace as Record<string, unknown>;
  assert.equal((inspectedTrace.execution_reviews as unknown[]).length, 1);
  const stats = await call("mottainai_policy_stats", {}, ctx);
  assert.deepEqual(stats.provider_gaps, [
    { label: "dom", count: 1 }, { label: "screenshots", count: 1 }, { label: "styles", count: 1 },
  ]);
  assert.equal((stats.totals as Record<string, number>).execution_useful_rate, 0);
});

test("review closes the loop and is visible in stats", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", {
    task: { category: "bug_investigation" }, requested_capabilities: ["callers"],
  }, ctx);
  const review = await call("mottainai_review", {
    request_id: plan.request_id,
    expected_found: true,
    sufficient: false,
    usefulness: 4,
    missing_capabilities: ["ownership"],
    unexpected_noise: ["generated files"],
    next_capabilities: ["ownership"],
  }, ctx);

  assert.equal(review.status, "success");
  assert.equal(review.recorded, true);

  const stats = await call("mottainai_policy_stats", {}, ctx);
  assert.deepEqual(stats.totals, {
    requests: 1, reviewed: 1, review_rate: 1, executions: 0,
    technical_success_rate: null, execution_reviews: 0, execution_useful_rate: null, execution_sufficient_rate: null,
    expected_found_rate: 1, sufficient_rate: 0, mean_usefulness: 4,
  });
  const category = (stats.facts as Array<Record<string, unknown>>)[0];
  assert.deepEqual(category.missing_capabilities, [{ label: "ownership", count: 1 }]);
  assert.deepEqual(category.unexpected_noise, [{ label: "generated_files", count: 1 }]);
});

test("the nested review / outcome shape from the issue is accepted too", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", { task: { category: "bug_investigation" } }, ctx);
  const review = await call("mottainai_review", {
    request_id: plan.request_id,
    review: { expected_found: true, sufficient: false, usefulness: 4, missing_capabilities: ["ownership"], unexpected_noise: ["generated_files"] },
    outcome: { follow_up_requested: true, next_capabilities: ["runtime_state"] },
  }, ctx);
  assert.equal(review.recorded, true);
  const trace = ctx.traceStore.load({ requestId: String(plan.request_id) })[0];
  assert.deepEqual(trace.review?.missing_capabilities, ["ownership"]);
  assert.equal(trace.review?.follow_up_requested, true);
  assert.deepEqual(trace.review?.next_capabilities, ["runtime_state"]);
});

test("review of an unknown request_id fails instead of inventing a trace", async () => {
  const ctx = context();
  const review = await call("mottainai_review", { request_id: "rq_0000000000000000", expected_found: true, sufficient: true }, ctx);
  assert.equal(review.status, "failed");
  assert.equal(review.recorded, false);
  assert.equal((review.diagnostics as Array<Record<string, string>>)[0].severity, "error");
});

test("request review does not infer sufficient from expected_found", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", { task: { category: "bug_investigation" } }, ctx);
  await assert.rejects(
    () => callAdaptiveTool("mottainai_review", { request_id: plan.request_id, expected_found: true }, ctx),
    /sufficient must be a boolean/,
  );
});

test("stats can inspect a single request instead of aggregating", async () => {
  const ctx = context();
  const plan = await call("mottainai_plan", { task: { category: "ui_investigation" }, context: "button misaligned" }, ctx);
  const inspected = await call("mottainai_policy_stats", { request_id: plan.request_id }, ctx);
  const trace = inspected.trace as Record<string, Record<string, unknown>>;

  assert.equal(trace.request.request_id, plan.request_id);
  // 既定では自由記述の原文を返さない
  assert.equal(trace.request.context, undefined);
  assert.equal(typeof trace.request.context_digest, "string");

  const missing = await call("mottainai_policy_stats", { request_id: "rq_0000000000000000" }, ctx);
  assert.equal(missing.status, "failed");
});

test("propose writes a candidate policy that stays inactive until approved", async () => {
  const ctx = context();
  for (let index = 0; index < 8; index += 1) {
    const plan = await call("mottainai_plan", { task: { category: "bug_investigation" } }, ctx);
    await call("mottainai_review", {
      request_id: plan.request_id,
      expected_found: index % 2 === 0,
      sufficient: index % 2 === 0,
      missing_capabilities: index % 2 === 0 ? [] : ["ownership"],
    }, ctx);
  }

  const proposal = await call("mottainai_policy_propose", {}, ctx);
  assert.equal(proposal.proposal_status, "proposed");
  assert.equal(proposal.active_policy_version, "builtin-1");
  assert.match(String(proposal.activation), /pnpm run policy approve/);
  assert.equal(fs.existsSync(String(proposal.policy_file)), true);
  assert.equal(ctx.loadPolicy().policy_version, "builtin-1");

  approvePolicy(ctx.policyDir, String(proposal.policy_version), "test");
  assert.equal(ctx.loadPolicy().policy_version, proposal.policy_version);

  const afterApproval = await call("mottainai_plan", { task: { category: "bug_investigation" } }, ctx);
  assert.ok((afterApproval.facts as Array<Record<string, unknown>>).some((fact) => fact.capability === "ownership"));
});

test("propose can dry run without writing a candidate file", async () => {
  const ctx = context();
  for (let index = 0; index < 8; index += 1) {
    const plan = await call("mottainai_plan", { task: { category: "bug_investigation" } }, ctx);
    await call("mottainai_review", { request_id: plan.request_id, expected_found: false, sufficient: false, missing_capabilities: ["ownership"] }, ctx);
  }
  const proposal = await call("mottainai_policy_propose", { write: false }, ctx);
  assert.equal(proposal.proposal_status, "proposed");
  assert.equal(proposal.policy_file, undefined);
  assert.equal(fs.existsSync(ctx.policyDir), false);
});

test("invalid caller metadata is rejected with a readable message", async () => {
  const ctx = context();
  await assert.rejects(() => callAdaptiveTool("mottainai_plan", { task: {} }, ctx), /task.category must be a string/);
  await assert.rejects(
    () => callAdaptiveTool("mottainai_plan", { task: { category: "bug_investigation", confidence: 3 } }, ctx),
    /confidence must be a number between 0 and 1/,
  );
  await assert.rejects(() => callAdaptiveTool("mottainai_review", { expected_found: true }, ctx), /request_id must be/);
  await assert.rejects(() => callAdaptiveTool("mottainai_unknown", {}, ctx), /Unknown adaptive tool/);
});
