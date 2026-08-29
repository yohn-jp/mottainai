import fs from "node:fs";
import path from "node:path";
import type { NawabariExecutionClient, NawabariSession } from "../nawabari.js";
import { runGitCommand } from "../git/context.js";
import { transitionTask } from "./task-lifecycle.js";
import { resolveRepositoryIdentity, type RepositoryInstanceId } from "./identity.js";
import type {
  CleanupLeaseRecord,
  TaskId,
  TaskRecord,
  WorktreeRecord,
  WorkflowStateStore,
} from "../state/store.js";

/** The legacy physical rows are evidence only; Nawabari is the sole physical authority. */
export const LEGACY_PHYSICAL_AUTHORITY = "nawabari" as const;

export type LegacyMigrationMode = "complete" | "adopt";

export type LegacyMigrationFailureReason =
  | "invalid-input"
  | "task-not-found"
  | "task-not-legacy"
  | "legacy-task-not-terminal"
  | "legacy-ownership-ambiguous"
  | "legacy-physical-state-present"
  | "repository-identity-unavailable"
  | "repository-identity-mismatch"
  | "git-observation-failed"
  | "nawabari-unavailable"
  | "nawabari-identity-mismatch"
  | "nawabari-session-conflict"
  | "lifecycle-transition-blocked";

export interface LegacyPhysicalProof {
  authority: typeof LEGACY_PHYSICAL_AUTHORITY;
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  observedAt: number;
  worktreeRowIds: readonly string[];
  cleanupLeaseIds: readonly string[];
  activeWorktreeRowIds: readonly string[];
  observedGitWorktreePaths: readonly string[];
  observedGitBranches: readonly string[];
  existingLegacyPaths: readonly string[];
  existingLegacyBranches: readonly string[];
  activeLeaseIds: readonly string[];
}

export interface LegacyMigrationInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId: TaskId;
  mode: LegacyMigrationMode;
  /** Required for adopt; callers must name the exact Nawabari session explicitly. */
  sessionId?: string;
  nawabari?: NawabariExecutionClient;
  dryRun?: boolean;
  now?: () => number;
}

export type LegacyMigrationResult =
  | {
      ok: true;
      authority: typeof LEGACY_PHYSICAL_AUTHORITY;
      mode: LegacyMigrationMode;
      task: TaskRecord;
      proof: LegacyPhysicalProof;
      session?: NawabariSession;
      dryRun?: boolean;
    }
  | {
      ok: false;
      authority: typeof LEGACY_PHYSICAL_AUTHORITY;
      mode: LegacyMigrationMode;
      reason: LegacyMigrationFailureReason;
      detail: string;
      proof?: LegacyPhysicalProof;
    };

interface LegacyState {
  task: TaskRecord;
  worktrees: WorktreeRecord[];
  leases: CleanupLeaseRecord[];
  activeWorktrees: WorktreeRecord[];
  activeLeases: CleanupLeaseRecord[];
  legacyBranchNames: string[];
  proof: LegacyPhysicalProof;
}

function failure(
  mode: LegacyMigrationMode,
  reason: LegacyMigrationFailureReason,
  detail: string,
  proof?: LegacyPhysicalProof,
): LegacyMigrationResult {
  return { ok: false, authority: LEGACY_PHYSICAL_AUTHORITY, mode, reason, detail, ...(proof === undefined ? {} : { proof }) };
}

function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function physicalRowsForTask(store: WorkflowStateStore, task: TaskRecord): LegacyState {
  const worktrees = store.listWorktreesForTask(task.taskId);
  const leases = store.listCleanupLeases(task.instanceId);
  const taskLeases = leases.filter((lease) => lease.taskId === task.taskId);
  const activeWorktrees = worktrees.filter((worktree) => worktree.status === "active");
  const activeLeases = taskLeases.filter((lease) => ["reserved", "mutating", "verifying"].includes(lease.state));
  const taskStart = store.getTaskStartReconciliation(task.taskId);
  const legacyBranchNames = [
    ...new Set([
      ...worktrees.map((worktree) => worktree.branchName),
      ...(taskStart === undefined ? [] : [taskStart.branchName]),
    ]),
  ];
  const proof: LegacyPhysicalProof = {
    authority: LEGACY_PHYSICAL_AUTHORITY,
    taskId: task.taskId,
    instanceId: task.instanceId,
    observedAt: Date.now(),
    worktreeRowIds: worktrees.map((worktree) => worktree.worktreeId),
    cleanupLeaseIds: taskLeases.map((lease) => lease.operationId),
    activeWorktreeRowIds: activeWorktrees.map((worktree) => worktree.worktreeId),
    observedGitWorktreePaths: [],
    observedGitBranches: [],
    existingLegacyPaths: [],
    existingLegacyBranches: [],
    activeLeaseIds: activeLeases.map((lease) => lease.operationId),
  };
  return { task, worktrees, leases: taskLeases, activeWorktrees, activeLeases, legacyBranchNames, proof };
}

async function observeGitWorktreePaths(workspaceRoot: string): Promise<
  | { ok: true; paths: string[] }
  | { ok: false; detail: string }
> {
  const result = await runGitCommand(workspaceRoot, ["worktree", "list", "--porcelain"]);
  if (!result.usable || result.result.exitCode !== 0)
    return { ok: false, detail: "Git worktree ownership could not be observed" };
  const paths: string[] = [];
  for (const line of result.result.stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) paths.push(canonicalPath(line.slice("worktree ".length)));
  }
  return { ok: true, paths };
}

async function observeGitBranches(
  workspaceRoot: string,
): Promise<{ ok: true; branches: string[] } | { ok: false; detail: string }> {
  const result = await runGitCommand(workspaceRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!result.usable || result.result.exitCode !== 0)
    return { ok: false, detail: "Git local branch ownership could not be observed" };
  return {
    ok: true,
    branches: result.result.stdout.split(/\r?\n/u).filter((branch) => branch.length > 0),
  };
}

function validateRows(state: LegacyState, mode: LegacyMigrationMode): LegacyMigrationResult | undefined {
  if (state.activeWorktrees.length > 1)
    return failure(
      mode,
      "legacy-ownership-ambiguous",
      `task ${state.task.taskId} has multiple active legacy worktree rows; refusing to choose an owner`,
      state.proof,
    );
  for (const worktree of state.worktrees) {
    if (worktree.taskId !== state.task.taskId || worktree.instanceId !== state.task.instanceId)
      return failure(
        mode,
        "legacy-ownership-ambiguous",
        `legacy worktree ${worktree.worktreeId} does not match the task/repository identity`,
        state.proof,
      );
  }
  for (const lease of state.leases) {
    if (lease.instanceId !== state.task.instanceId || lease.taskId !== state.task.taskId)
      return failure(
        mode,
        "legacy-ownership-ambiguous",
        `legacy cleanup lease ${lease.operationId} does not match the task/repository identity`,
        state.proof,
      );
    if (lease.worktreeId !== undefined && !state.worktrees.some((worktree) => worktree.worktreeId === lease.worktreeId))
      return failure(
        mode,
        "legacy-ownership-ambiguous",
        `legacy cleanup lease ${lease.operationId} references an unknown worktree`,
        state.proof,
      );
  }
  if (state.activeLeases.length > 0)
    return failure(
      mode,
      "legacy-ownership-ambiguous",
      `task ${state.task.taskId} has active legacy cleanup lease(s); resolve them before migration`,
      state.proof,
    );
  return undefined;
}

function repositoryMatchesSession(session: NawabariSession, repositoryRoot: string, gitCommonDir: string): boolean {
  return samePath(session.repository, repositoryRoot) || samePath(session.repository, gitCommonDir);
}

function updateProof(
  proof: LegacyPhysicalProof,
  observedGitWorktreePaths: readonly string[],
  existingLegacyPaths: readonly string[],
  observedGitBranches: readonly string[] = proof.observedGitBranches,
  existingLegacyBranches: readonly string[] = proof.existingLegacyBranches,
): LegacyPhysicalProof {
  return {
    ...proof,
    observedGitWorktreePaths: [...observedGitWorktreePaths],
    observedGitBranches: [...observedGitBranches],
    existingLegacyPaths: [...existingLegacyPaths],
    existingLegacyBranches: [...existingLegacyBranches],
  };
}

async function migrateComplete(input: LegacyMigrationInput, state: LegacyState): Promise<LegacyMigrationResult> {
  const rowFailure = validateRows(state, input.mode);
  if (rowFailure !== undefined) return rowFailure;
  const activeOrphan = state.task.lifecycleState === "active";
  if (!activeOrphan && !["merged", "abandoned", "orphaned", "cleaned"].includes(state.task.lifecycleState))
    return failure(
      input.mode,
      "legacy-task-not-terminal",
      `task ${state.task.taskId} is ${state.task.lifecycleState}; complete or abandon it before migration`,
      state.proof,
    );

  const observed = await observeGitWorktreePaths(input.workspaceRoot);
  if (!observed.ok) return failure(input.mode, "git-observation-failed", observed.detail, state.proof);
  const observedBranches = await observeGitBranches(input.workspaceRoot);
  if (!observedBranches.ok) return failure(input.mode, "git-observation-failed", observedBranches.detail, state.proof);
  const existingLegacyPaths = state.worktrees
    .filter((worktree) => worktree.status !== "removed" && fs.existsSync(worktree.canonicalPath))
    .map((worktree) => canonicalPath(worktree.canonicalPath));
  const existingLegacyBranches = state.legacyBranchNames.filter((branch) => observedBranches.branches.includes(branch));
  const proof = updateProof(
    state.proof,
    observed.paths,
    existingLegacyPaths,
    observedBranches.branches,
    existingLegacyBranches,
  );
  if (
    state.worktrees.some((worktree) => worktree.status !== "removed") ||
    existingLegacyPaths.length > 0 ||
    existingLegacyBranches.length > 0 ||
    state.worktrees.some((worktree) =>
      observed.paths.some((observedPath) => samePath(observedPath, worktree.canonicalPath)),
    )
  )
    return failure(
      input.mode,
      "legacy-physical-state-present",
      `task ${state.task.taskId} still has legacy physical worktree/branch state; complete it with the pre-cutover workflow or adopt a proven Nawabari session`,
      proof,
    );

  if (input.dryRun === true || state.task.lifecycleState === "cleaned")
    return { ok: true, authority: LEGACY_PHYSICAL_AUTHORITY, mode: input.mode, task: state.task, proof, dryRun: true };
  if (activeOrphan) {
    const transitioned = transitionTask(input.store, state.task.taskId, "abandoned");
    if (!transitioned.ok)
      return failure(input.mode, "lifecycle-transition-blocked", transitioned.blocked.blockingRule, proof);
    return { ok: true, authority: LEGACY_PHYSICAL_AUTHORITY, mode: input.mode, task: transitioned.task, proof };
  }
  const transitioned = transitionTask(input.store, state.task.taskId, "cleaned");
  if (!transitioned.ok)
    return failure(input.mode, "lifecycle-transition-blocked", transitioned.blocked.blockingRule, proof);
  return { ok: true, authority: LEGACY_PHYSICAL_AUTHORITY, mode: input.mode, task: transitioned.task, proof };
}

async function migrateAdopt(input: LegacyMigrationInput, state: LegacyState): Promise<LegacyMigrationResult> {
  const rowFailure = validateRows(state, input.mode);
  if (rowFailure !== undefined) return rowFailure;
  if (input.sessionId === undefined || input.sessionId.length === 0)
    return failure(input.mode, "invalid-input", "adopt requires an explicit Nawabari sessionId", state.proof);
  if (input.nawabari === undefined)
    return failure(input.mode, "nawabari-unavailable", "adopt requires a compatible Nawabari execution boundary", state.proof);
  if (state.activeWorktrees.length !== 1)
    return failure(
      input.mode,
      "legacy-ownership-ambiguous",
      "adopt requires exactly one active legacy worktree row to prove branch and path ownership",
      state.proof,
    );
  const attachedElsewhere = input.store
    .listTasks(state.task.instanceId)
    .find((task) => task.taskId !== state.task.taskId && task.nawabariSessionId === input.sessionId);
  if (attachedElsewhere !== undefined)
    return failure(
      input.mode,
      "nawabari-session-conflict",
      `Nawabari session ${input.sessionId} is already attached to task ${attachedElsewhere.taskId}`,
      state.proof,
    );

  const identity = resolveRepositoryIdentity(input.workspaceRoot);
  if (!identity.ok) return failure(input.mode, "repository-identity-unavailable", identity.reason, state.proof);
  if (identity.identity.instanceId !== state.task.instanceId)
    return failure(
      input.mode,
      "repository-identity-mismatch",
      `workspace repository instance does not match task ${state.task.taskId}`,
      state.proof,
    );
  const worktree = state.activeWorktrees[0]!;
  let session: NawabariSession;
  try {
    session = await input.nawabari.showSession({ cwd: worktree.canonicalPath, sessionId: input.sessionId });
  } catch (error) {
    return failure(
      input.mode,
      "nawabari-identity-mismatch",
      `could not prove Nawabari session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      state.proof,
    );
  }
  if (
    session.sessionId !== input.sessionId ||
    session.state !== "active" ||
    !repositoryMatchesSession(session, identity.identity.canonicalRepositoryRoot, identity.identity.gitCommonDir) ||
    !samePath(session.worktree, worktree.canonicalPath) ||
    session.branch !== worktree.branchName
  )
    return failure(
      input.mode,
      "nawabari-identity-mismatch",
      `Nawabari session ${input.sessionId} does not prove ownership of the legacy branch/worktree`,
      state.proof,
    );

  const proof = updateProof(state.proof, [], [canonicalPath(worktree.canonicalPath)]);
  if (input.dryRun === true)
    return { ok: true, authority: LEGACY_PHYSICAL_AUTHORITY, mode: input.mode, task: state.task, proof, session, dryRun: true };
  let task = input.store.attachNawabariSession(state.task.taskId, input.sessionId as NonNullable<TaskRecord["nawabariSessionId"]>);
  if (task.lifecycleState === "planned" || task.lifecycleState === "orphaned") {
    const transitioned = transitionTask(input.store, task.taskId, "active");
    if (!transitioned.ok)
      return failure(input.mode, "lifecycle-transition-blocked", transitioned.blocked.blockingRule, proof);
    task = transitioned.task;
  }
  return { ok: true, authority: LEGACY_PHYSICAL_AUTHORITY, mode: input.mode, task, proof, session };
}

/**
 * Explicit cutover for one pre-Nawabari task. This function never mutates a
 * legacy worktree, branch, lease, or cleanup row. Complete only accepts
 * independently observed absence; adopt accepts one explicitly named session
 * after Nawabari proves the exact repository/worktree/branch identity.
 */
export async function migrateLegacyWorkflowTask(input: LegacyMigrationInput): Promise<LegacyMigrationResult> {
  if (input.mode !== "complete" && input.mode !== "adopt")
    return failure(input.mode, "invalid-input", "mode must be complete or adopt");
  const task = input.store.getTask(input.taskId);
  if (task === undefined) return failure(input.mode, "task-not-found", `task was not found: ${input.taskId}`);
  if (task.nawabariSessionId !== undefined)
    return failure(input.mode, "task-not-legacy", `task ${task.taskId} already references Nawabari`, undefined);
  const state = physicalRowsForTask(input.store, task);
  state.proof = { ...state.proof, observedAt: input.now?.() ?? Date.now() };
  return input.mode === "complete" ? migrateComplete(input, state) : migrateAdopt(input, state);
}
