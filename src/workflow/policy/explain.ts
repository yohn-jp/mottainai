import { loadWorkflowPolicy } from "./load.js";
import { getPreset } from "./presets.js";
import { resolveRule } from "./resolve.js";
import type { PolicySource, ResolvedRule } from "./resolve.js";
import type { RuleMode, WorkflowPolicyDocument, WorktreeRule } from "./schema.js";

/**
 * `policy explain`（Issue #34）。`resolve.ts`（Child Issue 1）の resolveRule() を、
 * schema.ts の実際の RuleMode フィールド（protectedBranchRule.* / worktree.{required,
 * issueRequired,multipleActiveTasksPerIssue,multipleWorktreesPerTask,staleBaseBranch} /
 * cleanup.*）だけに適用する。これらは値そのものが RuleMode（"off"/"advisory"/
 * "enforce"/"confirm"）で、強さも兼ねる — resolveRule() の Value=RuleMode としてそのまま
 * 解決できる。
 *
 * `protectedBranches`（string[]）・`controlPlaneRole`・`stagingMode`・
 * `worktree.bootstrapMode` は設定値であって RuleMode を持たない
 * （schema.ts にも対応する mode フィールドが存在しない）。`ResolvedPolicy` の型は
 * 全フィールドを `ResolvedRule<Value>` として扱える形をしているが、無理に
 * authority/weakening を捏造せず `descriptive` として値だけ返す — 実在しない
 * 意味論を作らない。将来これらにも authority/weakening が schema に追加された時点で
 * `rules` 側に昇格する。
 *
 * authority: `.mottainai/workflow.json` が `preset` を宣言していれば、その preset の
 * 値を "preset" authority、ファイル自身の値を "repository" authority として渡す
 * （宣言した preset からの弱体化は、humanApproval を記録する仕組みが schema に無いため
 * 常に拒否される — resolveRule() の設計通り）。`preset` 未宣言ならファイル自身のみを
 * "repository" として扱う。ファイルが無ければ built-in `standard` preset のみを
 * "preset" として使う（`resolveEffectiveWorkflowPolicy` と同じ既定 fallback）。
 *
 * 注意: `startTask`/`getTaskStatusForWorkspace` はこの解決結果を使わず、実効
 * document（`resolveEffectiveWorkflowPolicy`）をそのまま渡す。ここでの
 * authority/weakening 判定は現時点では `policy explain` の表示専用であり、
 * task 開始の実際の許可判定を変更するものではない。
 */

const PROTECTED_BRANCH_RULE_KEYS = ["sourceWrite", "stage", "commit", "directPush", "forcePush", "destructiveBranchOp"] as const;
const CLEANUP_RULE_KEYS = ["worktreeRemoval", "localBranchDeletion", "remoteBranchDeletion", "worktreePrune", "forceCleanup"] as const;

export interface ExplainedRuleGroups {
  protectedBranchRule: Record<(typeof PROTECTED_BRANCH_RULE_KEYS)[number], ResolvedRule<RuleMode>>;
  worktree: Record<"required" | "issueRequired" | "multipleActiveTasksPerIssue" | "multipleWorktreesPerTask" | "staleBaseBranch", ResolvedRule<RuleMode>>;
  cleanup: Record<(typeof CLEANUP_RULE_KEYS)[number], ResolvedRule<RuleMode>>;
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
  };
  rules: ExplainedRuleGroups;
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
  } satisfies ExplainedRuleGroups["worktree"];

  const cleanup = {
    worktreeRemoval: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.worktreeRemoval),
    localBranchDeletion: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.localBranchDeletion),
    remoteBranchDeletion: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.remoteBranchDeletion),
    worktreePrune: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.worktreePrune),
    forceCleanup: resolveModeField(presetDocument, repositoryDocument, (document) => document.cleanup.forceCleanup),
  } satisfies ExplainedRuleGroups["cleanup"];

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
      },
      rules: { protectedBranchRule, worktree, cleanup },
    },
  };
}
