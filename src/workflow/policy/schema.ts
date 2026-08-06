import { z } from "zod";

/**
 * Git workflow policy のバージョン付き schema。src/adaptive/policy.ts の
 * capability-routing policy とは無関係の別 domain（Issue #28）。
 */

export const RULE_MODES = ["off", "advisory", "enforce", "confirm"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const PRESET_NAMES = ["minimal", "standard", "strict-worktree"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const POLICY_SCHEMA_VERSION = 1;

const ruleModeSchema = z.enum(RULE_MODES);

const protectedBranchRuleSchema = z.object({
  sourceWrite: ruleModeSchema,
  stage: ruleModeSchema,
  commit: ruleModeSchema,
  directPush: ruleModeSchema,
  forcePush: ruleModeSchema,
  destructiveBranchOp: ruleModeSchema,
});
export type ProtectedBranchRule = z.infer<typeof protectedBranchRuleSchema>;

const worktreeRuleSchema = z.object({
  required: ruleModeSchema,
  bootstrapMode: z.enum(["off", "suggest", "automatic", "conditional"]),
  multipleActiveTasksPerIssue: ruleModeSchema,
  multipleWorktreesPerTask: ruleModeSchema,
});
export type WorktreeRule = z.infer<typeof worktreeRuleSchema>;

const stagingModeSchema = z.enum(["explicit", "already-staged-only", "tracked", "all"]);
export type StagingMode = z.infer<typeof stagingModeSchema>;

const cleanupRuleSchema = z.object({
  worktreeRemoval: ruleModeSchema,
  localBranchDeletion: ruleModeSchema,
  remoteBranchDeletion: ruleModeSchema,
  worktreePrune: ruleModeSchema,
  forceCleanup: ruleModeSchema,
});
export type CleanupRule = z.infer<typeof cleanupRuleSchema>;

/**
 * Git workflow policy document。`.mottainai/workflow.json` の中身と一致する。
 * 未知キー・未対応 version は呼び出し側で fail-closed に扱う（load.ts 側の責務）。
 */
export const workflowPolicySchema = z.object({
  schemaVersion: z.literal(POLICY_SCHEMA_VERSION),
  preset: z.enum(PRESET_NAMES).optional(),
  protectedBranches: z.array(z.string().min(1)),
  protectedBranchRule: protectedBranchRuleSchema,
  controlPlaneRole: z.enum(["primary-checkout", "any"]),
  worktree: worktreeRuleSchema,
  stagingMode: stagingModeSchema,
  cleanup: cleanupRuleSchema,
}).strict();

export type WorkflowPolicyDocument = z.infer<typeof workflowPolicySchema>;
