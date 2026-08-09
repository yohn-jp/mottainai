import { loadWorkflowPolicy } from "./load.js";
import { getPreset } from "./presets.js";
import { resolveRule } from "./resolve.js";
import type { PolicySource, ResolvedRule } from "./resolve.js";
import type { RuleMode, WorkflowPolicyDocument, WorktreeRule } from "./schema.js";
import { resolvePullRequestRenderPolicy } from "../domain/pr-render.js";
import type { PullRequestRenderPolicy } from "../domain/pr-render.js";

/**
 * `policy explain`（Issue #39, extending #34）。`resolve.ts`（Child Issue 1）の resolveRule() を、
 * schema.ts の実際の RuleMode フィールド（protectedBranchRule.* / worktree.{required,
 * issueRequired,multipleActiveTasksPerIssue,multipleWorktreesPerTask,staleBaseBranch} /
 * cleanup.*）だけに適用する。これらは値そのものが RuleMode（"off"/"advisory"/
 * "enforce"/"confirm"）で、強さも兼ねる — resolveRule() の Value=RuleMode としてそのまま
 * 解決できる。
 *
 * `protectedBranches`（string[]）・`controlPlaneRole`・`stagingMode`・
 * `worktree.bootstrapMode`・PR body policy は RuleMode を持たない
 * （schema.ts にも対応する mode フィールドが存在しない）。そのため、これらは
 * `ExplainedValue` として値/authorityを返し、mode/weakeningを捏造しない。
 *
 * authority: `.mottainai/workflow.json` が `preset` を宣言していれば、その preset の
 * 値を "preset" authority、ファイル自身の値を "repository" authority として渡す
 * （宣言した preset からの弱体化は、humanApproval を記録する仕組みが schema に無いため
 * 常に拒否される — resolveRule() の設計通り）。`preset` 未宣言ならファイル自身のみを
 * "repository" として扱う。ファイルが無ければ built-in `standard` preset のみを
 * "preset" として使う（`resolveEffectiveWorkflowPolicy` と同じ既定 fallback）。
 *
 * task startの実際の許可判定は従来どおり domain が受け取る実効 documentで行う。
 * このprojection自体は読み取り専用であり、policyの弱体化を許可するAPIではない。
 */

const PROTECTED_BRANCH_RULE_KEYS = ["sourceWrite", "stage", "commit", "directPush", "forcePush", "destructiveBranchOp"] as const;
const CLEANUP_RULE_KEYS = ["worktreeRemoval", "localBranchDeletion", "remoteBranchDeletion", "worktreePrune", "forceCleanup"] as const;

export interface ExplainedRuleGroups {
  protectedBranchRule: Record<(typeof PROTECTED_BRANCH_RULE_KEYS)[number], ResolvedRule<RuleMode>>;
  worktree: Record<"required" | "issueRequired" | "multipleActiveTasksPerIssue" | "multipleWorktreesPerTask" | "staleBaseBranch", ResolvedRule<RuleMode>> & {
    bootstrapMode: ExplainedValue<WorktreeRule["bootstrapMode"]>;
  };
  cleanup: Record<(typeof CLEANUP_RULE_KEYS)[number], ResolvedRule<RuleMode>>;
  pullRequest: ExplainedPullRequestRule;
}

export interface ExplainedValue<Value> {
  value: Value;
  authority: "preset" | "repository";
}

export interface ExplainedPullRequestRule {
  issue: ExplainedValue<NonNullable<PullRequestRenderPolicy["issue"]>>;
  closingIssue: ExplainedValue<NonNullable<PullRequestRenderPolicy["closingIssue"]>>;
  requiredSections: ExplainedValue<readonly string[]>;
  acceptanceCriteriaSection: ExplainedValue<string>;
  acceptanceCriteriaChecklist: ExplainedValue<boolean>;
  templates: ExplainedValue<Readonly<Record<string, string>>>;
}

export interface ExplainedResolvedPolicy {
  schemaVersion: ExplainedValue<WorkflowPolicyDocument["schemaVersion"]>;
  preset: ExplainedValue<WorkflowPolicyDocument["preset"]>;
  protectedBranches: ExplainedValue<readonly string[]>;
  protectedBranchRule: ExplainedRuleGroups["protectedBranchRule"];
  controlPlaneRole: ExplainedValue<WorkflowPolicyDocument["controlPlaneRole"]>;
  worktree: ExplainedRuleGroups["worktree"];
  stagingMode: ExplainedValue<WorkflowPolicyDocument["stagingMode"]>;
  cleanup: ExplainedRuleGroups["cleanup"];
  pullRequest: ExplainedPullRequestRule;
}

export interface ExplainedPolicy {
  /** どの authority から実効 document が来たか（`preset`宣言が無ければ repository=preset と同値）。 */
  policySourceAuthority: "preset" | "repository";
  policyFilePath: string;
  preset: WorkflowPolicyDocument["preset"];
  descriptive: {
    protectedBranches: string[];
    controlPlaneRole: WorkflowPolicyDocument["controlPlaneRole"];
    stagingMode: WorkflowPolicyDocument["stagingMode"];
    bootstrapMode: WorktreeRule["bootstrapMode"];
    pullRequest: PullRequestRenderPolicy;
  };
  rules: ExplainedRuleGroups;
  /** 完全な値を含む、authority/provenance付きのresolved policy projection。 */
  resolvedPolicy: ExplainedResolvedPolicy;
  /** 後方互換のための実効policy document。PR policyの暗黙defaultも展開する。 */
  effectivePolicy: Omit<WorkflowPolicyDocument, "pullRequest"> & { pullRequest: PullRequestRenderPolicy };
}

export type ExplainWorkflowPolicyResult = { ok: true; explained: ExplainedPolicy } | { ok: false; reason: string };

function resolveModeField(
  presetDocument: WorkflowPolicyDocument | undefined,
  repositoryDocument: WorkflowPolicyDocument | undefined,
  select: (document: WorkflowPolicyDocument) => RuleMode,
): ResolvedRule<RuleMode> {
  const sources: PolicySource<RuleMode>[] = [];
  if (presetDocument !== undefined) {
    const mode = select(presetDocument);
    sources.push({ authority: "preset", value: mode, mode });
  }
  if (repositoryDocument !== undefined) {
    const mode = select(repositoryDocument);
    sources.push({ authority: "repository", value: mode, mode });
  }
  return resolveRule(sources);
}

export function explainWorkflowPolicy(workspaceRoot: string): ExplainWorkflowPolicyResult {
  const loaded = loadWorkflowPolicy(workspaceRoot);

  let presetDocument: WorkflowPolicyDocument | undefined;
  let repositoryDocument: WorkflowPolicyDocument | undefined;
  let policySourceAuthority: "preset" | "repository";
  let effective: WorkflowPolicyDocument;

  if (loaded.ok) {
    repositoryDocument = loaded.document;
    presetDocument = loaded.document.preset === undefined ? undefined : getPreset(loaded.document.preset);
    policySourceAuthority = "repository";
    effective = loaded.document;
  } else if (loaded.reason === "not-found") {
    presetDocument = getPreset("standard");
    policySourceAuthority = "preset";
    effective = presetDocument;
  } else {
    return { ok: false, reason: loaded.reason };
  }

  const pullRequest = resolvePullRequestRenderPolicy(effective.pullRequest);
  const sourceAuthority: "preset" | "repository" = policySourceAuthority;
  const explainedValue = <Value>(value: Value): ExplainedValue<Value> => ({ value, authority: sourceAuthority });

  const protectedBranchRule = {
    sourceWrite: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.sourceWrite),
    stage: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.stage),
    commit: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.commit),
    directPush: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.directPush),
    forcePush: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.forcePush),
    destructiveBranchOp: resolveModeField(presetDocument, repositoryDocument, (document) => document.protectedBranchRule.destructiveBranchOp),
  } satisfies ExplainedRuleGroups["protectedBranchRule"];

  const worktree = {
    required: resolveModeField(presetDocument, repositoryDocument, (document) => document.worktree.required),
    issueRequired: resolveModeField(presetDocument, repositoryDocument, (document) => document.worktree.issueRequired),
    multipleActiveTasksPerIssue: resolveModeField(presetDocument, repositoryDocument, (document) => document.worktree.multipleActiveTasksPerIssue),
    multipleWorktreesPerTask: resolveModeField(presetDocument, repositoryDocument, (document) => document.worktree.multipleWorktreesPerTask),
    staleBaseBranch: resolveModeField(presetDocument, repositoryDocument, (document) => document.worktree.staleBaseBranch),
  } satisfies Omit<ExplainedRuleGroups["worktree"], "bootstrapMode">;

  const cleanup = {
    worktreeRemoval: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.worktreeRemoval),
    localBranchDeletion: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.localBranchDeletion),
    remoteBranchDeletion: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.remoteBranchDeletion),
    worktreePrune: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.worktreePrune),
    forceCleanup: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.forceCleanup),
  } satisfies ExplainedRuleGroups["cleanup"];

  const explainedPullRequest: ExplainedPullRequestRule = {
    issue: explainedValue(pullRequest.issue ?? "optional"),
    closingIssue: explainedValue(pullRequest.closingIssue ?? "optional"),
    requiredSections: explainedValue([...(pullRequest.requiredSections ?? [])]),
    acceptanceCriteriaSection: explainedValue(pullRequest.acceptanceCriteriaSection ?? "Acceptance criteria"),
    acceptanceCriteriaChecklist: explainedValue(pullRequest.acceptanceCriteriaChecklist ?? false),
    templates: explainedValue({ ...(pullRequest.templates ?? {}) }),
  };
  const explainedWorktree = { ...worktree, bootstrapMode: explainedValue(effective.worktree.bootstrapMode) } satisfies ExplainedRuleGroups["worktree"];
  const rules = { protectedBranchRule, worktree: explainedWorktree, cleanup, pullRequest: explainedPullRequest } satisfies ExplainedRuleGroups;
  const resolvedPolicy: ExplainedResolvedPolicy = {
    schemaVersion: explainedValue(effective.schemaVersion),
    preset: explainedValue(effective.preset),
    protectedBranches: explainedValue([...effective.protectedBranches]),
    protectedBranchRule,
    controlPlaneRole: explainedValue(effective.controlPlaneRole),
    worktree: explainedWorktree,
    stagingMode: explainedValue(effective.stagingMode),
    cleanup,
    pullRequest: explainedPullRequest,
  };

  return {
    ok: true,
    explained: {
      policySourceAuthority,
      policyFilePath: loaded.filePath,
      preset: effective.preset,
      descriptive: {
        protectedBranches: effective.protectedBranches,
        controlPlaneRole: effective.controlPlaneRole,
        stagingMode: effective.stagingMode,
        bootstrapMode: effective.worktree.bootstrapMode,
        pullRequest,
      },
      rules,
      resolvedPolicy,
      effectivePolicy: { ...effective, pullRequest },
    },
  };
}
