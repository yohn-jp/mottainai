import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_POLICY, resolvePlan } from "./policy.js";
import { evaluatePolicy, proposePolicy } from "./propose.js";
import type { Trace } from "./trace.js";

function trace(index: number, missing: string[], options: { category?: string; executions?: Trace["executions"] } = {}): Trace {
  const requestId = `rq_${index}`;
  const category = options.category ?? "bug_investigation";
  // このフィクスチャは呼び出し側が何も明示せず policy 任せで探索したケースを模す
  // （caller_requested_capabilities: []）。resolved plan は active policy そのもの。
  const resolved = resolvePlan(BUILTIN_POLICY, category, []);
  return {
    request: {
      type: "request", schema_version: 1, request_id: requestId,
      timestamp: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
      task_category: category,
      caller_requested_capabilities: [],
      planned_capabilities: resolved.capabilities,
      added_by_policy: resolved.added_by_policy,
      suppressed_by_policy: resolved.suppressed,
      policy_version: "builtin-1",
    },
    executions: (options.executions ?? []).map((execution) => ({ ...execution, request_id: requestId })),
    review: {
      type: "review", schema_version: 1, request_id: requestId, timestamp: `2026-07-${String(10 + index).padStart(2, "0")}T01:00:00.000Z`,
      expected_found: missing.length === 0, sufficient: missing.length === 0, usefulness: missing.length === 0 ? 5 : 2,
      missing_capabilities: missing, unexpected_noise: [], follow_up_requested: missing.length > 0, next_capabilities: missing,
    },
  };
}

const now = new Date("2026-07-31T09:00:00.000Z");

test("a capability reported missing often enough becomes a proposed rule", () => {
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["ownership"] : []));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });

  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.policy?.status, "candidate");
  assert.deepEqual(proposal.changes.map((change) => change.added), [["ownership"]]);
  const rule = proposal.policy?.rules.find((entry) => entry.task_category === "bug_investigation");
  assert.deepEqual(rule?.capabilities, [...resolvePlan(BUILTIN_POLICY, "bug_investigation", []).capabilities, "ownership"]);
  assert.equal(rule?.support, proposal.training_traces);
});

test("the candidate is replayed against history and reports coverage gain", () => {
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["ownership"] : []));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });

  assert.ok(proposal.training_evaluation.missing_coverage_active !== null);
  assert.equal(proposal.training_evaluation.missing_coverage_candidate, 1);
  assert.ok((proposal.training_evaluation.coverage_delta ?? 0) > 0);
  assert.equal(proposal.training_evaluation.regressions, 0);
  assert.equal(proposal.training_evaluation.mean_extra_capabilities, 1);
});

test("newest reviewed traces are held out of rule generation", () => {
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["ownership"] : []));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });

  assert.equal(proposal.training_traces, 6);
  assert.equal(proposal.holdout_traces, 2);
  assert.equal(proposal.holdout_evaluation?.traces, 2);
});

test("too few reviewed traces produce no rule and say why", () => {
  const proposal = proposePolicy([trace(0, ["ownership"]), trace(1, ["ownership"])], BUILTIN_POLICY, { now });
  assert.equal(proposal.status, "no_change");
  assert.equal(proposal.policy, undefined);
  assert.deepEqual(proposal.changes, []);
  assert.ok(proposal.reasons.some((reason) => reason.includes("below min support")));
});

test("traces without any review yield insufficient_data", () => {
  const unreviewed = { ...trace(0, []), review: undefined };
  const proposal = proposePolicy([unreviewed], BUILTIN_POLICY, { now });
  assert.equal(proposal.status, "insufficient_data");
  assert.deepEqual(proposal.reasons, ["no reviewed traces"]);
});

test("satisfied explorations do not change the policy", () => {
  const traces = [0, 1, 2, 3, 4, 5].map((index) => trace(index, []));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });
  assert.equal(proposal.status, "no_change");
  assert.equal(proposal.policy, undefined);
});

test("a capability that never returns evidence in a category is proposed as avoid", () => {
  const executions: Trace["executions"] = [{
    type: "execution", schema_version: 1, execution_id: "ex_1", request_id: "rq", timestamp: "2026-07-20T00:00:00.000Z",
    provider: "codegraph", tool: "codegraph__explore", capability: "runtime_state",
    duration_ms: 5, result_count: 0, output_size: 0, status: "empty",
  }];
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["ownership"] : [], { executions }));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });
  assert.deepEqual(proposal.changes[0].avoid_added, ["runtime_state"]);
  assert.deepEqual(
    proposal.policy?.rules.find((rule) => rule.task_category === "bug_investigation")?.avoid_capabilities,
    ["runtime_state"],
  );
});

test("a capability with no available provider is never proposed as avoid (issue #47 Phase 4)", () => {
  const executions: Trace["executions"] = [{
    type: "execution", schema_version: 1, execution_id: "ex_1", request_id: "rq", timestamp: "2026-07-20T00:00:00.000Z",
    provider: "none", tool: "none", capability: "runtime_state",
    duration_ms: 0, result_count: 0, output_size: 0, status: "unavailable",
  }];
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["ownership"] : [], { executions }));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });
  assert.deepEqual(proposal.changes[0].avoid_added, []);
  assert.equal(
    proposal.policy?.rules.find((rule) => rule.task_category === "bug_investigation")?.avoid_capabilities,
    undefined,
  );
});

test("confidence excludes capabilities suppressed by avoid_capabilities", () => {
  const executions: Trace["executions"] = [{
    type: "execution", schema_version: 1, execution_id: "ex_1", request_id: "rq", timestamp: "2026-07-20T00:00:00.000Z",
    provider: "codegraph", tool: "codegraph__explore", capability: "runtime_state",
    duration_ms: 5, result_count: 0, output_size: 0, status: "empty",
  }];
  // runtime_state はすでに bug_investigation の baseline にあるため avoid にしか回らない。
  // missing に runtime_state を含む trace は、抑制後は capabilities で説明できないはず。
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => trace(index, index % 2 === 0 ? ["runtime_state"] : [], { executions }));
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });
  assert.deepEqual(proposal.changes[0].avoid_added, ["runtime_state"]);
  // 3/6 の training trace だけが runtime_state を要求しない = 抑制後に説明できる。
  assert.equal(proposal.changes[0].confidence, 0.5);
});

test("minSupport for avoid is measured in distinct traces, not execution count", () => {
  // 3 件の trace だけが runtime_state を実行し、各 trace で 2 回失敗する
  // (execution 合計は 6 = minSupport 以上だが、trace は 3 件しかない)。
  const failingExecution = (index: number, suffix: string): Trace["executions"][number] => ({
    type: "execution", schema_version: 1, execution_id: `ex_${index}_${suffix}`, request_id: `rq_${index}`,
    timestamp: "2026-07-20T00:00:00.000Z", provider: "codegraph", tool: "codegraph__explore",
    capability: "runtime_state", duration_ms: 5, result_count: 0, output_size: 0, status: "empty",
  });
  const traces = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => {
    const missing = [0, 2, 4].includes(index) ? ["ownership"] : [];
    const executions = [0, 1, 2].includes(index) ? [failingExecution(index, "a"), failingExecution(index, "b")] : [];
    return trace(index, missing, { executions });
  });
  const proposal = proposePolicy(traces, BUILTIN_POLICY, { now });
  assert.deepEqual(proposal.changes[0].added, ["ownership"]);
  assert.deepEqual(proposal.changes[0].avoid_added, []);
});

test("evaluation treats traces with nothing missing as full coverage on both sides", () => {
  const evaluation = evaluatePolicy(BUILTIN_POLICY, BUILTIN_POLICY, [trace(0, []), trace(1, [])]);
  assert.equal(evaluation.missing_coverage_active, 1);
  assert.equal(evaluation.missing_coverage_candidate, 1);
  assert.equal(evaluation.coverage_delta, 0);
  assert.equal(evaluation.regressions, 0);
});
