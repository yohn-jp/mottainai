import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTraces } from "./stats.js";
import type { Trace, TraceExecutionRecord, TraceExecutionReviewRecord, TraceReviewRecord } from "./trace.js";

let executionSequence = 0;

function execution(overrides: Partial<TraceExecutionRecord> = {}): TraceExecutionRecord {
  return {
    type: "execution", schema_version: 1, execution_id: `ex_${executionSequence++}`, request_id: "rq_1", timestamp: "2026-07-30T00:00:01.000Z",
    provider: "codegraph", tool: "codegraph__explore", capability: "callers",
    duration_ms: 10, result_count: 2, output_size: 100, status: "success", ...overrides,
  };
}

function review(overrides: Partial<TraceReviewRecord> = {}): TraceReviewRecord {
  return {
    type: "review", schema_version: 1, request_id: "rq_1", timestamp: "2026-07-30T00:00:02.000Z",
    expected_found: true, sufficient: true, usefulness: 4,
    missing_capabilities: [], unexpected_noise: [], follow_up_requested: false, next_capabilities: [], ...overrides,
  };
}

function executionReview(executionId: string, overrides: Partial<TraceExecutionReviewRecord> = {}): TraceExecutionReviewRecord {
  return {
    type: "execution_review", schema_version: 1, request_id: "rq_1", execution_id: executionId,
    timestamp: "2026-07-30T00:00:03.000Z", useful: true, sufficient_for_capability: false,
    missing_capabilities: [], unexpected_noise: [], ...overrides,
  };
}

function trace(id: string, category: string, requested: string[], executions: TraceExecutionRecord[], reviewRecord?: TraceReviewRecord, executionReviews: TraceExecutionReviewRecord[] = []): Trace {
  return {
    request: {
      type: "request", schema_version: 1, request_id: id, timestamp: "2026-07-30T00:00:00.000Z", task_category: category,
      caller_requested_capabilities: requested, planned_capabilities: requested, added_by_policy: [], suppressed_by_policy: [],
      policy_version: "builtin-1",
    },
    executions: executions.map((entry) => ({ ...entry, request_id: id })),
    review: reviewRecord === undefined ? undefined : { ...reviewRecord, request_id: id },
    execution_reviews: executionReviews.map((entry) => ({ ...entry, request_id: id })),
  };
}

const traces: Trace[] = [
  trace("rq_1", "bug_investigation", ["callers", "tests"], [execution(), execution({ provider: "local", tool: "mottainai_exec", capability: "tests", status: "empty", duration_ms: 30, output_size: 20 })],
    review({ sufficient: false, missing_capabilities: ["ownership"], unexpected_noise: ["generated_files"], follow_up_requested: true, next_capabilities: ["ownership"] }),
    [executionReview("ex_0")]),
  trace("rq_2", "bug_investigation", ["callers"], [execution({ status: "tool_error", duration_ms: 50, output_size: 0 })],
    review({ expected_found: false, sufficient: false, usefulness: 2, missing_capabilities: ["ownership", "recent_changes"] })),
  trace("rq_3", "symbol_lookup", ["definitions"], [execution({ capability: "definitions", duration_ms: 6, output_size: 300 })]),
];

test("totals count reviewed traces separately from requests", () => {
  const stats = aggregateTraces(traces);
  assert.deepEqual(stats.totals, {
    requests: 3, reviewed: 2, review_rate: 0.667, executions: 4,
    technical_success_rate: 0.75, execution_reviews: 1, execution_useful_rate: 1, execution_sufficient_rate: 0,
    expected_found_rate: 0.5, sufficient_rate: 0, mean_usefulness: 3,
  });
});

test("category stats rank missing capabilities and noise by frequency", () => {
  const stats = aggregateTraces(traces);
  const bug = stats.by_task_category.find((entry) => entry.task_category === "bug_investigation")!;
  assert.equal(bug.requests, 2);
  assert.equal(bug.expected_found_rate, 0.5);
  assert.equal(bug.follow_up_rate, 0.5);
  assert.deepEqual(bug.missing_capabilities, [{ label: "ownership", count: 2 }, { label: "recent_changes", count: 1 }]);
  assert.deepEqual(bug.unexpected_noise, [{ label: "generated_files", count: 1 }]);
});

test("capability stats separate empty results from errors and successes", () => {
  const stats = aggregateTraces(traces);
  const tests = stats.by_capability.find((entry) => entry.capability === "tests")!;
  assert.equal(tests.executions, 1);
  assert.equal(tests.status_counts.empty, 1);
  assert.equal(tests.status_counts.success, 0);

  const callers = stats.by_capability.find((entry) => entry.capability === "callers")!;
  assert.equal(callers.requested, 2);
  assert.equal(callers.status_counts.tool_error, 1);
  assert.equal(callers.mean_duration_ms, 30);
  assert.equal(callers.expected_found_rate, 0.5);
  assert.equal(callers.useful_rate, 1);
  assert.equal(callers.technical_success_rate, 0.5);

  // review でしか現れない capability も、欠落として数える
  const ownership = stats.by_capability.find((entry) => entry.capability === "ownership")!;
  assert.equal(ownership.missing_reports, 2);
  assert.equal(ownership.executions, 0);
});

test("provider stats break down success rate per capability", () => {
  const stats = aggregateTraces(traces);
  const codegraph = stats.by_provider.find((entry) => entry.provider === "codegraph")!;
  assert.equal(codegraph.executions, 3);
  assert.equal(codegraph.status_counts.success, 2);
  assert.equal(codegraph.status_counts.tool_error, 1);
  assert.equal(codegraph.useful_rate, 1);
  assert.deepEqual(codegraph.capabilities, [
    { capability: "callers", executions: 2, success_rate: 0.5 },
    { capability: "definitions", executions: 1, success_rate: 1 },
  ]);
});

test("follow-up capabilities become transitions per task category", () => {
  const stats = aggregateTraces(traces);
  assert.deepEqual(stats.transitions, [{ task_category: "bug_investigation", next_capability: "ownership", count: 1 }]);
});

test("aggregating no traces returns nulls instead of dividing by zero", () => {
  const stats = aggregateTraces([]);
  assert.deepEqual(stats.totals, {
    requests: 0, reviewed: 0, review_rate: null, executions: 0,
    technical_success_rate: null, execution_reviews: 0, execution_useful_rate: null, execution_sufficient_rate: null,
    expected_found_rate: null, sufficient_rate: null, mean_usefulness: null,
  });
  assert.deepEqual(stats.by_task_category, []);
});
