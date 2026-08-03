import type { ExecutionStatus, Trace } from "./trace.js";

function zeroStatusCounts(): Record<ExecutionStatus, number> {
  return { success: 0, empty: 0, tool_error: 0, provider_error: 0, unavailable: 0, policy_suppressed: 0, not_executed: 0 };
}

/**
 * trace の決定論的集約。LLM を使わない。
 *
 * 「provider が成功したか」ではなく「期待した証拠が揃ったか」を中心に数える。
 * 欠けた capability と noise の頻度が、policy 提案の主な入力になる。
 */

export interface LabelCount {
  label: string;
  count: number;
}

export interface CategoryStats {
  task_category: string;
  requests: number;
  reviewed: number;
  expected_found_rate: number | null;
  sufficient_rate: number | null;
  mean_usefulness: number | null;
  follow_up_rate: number | null;
  /** policy 適用後、実際に使われた capability（呼び出し側の指定 + policy が足した分）。 */
  planned_capabilities: LabelCount[];
  missing_capabilities: LabelCount[];
  unexpected_noise: LabelCount[];
  next_capabilities: LabelCount[];
}

export interface CapabilityStats {
  capability: string;
  requested: number;
  executions: number;
  status_counts: Record<ExecutionStatus, number>;
  missing_reports: number;
  mean_duration_ms: number | null;
  mean_output_size: number | null;
  /** この capability を要求した review 済み trace のうち expected_found だった比率。 */
  expected_found_rate: number | null;
  execution_reviews: number;
  useful_rate: number | null;
  sufficient_for_capability_rate: number | null;
  technical_success_rate: number | null;
}

export interface ProviderCapabilityStats {
  capability: string;
  executions: number;
  success_rate: number | null;
}

export interface ProviderStats {
  provider: string;
  executions: number;
  status_counts: Record<ExecutionStatus, number>;
  mean_duration_ms: number | null;
  mean_output_size: number | null;
  capabilities: ProviderCapabilityStats[];
  useful_rate: number | null;
  technical_success_rate: number | null;
}

export interface TransitionStats {
  task_category: string;
  next_capability: string;
  count: number;
}

export interface RoutingStats {
  totals: {
    requests: number;
    reviewed: number;
    review_rate: number | null;
    executions: number;
    technical_success_rate: number | null;
    execution_reviews: number;
    execution_useful_rate: number | null;
    execution_sufficient_rate: number | null;
    expected_found_rate: number | null;
    sufficient_rate: number | null;
    mean_usefulness: number | null;
  };
  by_task_category: CategoryStats[];
  by_capability: CapabilityStats[];
  by_provider: ProviderStats[];
  provider_gaps: LabelCount[];
  transitions: TransitionStats[];
  unknown_labels: LabelCount[];
  policy_versions: LabelCount[];
}

interface CategoryAccumulator {
  requests: number;
  reviewed: number;
  expectedFound: number;
  sufficient: number;
  usefulness: number[];
  followUp: number;
  requested: Map<string, number>;
  missing: Map<string, number>;
  noise: Map<string, number>;
  next: Map<string, number>;
}

interface CapabilityAccumulator {
  requested: number;
  executions: number;
  statusCounts: Record<ExecutionStatus, number>;
  missing: number;
  durations: number[];
  outputSizes: number[];
  reviewedRequests: number;
  expectedFound: number;
  technicalAttempts: number;
  technicalSuccesses: number;
  executionReviews: number;
  usefulReviews: number;
  useful: number;
  sufficientReviews: number;
  sufficient: number;
}

interface ProviderAccumulator {
  executions: number;
  statusCounts: Record<ExecutionStatus, number>;
  durations: number[];
  outputSizes: number[];
  capabilities: Map<string, { executions: number; success: number }>;
  executionReviews: number;
  usefulReviews: number;
  useful: number;
  technicalAttempts: number;
  technicalSuccesses: number;
}

const TECHNICAL_ATTEMPT_STATUSES = new Set<ExecutionStatus>(["success", "empty", "tool_error", "provider_error"]);

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round(numerator / denominator);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function increment(counter: Map<string, number>, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

function toLabelCounts(counter: Map<string, number>): LabelCount[] {
  return [...counter.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

export function aggregateTraces(traces: Trace[]): RoutingStats {
  const categories = new Map<string, CategoryAccumulator>();
  const capabilities = new Map<string, CapabilityAccumulator>();
  const providers = new Map<string, ProviderAccumulator>();
  const transitions = new Map<string, number>();
  const unknownLabels = new Map<string, number>();
  const policyVersions = new Map<string, number>();
  const providerGaps = new Map<string, number>();

  let reviewed = 0;
  let executions = 0;
  let expectedFound = 0;
  let sufficient = 0;
  let technicalAttempts = 0;
  let technicalSuccesses = 0;
  let executionReviews = 0;
  let executionUsefulReviews = 0;
  let executionUseful = 0;
  let executionSufficientReviews = 0;
  let executionSufficient = 0;
  const usefulness: number[] = [];

  for (const trace of traces) {
    const category: CategoryAccumulator = categories.get(trace.request.task_category) ?? {
      requests: 0, reviewed: 0, expectedFound: 0, sufficient: 0, usefulness: [], followUp: 0,
      requested: new Map(), missing: new Map(), noise: new Map(), next: new Map(),
    };
    category.requests += 1;
    categories.set(trace.request.task_category, category);
    increment(policyVersions, trace.request.policy_version);
    for (const label of trace.request.unknown_labels ?? []) increment(unknownLabels, label);

    for (const capability of trace.request.planned_capabilities) {
      increment(category.requested, capability);
      const entry = capabilityEntry(capabilities, capability);
      entry.requested += 1;
      if (trace.review !== undefined) {
        entry.reviewedRequests += 1;
        if (trace.review.expected_found) entry.expectedFound += 1;
      }
    }

    for (const execution of trace.executions) {
      executions += 1;
      const entry = capabilityEntry(capabilities, execution.capability);
      entry.executions += 1;
      entry.statusCounts[execution.status] += 1;
      entry.durations.push(execution.duration_ms);
      entry.outputSizes.push(execution.output_size);
      if (TECHNICAL_ATTEMPT_STATUSES.has(execution.status)) {
        entry.technicalAttempts += 1;
        technicalAttempts += 1;
        if (execution.status === "success" || execution.status === "empty") {
          entry.technicalSuccesses += 1;
          technicalSuccesses += 1;
        }
      }
      if (execution.status === "unavailable") increment(providerGaps, execution.capability);

      const provider: ProviderAccumulator = providers.get(execution.provider) ?? {
        executions: 0, statusCounts: zeroStatusCounts(), durations: [], outputSizes: [], capabilities: new Map(),
        executionReviews: 0, usefulReviews: 0, useful: 0, technicalAttempts: 0, technicalSuccesses: 0,
      };
      provider.executions += 1;
      provider.statusCounts[execution.status] += 1;
      provider.durations.push(execution.duration_ms);
      provider.outputSizes.push(execution.output_size);
      if (TECHNICAL_ATTEMPT_STATUSES.has(execution.status)) {
        provider.technicalAttempts += 1;
        if (execution.status === "success" || execution.status === "empty") provider.technicalSuccesses += 1;
      }
      const perCapability = provider.capabilities.get(execution.capability) ?? { executions: 0, success: 0 };
      perCapability.executions += 1;
      if (execution.status === "success") perCapability.success += 1;
      provider.capabilities.set(execution.capability, perCapability);
      providers.set(execution.provider, provider);
    }

    for (const executionReview of trace.execution_reviews ?? []) {
      executionReviews += 1;
      if (executionReview.useful !== undefined) {
        executionUsefulReviews += 1;
        if (executionReview.useful) executionUseful += 1;
      }
      if (executionReview.sufficient_for_capability !== undefined) {
        executionSufficientReviews += 1;
        if (executionReview.sufficient_for_capability) executionSufficient += 1;
      }
      const execution = trace.executions.find((candidate) => candidate.execution_id === executionReview.execution_id);
      if (execution === undefined) continue;
      const capability = capabilityEntry(capabilities, execution.capability);
      capability.executionReviews += 1;
      if (executionReview.useful !== undefined) {
        capability.usefulReviews += 1;
        if (executionReview.useful) capability.useful += 1;
      }
      if (executionReview.sufficient_for_capability !== undefined) {
        capability.sufficientReviews += 1;
        if (executionReview.sufficient_for_capability) capability.sufficient += 1;
      }
      const provider = providers.get(execution.provider);
      if (provider !== undefined) {
        provider.executionReviews += 1;
        if (executionReview.useful !== undefined) {
          provider.usefulReviews += 1;
          if (executionReview.useful) provider.useful += 1;
        }
      }
    }

    if (trace.review === undefined) continue;
    reviewed += 1;
    category.reviewed += 1;
    if (trace.review.expected_found) {
      expectedFound += 1;
      category.expectedFound += 1;
    }
    if (trace.review.sufficient) {
      sufficient += 1;
      category.sufficient += 1;
    }
    if (typeof trace.review.usefulness === "number") {
      usefulness.push(trace.review.usefulness);
      category.usefulness.push(trace.review.usefulness);
    }
    if (trace.review.follow_up_requested) category.followUp += 1;
    for (const capability of trace.review.missing_capabilities) {
      increment(category.missing, capability);
      capabilityEntry(capabilities, capability).missing += 1;
    }
    for (const label of trace.review.unexpected_noise) increment(category.noise, label);
    for (const capability of trace.review.next_capabilities) {
      increment(category.next, capability);
      increment(transitions, `${trace.request.task_category} ${capability}`);
    }
  }

  return {
    totals: {
      requests: traces.length,
      reviewed,
      review_rate: rate(reviewed, traces.length),
      executions,
      technical_success_rate: rate(technicalSuccesses, technicalAttempts),
      execution_reviews: executionReviews,
      execution_useful_rate: rate(executionUseful, executionUsefulReviews),
      execution_sufficient_rate: rate(executionSufficient, executionSufficientReviews),
      expected_found_rate: rate(expectedFound, reviewed),
      sufficient_rate: rate(sufficient, reviewed),
      mean_usefulness: mean(usefulness),
    },
    by_task_category: [...categories.entries()]
      .map(([taskCategory, entry]) => ({
        task_category: taskCategory,
        requests: entry.requests,
        reviewed: entry.reviewed,
        expected_found_rate: rate(entry.expectedFound, entry.reviewed),
        sufficient_rate: rate(entry.sufficient, entry.reviewed),
        mean_usefulness: mean(entry.usefulness),
        follow_up_rate: rate(entry.followUp, entry.reviewed),
        planned_capabilities: toLabelCounts(entry.requested),
        missing_capabilities: toLabelCounts(entry.missing),
        unexpected_noise: toLabelCounts(entry.noise),
        next_capabilities: toLabelCounts(entry.next),
      }))
      .sort((left, right) => right.requests - left.requests || left.task_category.localeCompare(right.task_category)),
    by_capability: [...capabilities.entries()]
      .map(([capability, entry]) => ({
        capability,
        requested: entry.requested,
        executions: entry.executions,
        status_counts: entry.statusCounts,
        missing_reports: entry.missing,
        mean_duration_ms: mean(entry.durations),
        mean_output_size: mean(entry.outputSizes),
        expected_found_rate: rate(entry.expectedFound, entry.reviewedRequests),
        execution_reviews: entry.executionReviews,
        useful_rate: rate(entry.useful, entry.usefulReviews),
        sufficient_for_capability_rate: rate(entry.sufficient, entry.sufficientReviews),
        technical_success_rate: rate(entry.technicalSuccesses, entry.technicalAttempts),
      }))
      .sort((left, right) =>
        right.requested + right.executions - (left.requested + left.executions) ||
        left.capability.localeCompare(right.capability),
      ),
    by_provider: [...providers.entries()]
      .map(([provider, entry]) => ({
        provider,
        executions: entry.executions,
        status_counts: entry.statusCounts,
        mean_duration_ms: mean(entry.durations),
        mean_output_size: mean(entry.outputSizes),
        capabilities: [...entry.capabilities.entries()]
          .map(([capability, perCapability]) => ({
            capability,
            executions: perCapability.executions,
            success_rate: rate(perCapability.success, perCapability.executions),
          }))
          .sort((left, right) => right.executions - left.executions || left.capability.localeCompare(right.capability)),
        useful_rate: rate(entry.useful, entry.usefulReviews),
        technical_success_rate: rate(entry.technicalSuccesses, entry.technicalAttempts),
      }))
      .sort((left, right) => right.executions - left.executions || left.provider.localeCompare(right.provider)),
    transitions: [...transitions.entries()]
      .map(([key, count]) => {
        const [taskCategory, nextCapability] = key.split(" ");
        return { task_category: taskCategory, next_capability: nextCapability, count };
      })
      .sort((left, right) => right.count - left.count || left.task_category.localeCompare(right.task_category)),
    provider_gaps: toLabelCounts(providerGaps),
    unknown_labels: toLabelCounts(unknownLabels),
    policy_versions: toLabelCounts(policyVersions),
  };
}

function capabilityEntry(capabilities: Map<string, CapabilityAccumulator>, capability: string): CapabilityAccumulator {
  const entry: CapabilityAccumulator = capabilities.get(capability) ?? {
    requested: 0, executions: 0, statusCounts: zeroStatusCounts(),
    missing: 0, durations: [], outputSizes: [], reviewedRequests: 0, expectedFound: 0,
    technicalAttempts: 0, technicalSuccesses: 0, executionReviews: 0, usefulReviews: 0, useful: 0,
    sufficientReviews: 0, sufficient: 0,
  };
  capabilities.set(capability, entry);
  return entry;
}
