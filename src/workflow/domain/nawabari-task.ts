import fs from "node:fs";
import { runProgram } from "../../subprocess.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { validateBranchNameAgainstGovernance } from "../governance/branch.js";
import { buildWorktreeNaming, decideBootstrap, runBootstrap } from "../git/worktree.js";
import { resolveRepositoryIdentity } from "./identity.js";
import { resolveRepoState } from "./repo-state.js";
import { checkStaleBaseBranch, getTaskStatusForWorkspace, type StartTaskWarning } from "./task.js";
import { transitionTask } from "./task-lifecycle.js";
import { reconcileNawabariClosures } from "./nawabari-close.js";
import type { RepositoryInstanceId } from "./identity.js";
import type {
  NawabariSessionId,
  TaskId,
  TaskRecord,
  TaskStartReconciliationRecord,
  WorkflowStateStore,
} from "../state/store.js";
import { createSemanticExecutionPlan, type SemanticExecutionPlan } from "../../semantics/execution-plan.js";
import {
  NawabariExecutionClient,
  NawabariExecutionError,
  resumeNawabariExecution,
  startNawabariExecution,
  type NawabariSession,
} from "../nawabari.js";

export interface NawabariTaskStartInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  policy: WorkflowPolicyDocument;
  taskSlug: string;
  branchType: string;
  issueRef?: string;
  idempotencyKey?: string;
  expectedLockfileDigest?: string;
  semanticPlan?: SemanticExecutionPlan;
  nawabari?: NawabariExecutionClient;
  /** Internal fault-test seam; runtime callers leave this unset. */
  faultInjection?: (
    point: "after-session-created" | "after-attachment-persistence" | "after-lifecycle-activation",
  ) => void;
}

export type NawabariTaskStartFailureReason =
  | "invalid-input"
  | "unsupported-repo-state"
  | "policy-denied"
  | "issue-required"
  | "issue-already-claimed"
  | "invalid-branch-name"
  | "branch-governance-unavailable"
  | "nawabari-unavailable"
  | "nawabari-incompatible"
  | "nawabari-contract-invalid"
  | "nawabari-rejected"
  | "nawabari-command-failed"
  | "cleanup-blocked"
  | "nawabari-ownership-ambiguous"
  | "legacy-task-adoption-required"
  | "active-task-in-workspace";

export interface NawabariTaskExecutionReference {
  sessionId: string;
  worktree: string;
  branch: string;
  state: string;
}

export type NawabariTaskStartResult =
  | {
      ok: true;
      task: TaskRecord;
      execution: NawabariTaskExecutionReference;
      semanticPlan: SemanticExecutionPlan;
      warnings: readonly StartTaskWarning[];
      bootstrap?: { command: string; ran: boolean; ok?: boolean; detail?: string };
      reused?: boolean;
    }
  | { ok: false; reason: NawabariTaskStartFailureReason; detail: string };

function failureFrom(error: unknown): Extract<NawabariTaskStartResult, { ok: false }> {
  if (error instanceof NawabariExecutionError) {
    return { ok: false, reason: error.code, detail: error.message } as Extract<NawabariTaskStartResult, { ok: false }>;
  }
  return {
    ok: false,
    reason: "nawabari-command-failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

async function baseCommit(workspaceRoot: string, branch: string): Promise<string | undefined> {
  const result = await runProgram("git", ["rev-parse", "--verify", "-q", branch], workspaceRoot, 5_000, 64 * 1024);
  if (result.spawnError !== undefined || result.timedOut || result.outputLimit || result.exitCode !== 0)
    return undefined;
  const commit = result.stdout.trim();
  return commit.length === 0 ? undefined : commit;
}

function execution(session: NawabariSession): NawabariTaskExecutionReference {
  return { sessionId: session.sessionId, worktree: session.worktree, branch: session.branch, state: session.state };
}

function warning(code: StartTaskWarning["code"], detail: string): StartTaskWarning {
  return { code, detail };
}

interface TaskStartExpectation {
  taskLabel: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  instanceId: RepositoryInstanceId;
  canonicalRepositoryRoot: string;
  gitCommonDir: string;
}

function ownershipFailure(detail: string): Extract<NawabariTaskStartResult, { ok: false }> {
  return { ok: false, reason: "nawabari-ownership-ambiguous", detail };
}

function sameCanonicalPath(left: string, right: string): boolean {
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return left === right;
  }
}

function sessionIdentityMismatches(
  session: NawabariSession,
  expected: TaskStartExpectation,
  expectedSessionId?: string,
): string[] {
  return [
    expectedSessionId !== undefined && session.sessionId !== expectedSessionId ? "session" : undefined,
    session.repository === undefined ||
    (!sameCanonicalPath(session.repository, expected.canonicalRepositoryRoot) &&
      !sameCanonicalPath(session.repository, expected.gitCommonDir))
      ? "repository"
      : undefined,
    session.label !== expected.taskLabel ? "task label" : undefined,
    session.branch !== expected.branchName ? "branch" : undefined,
  ].filter((value): value is string => value !== undefined);
}

function reconciliationIdentityMatches(
  record: TaskStartReconciliationRecord,
  task: TaskRecord,
  expected: TaskStartExpectation,
): boolean {
  return (
    record.taskId === task.taskId &&
    record.instanceId === expected.instanceId &&
    task.instanceId === expected.instanceId &&
    record.taskLabel === expected.taskLabel &&
    record.branchName === expected.branchName &&
    record.baseBranch === expected.baseBranch &&
    record.baseCommit === expected.baseCommit
  );
}

function sameTaskStartInput(
  store: WorkflowStateStore,
  task: TaskRecord,
  input: NawabariTaskStartInput,
  expected: TaskStartExpectation,
): boolean {
  if (
    !["planned", "active", "orphaned"].includes(task.lifecycleState) ||
    task.instanceId !== expected.instanceId ||
    task.taskSlug !== input.taskSlug ||
    task.issueRef !== input.issueRef ||
    task.startIdempotencyKey !== input.idempotencyKey ||
    task.baseBranch !== expected.baseBranch ||
    task.baseCommit !== expected.baseCommit
  )
    return false;
  const record = store.getTaskStartReconciliation(task.taskId);
  return record !== undefined && reconciliationIdentityMatches(record, task, expected);
}

function findRecoverableTaskStart(input: {
  store: WorkflowStateStore;
  instanceId: RepositoryInstanceId;
  taskInput: NawabariTaskStartInput;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  canonicalRepositoryRoot: string;
  gitCommonDir: string;
}): { task?: TaskRecord; ambiguous: boolean } {
  const candidates = input.store.listTasks(input.instanceId).filter((task) =>
    sameTaskStartInput(input.store, task, input.taskInput, {
      taskLabel: `mottainai-task-${task.taskId}`,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      baseCommit: input.baseCommit,
      instanceId: input.instanceId,
      canonicalRepositoryRoot: input.canonicalRepositoryRoot,
      gitCommonDir: input.gitCommonDir,
    }),
  );
  return candidates.length === 1 ? { task: candidates[0], ambiguous: false } : { ambiguous: candidates.length > 1 };
}

function bestEffortReconciliationState(
  store: WorkflowStateStore,
  taskId: TaskId,
  state: "active" | "abandoned" | "orphaned" | "attached" | "session-created",
  detail?: string,
): void {
  try {
    store.updateTaskStartReconciliation(taskId, state, detail);
  } catch {
    // Preserve the original task-start failure; the task lifecycle below is the
    // safety boundary for the normal-active invariant.
  }
}

function transitionTaskBestEffort(
  store: WorkflowStateStore,
  taskId: TaskId,
  next: "active" | "abandoned" | "orphaned",
): boolean {
  try {
    const current = store.getTask(taskId);
    if (current === undefined || current.lifecycleState === next) return true;
    const transitioned = transitionTask(store, taskId, next);
    // Compensation must not turn an already-advanced lifecycle into a second
    // failure. The reconciliation record still carries the diagnostic; when a
    // later lifecycle transition is not legal, preserve that authoritative
    // state instead of retrying a planned-row deletion.
    return transitioned.ok;
  } catch {
    // A failed lifecycle write is a hard boundary: callers that are about to
    // mutate Nawabari must stop, while ordinary error paths preserve their
    // original failure and durable reconciliation evidence where possible.
    return false;
  }
}

async function compensateTaskStart(input: {
  client: NawabariExecutionClient;
  workspaceRoot: string;
  store: WorkflowStateStore;
  task: TaskRecord;
  reconciliation: TaskStartReconciliationRecord;
  expected: TaskStartExpectation;
  session?: NawabariSession;
  externalSessionMayExist: boolean;
  ownsReservation: boolean;
}): Promise<void> {
  const sessionId = input.reconciliation.nawabariSessionId ?? input.task.nawabariSessionId ?? input.session?.sessionId;
  const currentBeforeObservation = input.store.getTask(input.task.taskId);
  const demotedActiveTask = currentBeforeObservation?.lifecycleState === "active";

  // Make the orchestration row non-active before observing or closing an
  // external session. If the process dies after Nawabari reports a closed
  // session (or after close succeeds), the durable row cannot remain a normal
  // active task pointing at that session.
  if (demotedActiveTask) {
    bestEffortReconciliationState(
      input.store,
      input.task.taskId,
      "orphaned",
      `task-start compensation is verifying Nawabari session ${sessionId ?? "(unknown)"}`,
    );
    if (!transitionTaskBestEffort(input.store, input.task.taskId, "orphaned")) return;
  } else if (sessionId !== undefined && currentBeforeObservation?.lifecycleState === "planned") {
    // Keep a planned reservation recoverable if the process dies in the
    // external-close window; it can still be deleted after close is proven.
    bestEffortReconciliationState(
      input.store,
      input.task.taskId,
      "orphaned",
      `task-start compensation is closing Nawabari session ${sessionId}`,
    );
  }
  if (sessionId === undefined) {
    if (
      input.ownsReservation &&
      !input.externalSessionMayExist &&
      input.task.lifecycleState === "planned" &&
      input.reconciliation.state === "reserved"
    ) {
      input.store.deleteReservedTask(input.task.taskId);
      return;
    }
    if (input.externalSessionMayExist) {
      try {
        const candidates = (await input.client.listSessions(input.workspaceRoot)).filter(
          (candidate) => candidate.label === input.expected.taskLabel,
        );
        if (candidates.length === 1 && candidates[0] !== undefined) {
          const mismatches = sessionIdentityMismatches(candidates[0], input.expected, candidates[0].sessionId);
          if (mismatches.length === 0) {
            const recovered = input.store.recordTaskStartSession(
              input.task.taskId,
              candidates[0].sessionId as NawabariSessionId,
            );
            await compensateTaskStart({ ...input, reconciliation: recovered, session: candidates[0] });
            return;
          }
        }
      } catch {
        // Ownership remains ambiguous; do not guess which external session to close.
      }
    }
    bestEffortReconciliationState(
      input.store,
      input.task.taskId,
      "orphaned",
      "task-start failed without a provable Nawabari session identity",
    );
    transitionTaskBestEffort(input.store, input.task.taskId, "orphaned");
    return;
  }

  let observed: NawabariSession;
  try {
    observed = await input.client.showSession({ cwd: input.workspaceRoot, sessionId });
  } catch (error) {
    const detail = `cannot prove ownership of Nawabari session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`;
    bestEffortReconciliationState(input.store, input.task.taskId, "orphaned", detail);
    transitionTaskBestEffort(input.store, input.task.taskId, "orphaned");
    return;
  }
  const mismatches = sessionIdentityMismatches(observed, input.expected, sessionId);
  if (mismatches.length > 0) {
    const detail = `refusing compensation for Nawabari session ${sessionId}: identity mismatch (${mismatches.join(", ")})`;
    bestEffortReconciliationState(input.store, input.task.taskId, "orphaned", detail);
    transitionTaskBestEffort(input.store, input.task.taskId, "orphaned");
    return;
  }

  if (observed.state === "active") {
    try {
      await input.client.closeSession({ cwd: observed.worktree, sessionId });
    } catch (error) {
      const detail = `cannot close owned Nawabari session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`;
      bestEffortReconciliationState(input.store, input.task.taskId, "orphaned", detail);
      transitionTaskBestEffort(input.store, input.task.taskId, "orphaned");
      return;
    }
  }

  // Ownership was proven before the close request. A successful close (or an
  // already non-active session) is a known compensation result, not an orphan.
  const current = input.store.getTask(input.task.taskId);
  if (current?.lifecycleState === "planned" && input.ownsReservation) {
    input.store.deleteReservedTask(input.task.taskId);
    return;
  }
  const compensatedState = demotedActiveTask
    ? "abandoned"
    : current?.lifecycleState === "orphaned"
      ? "orphaned"
      : "abandoned";
  bestEffortReconciliationState(
    input.store,
    input.task.taskId,
    compensatedState,
    `task-start compensated Nawabari session ${sessionId}`,
  );
  if (demotedActiveTask && current?.lifecycleState === "orphaned") {
    transitionTaskBestEffort(input.store, input.task.taskId, "abandoned");
  } else if (current !== undefined && current.lifecycleState !== "orphaned" && current.lifecycleState !== "abandoned") {
    transitionTaskBestEffort(input.store, input.task.taskId, "abandoned");
  }
}

async function recoverSessionById(
  client: NawabariExecutionClient,
  workspaceRoot: string,
  sessionId: string,
  expected: TaskStartExpectation,
): Promise<{ ok: true; session: NawabariSession } | { ok: false; detail: string; closed: boolean }> {
  let session: NawabariSession;
  try {
    session = await client.showSession({ cwd: workspaceRoot, sessionId });
  } catch (error) {
    return {
      ok: false,
      detail: `cannot recover persisted Nawabari session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      closed: false,
    };
  }
  const mismatches = sessionIdentityMismatches(session, expected, sessionId);
  if (mismatches.length > 0)
    return {
      ok: false,
      detail: `persisted Nawabari session ${sessionId} failed identity verification (${mismatches.join(", ")})`,
      closed: false,
    };
  if (session.state !== "active")
    return {
      ok: false,
      detail: `persisted Nawabari session ${sessionId} is ${session.state}, not active`,
      closed: true,
    };
  return { ok: true, session };
}

/**
 * Start the orchestration record and the Nawabari-owned local session. No
 * Mottainai worktree reservation or Git worktree mutation occurs in this path.
 */
export async function startNawabariTask(input: NawabariTaskStartInput): Promise<NawabariTaskStartResult> {
  const client = input.nawabari ?? new NawabariExecutionClient();
  const identity = resolveRepositoryIdentity(input.workspaceRoot);
  if (!identity.ok) return { ok: false, reason: "unsupported-repo-state", detail: identity.reason };
  const repoState = await resolveRepoState(input.workspaceRoot);
  if (!repoState.ok || !repoState.state.supported)
    return {
      ok: false,
      reason: "unsupported-repo-state",
      detail: !repoState.ok ? repoState.reason : repoState.state.reason,
    };

  // This is orchestration identity, not physical ownership. Refuse to create
  // a second task from an already-managed worktree before asking Nawabari to
  // provision or claim anything.
  const localTask = await getTaskStatusForWorkspace(input.workspaceRoot, input.store);
  if (localTask.ok && localTask.active)
    return {
      ok: false,
      reason: "active-task-in-workspace",
      detail: `workspace already has an active task: ${localTask.status.task.taskId}`,
    };
  try {
    const currentSessionId = await client.currentSessionId(input.workspaceRoot);
    const currentTask = input.store.listTasks().find((task) => task.nawabariSessionId === currentSessionId);
    if (currentTask !== undefined && currentTask.lifecycleState !== "merged")
      return {
        ok: false,
        reason: "active-task-in-workspace",
        detail: `workspace already has an active Nawabari task: ${currentTask.taskId}`,
      };
  } catch {
    // Primary checkouts and legacy worktrees do not have a current Nawabari
    // session; their normal start path continues below.
  }
  if (
    (input.policy.worktree.issueRequired === "enforce" || input.policy.worktree.issueRequired === "confirm") &&
    input.issueRef === undefined
  )
    return {
      ok: false,
      reason: "issue-required",
      detail: `policy.worktree.issueRequired=${input.policy.worktree.issueRequired} but no issueRef was provided`,
    };

  const branch = buildWorktreeNaming({
    branchType: input.branchType,
    issueRef: input.issueRef ?? "unlinked",
    taskSlug: input.taskSlug,
  }).branchName;
  const branchValidation = await validateBranchNameAgainstGovernance(branch, identity.identity.canonicalRepositoryRoot);
  if (!branchValidation.ok)
    return {
      ok: false,
      reason: branchValidation.kind === "invalid" ? "invalid-branch-name" : "branch-governance-unavailable",
      detail: `generated branch ${branch} was rejected before Nawabari mutation: ${branchValidation.detail}`,
    };

  const policyDecision = decideProtectedBranchOperation({
    policy: input.policy,
    branch: repoState.state.branch,
    operation: "worktreeManagement",
    repository: { isPrimaryCheckout: repoState.state.isPrimaryCheckout },
  });
  if (!policyDecision.allowed) return { ok: false, reason: "policy-denied", detail: policyDecision.reason };

  const base = repoState.state.branch ?? "HEAD";
  const baseTip = await baseCommit(input.workspaceRoot, base);
  if (baseTip === undefined)
    return { ok: false, reason: "unsupported-repo-state", detail: `cannot resolve tip commit of ${base}` };

  const semanticPlan = input.semanticPlan ?? createSemanticExecutionPlan();
  if (semanticPlan.claimGeneration.strategy === "blocked")
    return { ok: false, reason: "policy-denied", detail: semanticPlan.claimGeneration.reason };

  let staleWarning: StartTaskWarning | undefined;
  if (input.policy.worktree.staleBaseBranch === "advisory" || input.policy.worktree.staleBaseBranch === "enforce") {
    const stale = await checkStaleBaseBranch(input.workspaceRoot, base, baseTip);
    if (stale.kind === "stale") {
      const detail = `local ${base} (${baseTip}) is behind origin/${base} (${stale.remoteCommit})`;
      if (input.policy.worktree.staleBaseBranch === "enforce")
        return { ok: false, reason: "unsupported-repo-state", detail };
      staleWarning = warning("stale-base-branch", detail);
    } else if (stale.kind === "unknown") {
      const detail = `could not determine whether ${base} is behind origin/${base}: ${stale.reason}`;
      if (input.policy.worktree.staleBaseBranch === "enforce")
        return { ok: false, reason: "unsupported-repo-state", detail };
      staleWarning = warning("stale-base-branch-check-unavailable", detail);
    }
  }

  input.store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });

  const instanceId = identity.identity.instanceId as RepositoryInstanceId;
  const closeReconciliation = await reconcileNawabariClosures({
    workspaceRoot: input.workspaceRoot,
    store: input.store,
    client,
    instanceId,
  });
  if (closeReconciliation.blocked.length > 0)
    return {
      ok: false,
      reason: "cleanup-blocked",
      detail: closeReconciliation.blocked.map((blocked) => blocked.detail).join("; "),
    };
  const recoverable = findRecoverableTaskStart({
    store: input.store,
    instanceId,
    taskInput: input,
    branchName: branch,
    baseBranch: base,
    baseCommit: baseTip,
    canonicalRepositoryRoot: identity.identity.canonicalRepositoryRoot,
    gitCommonDir: identity.identity.gitCommonDir,
  });
  if (recoverable.ambiguous)
    return ownershipFailure(
      `multiple recoverable task-start records match ${input.taskSlug}/${input.issueRef ?? "(none)"}; refusing to create another Nawabari session`,
    );

  const reservation =
    recoverable.task === undefined
      ? input.store.reserveTask({
          instanceId,
          taskSlug: input.taskSlug,
          issueRef: input.issueRef,
          startIdempotencyKey: input.idempotencyKey,
          baseBranch: base,
          baseCommit: baseTip,
          allowMultipleActiveTasksPerIssue:
            input.policy.worktree.multipleActiveTasksPerIssue === "off" ||
            input.policy.worktree.multipleActiveTasksPerIssue === "advisory",
        })
      : { ok: true as const, task: recoverable.task };
  const ownsReservation = recoverable.task === undefined && reservation.ok;
  let task: TaskRecord;
  if (!reservation.ok) {
    const existing = reservation.existingTask;
    if (
      (input.idempotencyKey !== undefined &&
        existing.startIdempotencyKey === input.idempotencyKey &&
        ["planned", "active", "orphaned"].includes(existing.lifecycleState)) ||
      sameTaskStartInput(input.store, existing, input, {
        taskLabel: `mottainai-task-${existing.taskId}`,
        branchName: branch,
        baseBranch: base,
        baseCommit: baseTip,
        instanceId,
        canonicalRepositoryRoot: identity.identity.canonicalRepositoryRoot,
        gitCommonDir: identity.identity.gitCommonDir,
      })
    ) {
      // A prior process may have stopped at any task-start boundary. Continue
      // the same durable operation instead of creating a second task identity.
      task = existing;
    } else {
      return {
        ok: false,
        reason: existing.nawabariSessionId === undefined ? "legacy-task-adoption-required" : "issue-already-claimed",
        detail:
          existing.nawabariSessionId === undefined
            ? `task ${existing.taskId} has no Nawabari session reference; resolve the legacy task before retrying`
            : `issue ${input.issueRef ?? "(none)"} is already claimed by task ${existing.taskId}`,
      };
    }
  } else {
    task = reservation.task;
  }

  const taskLabel = `mottainai-task-${task.taskId}`;
  const expected: TaskStartExpectation = {
    taskLabel,
    branchName: branch,
    baseBranch: base,
    baseCommit: baseTip,
    instanceId: identity.identity.instanceId as RepositoryInstanceId,
    canonicalRepositoryRoot: identity.identity.canonicalRepositoryRoot,
    gitCommonDir: identity.identity.gitCommonDir,
  };
  let reconciliation: TaskStartReconciliationRecord | undefined;
  try {
    reconciliation = input.store.beginTaskStartReconciliation({
      taskId: task.taskId,
      instanceId: expected.instanceId,
      taskLabel,
      branchName: branch,
      baseBranch: base,
      baseCommit: baseTip,
    });
  } catch (error) {
    if (ownsReservation) input.store.deleteReservedTask(task.taskId);
    return failureFrom(error);
  }
  if (!reconciliationIdentityMatches(reconciliation, task, expected)) {
    const detail = `task-start reconciliation identity mismatch for task ${task.taskId}`;
    bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
    transitionTaskBestEffort(input.store, task.taskId, "orphaned");
    return ownershipFailure(detail);
  }

  const taskSessionId = task.nawabariSessionId;
  if (
    reconciliation.nawabariSessionId !== undefined &&
    taskSessionId !== undefined &&
    reconciliation.nawabariSessionId !== taskSessionId
  ) {
    const detail = `task ${task.taskId} has conflicting durable Nawabari session identities`;
    bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
    transitionTaskBestEffort(input.store, task.taskId, "orphaned");
    return ownershipFailure(detail);
  }

  if (reconciliation.nawabariSessionId === undefined && taskSessionId !== undefined) {
    try {
      reconciliation = input.store.recordTaskStartSession(task.taskId, taskSessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
      transitionTaskBestEffort(input.store, task.taskId, "orphaned");
      return ownershipFailure(detail);
    }
  }

  const persistedSessionId = reconciliation.nawabariSessionId ?? taskSessionId;
  let demotedActiveForRecovery = false;
  if (input.store.getTask(task.taskId)?.lifecycleState === "active") {
    bestEffortReconciliationState(
      input.store,
      task.taskId,
      "orphaned",
      `task-start recovery is verifying Nawabari session ${persistedSessionId ?? "(unknown)"}`,
    );
    if (!transitionTaskBestEffort(input.store, task.taskId, "orphaned"))
      return ownershipFailure(`could not durably enter reconciliation state for active task ${task.taskId}`);
    demotedActiveForRecovery = true;
  }
  if (persistedSessionId !== undefined) {
    const recovered = await recoverSessionById(client, input.workspaceRoot, persistedSessionId, expected);
    if (!recovered.ok) {
      const current = input.store.getTask(task.taskId);
      const state =
        recovered.closed && (demotedActiveForRecovery || current?.lifecycleState !== "orphaned")
          ? "abandoned"
          : "orphaned";
      bestEffortReconciliationState(input.store, task.taskId, state, recovered.detail);
      if (!transitionTaskBestEffort(input.store, task.taskId, state)) return ownershipFailure(recovered.detail);
      return recovered.closed
        ? { ok: false, reason: "nawabari-rejected", detail: recovered.detail }
        : ownershipFailure(recovered.detail);
    }
    if (demotedActiveForRecovery) {
      try {
        const attached = input.store.attachNawabariSession(task.taskId, persistedSessionId as NawabariSessionId);
        const current = input.store.getTask(task.taskId);
        const active =
          current?.lifecycleState === "active"
            ? attached
            : (() => {
                const transitioned = transitionTask(input.store, task.taskId, "active");
                if (!transitioned.ok) throw new Error(transitioned.blocked.blockingRule);
                return transitioned.task;
              })();
        bestEffortReconciliationState(input.store, task.taskId, "active");
        return {
          ok: true,
          task: active,
          execution: execution(recovered.session),
          semanticPlan,
          warnings: staleWarning === undefined ? [] : [staleWarning],
          reused: true,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
        transitionTaskBestEffort(input.store, task.taskId, "orphaned");
        return ownershipFailure(detail);
      }
    }
  }
  if (input.store.getTask(task.taskId)?.lifecycleState === "active") {
    const detail = `active task ${task.taskId} has no provable Nawabari session identity`;
    bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
    if (!transitionTaskBestEffort(input.store, task.taskId, "orphaned")) return ownershipFailure(detail);
    return ownershipFailure(detail);
  }

  let started: Awaited<ReturnType<typeof startNawabariExecution>>;
  let externalSessionMayExist = persistedSessionId !== undefined;
  try {
    let resumeSession: NawabariSession | undefined;
    if (persistedSessionId !== undefined) {
      const recovered = await recoverSessionById(client, input.workspaceRoot, persistedSessionId, expected);
      if (!recovered.ok) throw new NawabariExecutionError("nawabari-rejected", recovered.detail, "OWNERSHIP_MISMATCH");
      resumeSession = recovered.session;
    } else {
      // Once external session state is being inspected, a failed observation
      // can no longer prove that no session exists. Never compensate by
      // deleting the planned task on that ambiguity; the recovery path must
      // retain an orphaned record instead.
      externalSessionMayExist = true;
      const listedSessions = await client.listSessions(input.workspaceRoot);
      const sessions = listedSessions.filter((session) => session.label === taskLabel);
      const unlabelledRelatedSessions = listedSessions.filter(
        (session) =>
          session.state === "active" &&
          session.label === undefined &&
          session.branch === expected.branchName &&
          session.repository !== undefined &&
          (sameCanonicalPath(session.repository, expected.canonicalRepositoryRoot) ||
            sameCanonicalPath(session.repository, expected.gitCommonDir)),
      );
      if (unlabelledRelatedSessions.length > 0)
        throw new NawabariExecutionError(
          "nawabari-rejected",
          `active Nawabari session has no task label for branch ${expected.branchName}; ownership is ambiguous`,
          "OWNERSHIP_MISMATCH",
          unlabelledRelatedSessions,
        );
      if (sessions.length > 1) {
        throw new NawabariExecutionError(
          "nawabari-rejected",
          `multiple Nawabari sessions match retry label ${taskLabel}`,
          "OWNERSHIP_MISMATCH",
          sessions,
        );
      }
      if (sessions[0] !== undefined) {
        const mismatches = sessionIdentityMismatches(sessions[0], expected, sessions[0].sessionId);
        if (mismatches.length > 0)
          throw new NawabariExecutionError(
            "nawabari-rejected",
            `Nawabari retry session failed identity verification (${mismatches.join(", ")})`,
            "OWNERSHIP_MISMATCH",
            sessions[0].raw,
          );
        if (sessions[0].state !== "active") {
          input.store.recordTaskStartSession(task.taskId, sessions[0].sessionId as NawabariSessionId);
          const closedState = task.lifecycleState === "orphaned" ? "orphaned" : "abandoned";
          bestEffortReconciliationState(
            input.store,
            task.taskId,
            closedState,
            `matching Nawabari session is ${sessions[0].state}`,
          );
          if (closedState === "abandoned") transitionTaskBestEffort(input.store, task.taskId, "abandoned");
          return {
            ok: false,
            reason: "nawabari-rejected",
            detail: `matching Nawabari session is ${sessions[0].state}`,
          };
        }
        input.store.recordTaskStartSession(task.taskId, sessions[0].sessionId as NawabariSessionId);
        externalSessionMayExist = true;
        resumeSession = sessions[0];
      }
    }

    if (demotedActiveForRecovery && resumeSession === undefined) {
      const detail = `active task ${task.taskId} has no recoverable Nawabari session identity`;
      bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
      return ownershipFailure(detail);
    }

    started =
      resumeSession === undefined
        ? await startNawabariExecution({
            client,
            cwd: input.workspaceRoot,
            branch,
            base,
            taskLabel,
            plan: semanticPlan,
            closeOnClaimFailure: false,
            onSessionCreated: (session) => {
              externalSessionMayExist = true;
              input.store.recordTaskStartSession(task.taskId, session.sessionId as NawabariSessionId);
              const mismatches = sessionIdentityMismatches(session, expected, session.sessionId);
              if (mismatches.length > 0)
                throw new NawabariExecutionError(
                  "nawabari-rejected",
                  `Nawabari session failed identity verification before claims (${mismatches.join(", ")})`,
                  "OWNERSHIP_MISMATCH",
                  session.raw,
                );
              if (session.state !== "active")
                throw new NawabariExecutionError(
                  "nawabari-rejected",
                  `Nawabari session ${session.sessionId} is ${session.state}, not active`,
                  "SESSION_NOT_ACTIVE",
                  session.raw,
                );
              input.faultInjection?.("after-session-created");
            },
          })
        : await resumeNawabariExecution({
            client,
            cwd: input.workspaceRoot,
            session: resumeSession,
            branch,
            base,
            plan: semanticPlan,
          });
  } catch (error) {
    const updated = input.store.getTaskStartReconciliation(task.taskId) ?? reconciliation;
    await compensateTaskStart({
      client,
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      task: input.store.getTask(task.taskId) ?? task,
      reconciliation: updated,
      expected,
      externalSessionMayExist,
      ownsReservation,
    });
    // A companion that cannot be spawned at all is not an ownership question:
    // every observation compensation retries will hit the same unavailability
    // and land on "orphaned" for an unrelated reason. Preserve the original
    // failure code in that case instead of reporting it as ambiguous.
    if (error instanceof NawabariExecutionError && error.code === "nawabari-unavailable") return failureFrom(error);
    const compensated = input.store.getTaskStartReconciliation(task.taskId);
    if (compensated?.state === "orphaned") return ownershipFailure(compensated.detail ?? String(error));
    return failureFrom(error);
  }

  try {
    const mismatches = sessionIdentityMismatches(started.session, expected, started.session.sessionId);
    if (mismatches.length > 0) {
      const detail = `Nawabari session failed identity verification (${mismatches.join(", ")})`;
      bestEffortReconciliationState(input.store, task.taskId, "orphaned", detail);
      transitionTaskBestEffort(input.store, task.taskId, "orphaned");
      return ownershipFailure(detail);
    }
    const attached = input.store.attachNawabariSession(
      task.taskId,
      started.session.sessionId as NonNullable<TaskRecord["nawabariSessionId"]>,
    );
    bestEffortReconciliationState(input.store, attached.taskId, "attached");
    input.faultInjection?.("after-attachment-persistence");
    const active =
      attached.lifecycleState === "active"
        ? attached
        : (() => {
            const transitioned = transitionTask(input.store, attached.taskId, "active");
            if (!transitioned.ok) throw new Error(transitioned.blocked.blockingRule);
            return transitioned.task;
          })();
    bestEffortReconciliationState(input.store, active.taskId, "active");
    input.faultInjection?.("after-lifecycle-activation");
    const bootstrap = decideBootstrap(
      input.policy.worktree.bootstrapMode,
      started.session.worktree,
      input.expectedLockfileDigest,
    );
    if (bootstrap.shouldExecute && bootstrap.command !== undefined) {
      const run = await runBootstrap(started.session.worktree, bootstrap.command);
      return {
        ok: true,
        task: active,
        execution: execution(started.session),
        semanticPlan,
        warnings: staleWarning === undefined ? [] : [staleWarning],
        bootstrap: {
          command: bootstrap.command,
          ran: run.ran,
          ok: run.exitCode === 0,
          detail: run.stderr.slice(0, 256) || undefined,
        },
      };
    }
    return {
      ok: true,
      task: active,
      execution: execution(started.session),
      semanticPlan,
      warnings: staleWarning === undefined ? [] : [staleWarning],
      bootstrap: bootstrap.shouldExecute ? { command: bootstrap.command ?? "", ran: false } : undefined,
    };
  } catch (error) {
    const updated = input.store.getTaskStartReconciliation(task.taskId) ?? reconciliation;
    await compensateTaskStart({
      client,
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      task: input.store.getTask(task.taskId) ?? task,
      reconciliation: updated,
      expected,
      session: started.session,
      externalSessionMayExist: true,
      ownsReservation,
    });
    const compensated = input.store.getTaskStartReconciliation(task.taskId);
    if (compensated?.state === "orphaned") return ownershipFailure(compensated.detail ?? String(error));
    return failureFrom(error);
  }
}
