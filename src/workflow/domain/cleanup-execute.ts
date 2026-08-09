import type { CleanupLeaseRecord, TaskRecord, WorkflowStateStore } from "../state/store.js";
import { markLease, reserveLease } from "./lease.js";
import {
  computeCleanupPlanDigest,
  revalidateCleanupPlan,
  type CleanupAction,
  type CleanupActivityProbe,
  type CleanupBlocker,
  type CleanupPlan,
  type CleanupPullRequestObserver,
  type CleanupSafetySnapshot,
} from "./cleanup-plan.js";
import { runGitCommand } from "../git/context.js";

export interface CleanupExecuteInput {
  plan: CleanupPlan;
  store: WorkflowStateStore;
  now?: () => number;
  leaseTtlMs?: number;
  owner?: string;
  pullRequestObserver?: CleanupPullRequestObserver;
  activityProbe?: CleanupActivityProbe;
  /** Test/integration barrier. It is called immediately before each external mutation. */
  beforeAction?: (action: CleanupAction) => void | Promise<void>;
  originalError?: unknown;
}

export type CleanupExecutionStatus = "completed" | "already-completed" | "blocked" | "partial" | "failed";

export interface CleanupExecutionResult {
  ok: boolean;
  status: CleanupExecutionStatus;
  task: TaskRecord | undefined;
  lease: CleanupLeaseRecord | undefined;
  completedActionIds: string[];
  blockers: CleanupBlocker[];
  recoveryOptions: string[];
  originalError: string | undefined;
  cleanupError: string | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionFailure(code: string, detail: string): CleanupBlocker {
  return { code, detail, recoveryOptions: ["inspect the exact plan and lease, then retry only after revalidation"] };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function baseResult(
  input: CleanupExecuteInput,
  status: CleanupExecutionStatus,
  overrides: Partial<CleanupExecutionResult> = {},
): CleanupExecutionResult {
  return {
    ok: status === "completed" || status === "already-completed",
    status,
    task: undefined,
    lease: undefined,
    completedActionIds: [],
    blockers: [],
    recoveryOptions: [],
    originalError: input.originalError === undefined ? undefined : errorText(input.originalError),
    cleanupError: undefined,
    ...overrides,
  };
}

async function remoteBranchExists(
  plan: CleanupPlan,
  remoteName: string,
  branchName: string,
): Promise<{ ok: boolean; exists: boolean; detail: string }> {
  if (plan.repository === undefined)
    return { ok: false, exists: false, detail: "repository identity is missing from cleanup plan" };
  const observation = await runGitCommand(plan.repository.canonicalRepositoryRoot, [
    "ls-remote",
    "--heads",
    remoteName,
    `refs/heads/${branchName}`,
  ]);
  if (!observation.usable) return { ok: false, exists: false, detail: "remote branch state could not be verified" };
  if (observation.result.exitCode !== 0)
    return {
      ok: false,
      exists: false,
      detail: `remote branch query exited with code ${observation.result.exitCode ?? "unknown"}`,
    };
  return { ok: true, exists: observation.result.stdout.trim().length > 0, detail: "remote branch state verified" };
}

async function actionSatisfied(
  plan: CleanupPlan,
  action: CleanupAction,
  safety: CleanupSafetySnapshot,
): Promise<boolean> {
  if (action.id === "remove-worktree") return !safety.git.worktreeRegistered && !safety.git.worktreePathExists;
  if (action.id === "delete-local-branch") return safety.git.branchHead === undefined;
  if (action.id === "delete-remote-branch") {
    const result = await remoteBranchExists(plan, action.remoteName, action.branchName);
    return result.ok && !result.exists;
  }
  if (action.id === "prune-worktrees") return action.candidates.length === 0 || safety.git.pruneCandidates.length === 0;
  if (action.id === "mark-worktree-removed") return plan.worktree?.status === "removed";
  if (action.id === "mark-task-cleaned") return false;
  return false;
}

async function runExternalAction(
  plan: CleanupPlan,
  action: CleanupAction,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (plan.repository === undefined) return { ok: false, detail: "repository identity is missing from cleanup plan" };
  let args: string[];
  if (action.id === "remove-worktree") args = ["worktree", "remove", action.canonicalPath];
  else if (action.id === "delete-local-branch") args = ["branch", "-d", action.branchName];
  else if (action.id === "delete-remote-branch") args = ["push", action.remoteName, "--delete", action.branchName];
  else if (action.id === "prune-worktrees") args = ["worktree", "prune", "--verbose"];
  else return { ok: true };
  const observation = await runGitCommand(plan.repository.canonicalRepositoryRoot, args);
  if (!observation.usable || observation.result.exitCode !== 0) {
    return { ok: false, detail: `Git ${action.kind} failed with code ${observation.result.exitCode ?? "unknown"}` };
  }
  return { ok: true };
}

async function markFailed(
  input: CleanupExecuteInput,
  lease: CleanupLeaseRecord | undefined,
  completedActionIds: string[],
  detail: string,
): Promise<{ lease: CleanupLeaseRecord | undefined; cleanupError: string }> {
  if (lease === undefined) return { lease: undefined, cleanupError: detail };
  try {
    const failed = markLease(input.store, {
      operationId: lease.operationId,
      state: "failed",
      completedActionIds,
      lastError: detail,
      updatedAt: input.now?.() ?? Date.now(),
    });
    return { lease: failed, cleanupError: detail };
  } catch (error) {
    return { lease, cleanupError: `${detail}; failed to record cleanup failure: ${errorText(error)}` };
  }
}

export async function executeCleanup(input: CleanupExecuteInput): Promise<CleanupExecutionResult> {
  const plan = input.plan;
  const now = input.now?.() ?? Date.now();
  const originalError = input.originalError === undefined ? undefined : errorText(input.originalError);
  if (plan.status === "noop" || plan.disposition === "cleaned")
    return baseResult(input, "already-completed", { originalError });
  if (plan.status !== "ready")
    return baseResult(input, "blocked", {
      blockers: plan.blockers,
      recoveryOptions: unique(plan.blockers.flatMap((item) => item.recoveryOptions)),
      originalError,
    });
  if (computeCleanupPlanDigest(plan) !== plan.planDigest) {
    return baseResult(input, "blocked", {
      blockers: [
        actionFailure("plan-digest-mismatch", "cleanup plan serialization or contents changed after planning"),
      ],
      recoveryOptions: ["discard the altered plan and create a new plan"],
      originalError,
    });
  }

  const leaseResult = reserveLease(input.store, {
    operationId: plan.planId,
    planDigest: plan.planDigest,
    instanceId: plan.task.instanceId,
    taskId: plan.task.taskId,
    worktreeId: plan.worktree?.worktreeId,
    owner: input.owner,
    now,
    ttlMs: input.leaseTtlMs,
  });
  if (!leaseResult.ok) {
    return baseResult(input, "blocked", {
      blockers: [
        actionFailure(
          leaseResult.reason,
          leaseResult.reason === "active-lease"
            ? `cleanup lease ${leaseResult.existingLease.operationId} is active`
            : "cleanup plan digest does not match the existing lease",
        ),
      ],
      recoveryOptions: ["wait for or resume the exact lease; do not delete the worktree manually"],
      originalError,
    });
  }
  let lease = leaseResult.lease;
  if (lease.state === "committed") {
    return baseResult(input, "already-completed", {
      lease,
      originalError,
      completedActionIds: lease.completedActionIds,
    });
  }

  let completedActionIds = unique(lease.completedActionIds);
  const initial = await revalidateCleanupPlan({
    plan,
    store: input.store,
    now,
    pullRequestObserver: input.pullRequestObserver,
    activityProbe: input.activityProbe,
    allowPostMutationState: lease.state !== "reserved",
    expectedCompletedActionIds: completedActionIds,
  });
  completedActionIds = unique([...completedActionIds, ...initial.completedActionIds]);
  if (!initial.ok) {
    const failed = await markFailed(
      input,
      lease,
      completedActionIds,
      initial.blockers.map((item) => `${item.code}: ${item.detail}`).join("; "),
    );
    return baseResult(input, "blocked", {
      lease: failed.lease,
      completedActionIds,
      blockers: initial.blockers,
      recoveryOptions: unique(initial.blockers.flatMap((item) => item.recoveryOptions)),
      originalError,
      cleanupError: failed.cleanupError,
    });
  }

  try {
    if (lease.state === "reserved")
      lease = markLease(input.store, {
        operationId: lease.operationId,
        state: "mutating",
        completedActionIds,
        updatedAt: now,
      });
    else if (lease.state === "verifying")
      lease = markLease(input.store, {
        operationId: lease.operationId,
        state: "verifying",
        completedActionIds,
        updatedAt: now,
      });
  } catch (error) {
    const failed = await markFailed(
      input,
      lease,
      completedActionIds,
      `cannot mark cleanup mutation phase: ${errorText(error)}`,
    );
    return baseResult(input, "failed", {
      lease: failed.lease,
      completedActionIds,
      originalError,
      cleanupError: failed.cleanupError,
    });
  }

  for (const action of plan.actions) {
    if (completedActionIds.includes(action.id)) continue;
    if (action.id === "mark-worktree-removed" || action.id === "mark-task-cleaned") {
      completedActionIds.push(action.id);
      continue;
    }
    const beforeAction = await revalidateCleanupPlan({
      plan,
      store: input.store,
      now: input.now?.() ?? Date.now(),
      pullRequestObserver: input.pullRequestObserver,
      activityProbe: input.activityProbe,
      allowPostMutationState: completedActionIds.length > 0,
      expectedCompletedActionIds: completedActionIds,
    });
    if (!beforeAction.ok || beforeAction.safety === undefined) {
      const failed = await markFailed(
        input,
        lease,
        completedActionIds,
        beforeAction.blockers.map((item) => `${item.code}: ${item.detail}`).join("; "),
      );
      return baseResult(input, "partial", {
        lease: failed.lease,
        completedActionIds,
        blockers: beforeAction.blockers,
        recoveryOptions: unique(beforeAction.blockers.flatMap((item) => item.recoveryOptions)),
        originalError,
        cleanupError: failed.cleanupError,
      });
    }
    if (await actionSatisfied(plan, action, beforeAction.safety)) {
      completedActionIds.push(action.id);
      lease = markLease(input.store, {
        operationId: lease.operationId,
        state: "mutating",
        completedActionIds,
        updatedAt: input.now?.() ?? Date.now(),
      });
      continue;
    }
    try {
      if (input.beforeAction !== undefined) await input.beforeAction(action);
      const result = await runExternalAction(plan, action);
      if (!result.ok) {
        const afterFailure = await revalidateCleanupPlan({
          plan,
          store: input.store,
          now: input.now?.() ?? Date.now(),
          pullRequestObserver: input.pullRequestObserver,
          activityProbe: input.activityProbe,
          allowPostMutationState: true,
          expectedCompletedActionIds: completedActionIds,
        });
        if (afterFailure.safety !== undefined && (await actionSatisfied(plan, action, afterFailure.safety))) {
          completedActionIds.push(action.id);
          lease = markLease(input.store, {
            operationId: lease.operationId,
            state: "mutating",
            completedActionIds,
            updatedAt: input.now?.() ?? Date.now(),
          });
          continue;
        }
        const failed = await markFailed(input, lease, completedActionIds, result.detail);
        return baseResult(input, "partial", {
          lease: failed.lease,
          completedActionIds,
          blockers: [actionFailure("external-mutation-failed", result.detail)],
          recoveryOptions: ["inspect the exact target and rerun the same plan after the lease expires"],
          originalError,
          cleanupError: failed.cleanupError,
        });
      }
      completedActionIds.push(action.id);
      lease = markLease(input.store, {
        operationId: lease.operationId,
        state: "mutating",
        completedActionIds,
        updatedAt: input.now?.() ?? Date.now(),
      });
    } catch (error) {
      const failed = await markFailed(input, lease, completedActionIds, `${action.kind} failed: ${errorText(error)}`);
      return baseResult(input, "partial", {
        lease: failed.lease,
        completedActionIds,
        blockers: [actionFailure("cleanup-action-failed", `${action.kind} failed: ${errorText(error)}`)],
        recoveryOptions: ["inspect the exact target and rerun the same plan after revalidation"],
        originalError,
        cleanupError: failed.cleanupError,
      });
    }
  }

  try {
    lease = markLease(input.store, {
      operationId: lease.operationId,
      state: "verifying",
      completedActionIds,
      updatedAt: input.now?.() ?? Date.now(),
    });
    const finalVerification = await revalidateCleanupPlan({
      plan,
      store: input.store,
      now: input.now?.() ?? Date.now(),
      pullRequestObserver: input.pullRequestObserver,
      activityProbe: input.activityProbe,
      allowPostMutationState: true,
      expectedCompletedActionIds: completedActionIds,
    });
    if (!finalVerification.ok) {
      const failed = await markFailed(
        input,
        lease,
        completedActionIds,
        finalVerification.blockers.map((item) => `${item.code}: ${item.detail}`).join("; "),
      );
      return baseResult(input, "partial", {
        lease: failed.lease,
        completedActionIds,
        blockers: finalVerification.blockers,
        recoveryOptions: unique(finalVerification.blockers.flatMap((item) => item.recoveryOptions)),
        originalError,
        cleanupError: failed.cleanupError,
      });
    }
    const committed = input.store.commitCleanup({
      operationId: plan.planId,
      planDigest: plan.planDigest,
      instanceId: plan.task.instanceId,
      taskId: plan.task.taskId,
      worktreeId: plan.worktree?.worktreeId,
      expectedTaskVersion: plan.task.version!,
      expectedLifecycle: plan.task.lifecycleState as Exclude<CleanupPlan["disposition"], "cleaned" | "unknown">,
      completedActionIds,
      committedAt: input.now?.() ?? Date.now(),
    });
    return baseResult(input, "completed", {
      task: committed.task,
      lease: committed.lease,
      completedActionIds,
      originalError,
    });
  } catch (error) {
    const failed = await markFailed(
      input,
      lease,
      completedActionIds,
      `cleanup state commit failed: ${errorText(error)}`,
    );
    return baseResult(input, "partial", {
      lease: failed.lease,
      completedActionIds,
      blockers: [actionFailure("cleanup-state-commit-failed", errorText(error))],
      recoveryOptions: ["preserve the exact plan and rerun after the lease expires"],
      originalError,
      cleanupError: failed.cleanupError,
    });
  }
}

export const executeCleanupPlan = executeCleanup;
