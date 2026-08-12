import { runProgram } from "../../subprocess.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { validateBranchNameAgainstGovernance } from "../governance/branch.js";
import { buildWorktreeNaming, decideBootstrap, runBootstrap } from "../git/worktree.js";
import { resolveRepositoryIdentity } from "./identity.js";
import { resolveRepoState } from "./repo-state.js";
import { checkStaleBaseBranch, getTaskStatusForWorkspace, type StartTaskWarning } from "./task.js";
import type { RepositoryInstanceId } from "./identity.js";
import type { TaskId, TaskRecord, WorkflowStateStore } from "../state/store.js";
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
    if (currentTask !== undefined)
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

  const reservation = input.store.reserveTask({
    instanceId: identity.identity.instanceId as RepositoryInstanceId,
    taskSlug: input.taskSlug,
    issueRef: input.issueRef,
    startIdempotencyKey: input.idempotencyKey,
    baseBranch: base,
    baseCommit: baseTip,
    allowMultipleActiveTasksPerIssue:
      input.policy.worktree.multipleActiveTasksPerIssue === "off" ||
      input.policy.worktree.multipleActiveTasksPerIssue === "advisory",
  });
  const ownsReservation = reservation.ok;
  let task: TaskRecord;
  if (!reservation.ok) {
    const existing = reservation.existingTask;
    if (
      input.idempotencyKey !== undefined &&
      existing.startIdempotencyKey === input.idempotencyKey &&
      existing.nawabariSessionId !== undefined
    ) {
      try {
        const session = await client.showSession({ cwd: input.workspaceRoot, sessionId: existing.nawabariSessionId });
        return {
          ok: true,
          task: existing,
          execution: execution(session),
          semanticPlan,
          warnings: staleWarning === undefined ? [] : [staleWarning],
          reused: true,
        };
      } catch (error) {
        return failureFrom(error);
      }
    }
    if (
      input.idempotencyKey !== undefined &&
      existing.startIdempotencyKey === input.idempotencyKey &&
      existing.lifecycleState === "planned"
    ) {
      // A prior process may have stopped after reserving the orchestration row
      // but before attaching its external session. Continue the same operation
      // instead of creating a second task identity.
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
  let started: Awaited<ReturnType<typeof startNawabariExecution>>;
  try {
    const retrySessions = (await client.listSessions(input.workspaceRoot)).filter(
      (session) => session.state === "active" && session.label === taskLabel,
    );
    if (retrySessions.length > 1)
      throw new NawabariExecutionError(
        "nawabari-rejected",
        `multiple active Nawabari sessions match retry label ${taskLabel}`,
        "OWNERSHIP_MISMATCH",
      );
    started =
      retrySessions[0] === undefined
        ? await startNawabariExecution({
            client,
            cwd: input.workspaceRoot,
            branch,
            base,
            taskLabel,
            plan: semanticPlan,
          })
        : await resumeNawabariExecution({
            client,
            cwd: input.workspaceRoot,
            session: retrySessions[0],
            branch,
            base,
            plan: semanticPlan,
          });
  } catch (error) {
    if (ownsReservation) input.store.deleteReservedTask(task.taskId);
    return failureFrom(error);
  }

  try {
    const attached = input.store.attachNawabariSession(
      task.taskId,
      started.session.sessionId as NonNullable<TaskRecord["nawabariSessionId"]>,
    );
    const active = input.store.updateTaskLifecycleState(attached.taskId, "active");
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
    if (ownsReservation) {
      await client
        .closeSession({ cwd: started.session.worktree, sessionId: started.session.sessionId })
        .catch(() => undefined);
      input.store.deleteReservedTask(task.taskId);
    }
    return failureFrom(error);
  }
}
