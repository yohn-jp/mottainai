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
}).strict();
export type ProtectedBranchRule = z.infer<typeof protectedBranchRuleSchema>;

const worktreeRuleSchema = z.object({
  required: ruleModeSchema,
  // default("off"): 既存の schemaVersion=1 policy ファイルは issueRequired を
  // 持たない。version を上げず既存ドキュメントの読み込みを維持するため、
  // 省略時は最も緩い "off"（issue 紐付け任意）へ fallback する。
  issueRequired: ruleModeSchema.default("off"),
  bootstrapMode: z.enum(["off", "suggest", "automatic", "conditional"]),
  multipleActiveTasksPerIssue: ruleModeSchema,
  multipleWorktreesPerTask: ruleModeSchema,
  // default("off"): schemaVersion=1 の既存 policy ファイルは staleBaseBranch を
  // 持たない。issueRequired と同じ理由で、省略時は最も緩い "off" へ fallback する。
  staleBaseBranch: ruleModeSchema.default("off"),
}).strict();
export type WorktreeRule = z.infer<typeof worktreeRuleSchema>;

const stagingModeSchema = z.enum(["explicit", "already-staged-only", "tracked", "all"]);
export type StagingMode = z.infer<typeof stagingModeSchema>;

const cleanupRuleSchema = z.object({
  worktreeRemoval: ruleModeSchema,
  localBranchDeletion: ruleModeSchema,
  remoteBranchDeletion: ruleModeSchema,
  worktreePrune: ruleModeSchema,
  forceCleanup: ruleModeSchema,
}).strict();
export type CleanupRule = z.infer<typeof cleanupRuleSchema>;

/** 未指定時は既存 policy と互換のデフォルト値を持つ。 */
export const pullRequestRuleSchema = z.object({
  issue: z.enum(["required", "optional"]).default("optional"),
  closingIssue: z.enum(["exactly-one", "optional", "none"]).default("optional"),
  requiredSections: z.array(z.string().min(1)).default([]),
  acceptanceCriteriaSection: z.string().min(1).default("Acceptance criteria"),
  acceptanceCriteriaChecklist: z.boolean().default(false),
  templates: z.record(z.string()).default({}),
}).strict();
export type PullRequestRule = z.infer<typeof pullRequestRuleSchema>;

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
  pullRequest: pullRequestRuleSchema.optional(),
}).strict();

export type WorkflowPolicyDocument = z.infer<typeof workflowPolicySchema>;
