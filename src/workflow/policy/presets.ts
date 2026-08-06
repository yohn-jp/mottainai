import { POLICY_SCHEMA_VERSION } from "./schema.js";
import type { PresetName, WorkflowPolicyDocument } from "./schema.js";

/**
 * 同梱 preset。全て workflowPolicySchema をそのまま満たす（generator と validator の
 * 乖離を防ぐため、テストで自己検証する）。
 */
const minimal: WorkflowPolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  preset: "minimal",
  protectedBranches: [],
  protectedBranchRule: {
    sourceWrite: "off",
    stage: "off",
    commit: "off",
    directPush: "off",
    forcePush: "off",
    destructiveBranchOp: "off",
  },
  controlPlaneRole: "any",
  worktree: {
    required: "off",
    bootstrapMode: "off",
    multipleActiveTasksPerIssue: "off",
    multipleWorktreesPerTask: "off",
  },
  stagingMode: "all",
  cleanup: {
    worktreeRemoval: "off",
    localBranchDeletion: "off",
    remoteBranchDeletion: "off",
    worktreePrune: "off",
    forceCleanup: "off",
  },
};

const standard: WorkflowPolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  preset: "standard",
  protectedBranches: ["main", "master"],
  protectedBranchRule: {
    sourceWrite: "advisory",
    stage: "advisory",
    commit: "advisory",
    directPush: "enforce",
    forcePush: "enforce",
    destructiveBranchOp: "enforce",
  },
  controlPlaneRole: "any",
  worktree: {
    required: "off",
    bootstrapMode: "suggest",
    multipleActiveTasksPerIssue: "advisory",
    multipleWorktreesPerTask: "advisory",
  },
  stagingMode: "tracked",
  cleanup: {
    worktreeRemoval: "advisory",
    localBranchDeletion: "advisory",
    remoteBranchDeletion: "off",
    worktreePrune: "advisory",
    forceCleanup: "off",
  },
};

/**
 * strict-worktree: Issue-bound worktree、main への直接編集/commit/push 全面拒否、
 * 検証済み merge 後の worktree 自動削除。remote branch 削除は既定 off のまま。
 */
const strictWorktree: WorkflowPolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  preset: "strict-worktree",
  protectedBranches: ["main", "master", "release/*"],
  protectedBranchRule: {
    sourceWrite: "enforce",
    stage: "enforce",
    commit: "enforce",
    directPush: "enforce",
    forcePush: "enforce",
    destructiveBranchOp: "enforce",
  },
  controlPlaneRole: "primary-checkout",
  worktree: {
    required: "enforce",
    bootstrapMode: "conditional",
    multipleActiveTasksPerIssue: "off",
    multipleWorktreesPerTask: "off",
  },
  stagingMode: "explicit",
  cleanup: {
    worktreeRemoval: "enforce",
    localBranchDeletion: "advisory",
    remoteBranchDeletion: "off",
    worktreePrune: "advisory",
    forceCleanup: "off",
  },
};

export const BUILTIN_PRESETS: Record<PresetName, WorkflowPolicyDocument> = {
  minimal,
  standard,
  "strict-worktree": strictWorktree,
};

export function getPreset(name: PresetName): WorkflowPolicyDocument {
  return BUILTIN_PRESETS[name];
}
