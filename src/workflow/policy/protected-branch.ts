import type { ProtectedBranchRule, RuleMode, WorkflowPolicyDocument } from "./schema.js";

/**
 * Protected-branch/control-plane の policy decision API（Issue #28 Child 3）。
 * ここは「許可されるか」を判定して返すだけで、実際の Git 操作の実行や
 * write-path の割り込みは行わない（実効化は Child Issue 9a-2）。
 */

export const PROTECTED_BRANCH_OPERATIONS = [
  "sourceWrite",
  "stage",
  "commit",
  "directPush",
  "forcePush",
  "destructiveBranchOp",
] as const;
export type ProtectedBranchOperation = (typeof PROTECTED_BRANCH_OPERATIONS)[number];

/** repo-sync/worktree 管理系操作。control-plane role が有効でも primary checkout で許可される。 */
export const CONTROL_PLANE_MANAGEMENT_OPERATIONS = ["repoSync", "worktreeManagement"] as const;
export type ControlPlaneManagementOperation = (typeof CONTROL_PLANE_MANAGEMENT_OPERATIONS)[number];

export type WorkflowOperation = ProtectedBranchOperation | ControlPlaneManagementOperation;

export interface ProtectedBranchMatch {
  matched: boolean;
  pattern?: string;
}

/**
 * glob 風パターン（`release/*` の `*` のみサポート、それ以外の文字は
 * リテラル一致）で branch 名を判定する。`*` は `/` を含む任意文字列に
 * マッチする（`release/*` が `release/1.0/hotfix` にもマッチしてよい —
 * 命名規則の細部を先取りして限定しない）。
 */
export function matchesProtectedBranch(branch: string, patterns: readonly string[]): ProtectedBranchMatch {
  for (const pattern of patterns) {
    if (patternToRegExp(pattern).test(branch)) return { matched: true, pattern };
  }
  return { matched: false };
}

function patternToRegExp(pattern: string): RegExp {
  const escapeLiteral = (segment: string): string => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const source = pattern.split("*").map(escapeLiteral).join(".*");
  return new RegExp(`^${source}$`);
}

export interface RepositoryRoleContext {
  /** このチェックアウトが primary checkout（common-dir と worktree が一致する側）か。 */
  isPrimaryCheckout: boolean;
}

export interface ProtectedBranchDecisionInput {
  policy: WorkflowPolicyDocument;
  /** detached HEAD の場合は undefined。 */
  branch: string | undefined;
  operation: WorkflowOperation;
  repository: RepositoryRoleContext;
}

export type ProtectedBranchDecisionReason =
  | "not-protected"
  | "rule-off"
  | "rule-active"
  | "control-plane-management-allowed"
  | "control-plane-source-denied"
  | "detached-head-treated-as-unprotected";

export interface ProtectedBranchDecision {
  allowed: boolean;
  operation: WorkflowOperation;
  mode: RuleMode;
  branchMatch: ProtectedBranchMatch;
  reason: ProtectedBranchDecisionReason;
}

function isProtectedBranchOperation(operation: WorkflowOperation): operation is ProtectedBranchOperation {
  return (PROTECTED_BRANCH_OPERATIONS as readonly string[]).includes(operation);
}

function isSourceChangeOperation(operation: WorkflowOperation): boolean {
  return operation === "sourceWrite" || operation === "stage" || operation === "commit";
}

function modeAllows(mode: RuleMode): boolean {
  return mode === "off" || mode === "advisory";
}

/**
 * 与えられた repository/branch/operation の組が許可されるかを判定する。
 *
 * 判定順序:
 * 1. control-plane role: `controlPlaneRole === "primary-checkout"` かつ
 *    primary checkout 上での source 変更系操作（sourceWrite/stage/commit）は、
 *    branch が protected かどうかに関係なく拒否する（primary checkout は
 *    repo 同期・worktree 管理のみの役割）。repo-sync/worktree 管理系操作は
 *    常に許可する。
 * 2. protected-branch rule: branch が `protectedBranches` のいずれかの
 *    パターンにマッチする場合、対応する operation の rule mode を見る。
 *    `off`/`advisory` は許可（advisory は許可した上で観測記録の対象——
 *    記録自体は Child Issue 8 の reconciliation が担う）、`enforce`/`confirm`
 *    は拒否。confirm はここでは「確認済みでなければ拒否」として扱う—
 *    確認済み状態の表現（ConfirmationRecord 等）は呼び出し側の resolved
 *    policy 層（Child Issue 1 の resolveRule）の責務であり、この関数は
 *    schema 上の生 RuleMode のみを受け取る。
 * 3. branch が protected でない（あるいは detached HEAD で branch 名が
 *    不明）場合は許可する。
 */
export function decideProtectedBranchOperation(input: ProtectedBranchDecisionInput): ProtectedBranchDecision {
  const { policy, branch, operation, repository } = input;

  if (policy.controlPlaneRole === "primary-checkout" && repository.isPrimaryCheckout) {
    if (!isProtectedBranchOperation(operation)) {
      return { allowed: true, operation, mode: "off", branchMatch: { matched: false }, reason: "control-plane-management-allowed" };
    }
    if (isSourceChangeOperation(operation)) {
      return { allowed: false, operation, mode: "enforce", branchMatch: { matched: false }, reason: "control-plane-source-denied" };
    }
  }

  if (!isProtectedBranchOperation(operation)) {
    return { allowed: true, operation, mode: "off", branchMatch: { matched: false }, reason: "control-plane-management-allowed" };
  }

  if (branch === undefined) {
    return { allowed: true, operation, mode: "off", branchMatch: { matched: false }, reason: "detached-head-treated-as-unprotected" };
  }

  const branchMatch = matchesProtectedBranch(branch, policy.protectedBranches);
  if (!branchMatch.matched) {
    return { allowed: true, operation, mode: "off", branchMatch, reason: "not-protected" };
  }

  const mode = policy.protectedBranchRule[operation as keyof ProtectedBranchRule];
  if (modeAllows(mode)) {
    return { allowed: true, operation, mode, branchMatch, reason: "rule-off" };
  }
  return { allowed: false, operation, mode, branchMatch, reason: "rule-active" };
}
