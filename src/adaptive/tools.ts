import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_SCHEMA, output } from "../envelope.js";
import type { ArtifactStore } from "../retrieve.js";
import type { CapabilityIndex } from "./capabilities.js";
import { normalizeCallerMetadata } from "./caller.js";
import { loadPolicies, policyFileName, resolvePlan, savePolicy } from "./policy.js";
import type { PolicyDocument } from "./policy.js";
import { proposePolicy } from "./propose.js";
import { aggregateTraces } from "./stats.js";
import type { RoutingStats } from "./stats.js";
import type { Trace, TraceStore } from "./trace.js";
import { normalizeCapabilityList, normalizeNoiseList } from "./taxonomy.js";
import { assertValidToolArguments, ToolInputValidationError } from "../mcp-tool-validation.js";

/**
 * caller-supervised routing の MCP 面。
 *
 * `mottainai_plan` は capability を provider へ写像した計画と `request_id` を返すだけで、
 * upstream は呼ばない。証拠収集そのものは既存ツール（gateway 経由の任意ツール）が行い、
 * `_mottainai.request_id` を添えることで同じ trace へ紐付く。
 */

const TASK_SCHEMA = {
  type: "object" as const,
  properties: {
    category: { type: "string", description: "Task class such as bug_investigation or symbol_lookup." },
    intent: { type: "string", description: "Caller intent such as locate_root_cause." },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["category"],
  additionalProperties: false,
};

const CAPABILITY_LIST_SCHEMA = { type: "array" as const, items: { type: "string" as const } };

const REVIEW_SCHEMA = {
  type: "object" as const,
  properties: {
    expected_found: { type: "boolean" as const },
    sufficient: { type: "boolean" as const },
    usefulness: { type: "integer" as const, minimum: 1, maximum: 5 },
    missing_capabilities: CAPABILITY_LIST_SCHEMA,
    unexpected_noise: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["expected_found", "sufficient"],
  additionalProperties: false,
};

const OUTCOME_SCHEMA = {
  type: "object" as const,
  properties: {
    follow_up_requested: { type: "boolean" as const },
    next_capabilities: CAPABILITY_LIST_SCHEMA,
  },
  additionalProperties: false,
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const adaptiveTools: Tool[] = [
  {
    name: "mottainai_plan",
    description: "Open a supervised exploration: map task and evidence capabilities to available providers, return request_id.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_SCHEMA,
        requested_capabilities: { ...CAPABILITY_LIST_SCHEMA, description: "Evidence capabilities such as definitions, callers, tests." },
        context: { type: "string", description: "Optional free text; stored as digest unless raw retention is enabled." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_review",
    description: "Report whether an exploration returned the expected evidence. Cheap; call after consuming a request_id result.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1 },
        expected_found: { type: "boolean", description: "Expected evidence was present." },
        sufficient: { type: "boolean", description: "No further exploration needed." },
        usefulness: { type: "integer", minimum: 1, maximum: 5 },
        missing_capabilities: CAPABILITY_LIST_SCHEMA,
        unexpected_noise: { type: "array", items: { type: "string" }, description: "Noise labels such as generated_files." },
        follow_up_requested: { type: "boolean" },
        next_capabilities: CAPABILITY_LIST_SCHEMA,
        review: REVIEW_SCHEMA,
        outcome: OUTCOME_SCHEMA,
      },
      required: ["request_id"],
      anyOf: [
        { required: ["expected_found", "sufficient"] },
        { required: ["review"] },
      ],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "mottainai_execution_review",
    description: "Report usefulness of one execution without replacing the whole-request review.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1 },
        execution_id: { type: "string", minLength: 1 },
        expected_found: { type: "boolean" },
        useful: { type: "boolean" },
        sufficient_for_capability: { type: "boolean" },
        missing_capabilities: CAPABILITY_LIST_SCHEMA,
        unexpected_noise: { type: "array", items: { type: "string" } },
      },
      required: ["request_id", "execution_id"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "mottainai_policy_stats",
    description: "Aggregate stored routing traces by task category, capability and provider, or inspect one request_id.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, description: "Inspect a single trace instead of aggregating." },
        task_category: { type: "string", minLength: 1 },
        since_hours: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        reviewed_only: { type: "boolean" },
        top: { type: "integer", minimum: 1, maximum: 50, description: "Entries kept per ranked list; default 10." },
      },
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_policy_propose",
    description: "Propose capability routing rules from traces and replay them against history. Never activates a policy.",
    inputSchema: {
      type: "object",
      properties: {
        min_support: { type: "integer", minimum: 1, maximum: 10_000, description: "Reviewed traces required per rule; default 5." },
        missing_threshold: { type: "number", minimum: 0, maximum: 1, description: "Missing-report rate to add a capability; default 0.3." },
        holdout_ratio: { type: "number", minimum: 0, maximum: 0.9, description: "Newest reviewed traces held out; default 0.3." },
        write: { type: "boolean", description: "Persist the candidate policy file; default true." },
      },
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const adaptiveToolNames = new Set(adaptiveTools.map((tool) => tool.name));

export function isAdaptiveTool(name: string): boolean {
  return adaptiveToolNames.has(name);
}

export interface AdaptiveToolContext {
  traceStore: TraceStore;
  capabilityIndex: CapabilityIndex;
  loadPolicy: () => PolicyDocument;
  policyDir: string;
  artifactStore: ArtifactStore;
}

type Args = Record<string, unknown> | undefined;

const DEFAULT_TOP = 10;

export async function callAdaptiveTool(name: string, args: Args, context: AdaptiveToolContext): Promise<CallToolResult> {
  const advertisedTool = adaptiveTools.find((tool) => tool.name === name);
  if (advertisedTool !== undefined) assertAdaptiveToolArguments(advertisedTool, args);
  switch (name) {
    case "mottainai_plan": return planTool(args, context);
    case "mottainai_review": return reviewTool(args, context);
    case "mottainai_execution_review": return executionReviewTool(args, context);
    case "mottainai_policy_stats": return statsTool(args, context);
    case "mottainai_policy_propose": return proposeTool(args, context);
    default: throw new Error(`Unknown adaptive tool: ${name}`);
  }
}

/**
 * Keep the existing semantic parser diagnostics for malformed values it owns,
 * while routing envelope/unknown-field checks through the canonical validator.
 * The parser is deliberately run only after a schema failure and has no
 * persistence or provider effects.
 */
function assertAdaptiveToolArguments(tool: Tool, args: Args): void {
  try {
    assertValidToolArguments(tool, args);
  } catch (error) {
    if (!(error instanceof ToolInputValidationError)) throw error;
    if (error.issues.some((issue) => issue.keyword === "additionalProperties")) throw error;
    try {
      adaptiveSemanticPreflight(tool.name, args);
    } catch (legacyError) {
      throw legacyError;
    }
    throw error;
  }
}

function adaptiveSemanticPreflight(name: string, args: Args): void {
  if (name === "mottainai_plan") {
    planMetadata(args);
    return;
  }
  if (name === "mottainai_review") parseReviewInput(args);
}

function booleanArg(args: Args, key: string): boolean | undefined {
  const candidate = args?.[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") throw new Error(`${key} must be a boolean`);
  return candidate;
}

function numberArg(args: Args, key: string, min: number, max: number): number | undefined {
  const candidate = args?.[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < min || candidate > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return candidate;
}

function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = args?.[key];
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${key} must be a non-empty string`);
  return candidate;
}

/** 全量を artifact へ入れる。返却は上位 N 件に絞り、全体は result_id から辿れるようにする。 */
function storeSnapshot<T>(store: ArtifactStore, operation: string, payload: T): string {
  return store.putArtifact({
    text: JSON.stringify(payload, null, 2),
    metadata: { operation, summary: `${operation} snapshot` },
  });
}

function planMetadata(args: Args): ReturnType<typeof normalizeCallerMetadata> {
  return normalizeCallerMetadata({
    task: args?.task,
    requested_capabilities: args?.requested_capabilities,
    context: args?.context,
  }, "mottainai_plan");
}

async function planTool(args: Args, context: AdaptiveToolContext): Promise<CallToolResult> {
  const metadata = planMetadata(args);
  const task = metadata.task;
  if (task === undefined) throw new Error("task.category is required");

  const policy = context.loadPolicy();
  const plan = resolvePlan(policy, task.category, metadata.requested_capabilities);
  const entries = plan.capabilities.map((capability) => {
    const providers = context.capabilityIndex.rankProviders(capability, { taskCategory: task.category });
    return {
      capability,
      requested_by_caller: metadata.requested_capabilities.includes(capability),
      providers: providers.map((provider) => ({
        provider: provider.provider,
        tool: provider.tool,
        source: provider.source,
        rank: provider.rank,
        reasons: provider.reasons,
        eligible_for_fallback: provider.eligible_for_fallback,
      })),
      status: providers.length > 0 ? "available" : "unsatisfied",
    };
  });
  const unsatisfied = entries.filter((entry) => entry.status === "unsatisfied").map((entry) => entry.capability);

  const request = await context.traceStore.beginRequest({
    task_category: task.category,
    task_intent: task.intent,
    task_confidence: task.confidence,
    caller_requested_capabilities: metadata.requested_capabilities,
    planned_capabilities: plan.capabilities,
    added_by_policy: plan.added_by_policy,
    suppressed_by_policy: plan.suppressed,
    policy_version: plan.policy_version,
    unknown_labels: metadata.unknown_labels,
    context: metadata.context,
  });
  // 満たせる provider が無い capability は unavailable として残す。provider の欠落と
  // 「呼び出し側が避けるべき capability」は別の信号であり、混ぜない（issue #47）。
  for (const capability of unsatisfied) {
    await context.traceStore.recordExecution({
      request_id: request.request_id, provider: "none", tool: "none", capability,
      duration_ms: 0, result_count: 0, output_size: 0, status: "unavailable",
    });
  }

  const summary = `plan ${request.request_id} category=${task.category} capabilities=${plan.capabilities.length} unsatisfied=${unsatisfied.length} policy=${plan.policy_version}`;
  const payload = { request_id: request.request_id, plan: entries, policy: plan };
  return output("plan", unsatisfied.length === entries.length && entries.length > 0 ? "partial" : "success", summary, storeSnapshot(context.artifactStore, "plan", payload), {
    facts: entries,
    request_id: request.request_id,
    policy_version: plan.policy_version,
    task_category: task.category,
    matched_default_rule: plan.matched_default_rule,
    added_by_policy: plan.added_by_policy,
    suppressed_by_policy: plan.suppressed,
    unsatisfied_capabilities: unsatisfied,
    trace_persisted: context.traceStore.enabled,
    next_step: `pass {"_mottainai":{"request_id":"${request.request_id}"}} on each evidence call, then mottainai_review`,
    metrics: { capabilities: entries.length, unsatisfied: unsatisfied.length, providers: entries.reduce((sum, entry) => sum + entry.providers.length, 0) },
  });
}

function reviewSection(args: Args, key: string): Args {
  const nested = args?.[key];
  if (nested === undefined) return args;
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) throw new Error(`${key} must be an object`);
  return nested as Record<string, unknown>;
}

interface ParsedReviewInput {
  requestId: string;
  expectedFound: boolean;
  sufficient: boolean;
  usefulness: number | undefined;
  missing: string[];
  noise: string[];
  followUpRequested: boolean;
  nextCapabilities: string[];
}

function parseReviewInput(args: Args): ParsedReviewInput {
  const requestId = stringArg(args, "request_id", true)!;
  // issue #40 の例は review / outcome をネストする。フラット引数と両方受ける。
  const review = reviewSection(args, "review");
  const outcome = reviewSection(args, "outcome");
  const expectedFound = booleanArg(review, "expected_found");
  if (expectedFound === undefined) throw new Error("expected_found must be a boolean");
  const sufficient = booleanArg(review, "sufficient");
  if (sufficient === undefined) throw new Error("sufficient must be a boolean");
  const usefulness = numberArg(review, "usefulness", 1, 5);
  if (usefulness !== undefined && !Number.isInteger(usefulness)) throw new Error("usefulness must be an integer between 1 and 5");

  const missing = normalizeCapabilityList(review?.missing_capabilities, "missing_capabilities").map((entry) => entry.id);
  const noise = normalizeNoiseList(review?.unexpected_noise, "unexpected_noise").map((entry) => entry.id);
  const nextCapabilities = normalizeCapabilityList(outcome?.next_capabilities, "next_capabilities").map((entry) => entry.id);

  return {
    requestId,
    expectedFound,
    sufficient,
    usefulness,
    missing,
    noise,
    followUpRequested: booleanArg(outcome, "follow_up_requested") ?? nextCapabilities.length > 0,
    nextCapabilities,
  };
}

async function reviewTool(args: Args, context: AdaptiveToolContext): Promise<CallToolResult> {
  const {
    requestId,
    expectedFound,
    sufficient,
    usefulness,
    missing,
    noise,
    followUpRequested,
    nextCapabilities,
  } = parseReviewInput(args);

  const recorded = await context.traceStore.recordReview({
    request_id: requestId,
    expected_found: expectedFound,
    sufficient,
    usefulness,
    missing_capabilities: missing,
    unexpected_noise: noise,
    follow_up_requested: followUpRequested,
    next_capabilities: nextCapabilities,
  });

  const known = recorded === "recorded";
  const summary = known
    ? `review recorded ${requestId} expected_found=${expectedFound} missing=${missing.length} noise=${noise.length}`
    : `review rejected: unknown request_id ${requestId}`;
  const resultId = storeSnapshot(context.artifactStore, "review", { request_id: requestId, recorded: known, missing, noise });
  return output("review", known ? "success" : "failed", summary, resultId, {
    request_id: requestId,
    recorded: known,
    trace_persisted: context.traceStore.enabled,
    diagnostics: known ? [] : [{ severity: "error", message: "unknown request_id; call mottainai_plan first or pass the request_id returned by a traced call" }],
    metrics: { missing_capabilities: missing.length, unexpected_noise: noise.length, next_capabilities: nextCapabilities.length },
  });
}

async function executionReviewTool(args: Args, context: AdaptiveToolContext): Promise<CallToolResult> {
  const requestId = stringArg(args, "request_id", true)!;
  const executionId = stringArg(args, "execution_id", true)!;
  const expectedFound = booleanArg(args, "expected_found");
  const useful = booleanArg(args, "useful");
  const sufficient = booleanArg(args, "sufficient_for_capability");
  const missing = normalizeCapabilityList(args?.missing_capabilities, "missing_capabilities").map((entry) => entry.id);
  const noise = normalizeNoiseList(args?.unexpected_noise, "unexpected_noise").map((entry) => entry.id);
  if (expectedFound === undefined && useful === undefined && sufficient === undefined && missing.length === 0 && noise.length === 0) {
    throw new Error("execution review must include at least one review field");
  }

  const recorded = await context.traceStore.recordExecutionReview({
    request_id: requestId,
    execution_id: executionId,
    expected_found: expectedFound,
    useful,
    sufficient_for_capability: sufficient,
    missing_capabilities: missing,
    unexpected_noise: noise,
  });
  const known = recorded === "recorded";
  const summary = known
    ? `execution review recorded ${executionId} useful=${useful ?? "unknown"}`
    : `execution review rejected: ${recorded} ${executionId}`;
  const resultId = storeSnapshot(context.artifactStore, "execution_review", { request_id: requestId, execution_id: executionId, recorded: known });
  return output("execution_review", known ? "success" : "failed", summary, resultId, {
    request_id: requestId,
    execution_id: executionId,
    recorded: known,
    diagnostics: known ? [] : [{ severity: "error", message: recorded === "unknown_request" ? "unknown request_id" : "unknown execution_id" }],
    metrics: { missing_capabilities: missing.length, unexpected_noise: noise.length },
  });
}

function trimStats(stats: RoutingStats, top: number): RoutingStats {
  return {
    ...stats,
    by_task_category: stats.by_task_category.slice(0, top).map((category) => ({
      ...category,
      planned_capabilities: category.planned_capabilities.slice(0, top),
      missing_capabilities: category.missing_capabilities.slice(0, top),
      unexpected_noise: category.unexpected_noise.slice(0, top),
      next_capabilities: category.next_capabilities.slice(0, top),
    })),
    by_capability: stats.by_capability.slice(0, top),
    by_provider: stats.by_provider.slice(0, top).map((provider) => ({ ...provider, capabilities: provider.capabilities.slice(0, top) })),
    transitions: stats.transitions.slice(0, top),
    provider_gaps: stats.provider_gaps.slice(0, top),
    unknown_labels: stats.unknown_labels.slice(0, top),
    policy_versions: stats.policy_versions.slice(0, top),
  };
}

function traceView(trace: Trace): Record<string, unknown> {
  return {
    request: { ...trace.request, context: undefined },
    executions: trace.executions,
    review: trace.review,
    execution_reviews: trace.execution_reviews,
  };
}

function statsTool(args: Args, context: AdaptiveToolContext): CallToolResult {
  const requestId = stringArg(args, "request_id");
  const sinceHours = numberArg(args, "since_hours", 0, Number.MAX_SAFE_INTEGER);
  const top = numberArg(args, "top", 1, 50) ?? DEFAULT_TOP;
  const traces = context.traceStore.load({
    requestId,
    taskCategory: stringArg(args, "task_category"),
    reviewedOnly: booleanArg(args, "reviewed_only"),
    since: sinceHours === undefined ? undefined : Date.now() - sinceHours * 60 * 60 * 1000,
  });

  if (requestId !== undefined) {
    const trace = traces[0];
    const resultId = storeSnapshot(context.artifactStore, "policy_stats", trace === undefined ? { request_id: requestId } : traceView(trace));
    if (trace === undefined) {
      return output("policy_stats", "failed", `trace not found: ${requestId}`, resultId, {
        diagnostics: [{ severity: "error", message: "unknown request_id, or traces are disabled or expired" }],
        request_id: requestId,
      });
    }
    return output("policy_stats", "success", `trace ${requestId} category=${trace.request.task_category} executions=${trace.executions.length} reviewed=${trace.review !== undefined}`, resultId, {
      facts: trace.executions,
      trace: traceView(trace),
      metrics: { executions: trace.executions.length },
    });
  }

  const stats = aggregateTraces(traces);
  const resultId = storeSnapshot(context.artifactStore, "policy_stats", stats);
  const trimmed = trimStats(stats, top);
  const truncated = JSON.stringify(trimmed) !== JSON.stringify(stats);
  const policy = context.loadPolicy();
  return output("policy_stats", "success", `stats requests=${stats.totals.requests} reviewed=${stats.totals.reviewed} executions=${stats.totals.executions} policy=${policy.policy_version}`, resultId, {
    facts: trimmed.by_task_category,
    totals: stats.totals,
    by_capability: trimmed.by_capability,
    by_provider: trimmed.by_provider,
    provider_gaps: trimmed.provider_gaps,
    transitions: trimmed.transitions,
    unknown_labels: trimmed.unknown_labels,
    policy_versions: trimmed.policy_versions,
    active_policy_version: policy.policy_version,
    trace_directory: context.traceStore.directory,
    truncated,
    metrics: { requests: stats.totals.requests, reviewed: stats.totals.reviewed, executions: stats.totals.executions, top },
  });
}

function proposeTool(args: Args, context: AdaptiveToolContext): CallToolResult {
  const active = context.loadPolicy();
  const proposal = proposePolicy(context.traceStore.load(), active, {
    minSupport: numberArg(args, "min_support", 1, 10_000),
    missingThreshold: numberArg(args, "missing_threshold", 0, 1),
    holdoutRatio: numberArg(args, "holdout_ratio", 0, 0.9),
  });
  const write = booleanArg(args, "write") ?? true;
  const filePath = write && proposal.policy !== undefined ? savePolicy(context.policyDir, proposal.policy) : undefined;
  const candidates = loadPolicies(context.policyDir).filter((stored) => stored.document.status === "candidate");

  const summary = proposal.status === "proposed"
    ? `policy candidate ${proposal.policy?.policy_version} rules_changed=${proposal.changes.length} coverage_delta=${proposal.holdout_evaluation?.coverage_delta ?? proposal.training_evaluation.coverage_delta ?? 0} (not active)`
    : `no policy change: ${proposal.status} from ${proposal.training_traces} reviewed traces`;
  const resultId = storeSnapshot(context.artifactStore, "policy_propose", proposal);
  return output("policy_propose", proposal.status === "proposed" ? "success" : "partial", summary, resultId, {
    facts: proposal.changes,
    proposal_status: proposal.status,
    policy_version: proposal.policy?.policy_version,
    policy: proposal.policy,
    policy_file: filePath,
    active_policy_version: active.policy_version,
    training_evaluation: proposal.training_evaluation,
    holdout_evaluation: proposal.holdout_evaluation,
    reasons: proposal.reasons,
    open_candidates: candidates.map((stored) => stored.document.policy_version),
    // 承認は人間の明示操作に限る。MCP からは activate しない。
    activation: proposal.policy === undefined
      ? "no candidate generated"
      : `review ${filePath ?? policyFileName(proposal.policy.policy_version)}, then run: pnpm run policy approve ${proposal.policy.policy_version}`,
    metrics: {
      training_traces: proposal.training_traces,
      holdout_traces: proposal.holdout_traces,
      rules_changed: proposal.changes.length,
      regressions: (proposal.holdout_evaluation ?? proposal.training_evaluation).regressions,
    },
  });
}
