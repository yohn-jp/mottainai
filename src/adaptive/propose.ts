import { DEFAULT_RULE_CATEGORY, newPolicyVersion, resolvePlan } from "./policy.js";
import type { PolicyDocument, PolicyRule } from "./policy.js";
import type { ExecutionStatus, Trace } from "./trace.js";

/**
 * avoid 判定の母数に数える execution status。issue #47: provider が無い（`unavailable`）、
 * provider/接続が落ちた（`provider_error`）、policy で抑制された・実行されなかった
 * （`policy_suppressed` / `not_executed`）ケースは「呼び出し側がこの capability を
 * 避けたい」という信号ではない。実際に provider が動いて結果を返した（または tool 自体が
 * 失敗を返した）ケースだけを数える。
 */
const ATTEMPTED_STATUSES: ReadonlySet<ExecutionStatus> = new Set(["success", "empty", "tool_error"]);

/**
 * 蓄積した trace から候補 policy を生成し、履歴に対して再生評価する。
 *
 * 生成も評価も統計だけで行う（LLM 不要）。生成した policy は必ず `candidate` 状態で、
 * 人間が承認するまで routing には効かない。
 */

export interface ProposalOptions {
  /** 規則を提案するのに必要な、その分類の review 済み trace 数。 */
  minSupport?: number;
  /** capability を追加する missing 報告比率のしきい値。 */
  missingThreshold?: number;
  /** 評価用に末尾へ取り分ける review 済み trace の比率。 */
  holdoutRatio?: number;
  now?: Date;
}

export interface RuleChange {
  task_category: string;
  added: string[];
  avoid_added: string[];
  support: number;
  confidence: number;
}

export interface EvaluationByCategory {
  task_category: string;
  traces: number;
  missing_coverage_active: number | null;
  missing_coverage_candidate: number | null;
  mean_extra_capabilities: number | null;
}

export interface PolicyEvaluation {
  traces: number;
  missing_coverage_active: number | null;
  missing_coverage_candidate: number | null;
  coverage_delta: number | null;
  mean_extra_capabilities: number | null;
  /** 候補の方が missing を取り逃がした trace 数。 */
  regressions: number;
  by_task_category: EvaluationByCategory[];
}

export interface PolicyProposal {
  status: "proposed" | "insufficient_data" | "no_change";
  policy?: PolicyDocument;
  changes: RuleChange[];
  /** 提案生成に使わなかった後半 trace での評価。null は holdout を取れなかったことを表す。 */
  holdout_evaluation: PolicyEvaluation | null;
  /** 生成に使った trace 自身での評価（in-sample）。 */
  training_evaluation: PolicyEvaluation;
  training_traces: number;
  holdout_traces: number;
  reasons: string[];
}

const DEFAULT_MIN_SUPPORT = 5;
const DEFAULT_MISSING_THRESHOLD = 0.3;
const DEFAULT_HOLDOUT_RATIO = 0.3;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** review 済み trace を時刻順に並べ、学習用と holdout に分ける。 */
function splitTraces(traces: Trace[], holdoutRatio: number, minSupport: number): { training: Trace[]; holdout: Trace[] } {
  const reviewed = traces
    .filter((trace) => trace.review !== undefined)
    .sort((left, right) => left.request.timestamp.localeCompare(right.request.timestamp));
  // 学習側が最低支持数を割ると規則が出ない。母数が小さいうちは holdout を諦めて全件学習する。
  const holdoutSize = Math.floor(reviewed.length * holdoutRatio);
  if (holdoutSize === 0 || reviewed.length - holdoutSize < minSupport) {
    return { training: reviewed, holdout: [] };
  }
  return { training: reviewed.slice(0, reviewed.length - holdoutSize), holdout: reviewed.slice(reviewed.length - holdoutSize) };
}

function activeRuleCapabilities(policy: PolicyDocument, taskCategory: string): string[] {
  const rule = policy.rules.find((candidate) => candidate.task_category === taskCategory)
    ?? policy.rules.find((candidate) => candidate.task_category === DEFAULT_RULE_CATEGORY);
  return [...(rule?.capabilities ?? [])];
}

/** その分類の trace 群から、追加すべき capability と避けるべき capability を決める。 */
function proposeRule(
  taskCategory: string,
  traces: Trace[],
  active: PolicyDocument,
  minSupport: number,
  missingThreshold: number,
): { rule: PolicyRule; change: RuleChange } | undefined {
  if (traces.length < minSupport) return undefined;
  const baseline = activeRuleCapabilities(active, taskCategory);
  const missingCounts = new Map<string, number>();
  for (const trace of traces) {
    for (const capability of trace.review?.missing_capabilities ?? []) {
      missingCounts.set(capability, (missingCounts.get(capability) ?? 0) + 1);
    }
  }

  const added = [...missingCounts.entries()]
    .filter(([capability, count]) => count / traces.length >= missingThreshold && !baseline.includes(capability))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([capability]) => capability);

  // 「要求されたのに、その分類では一度も証拠が出なかった」capability だけを avoid にする。
  // noise ラベルは capability ではないため、直接 avoid へ写像しない。
  // provider が無い・落ちた・実行されなかった execution は母数に入れない（provider の
  // 欠落を「避けるべき capability」と誤学習しないため。issue #47 Phase 4）。
  const executionsByCapability = new Map<string, { total: number; success: number }>();
  for (const trace of traces) {
    for (const execution of trace.executions) {
      if (!ATTEMPTED_STATUSES.has(execution.status)) continue;
      const entry = executionsByCapability.get(execution.capability) ?? { total: 0, success: 0 };
      entry.total += 1;
      if (execution.status === "success") entry.success += 1;
      executionsByCapability.set(execution.capability, entry);
    }
  }
  const avoidAdded = baseline
    .filter((capability) => {
      const executed = executionsByCapability.get(capability);
      return executed !== undefined && executed.total >= minSupport && executed.success === 0;
    })
    .sort();

  if (added.length === 0 && avoidAdded.length === 0) return undefined;

  const capabilities = [...baseline, ...added];
  const covered = traces.filter((trace) =>
    (trace.review?.missing_capabilities ?? []).every((capability) => capabilities.includes(capability)),
  ).length;
  const rule: PolicyRule = {
    task_category: taskCategory,
    capabilities,
    avoid_capabilities: avoidAdded.length > 0 ? avoidAdded : undefined,
    support: traces.length,
    confidence: round(covered / traces.length),
  };
  return {
    rule,
    change: { task_category: taskCategory, added, avoid_added: avoidAdded, support: traces.length, confidence: rule.confidence ?? 0 },
  };
}

export function evaluatePolicy(candidate: PolicyDocument, active: PolicyDocument, traces: Trace[]): PolicyEvaluation {
  const reviewed = traces.filter((trace) => trace.review !== undefined);
  const perCategory = new Map<string, { activeCoverage: number[]; candidateCoverage: number[]; extra: number[] }>();
  const activeCoverage: number[] = [];
  const candidateCoverage: number[] = [];
  const extraCapabilities: number[] = [];
  let regressions = 0;

  for (const trace of reviewed) {
    // issue #47: 過去の解決済みプランではなく、呼び出し側が実際に求めた capability を
    // 入力にする。旧プランを入力にすると、前の policy が足した capability を呼び出し側の
    // 意図として再学習してしまい、policy が自分の出力で自分を強化する（自己汚染）。
    const callerRequested = trace.request.caller_requested_capabilities;
    const activePlan = resolvePlan(active, trace.request.task_category, callerRequested).capabilities;
    const candidatePlan = resolvePlan(candidate, trace.request.task_category, callerRequested).capabilities;
    const missing = trace.review?.missing_capabilities ?? [];
    // missing が無い trace は「取り逃がしゼロ」として満点扱い。分母から外すと改善が過大に見える。
    const activeScore = missing.length === 0 ? 1 : missing.filter((capability) => activePlan.includes(capability)).length / missing.length;
    const candidateScore = missing.length === 0 ? 1 : missing.filter((capability) => candidatePlan.includes(capability)).length / missing.length;
    const extra = candidatePlan.filter((capability) => !activePlan.includes(capability)).length;
    if (candidateScore < activeScore) regressions += 1;
    activeCoverage.push(activeScore);
    candidateCoverage.push(candidateScore);
    extraCapabilities.push(extra);
    const entry = perCategory.get(trace.request.task_category) ?? { activeCoverage: [], candidateCoverage: [], extra: [] };
    entry.activeCoverage.push(activeScore);
    entry.candidateCoverage.push(candidateScore);
    entry.extra.push(extra);
    perCategory.set(trace.request.task_category, entry);
  }

  const activeMean = mean(activeCoverage);
  const candidateMean = mean(candidateCoverage);
  return {
    traces: reviewed.length,
    missing_coverage_active: activeMean,
    missing_coverage_candidate: candidateMean,
    coverage_delta: activeMean === null || candidateMean === null ? null : round(candidateMean - activeMean),
    mean_extra_capabilities: mean(extraCapabilities),
    regressions,
    by_task_category: [...perCategory.entries()]
      .map(([taskCategory, entry]) => ({
        task_category: taskCategory,
        traces: entry.activeCoverage.length,
        missing_coverage_active: mean(entry.activeCoverage),
        missing_coverage_candidate: mean(entry.candidateCoverage),
        mean_extra_capabilities: mean(entry.extra),
      }))
      .sort((left, right) => right.traces - left.traces || left.task_category.localeCompare(right.task_category)),
  };
}

export function proposePolicy(traces: Trace[], active: PolicyDocument, options: ProposalOptions = {}): PolicyProposal {
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const missingThreshold = options.missingThreshold ?? DEFAULT_MISSING_THRESHOLD;
  const { training, holdout } = splitTraces(traces, options.holdoutRatio ?? DEFAULT_HOLDOUT_RATIO, minSupport);
  const reasons: string[] = [];

  const byCategory = new Map<string, Trace[]>();
  for (const trace of training) {
    const entry = byCategory.get(trace.request.task_category) ?? [];
    entry.push(trace);
    byCategory.set(trace.request.task_category, entry);
  }

  const changes: RuleChange[] = [];
  const proposedRules = new Map<string, PolicyRule>();
  for (const [taskCategory, categoryTraces] of [...byCategory.entries()].sort()) {
    const proposed = proposeRule(taskCategory, categoryTraces, active, minSupport, missingThreshold);
    if (proposed === undefined) {
      if (categoryTraces.length < minSupport) {
        reasons.push(`${taskCategory}: reviewed traces ${categoryTraces.length} below min support ${minSupport}`);
      }
      continue;
    }
    proposedRules.set(taskCategory, proposed.rule);
    changes.push(proposed.change);
  }

  if (training.length === 0) {
    reasons.push("no reviewed traces");
  }

  const candidate: PolicyDocument = {
    policy_version: newPolicyVersion(options.now),
    status: "candidate",
    source: "proposed",
    generated_at: (options.now ?? new Date()).toISOString(),
    rules: active.rules
      .map((rule) => proposedRules.get(rule.task_category) ?? rule)
      .concat([...proposedRules.entries()]
        .filter(([taskCategory]) => !active.rules.some((rule) => rule.task_category === taskCategory))
        .map(([, rule]) => rule)),
    notes: `generated from ${training.length} reviewed traces (min support ${minSupport}, missing threshold ${missingThreshold}); base policy ${active.policy_version}`,
  };

  const status = changes.length > 0 ? "proposed" : training.length === 0 ? "insufficient_data" : "no_change";
  return {
    status,
    policy: status === "proposed" ? candidate : undefined,
    changes,
    training_evaluation: evaluatePolicy(candidate, active, training),
    holdout_evaluation: holdout.length === 0 ? null : evaluatePolicy(candidate, active, holdout),
    training_traces: training.length,
    holdout_traces: holdout.length,
    reasons,
  };
}
