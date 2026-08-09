import fs from "node:fs";
import path from "node:path";
import { runGitCommand, type GitCommandFailure } from "../git/context.js";
import { GithubAdapter } from "../providers/github.js";
import type { PullRequestLifecycleState } from "../providers/model.js";
import { isLeaseActive } from "../domain/lease.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type {
  GuardrailAuditRecord,
  TaskId,
  WorkflowStateStore,
} from "../state/store.js";

export const RECONCILIATION_SCHEMA_VERSION = 1;

export const DIVERGENCE_KINDS = [
  "missing-managed-worktree",
  "unregistered-managed-root-worktree",
  "moved-repository",
  "branch-task-mismatch",
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
  detail?: string;
}

export type PullRequestObserver = (
  record: Awaited<ReturnType<WorkflowStateStore["listPullRequestRecords"]>>[number],
) => Promise<PullRequestReconciliationObservation>;

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
  severity: "warning" | "error";
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

export interface ReconciliationReport {
  schemaVersion: typeof RECONCILIATION_SCHEMA_VERSION;
  mode: "read-only";
  observedAt: number;
  ok: boolean;
  repository: GitReconciliationSnapshot | undefined;
  managedWorktreeRoot: string | undefined;
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
    return { ok: true, lifecycleState: result.value.lifecycleState, headSha: result.value.head.revision };
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
      divergences: [],
      repairPlan: [],
      diagnostics: [{ code: snapshotResult.failure.code, severity: "error", detail: snapshotResult.failure.detail }],
      auditRecords,
    };
  }

  const snapshot = snapshotResult.snapshot;
  const diagnostics: ReconciliationDiagnostic[] = [];
  const allInstances =
    input.repositoryInstanceId === undefined
      ? input.store.listRepositoryInstances()
      : [input.store.getRepositoryInstance(input.repositoryInstanceId)].filter(
          (value): value is NonNullable<typeof value> => value !== undefined,
        );
  const instanceIds = new Set(allInstances.map((instance) => instance.instanceId));
  const isInScope = (instanceId: RepositoryInstanceId): boolean =>
    input.repositoryInstanceId === undefined || instanceIds.has(instanceId);
  if (input.repositoryInstanceId !== undefined && allInstances.length === 0) {
    diagnostics.push({
      code: "repository-instance-not-found",
      severity: "error",
      detail: `repository instance ${input.repositoryInstanceId} is not registered in workflow state`,
    });
  }
  const recordedWorktrees = input.store
    .listWorktrees()
    .filter((worktree) => isInScope(worktree.instanceId));
  const recordedTasks = input.store
    .listTasks()
    .filter((task) => isInScope(task.instanceId));
  const recordedLeases = input.store
    .listCleanupLeases()
    .filter((lease) => isInScope(lease.instanceId));
  const recordedPullRequests = input.store
    .listPullRequestRecords()
    .filter((record) => record.taskId === undefined || recordedTasks.some((task) => task.taskId === record.taskId));
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
    if (repair !== undefined) {
      const actionId = repairId(repair.kind, repair.targetId);
      repairPlan.push({ ...repair, actionId, divergenceId });
      divergence.repairActionId = actionId;
    }
    divergences.push(divergence);
  };

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
    const live = worktree.status !== "removed";
    if (task === undefined || task.instanceId !== worktree.instanceId) {
      addDivergence(
        "branch-task-mismatch",
        "recorded worktree is not associated with its recorded task",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { task_present: task !== undefined, branch: worktree.branchName },
      );
    }
    if (live && actual === undefined) {
      const safeToMarkRemoved = !pathExists(worktree.canonicalPath);
      addDivergence(
        "missing-managed-worktree",
        "recorded live worktree is absent from Git worktree list",
        { instanceId: worktree.instanceId, taskId: worktree.taskId, worktreeId: worktree.worktreeId },
        { recorded_path: worktree.canonicalPath, path_exists: !safeToMarkRemoved },
        safeToMarkRemoved
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
        { expected_branch: worktree.branchName, actual_branch: actual.branch ?? null, actual_detached: actual.detached },
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

  for (const actual of actualWorktrees.filter((worktree) => pathIsInside(managedWorktreeRoot, worktree.path))) {
    const recorded = recordedWorktrees.find((worktree) => canonicalPath(worktree.canonicalPath) === actual.path);
    if (recorded === undefined) {
      addDivergence(
        "unregistered-managed-root-worktree",
        "Git reports a worktree below the managed root without a live workflow record",
        {},
        { path: actual.path, branch: actual.branch ?? "detached" },
      );
    }
  }

  for (const lease of recordedLeases) {
    if (isLeaseActive(lease, observedAt)) continue;
    if (lease.state === "committed" || lease.state === "failed") continue;
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
  for (const task of recordedTasks) if (task.lifecycleState === "merged") mergedTaskIds.add(task.taskId);
  const observer = dependencies.pullRequestObserver ?? defaultPullRequestObserver(input.workspaceRoot);
  for (const record of recordedPullRequests) {
    const observed = await observer(record);
    if (!observed.ok) {
      diagnostics.push({
        code: "provider-observation-unavailable",
        severity: "error",
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
          ...(observed.headSha === undefined ? {} : { expected_head_sha: record.headSha, actual_head_sha: observed.headSha }),
        },
      );
    }
    if (observed.lifecycleState === "merged" && record.taskId !== undefined) mergedTaskIds.add(record.taskId);
  }
  for (const taskId of mergedTaskIds) {
    const task = input.store.getTask(taskId);
    if (task === undefined) continue;
    if (task.lifecycleState === "cleaned") continue;
    const worktrees = input.store.listWorktreesForTask(task.taskId);
    const surviving = worktrees.some(
      (worktree) =>
        worktree.status !== "removed" &&
        (actualByPath.has(canonicalPath(worktree.canonicalPath)) || pathExists(worktree.canonicalPath)),
    );
    const canMarkCleaned = !surviving && worktrees.every((worktree) => worktree.status === "removed");
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
  actionIds?: readonly string[];
  now?: () => number;
  pathExists?: (targetPath: string) => boolean;
}

export interface ExecuteReconciliationRepairsResult {
  ok: boolean;
  reason?: "confirmation-required" | "unknown-action" | "precondition-failed";
  applied: readonly string[];
  blocked: readonly string[];
}

export function executeReconciliationRepairs(
  input: ExecuteReconciliationRepairsInput,
): ExecuteReconciliationRepairsResult {
  if (input.confirm !== true)
    return { ok: false, reason: "confirmation-required", applied: [], blocked: input.actionIds ?? [] };
  const selected = input.actionIds === undefined ? [] : [...input.actionIds];
  const actions = new Map(input.report.repairPlan.map((action) => [action.actionId, action]));
  const pathExists = input.pathExists ?? defaultPathExists;
  const applied: string[] = [];
  const blocked: string[] = [];
  for (const actionId of selected) {
    const action = actions.get(actionId);
    if (action === undefined) {
      blocked.push(actionId);
      continue;
    }
    if (action.kind === "mark-worktree-removed") {
      const worktree = input.store.listWorktrees().find((candidate) => candidate.worktreeId === action.targetId);
      const actual = input.report.repository?.worktrees.some(
        (candidate) => canonicalPath(candidate.path) === canonicalPath(worktree?.canonicalPath ?? ""),
      );
      if (worktree === undefined || pathExists(worktree.canonicalPath) || actual) {
        blocked.push(actionId);
        continue;
      }
      input.store.markWorktreeRemoved(worktree.worktreeId, input.now?.() ?? Date.now());
      applied.push(actionId);
    } else if (action.kind === "mark-expired-lock-failed") {
      const lease = input.store.getCleanupLease(action.targetId);
      const now = input.now?.() ?? Date.now();
      if (lease === undefined || isLeaseActive(lease, now) || lease.state === "committed" || lease.state === "failed") {
        blocked.push(actionId);
        continue;
      }
      input.store.markCleanupLease({
        operationId: lease.operationId,
        state: "failed",
        expectedState: lease.state,
        lastError: "expired cleanup lease recorded by explicit reconciliation repair",
        updatedAt: now,
      });
      applied.push(actionId);
    } else {
      const task = input.store.getTask(action.targetId as TaskId);
      if (
        task === undefined ||
        task.lifecycleState === "cleaned" ||
        task.lifecycleState !== "merged" ||
        input.store
          .listWorktreesForTask(task.taskId)
          .some((worktree) => worktree.status !== "removed" || pathExists(worktree.canonicalPath))
      ) {
        blocked.push(actionId);
        continue;
      }
      input.store.updateTaskLifecycleState(task.taskId, "cleaned", input.now?.() ?? Date.now());
      applied.push(actionId);
    }
  }
  return {
    ok: blocked.length === 0,
    applied,
    blocked,
    ...(blocked.length > 0 ? { reason: "precondition-failed" as const } : {}),
  };
}

export const reconcile = reconcileWorkflow;
