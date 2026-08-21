import fs from "node:fs";
import path from "node:path";
import { runGitCommand, type GitCommandFailure } from "../git/context.js";
import { GithubAdapter } from "../providers/github.js";
import type { PullRequestLifecycleState } from "../providers/model.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type {
  CleanupLeaseRecord,
  GuardrailAuditRecord,
  PullRequestRecord,
  TaskId,
  WorkflowStateStore,
} from "../state/store.js";

export const RECONCILIATION_SCHEMA_VERSION = 1;

export const DIVERGENCE_KINDS = [
  "missing-managed-worktree",
  "unregistered-managed-root-worktree",
  "moved-repository",
  "branch-task-mismatch",
  "task-worktree-instance-mismatch",
  "pull-request-instance-mismatch",
  "pull-request-task-mismatch",
  "stale-lock",
  "merged-but-uncleaned-task",
  "cleaned-record-with-surviving-path",
  "provider-state-mismatch",
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

export interface GitWorktreeObservation {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

export interface GitReconciliationSnapshot {
  repositoryRoot: string;
  gitCommonDir: string;
  branch?: string;
  head?: string;
  worktrees: readonly GitWorktreeObservation[];
}

export type GitSnapshotResult =
  | { ok: true; snapshot: GitReconciliationSnapshot }
  | { ok: false; failure: GitCommandFailure };

export interface PullRequestReconciliationObservation {
  ok: boolean;
  lifecycleState: PullRequestLifecycleState | "unknown";
  headSha?: string;
  mergeRevision?: string;
  detail?: string;
}

export type PullRequestObserver = (record: PullRequestRecord) => Promise<PullRequestReconciliationObservation>;

export interface ReconciliationDependencies {
  now?: () => number;
  pathExists?: (targetPath: string) => boolean;
  gitSnapshot?: (workspaceRoot: string) => Promise<GitSnapshotResult>;
  pullRequestObserver?: PullRequestObserver;
  managedWorktreeRoot?: (snapshot: GitReconciliationSnapshot) => string;
}

export interface ReconcileWorkflowInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  repositoryInstanceId?: RepositoryInstanceId;
  dependencies?: ReconciliationDependencies;
}

export type ReconciliationRepairKind = "mark-worktree-removed" | "mark-expired-lock-failed" | "mark-task-cleaned";

export interface ReconciliationRepairAction {
  actionId: string;
  kind: ReconciliationRepairKind;
  targetId: string;
  divergenceId: string;
  requiresConfirmation: true;
  filesystemMutation: false;
  precondition: string;
}

export interface ReconciliationDivergence {
  divergenceId: string;
  kind: DivergenceKind;
  severity: "error";
  instanceId?: string;
  taskId?: string;
  worktreeId?: string;
  detail: string;
  evidence: Readonly<Record<string, string | number | boolean | null>>;
  repairActionId?: string;
}

export interface ReconciliationDiagnostic {
  code: string;
  severity: "warning" | "error";
  detail: string;
}

export interface LegacyPhysicalReconciliationEvidence {
  authority: "nawabari";
  worktreeRows: number;
  cleanupLeaseRows: number;
}

export interface ReconciliationReport {
  schemaVersion: typeof RECONCILIATION_SCHEMA_VERSION;
  mode: "read-only";
  observedAt: number;
  ok: boolean;
  repository: GitReconciliationSnapshot | undefined;
  managedWorktreeRoot: string | undefined;
  legacyPhysical: LegacyPhysicalReconciliationEvidence;
  divergences: readonly ReconciliationDivergence[];
  repairPlan: readonly ReconciliationRepairAction[];
  diagnostics: readonly ReconciliationDiagnostic[];
  auditRecords: readonly GuardrailAuditRecord[];
}

function canonicalPath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function defaultPathExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const resolvedRoot = canonicalPath(root);
  const resolvedCandidate = canonicalPath(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function legacyLeaseIsActive(lease: CleanupLeaseRecord, now: number): boolean {
  return ["reserved", "mutating", "verifying"].includes(lease.state) && lease.expiresAt > now;
}

export function parseGitWorktreeList(output: string): GitWorktreeObservation[] {
  const result: GitWorktreeObservation[] = [];
  let current: GitWorktreeObservation | undefined;
  const push = (): void => {
    if (current !== undefined) result.push(current);
    current = undefined;
  };
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      push();
      current = { path: line.slice("worktree ".length), detached: false, prunable: false };
    } else if (current !== undefined && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (current !== undefined && line.startsWith("branch refs/heads/"))
      current.branch = line.slice("branch refs/heads/".length);
    else if (current !== undefined && line === "detached") current.detached = true;
    else if (current !== undefined && line.startsWith("prunable")) current.prunable = true;
  }
  push();
  return result.map((worktree) => ({ ...worktree, path: canonicalPath(worktree.path) }));
}

export async function readGitReconciliationSnapshot(workspaceRoot: string): Promise<GitSnapshotResult> {
  const [topLevel, commonDir, branch, head, worktrees] = await Promise.all([
    runGitCommand(workspaceRoot, ["rev-parse", "--show-toplevel"]),
    runGitCommand(workspaceRoot, ["rev-parse", "--git-common-dir"]),
    runGitCommand(workspaceRoot, ["symbolic-ref", "-q", "--short", "HEAD"]),
    runGitCommand(workspaceRoot, ["rev-parse", "--verify", "HEAD"]),
    runGitCommand(workspaceRoot, ["worktree", "list", "--porcelain"]),
  ]);
  if (!topLevel.usable || topLevel.result.exitCode !== 0)
    return {
      ok: false,
      failure: {
        code: "git-command-failed",
        operation: "resolve-worktree-root",
        detail: "Git worktree root could not be resolved",
      },
    };
  if (!commonDir.usable || commonDir.result.exitCode !== 0)
    return {
      ok: false,
      failure: {
        code: "git-command-failed",
        operation: "resolve-git-common-dir",
        detail: "Git common directory could not be resolved",
      },
    };
  if (!worktrees.usable || worktrees.result.exitCode !== 0)
    return {
      ok: false,
      failure: {
        code: "git-command-failed",
        operation: "list-worktrees",
        detail: "Git worktree list could not be completed",
      },
    };
  const repositoryRoot = canonicalPath(topLevel.result.stdout.trim());
  const gitCommonDir = canonicalPath(path.resolve(workspaceRoot, commonDir.result.stdout.trim()));
  const worktreeList = parseGitWorktreeList(worktrees.result.stdout);
  return {
    ok: true,
    snapshot: {
      repositoryRoot,
      gitCommonDir,
      ...(branch.usable && branch.result.exitCode === 0 && branch.result.stdout.trim().length > 0
        ? { branch: branch.result.stdout.trim() }
        : {}),
      ...(head.usable && head.result.exitCode === 0 && head.result.stdout.trim().length > 0
        ? { head: head.result.stdout.trim() }
        : {}),
      worktrees: worktreeList,
    },
  };
}

function defaultPullRequestObserver(workspaceRoot: string): PullRequestObserver {
  const adapter = new GithubAdapter({ workspaceRoot });
  return async (record) => {
    if (record.provider !== "github")
      return {
        ok: false,
        lifecycleState: "unknown",
        detail: `provider observation is unavailable: ${record.provider}`,
      };
    const result = await adapter.viewPullRequest(record.prNumber, {
      provider: record.provider,
      id: record.repositoryId,
    });
    if (!result.ok) return { ok: false, lifecycleState: "unknown", detail: result.error.message };
    return {
      ok: true,
      lifecycleState: result.value.lifecycleState,
      headSha: result.value.head.revision,
      ...(result.value.mergeRevision === undefined ? {} : { mergeRevision: result.value.mergeRevision }),
    };
  };
}

function repairId(kind: ReconciliationRepairKind, targetId: string): string {
  return `repair:${kind}:${targetId}`;
}

export async function reconcileWorkflow(input: ReconcileWorkflowInput): Promise<ReconciliationReport> {
  const dependencies = input.dependencies ?? {};
  const observedAt = input.dependencies?.now?.() ?? Date.now();
  const snapshotResult = await (dependencies.gitSnapshot ?? readGitReconciliationSnapshot)(input.workspaceRoot);
  const auditRecords = input.store.listGuardrailAuditRecords();
  if (!snapshotResult.ok) {
    return {
      schemaVersion: RECONCILIATION_SCHEMA_VERSION,
      mode: "read-only",
      observedAt,
      ok: false,
      repository: undefined,
      managedWorktreeRoot: undefined,
      legacyPhysical: { authority: "nawabari", worktreeRows: 0, cleanupLeaseRows: 0 },
      divergences: [],
      repairPlan: [],
      diagnostics: [{ code: snapshotResult.failure.code, severity: "error", detail: snapshotResult.failure.detail }],
      auditRecords,
    };
  }

  const snapshot = snapshotResult.snapshot;
  const diagnostics: ReconciliationDiagnostic[] = [];
  // A Git snapshot describes one repository instance.  Never use every row in the
  // shared workflow store as the implicit scope: doing so can make a task, worktree,
  // or PR from another checkout appear to belong to this repository.
  const selectedInstance =
    input.repositoryInstanceId === undefined
      ? (input.store.getRepositoryInstanceByCommonDir(snapshot.gitCommonDir) ??
        (() => {
          // A single known instance can be reported as moved without ambiguity.
          // With multiple instances and no common-dir match, do not guess which
          // repository the snapshot belongs to.
          const instances = input.store.listRepositoryInstances();
          return instances.length === 1 ? instances[0] : undefined;
        })())
      : input.store.getRepositoryInstance(input.repositoryInstanceId);
  const allInstances = selectedInstance === undefined ? [] : [selectedInstance];
  const instanceIds = new Set(allInstances.map((instance) => instance.instanceId));
  const repositoryScopeMatches =
    selectedInstance !== undefined &&
    selectedInstance.gitCommonDir === snapshot.gitCommonDir &&
    input.store
      .listRepositoryPaths(selectedInstance.instanceId)
      .some((record) => record.isCurrent && canonicalPath(record.canonicalPath) === snapshot.repositoryRoot);
  const isInScope = (instanceId: RepositoryInstanceId): boolean =>
    repositoryScopeMatches && instanceIds.has(instanceId);
  if (allInstances.length === 0) {
    diagnostics.push({
      code: "repository-instance-not-found",
      severity: "error",
      detail:
        input.repositoryInstanceId === undefined
          ? "the current Git repository instance is not registered in workflow state"
          : `repository instance ${input.repositoryInstanceId} is not registered in workflow state`,
    });
  }
  const recordedWorktrees = input.store.listWorktrees().filter((worktree) => isInScope(worktree.instanceId));
  const recordedTasks = input.store.listTasks().filter((task) => isInScope(task.instanceId));
  const recordedLeases = input.store.listCleanupLeases().filter((lease) => isInScope(lease.instanceId));
  const legacyPhysical: LegacyPhysicalReconciliationEvidence = {
    authority: "nawabari",
    worktreeRows: recordedWorktrees.length,
    cleanupLeaseRows: recordedLeases.length,
  };
  if (legacyPhysical.worktreeRows > 0 || legacyPhysical.cleanupLeaseRows > 0) {
    diagnostics.push({
      code: "legacy-physical-state-non-authoritative",
      severity: "warning",
      detail: `observed ${legacyPhysical.worktreeRows} legacy worktree row(s) and ${legacyPhysical.cleanupLeaseRows} legacy cleanup lease row(s); Nawabari remains the sole physical authority`,
    });
  }
  const unscopedPullRequests: Array<{
    taskId: TaskId | undefined;
    instanceId: RepositoryInstanceId | undefined;
    task: ReturnType<WorkflowStateStore["getTask"]>;
  }> = [];
  const recordedPullRequests = input.store.listPullRequestRecords().filter((record) => {
    const task = record.taskId === undefined ? undefined : input.store.getTask(record.taskId);
    if (record.taskId === undefined || task === undefined) {
      if (record.instanceId === undefined || isInScope(record.instanceId))
        unscopedPullRequests.push({ taskId: record.taskId, instanceId: record.instanceId, task });
      return false;
    }
    if (!isInScope(task.instanceId)) return false;
    if (record.instanceId !== undefined && record.instanceId !== task.instanceId) {
      unscopedPullRequests.push({ taskId: record.taskId, instanceId: record.instanceId, task });
      return false;
    }
    // Records belonging to another repository are deliberately ignored.  They must
    // never be observed or used to derive a repair for the current snapshot.
    return true;
  });
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const managedWorktreeRoot =
    dependencies.managedWorktreeRoot?.(snapshot) ?? path.join(snapshot.repositoryRoot, ".mottainai", "worktrees");
  const actualWorktrees = snapshot.worktrees.map((worktree) => ({ ...worktree, path: canonicalPath(worktree.path) }));
  const actualByPath = new Map(actualWorktrees.map((worktree) => [worktree.path, worktree]));
  const divergences: ReconciliationDivergence[] = [];
  const repairPlan: ReconciliationRepairAction[] = [];
  let sequence = 0;

  const addDivergence = (
    kind: DivergenceKind,
    detail: string,
    target: { instanceId?: string; taskId?: string; worktreeId?: string },
    evidence: Readonly<Record<string, string | number | boolean | null>>,
    repair?: Omit<ReconciliationRepairAction, "actionId" | "divergenceId">,
  ): void => {
    const divergenceId = `divergence:${kind}:${sequence++}`;
    const divergence: ReconciliationDivergence = { divergenceId, kind, severity: "error", detail, evidence, ...target };
    // Keep a bounded informational proposal for report compatibility. The
    // executor below is permanently retired and cannot apply it.
    if (repair !== undefined && repositoryScopeMatches) {
      const actionId = repairId(repair.kind, repair.targetId);
      repairPlan.push({ ...repair, actionId, divergenceId });
      divergence.repairActionId = actionId;
    }
    divergences.push(divergence);
  };

  for (const record of unscopedPullRequests) {
    addDivergence(
      record.task === undefined ? "pull-request-task-mismatch" : "pull-request-instance-mismatch",
      record.task === undefined
        ? "pull-request metadata cannot be associated with a task in the current repository instance"
        : "pull-request metadata is associated with a different repository instance than its task",
      { instanceId: record.task?.instanceId, taskId: record.taskId },
      {
        task_present: record.task !== undefined,
        record_instance_present: record.instanceId !== undefined,
        instance_in_scope: record.instanceId === undefined ? null : isInScope(record.instanceId),
      },
    );
  }

  for (const instance of allInstances) {
    const currentPaths = input.store.listRepositoryPaths(instance.instanceId).filter((record) => record.isCurrent);
    const pathMatches = currentPaths.some((record) => canonicalPath(record.canonicalPath) === snapshot.repositoryRoot);
    if (instance.gitCommonDir !== snapshot.gitCommonDir || (currentPaths.length > 0 && !pathMatches)) {
      addDivergence(
        "moved-repository",
        "recorded repository identity does not match the current Git common directory or repository path",
        { instanceId: instance.instanceId },
        {
          recorded_common_dir: instance.gitCommonDir,
          actual_common_dir: snapshot.gitCommonDir,
          actual_repository_root: snapshot.repositoryRoot,
        },
      );
    }
  }

  for (const worktree of recordedWorktrees) {
    const task = input.store.getTask(worktree.taskId);
    const actual = actualByPath.get(canonicalPath(worktree.canonicalPath));
    const live = worktree.status === "active";
    if (task === undefined) {
      addDivergence(
        "branch-task-mismatch",
        "recorded worktree is not associated with its recorded task",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { task_present: task !== undefined, branch: worktree.branchName },
      );
    } else if (task.instanceId !== worktree.instanceId) {
      addDivergence(
        "task-worktree-instance-mismatch",
        "worktree and task belong to different repository instances",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { task_instance_matches: false, task_present: true },
      );
    }
    if (live && actual === undefined) {
      const managedPath = pathIsInside(managedWorktreeRoot, worktree.canonicalPath);
      const pathSurvives = pathExists(worktree.canonicalPath);
      const safeToMarkRemoved = worktree.status === "active" && managedPath && !pathSurvives;
      addDivergence(
        "missing-managed-worktree",
        "recorded live worktree is absent from Git worktree list",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { managed_path: managedPath, path_exists: pathSurvives, status: worktree.status },
        safeToMarkRemoved && task !== undefined && task.instanceId === worktree.instanceId
          ? {
              kind: "mark-worktree-removed",
              targetId: worktree.worktreeId,
              requiresConfirmation: true,
              filesystemMutation: false,
              precondition: "path is absent and Git no longer registers the worktree",
            }
          : undefined,
      );
    } else if (live && actual !== undefined && actual.branch !== worktree.branchName) {
      addDivergence(
        "branch-task-mismatch",
        "Git worktree branch does not match the branch recorded for the task",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        {
          expected_branch: worktree.branchName,
          actual_branch: actual.branch ?? null,
          actual_detached: actual.detached,
        },
      );
    }
    if (
      (worktree.status === "removed" || task?.lifecycleState === "cleaned") &&
      (actual !== undefined || pathExists(worktree.canonicalPath))
    ) {
      addDivergence(
        "cleaned-record-with-surviving-path",
        "cleaned workflow metadata still has a filesystem path or Git worktree",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { path_exists: pathExists(worktree.canonicalPath), git_registered: actual !== undefined },
      );
    }
  }

  // listWorktreesForTask is intentionally a task-keyed lookup.  Inspect every
  // selected task's result as well so a corrupt row that claims the task id but
  // another instance cannot disappear merely because instance-scoped listing hid it.
  for (const task of recordedTasks) {
    for (const worktree of input.store.listWorktreesForTask(task.taskId)) {
      if (worktree.instanceId === task.instanceId) continue;
      addDivergence(
        "task-worktree-instance-mismatch",
        "task and associated worktree do not belong to the same repository instance",
        { instanceId: task.instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId },
        { task_instance_matches: false, task_present: true },
      );
    }
  }

  for (const actual of actualWorktrees.filter((worktree) => pathIsInside(managedWorktreeRoot, worktree.path))) {
    const recorded = recordedWorktrees.find((worktree) => canonicalPath(worktree.canonicalPath) === actual.path);
    if (recorded === undefined) {
      addDivergence(
        "unregistered-managed-root-worktree",
        "Git reports a worktree below the managed root without a workflow record",
        {},
        { path: actual.path, branch: actual.branch ?? "detached" },
      );
    }
  }

  for (const lease of recordedLeases) {
    if (legacyLeaseIsActive(lease, observedAt)) continue;
    if (lease.state === "committed" || lease.state === "failed") continue;
    const leaseTask = input.store.getTask(lease.taskId);
    const leaseWorktree =
      lease.worktreeId === undefined
        ? undefined
        : input.store.listWorktrees().find((candidate) => candidate.worktreeId === lease.worktreeId);
    const leaseIdentityValid =
      leaseTask !== undefined &&
      leaseTask.instanceId === lease.instanceId &&
      (leaseWorktree === undefined ||
        (leaseWorktree.taskId === lease.taskId && leaseWorktree.instanceId === lease.instanceId));
    if (!leaseIdentityValid) {
      addDivergence(
        "task-worktree-instance-mismatch",
        "cleanup lease is not associated with the same repository instance as its task and worktree",
        { instanceId: lease.instanceId, taskId: lease.taskId, worktreeId: lease.worktreeId },
        {
          task_present: leaseTask !== undefined,
          worktree_present: lease.worktreeId === undefined || leaseWorktree !== undefined,
        },
      );
      continue;
    }
    const action: Omit<ReconciliationRepairAction, "actionId" | "divergenceId"> = {
      kind: "mark-expired-lock-failed",
      targetId: lease.operationId,
      requiresConfirmation: true,
      filesystemMutation: false,
      precondition: "lease is still expired and no longer owned by an active cleanup operation",
    };
    addDivergence(
      "stale-lock",
      "cleanup lease is expired while still in an active state",
      { instanceId: lease.instanceId, taskId: lease.taskId, worktreeId: lease.worktreeId },
      { state: lease.state, expires_at: lease.expiresAt },
      action,
    );
  }

  const mergedTaskIds = new Set<TaskId>();
  const providerObservations = new Map<string, PullRequestReconciliationObservation>();
  for (const task of recordedTasks) if (task.lifecycleState === "merged") mergedTaskIds.add(task.taskId);
  const observer = dependencies.pullRequestObserver ?? defaultPullRequestObserver(input.workspaceRoot);
  for (const record of recordedPullRequests) {
    const observed = await observer(record);
    providerObservations.set(record.recordId, observed);
    if (!observed.ok) {
      diagnostics.push({
        code: "provider-observation-unavailable",
        severity: "warning",
        detail:
          observed.detail ??
          `provider state unavailable for ${record.provider}/${record.repositoryId}#${record.prNumber}`,
      });
      continue;
    }
    const headShaMismatch = observed.headSha !== undefined && observed.headSha !== record.headSha;
    if (observed.lifecycleState !== record.lifecycleState || headShaMismatch) {
      const task = record.taskId === undefined ? undefined : input.store.getTask(record.taskId);
      addDivergence(
        "provider-state-mismatch",
        "provider pull-request lifecycle differs from recorded workflow state",
        { instanceId: task?.instanceId, taskId: record.taskId },
        {
          record_id: record.recordId,
          expected_lifecycle: record.lifecycleState,
          actual_lifecycle: observed.lifecycleState,
          ...(observed.headSha === undefined
            ? {}
            : { expected_head_sha: record.headSha, actual_head_sha: observed.headSha }),
        },
      );
    }
    // Never persist merge/integration evidence from a provider observation whose head
    // does not match the task-owned record: a stale or absent head is not authoritative
    // integration evidence, and reconcileNawabariClosures treats a persisted merged
    // record as sufficient to promote the task and request a Nawabari close.
    const observedHeadMatches = observed.headSha === record.headSha;
    if (observed.lifecycleState === "merged" && observedHeadMatches && record.taskId !== undefined)
      mergedTaskIds.add(record.taskId);
    if (observedHeadMatches && observed.mergeRevision !== undefined) {
      try {
        input.store.recordPullRequestMergeRevision(record.recordId, observed.mergeRevision);
      } catch (error) {
        diagnostics.push({
          code: "provider-merge-revision-persistence-failed",
          severity: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (observed.lifecycleState === "merged" && observedHeadMatches && record.lifecycleState !== "merged") {
      try {
        input.store.updatePullRequestLifecycleState(record.recordId, "merged");
      } catch (error) {
        diagnostics.push({
          code: "provider-lifecycle-persistence-failed",
          severity: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  for (const taskId of mergedTaskIds) {
    const task = input.store.getTask(taskId);
    if (task === undefined) continue;
    if (task.lifecycleState === "cleaned") continue;
    const closeState = input.store.getNawabariCloseReconciliation(task.taskId)?.state;
    if (closeState === "closed") continue;
    // A blocked close means Nawabari may still consider the session active;
    // never propose a cleaned-metadata repair while that is unresolved.
    if (closeState === "blocked") continue;
    const worktrees = input.store.listWorktreesForTask(task.taskId);
    const taskPullRequests = recordedPullRequests.filter((record) => record.taskId === task.taskId);
    const providerRepairSafe = taskPullRequests.every((record) => {
      const observed = providerObservations.get(record.recordId);
      return observed?.ok === true && observed.lifecycleState === "merged" && observed.headSha === record.headSha;
    });
    const surviving = worktrees.some(
      (worktree) =>
        worktree.status !== "removed" &&
        (actualByPath.has(canonicalPath(worktree.canonicalPath)) || pathExists(worktree.canonicalPath)),
    );
    const canMarkCleaned =
      providerRepairSafe &&
      !surviving &&
      worktrees.every(
        (worktree) =>
          worktree.instanceId === task.instanceId &&
          worktree.status === "removed" &&
          pathIsInside(managedWorktreeRoot, worktree.canonicalPath) &&
          !actualByPath.has(canonicalPath(worktree.canonicalPath)) &&
          !pathExists(worktree.canonicalPath),
      );
    const action: Omit<ReconciliationRepairAction, "actionId" | "divergenceId"> | undefined =
      canMarkCleaned && task.lifecycleState === "merged"
        ? {
            kind: "mark-task-cleaned",
            targetId: task.taskId,
            requiresConfirmation: true,
            filesystemMutation: false,
            precondition:
              "provider/task is merged and every associated worktree is already absent and removed in metadata",
          }
        : undefined;
    addDivergence(
      "merged-but-uncleaned-task",
      "provider or recorded task state is merged but task cleanup is incomplete",
      { instanceId: task.instanceId, taskId: task.taskId },
      { lifecycle_state: task.lifecycleState, surviving_path: surviving },
      action,
    );
  }

  return {
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    mode: "read-only",
    observedAt,
    ok: divergences.length === 0 && diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    repository: snapshot,
    managedWorktreeRoot,
    legacyPhysical,
    divergences,
    repairPlan,
    diagnostics,
    auditRecords,
  };
}

export interface ExecuteReconciliationRepairsInput {
  store: WorkflowStateStore;
  report: ReconciliationReport;
  confirm?: boolean;
  /** Omitted action IDs are rejected; a confirmed repair must name its actions explicitly. */
  actionIds?: readonly string[];
  /** Workspace used for the live re-observation. Defaults to the report root. */
  workspaceRoot?: string;
  repositoryInstanceId?: RepositoryInstanceId;
  dependencies?: ReconciliationDependencies;
  reconcile?: (input: ReconcileWorkflowInput) => Promise<ReconciliationReport>;
  now?: () => number;
  pathExists?: (targetPath: string) => boolean;
}

export interface ExecuteReconciliationRepairsResult {
  ok: boolean;
  reason?: "confirmation-required" | "unknown-action" | "precondition-failed" | "legacy-authority-retired";
  applied: readonly string[];
  blocked: readonly string[];
}

export async function executeReconciliationRepairs(
  input: ExecuteReconciliationRepairsInput,
): Promise<ExecuteReconciliationRepairsResult> {
  // Reconciliation is intentionally read-only after the Nawabari cutover.
  // Physical worktree, lease, and cleanup state is not Mottainai authority;
  // callers must use Nawabari or the explicit legacy migration command.
  if (input.actionIds === undefined) return { ok: false, reason: "precondition-failed", applied: [], blocked: [] };
  if (input.confirm !== true)
    return { ok: false, reason: "confirmation-required", applied: [], blocked: input.actionIds };
  return {
    ok: false,
    reason: "legacy-authority-retired",
    applied: [],
    blocked: input.actionIds === undefined ? [] : [...input.actionIds],
  };
}
