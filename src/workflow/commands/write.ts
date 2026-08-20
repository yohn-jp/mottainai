import fs from "node:fs";
import path from "node:path";
import { type PullRequestBodyDraft } from "../domain/pr-intent.js";
import type { CleanupPlan } from "../domain/cleanup-plan.js";
import {
  renderCommitMessage,
  verifyCommit,
  type CommitOperationInput,
  type StructuredCommitMessage,
} from "../git/commit.js";
import {
  isPathInsideWorkspace,
  runGitCommand,
  verifyWorkflowContext,
  type WorkflowContextInput,
} from "../git/context.js";
import { validateBranchNameSyntax } from "../git/branch.js";
import { verifyPush, type PushOperationInput } from "../git/push.js";
import { resolveRepositoryIdentity, type RepositoryInstanceId } from "../domain/identity.js";
import {
  getTaskStatusForWorkspace,
  transitionTaskForWorkspace,
  type WorkflowPullRequestObserver,
  type WorkspaceTaskTransitionResult,
} from "../domain/task.js";
import type { RepositoryIdentity, RevisionIdentity } from "../providers/model.js";
import { GhInariPullRequestAdapter } from "../providers/gh-inari.js";
import {
  GithubAdapter,
  openWorkflowPullRequest,
  type GithubFailure,
  type PullRequestCreateAdapter,
} from "../providers/github.js";
import { type GhInariClient } from "../../gh-inari.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import { closeNawabariExecution } from "../domain/nawabari-close.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type {
  CommitReconciliationRecord,
  NawabariSessionId,
  PushReconciliationRecord,
  TaskId,
  TaskRecord,
  WorktreeId,
  WorkflowStateStore,
} from "../state/store.js";
import {
  NawabariExecutionError,
  type NawabariCommandResult,
  type NawabariExecutionClient,
  type NawabariSession,
} from "../nawabari.js";
import type { ExecutionClaim } from "../../semantics/execution-plan.js";

export interface WorkflowWriteDependencies {
  githubAdapter?: GithubAdapter;
  /** Test/embedder seam for the production Inari-backed create adapter. */
  pullRequestAdapter?: PullRequestCreateAdapter;
  /** Explicit companion seam; production defaults to the bounded gh-inari client. */
  ghInariClient?: GhInariClient;
  /** Required by production managed mutation paths after the authority cutover. */
  nawabari?: NawabariExecutionClient;
}

export interface WorkflowTaskSelector {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId?: string;
  nawabari?: NawabariExecutionClient;
}

export interface ResolvedWorkflowTask {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  worktreeId: WorktreeId | undefined;
  expectedBranch: string | undefined;
  executionWorkspaceRoot?: string;
  nawabariSessionId?: NawabariSessionId;
}

type WorkspaceNawabariAuthority =
  | { kind: "none" }
  | { kind: "owned"; task: TaskRecord; session: NawabariSession }
  | { kind: "ambiguous"; detail: string };

export type WorkflowWriteFailure = {
  ok: false;
  reason: string;
  detail: string;
  provider?: GithubFailure;
  providerCreated?: boolean;
  shadow?: ShadowComparison;
  /** Available when an external commit may already exist. */
  commitId?: string;
  recovery?: CommitRecoveryDiagnostic;
};

export interface ShadowComparison {
  legacyDecision: "allow" | "deny" | "unavailable";
  nawabariDecision: "allow" | "deny" | "unavailable";
  agreement: boolean;
}

const ALL_NAWABARI_RESOURCES = ["**"] as const;
const LEGACY_SHADOW_TIMEOUT_MS = 1_000;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CommitRecoveryDiagnostic {
  taskId: TaskId;
  state: CommitReconciliationRecord["state"];
  beforeCommit: string;
  commitSha?: string;
  currentHead?: string;
  detail?: string;
}

export type WorkflowWriteResult<T extends object = Record<string, unknown>> =
  | ({ ok: true } & T)
  | (WorkflowWriteFailure & Partial<T>);

function failure(reason: string, detail: string): WorkflowWriteFailure {
  return { ok: false, reason, detail };
}

function nonEmpty(value: unknown, field: string): string | WorkflowWriteFailure {
  if (typeof value !== "string" || value.trim().length === 0)
    return failure("invalid-input", `${field} must be a non-empty string`);
  return value;
}

function boundedLegacyDecision(verification: Promise<{ ok: boolean }>): Promise<ShadowComparison["legacyDecision"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shadow = verification.then((result) => (result.ok ? "allow" : "deny")).catch(() => "unavailable" as const);
  const timeout = new Promise<ShadowComparison["legacyDecision"]>((resolve) => {
    timer = setTimeout(() => resolve("unavailable"), LEGACY_SHADOW_TIMEOUT_MS);
  });
  return Promise.race([shadow, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function shadowDecisionsAgree(
  legacyDecision: ShadowComparison["legacyDecision"],
  nawabariDecision: ShadowComparison["nawabariDecision"],
): boolean {
  return legacyDecision !== "unavailable" && nawabariDecision !== "unavailable" && legacyDecision === nawabariDecision;
}

function canonicalOrResolved(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalOrResolved(left) === canonicalOrResolved(right);
}

function evidenceString(evidence: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    if (typeof evidence[field] === "string" && (evidence[field] as string).length > 0) return evidence[field] as string;
  }
  return undefined;
}

function commitResultSha(result: Record<string, unknown>): string | undefined {
  return evidenceString(result, ["commitSha", "commit_sha"]);
}

function recoveryDiagnostic(
  record: CommitReconciliationRecord,
  overrides: Partial<Pick<CommitRecoveryDiagnostic, "state" | "commitSha" | "currentHead" | "detail">> = {},
): CommitRecoveryDiagnostic {
  return {
    taskId: record.taskId,
    state: overrides.state ?? record.state,
    beforeCommit: record.beforeCommit,
    ...((overrides.commitSha ?? record.commitSha) ? { commitSha: overrides.commitSha ?? record.commitSha } : {}),
    ...(overrides.currentHead === undefined ? {} : { currentHead: overrides.currentHead }),
    ...((overrides.detail ?? record.detail) ? { detail: overrides.detail ?? record.detail } : {}),
  };
}

function commitRecoveryFailure(
  reason: string,
  detail: string,
  record: CommitReconciliationRecord,
  overrides: Partial<Pick<CommitRecoveryDiagnostic, "state" | "commitSha" | "currentHead" | "detail">> = {},
): WorkflowWriteFailure {
  const diagnostic = recoveryDiagnostic(record, { ...overrides, detail: overrides.detail ?? detail });
  return {
    ...failure(reason, detail),
    ...(diagnostic.commitSha === undefined ? {} : { commitId: diagnostic.commitSha }),
    recovery: diagnostic,
  };
}

type CommitBoundaryObservation =
  | { ok: true; evidence: Record<string, unknown>; head: string }
  | { ok: false; reason: string; detail: string; currentHead?: string };

async function observeCommitBoundary(
  input: CommitWorkflowInput,
  selected: ResolvedWorkflowTask,
  record: CommitReconciliationRecord,
): Promise<CommitBoundaryObservation> {
  if (input.nawabari === undefined)
    return { ok: false, reason: "nawabari-unavailable", detail: "Nawabari is required for commit reconciliation" };

  let session;
  try {
    session = await input.nawabari.showSession({ cwd: input.workspaceRoot, sessionId: record.nawabariSessionId });
  } catch (error) {
    return {
      ok: false,
      reason: "commit-reconciliation-unavailable",
      detail: `could not observe the Nawabari commit boundary: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const repository = input.store.getRepositoryInstance(selected.instanceId);
  if (repository === undefined)
    return {
      ok: false,
      reason: "repository-instance-not-found",
      detail: "repository identity is not available for commit reconciliation",
    };
  const repositoryMatches =
    samePath(session.repository, repository.gitCommonDir) ||
    (path.basename(repository.gitCommonDir) === ".git" &&
      samePath(session.repository, path.dirname(repository.gitCommonDir)));
  if (!repositoryMatches)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari commit session repository does not match the recorded repository instance",
    };
  if (session.sessionId !== record.nawabariSessionId)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari commit session identity changed during recovery",
    };
  if (session.branch !== record.branchName)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari commit session branch does not match the recorded branch",
    };
  const executionWorkspaceRoot = selected.executionWorkspaceRoot ?? input.workspaceRoot;
  if (!samePhysicalWorktree(session.worktree, executionWorkspaceRoot))
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari commit session worktree does not match the selected execution workspace",
    };

  if (record.resources.length === 0)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "commit receipt does not contain the intended resource boundary",
    };

  let authorization: Record<string, unknown>;
  try {
    authorization = await input.nawabari.authorize({
      cwd: session.worktree,
      sessionId: record.nawabariSessionId,
      operation: "commit",
      resources: record.resources,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "commit-reconciliation-unavailable",
      detail: `could not revalidate the Nawabari commit resource boundary: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const authorizationSession = evidenceString(authorization, ["sessionId", "session_id"]);
  if (authorizationSession !== undefined && authorizationSession !== record.nawabariSessionId)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari commit authorization session identity does not match the commit receipt",
    };
  if (authorization.allowed !== true)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari no longer authorizes the persisted commit resource boundary",
    };

  let evidence: Record<string, unknown>;
  try {
    evidence = await input.nawabari.checkpoint({ cwd: session.worktree, sessionId: record.nawabariSessionId });
  } catch (error) {
    return {
      ok: false,
      reason: "commit-reconciliation-unavailable",
      detail: `could not observe the Nawabari commit checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const head = evidenceString(evidence, ["headId", "head_id", "head"]);
  const evidenceSession = evidenceString(evidence, ["sessionId", "session_id"]);
  if (head === undefined || evidenceSession === undefined)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari checkpoint omitted commit or session identity",
    };
  if (evidenceSession !== record.nawabariSessionId)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari checkpoint session identity does not match the commit receipt",
    };
  const evidenceRepository = evidenceString(evidence, ["repositoryId", "repository_id"]);
  if (evidenceRepository !== undefined && !samePath(evidenceRepository, repository.gitCommonDir))
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari checkpoint repository identity does not match the recorded repository instance",
    };
  const evidenceWorktree = evidenceString(evidence, ["worktreePath", "worktree_path"]);
  if (evidenceWorktree !== undefined && !samePath(evidenceWorktree, session.worktree))
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari checkpoint worktree identity does not match the observed execution workspace",
    };
  const evidenceBranch = evidenceString(evidence, ["branchName", "branch_name"]);
  if (evidenceBranch !== undefined && evidenceBranch !== record.branchName)
    return {
      ok: false,
      reason: "commit-result-ambiguous",
      detail: "Nawabari checkpoint branch identity does not match the commit receipt",
    };
  return { ok: true, evidence, head };
}

function reconcileCheckpoint(
  store: WorkflowStateStore,
  instanceId: RepositoryInstanceId,
  branch: string | undefined,
  evidence: Record<string, unknown>,
): void {
  // Nawabari's v1 evidence identity is `headId` (the session identity uses
  // snake_case, while governed Git results use the contract's camelCase
  // fields). Keep this reconciliation limited to the Git-observable head;
  // path/evidence meaning remains a Mottainai concern.
  const head = evidence.headId ?? evidence.head_id ?? evidence.head;
  if (typeof head !== "string" || branch === undefined) return;
  store.recordHookCheckpoint({ instanceId, branch, commit: head });
}

function shadowFailure(
  error: unknown,
  legacyDecision: ShadowComparison["legacyDecision"] = "unavailable",
): ShadowComparison {
  const nawabariDecision =
    error instanceof NawabariExecutionError && error.code === "nawabari-rejected" ? "deny" : "unavailable";
  return { legacyDecision, nawabariDecision, agreement: false };
}

function samePhysicalWorktree(left: string, right: string): boolean {
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/** Resolve task ownership from Nawabari's persisted session/worktree attachment. */
async function resolveNawabariAuthority(input: WorkflowTaskSelector): Promise<WorkspaceNawabariAuthority> {
  if (input.nawabari === undefined) return { kind: "none" };

  const identity = resolveRepositoryIdentity(input.workspaceRoot);
  if (!identity.ok) return { kind: "ambiguous", detail: identity.reason };

  let sessionId: string;
  try {
    sessionId = await input.nawabari.currentSessionId(input.workspaceRoot);
  } catch (error) {
    // A primary checkout or an unmanaged worktree has no current Nawabari
    // session; callers may still use the established legacy/explicit path.
    if (
      error instanceof NawabariExecutionError &&
      (error.nawabariCode === "NO_SESSION" || error.nawabariCode === "NO_CURRENT_SESSION")
    )
      return { kind: "none" };
    return {
      kind: "ambiguous",
      detail: `could not resolve the current Nawabari session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const attached = input.store.listTasks().filter((task) => task.nawabariSessionId === sessionId);
  if (attached.length !== 1)
    return {
      kind: "ambiguous",
      detail: `Nawabari session ${sessionId} is not attached to exactly one managed task`,
    };
  const task = attached[0]!;
  if (task.instanceId !== identity.identity.instanceId)
    return {
      kind: "ambiguous",
      detail: `Nawabari session ${sessionId} belongs to a foreign repository instance`,
    };

  let session: NawabariSession;
  try {
    session = await input.nawabari.showSession({ cwd: input.workspaceRoot, sessionId });
  } catch (error) {
    return {
      kind: "ambiguous",
      detail: `could not verify Nawabari session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (session.sessionId !== sessionId)
    return { kind: "ambiguous", detail: `Nawabari session identity changed while resolving ${sessionId}` };
  if (session.state !== "active")
    return { kind: "ambiguous", detail: `Nawabari session ${sessionId} is ${session.state}, not active` };
  if (!samePhysicalWorktree(session.worktree, identity.identity.worktreePath))
    return {
      kind: "ambiguous",
      detail: `Nawabari session ${sessionId} worktree does not match the current physical worktree`,
    };
  return { kind: "owned", task, session };
}

function explicitTaskAuthorityFailure(
  authority: WorkspaceNawabariAuthority,
  taskId: TaskId,
): WorkflowWriteFailure | undefined {
  if (authority.kind === "ambiguous") return failure("task-identity-ambiguous", authority.detail);
  if (authority.kind === "owned" && authority.task.taskId !== taskId)
    return failure(
      "task-identity-ambiguous",
      `explicit task ${taskId} conflicts with the current Nawabari-owned task ${authority.task.taskId}`,
    );
  return undefined;
}

/** Resolve an omitted task only from authoritative Nawabari evidence when present. */
export async function resolveWorkflowTask(
  input: WorkflowTaskSelector,
): Promise<WorkflowWriteResult<ResolvedWorkflowTask>> {
  if (input.taskId !== undefined) {
    const taskIdValue = nonEmpty(input.taskId, "taskId");
    if (typeof taskIdValue !== "string") return taskIdValue;
    const task = input.store.getTask(taskIdValue as TaskId);
    if (task === undefined) return failure("task-not-found", `task was not found: ${taskIdValue}`);
    const authority = await resolveNawabariAuthority(input);
    const authorityFailure = explicitTaskAuthorityFailure(authority, task.taskId);
    if (authorityFailure !== undefined) return authorityFailure;
    return taskContext(input, task, authority.kind === "owned" ? authority.session : undefined);
  }

  const authority = await resolveNawabariAuthority(input);
  if (authority.kind === "ambiguous") return failure("task-identity-ambiguous", authority.detail);
  if (authority.kind === "owned") return taskContext(input, authority.task, authority.session);

  const located = await getTaskStatusForWorkspace(input.workspaceRoot, input.store);
  if (!located.ok) return failure("repository-identity-unavailable", located.reason);
  if (!located.active)
    return failure("task-identity-ambiguous", "no active workflow task is associated with the current worktree");
  return taskContext(input, located.status.task);
}

async function taskContext(
  input: WorkflowTaskSelector,
  task: { taskId: TaskId; instanceId: RepositoryInstanceId },
  authoritativeSession?: NawabariSession,
): Promise<WorkflowWriteResult<ResolvedWorkflowTask>> {
  const storedTask = input.store.getTask(task.taskId);
  if (storedTask === undefined) return failure("task-not-found", `task was not found: ${task.taskId}`);
  if (storedTask.nawabariSessionId !== undefined) {
    if (input.nawabari === undefined)
      return failure(
        "nawabari-unavailable",
        "managed task references Nawabari but no compatible execution boundary was supplied",
      );
    try {
      const session =
        authoritativeSession ??
        (await input.nawabari.showSession({
          cwd: input.workspaceRoot,
          sessionId: storedTask.nawabariSessionId,
        }));
      if (session.sessionId !== storedTask.nawabariSessionId)
        return failure("task-identity-ambiguous", `task ${task.taskId} is attached to a different Nawabari session`);
      if (session.state !== "active")
        return failure(
          "task-identity-ambiguous",
          `Nawabari session ${session.sessionId} is ${session.state}, not active`,
        );
      return {
        ok: true,
        taskId: task.taskId,
        instanceId: task.instanceId,
        worktreeId: undefined,
        expectedBranch: session.branch,
        executionWorkspaceRoot: session.worktree,
        nawabariSessionId: session.sessionId as NawabariSessionId,
      };
    } catch (error) {
      const code = error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed";
      return failure(code, error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ok: false,
    reason: "legacy-task-adoption-required",
    detail: `task ${task.taskId} has no Nawabari session reference; adopt it before mutation`,
  };
}

function contextInput(
  input: WorkflowTaskSelector,
  task: ResolvedWorkflowTask,
  allowedLifecycleStates?: WorkflowContextInput["allowedLifecycleStates"],
): WorkflowContextInput {
  return {
    workspaceRoot: task.executionWorkspaceRoot ?? input.workspaceRoot,
    store: input.store,
    taskId: task.taskId,
    repositoryInstanceId: task.instanceId,
    worktreeId: task.worktreeId,
    expectedBranch: task.expectedBranch,
    ...(allowedLifecycleStates === undefined ? {} : { allowedLifecycleStates }),
  };
}

async function observeNawabariCheckpoint(input: {
  nawabari: NawabariExecutionClient;
  cwd: string;
  sessionId: NawabariSessionId;
}): Promise<{ ok: true; evidence: Record<string, unknown>; head: string } | WorkflowWriteFailure> {
  let evidence: Record<string, unknown>;
  try {
    evidence = await input.nawabari.checkpoint({ cwd: input.cwd, sessionId: input.sessionId });
  } catch (error) {
    return failure(
      error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
      `could not observe the Nawabari checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sessionId = evidenceString(evidence, ["sessionId", "session_id"]);
  if (sessionId !== input.sessionId)
    return failure("task-identity-ambiguous", "Nawabari checkpoint session identity does not match the task");
  const head = evidenceString(evidence, ["headId", "head_id", "head"]);
  if (head === undefined) return failure("nawabari-contract-invalid", "Nawabari checkpoint omitted the HEAD identity");
  return { ok: true, evidence, head };
}

function checkpointResources(evidence: Record<string, unknown>): readonly string[] {
  const paths = evidence.paths;
  if (typeof paths === "object" && paths !== null && "changed" in paths && Array.isArray(paths.changed)) {
    const changed = paths.changed.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (changed.length > 0) return changed;
  }
  return ALL_NAWABARI_RESOURCES;
}

interface ReconcileKnownCommitOptions {
  nawabariResult?: Record<string, unknown>;
  shadow?: ShadowComparison;
  recovered: boolean;
}

async function reconcileKnownCommit(
  input: CommitWorkflowInput,
  selected: ResolvedWorkflowTask,
  record: CommitReconciliationRecord,
  options: ReconcileKnownCommitOptions,
): Promise<WorkflowWriteResult> {
  if (record.commitSha === undefined)
    return commitRecoveryFailure(
      "commit-result-ambiguous",
      "commit receipt has no successful result identity",
      record,
      {
        state: "ambiguous",
      },
    );

  const observed = await observeCommitBoundary(input, selected, record);
  if (!observed.ok) {
    if (observed.reason === "commit-result-ambiguous") {
      try {
        input.store.markCommitReconciliationAmbiguous(selected.taskId, observed.detail);
      } catch {
        // Preserve the primary fail-closed diagnostic when the diagnostic write itself fails.
      }
      return commitRecoveryFailure(observed.reason, observed.detail, record, { state: "ambiguous" });
    }
    return commitRecoveryFailure(observed.reason, observed.detail, record, {
      ...(observed.currentHead === undefined ? {} : { currentHead: observed.currentHead }),
    });
  }
  if (observed.head !== record.commitSha) {
    const detail = `observed HEAD ${observed.head} does not match Nawabari commit result ${record.commitSha}`;
    try {
      input.store.markCommitReconciliationAmbiguous(selected.taskId, detail);
    } catch {
      // The returned diagnostic still carries the immutable result SHA.
    }
    return commitRecoveryFailure("commit-result-ambiguous", detail, record, {
      state: "ambiguous",
      currentHead: observed.head,
    });
  }

  try {
    input.store.recordHookCheckpoint({
      instanceId: selected.instanceId,
      branch: record.branchName,
      commit: record.commitSha,
    });
  } catch (error) {
    return commitRecoveryFailure(
      "commit-checkpoint-persistence-failed",
      `commit result is known but checkpoint reconciliation could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      record,
      { currentHead: observed.head },
    );
  }

  let transitioned: WorkspaceTaskTransitionResult;
  try {
    transitioned = await transitionTaskForWorkspace({
      ...contextInput(input, selected, ["active", "committed"]),
      expectedBranch: record.branchName,
      policy: input.policy,
      to: "committed",
      allowIdempotentTerminalState: true,
    });
  } catch (error) {
    return commitRecoveryFailure(
      "commit-lifecycle-persistence-failed",
      `commit result is known but task lifecycle reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      record,
      { currentHead: observed.head },
    );
  }
  if (!transitioned.ok)
    return commitRecoveryFailure("commit-lifecycle-reconciliation-failed", transitioned.detail, record, {
      currentHead: observed.head,
    });

  let reconciled: CommitReconciliationRecord;
  try {
    reconciled = input.store.markCommitReconciliationReconciled(selected.taskId);
  } catch (error) {
    return commitRecoveryFailure(
      "commit-reconciliation-persistence-failed",
      `task lifecycle is committed but commit reconciliation could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
      record,
      { currentHead: observed.head },
    );
  }
  return {
    ok: true,
    task: transitioned.task,
    taskId: selected.taskId,
    commit: {
      ok: true,
      commitId: record.commitSha,
      message: record.message,
      executionEvidence: observed.evidence,
      ...(options.nawabariResult === undefined ? {} : { nawabari: options.nawabariResult }),
      shadow: options.shadow ?? { legacyDecision: "unavailable", nawabariDecision: "allow", agreement: false },
      recovered: options.recovered,
      reconciliationState: reconciled.state,
    },
  };
}

type ExistingCommitResolution =
  | { kind: "retry"; record: CommitReconciliationRecord }
  | { kind: "result"; result: WorkflowWriteResult };

async function resolveExistingCommit(
  input: CommitWorkflowInput,
  selected: ResolvedWorkflowTask,
  record: CommitReconciliationRecord,
): Promise<ExistingCommitResolution> {
  if (record.state === "ambiguous")
    return {
      kind: "result",
      result: commitRecoveryFailure(
        "commit-result-ambiguous",
        record.detail ?? "commit result cannot be proven from the persisted reconciliation receipt",
        record,
      ),
    };
  if (record.state === "succeeded" || record.state === "reconciled")
    return {
      kind: "result",
      result: await reconcileKnownCommit(input, selected, record, { recovered: true }),
    };

  const observed = await observeCommitBoundary(input, selected, record);
  if (!observed.ok) {
    try {
      input.store.markCommitReconciliationAmbiguous(selected.taskId, observed.detail);
    } catch {
      // Keep the fail-closed result even if the ambiguity marker cannot be written.
    }
    return {
      kind: "result",
      result: commitRecoveryFailure(observed.reason, observed.detail, record, {
        state: "ambiguous",
        ...(observed.currentHead === undefined ? {} : { currentHead: observed.currentHead }),
      }),
    };
  }
  if (observed.head !== record.beforeCommit) {
    const detail = `HEAD advanced from ${record.beforeCommit} without a persisted Nawabari commit result; refusing to adopt an unverified commit`;
    try {
      input.store.markCommitReconciliationAmbiguous(selected.taskId, detail);
    } catch {
      // Keep the immutable before/observed identities in the returned diagnostic.
    }
    return {
      kind: "result",
      result: commitRecoveryFailure("commit-result-ambiguous", detail, record, {
        state: "ambiguous",
        currentHead: observed.head,
      }),
    };
  }
  return { kind: "retry", record };
}

function workflowPullRequestObserver(adapter: GithubAdapter): WorkflowPullRequestObserver {
  return async (record) => {
    if (record.provider !== "github") {
      return { ok: false, detail: `unsupported pull-request provider: ${record.provider}` };
    }
    try {
      const observed = await adapter.viewPullRequest(record.prNumber, {
        provider: record.provider,
        id: record.repositoryId,
      });
      return observed.ok ? { ok: true, pullRequest: observed.value } : { ok: false, detail: observed.error.message };
    } catch (error) {
      return {
        ok: false,
        detail: `provider pull-request observation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export interface CommitWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  message: StructuredCommitMessage;
  includePaths?: readonly string[];
  dryRun?: boolean;
}

interface CommitIntent {
  finalMessage: string;
  includePaths: string[] | undefined;
  resources: readonly string[];
}

function resolveCommitIntent(
  input: CommitWorkflowInput,
  selected: ResolvedWorkflowTask,
): CommitIntent | WorkflowWriteFailure {
  const rendered = renderCommitMessage(input.message);
  if (!rendered.ok) return failure(rendered.code, rendered.detail);

  const branch = selected.expectedBranch;
  if (branch === undefined) return failure("branch-mismatch", "Nawabari commit requires an attached branch identity");
  for (const operation of ["stage", "commit"] as const) {
    const policyDecision = decideProtectedBranchOperation({
      policy: input.policy,
      branch,
      operation,
      repository: { isPrimaryCheckout: false },
    });
    if (!policyDecision.allowed)
      return failure(
        "protected-branch",
        `${operation} denied for protected/control-plane branch ${branch}: ${policyDecision.reason}`,
      );
  }

  const workspaceRoot = selected.executionWorkspaceRoot ?? input.workspaceRoot;
  const requested = input.includePaths === undefined ? undefined : [...new Set(input.includePaths)];
  if (requested !== undefined && requested.length === 0)
    return failure("include-path-not-changed", "includePaths must contain at least one resource");
  if (requested === undefined && input.policy.stagingMode === "explicit")
    return failure("explicit-include-required", "explicit staging requires includePaths");
  for (const candidate of requested ?? []) {
    if (candidate.length === 0 || candidate.includes("\u0000") || !isPathInsideWorkspace(workspaceRoot, candidate))
      return failure("invalid-path", "include path must be a non-empty relative path inside the worktree");
    const normalized = path.normalize(candidate);
    if (normalized !== candidate && normalized !== candidate.replaceAll("/", path.sep))
      return failure("invalid-path", "include path must not contain path traversal or ambiguous separators");
  }
  return {
    finalMessage: rendered.message,
    includePaths: requested,
    resources: requested ?? ALL_NAWABARI_RESOURCES,
  };
}

/**
 * Restoration after a successful escalation whose retried authorization then
 * denied or threw is itself one atomic `session update` call back to the
 * exact prior claim set (Nawabari 0.4.1's `claim_set_replacement`
 * boundary). Best-effort is still not acceptable: a restoration failure
 * must surface as its own distinct, actionable error naming the intended
 * claim set, rather than be silently absorbed behind the original
 * commit-authorization failure.
 */
async function restorePriorNawabariClaims(
  nawabari: NawabariExecutionClient,
  cwd: string,
  sessionId: string,
  priorClaims: readonly ExecutionClaim[],
  causeDetail: string,
): Promise<void> {
  try {
    await nawabari.updateClaims({ cwd, sessionId, claims: priorClaims });
  } catch (error) {
    throw new NawabariExecutionError(
      "nawabari-command-failed",
      `${causeDetail}, and restoring the session's prior claim set also failed: ${error instanceof Error ? error.message : String(error)}; the intended set was ${JSON.stringify(priorClaims)}`,
    );
  }
}

/**
 * Manager's launch-time execution boundary is exactly this single broad
 * read claim until semantic scope is declared (`**:read`; Issue #357).
 * Commit escalation recognizes only this specific, known prior state and
 * atomically replaces it with the commit's concrete exclusive-write scope.
 * Any other prior claim set — additional claims, a different mode, more or
 * fewer than one claim — is unknown authority this rule does not attempt to
 * transform or preserve; Mottainai does not reimplement Nawabari's
 * glob/overlap semantics to decide what would or would not conflict, so an
 * unrecognized prior set fails closed instead.
 */
const KNOWN_MANAGER_LAUNCH_CLAIMS: readonly ExecutionClaim[] = [{ resource: "**", mode: "read" }];

function isKnownManagerLaunchClaimSet(priorClaims: readonly ExecutionClaim[]): boolean {
  return (
    priorClaims.length === KNOWN_MANAGER_LAUNCH_CLAIMS.length &&
    priorClaims.every(
      (claim, index) =>
        claim.resource === KNOWN_MANAGER_LAUNCH_CLAIMS[index]!.resource &&
        claim.mode === KNOWN_MANAGER_LAUNCH_CLAIMS[index]!.mode,
    )
  );
}

export async function commitWorkflowTask(input: CommitWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;

  const existingReceipt = input.store.getCommitReconciliation(selected.taskId);
  if (input.dryRun !== true && existingReceipt !== undefined) {
    const existing = await resolveExistingCommit(input, selected, existingReceipt);
    if (existing.kind === "result") return existing.result;
  }

  const operation: CommitOperationInput = {
    ...contextInput(input, selected),
    policy: input.policy,
    message: input.message,
    includePaths: input.includePaths,
    commitPolicy: { stagingMode: input.policy.stagingMode },
  };
  if (input.dryRun === true) {
    const verification = await verifyCommit(operation);
    if (!verification.ok) return failure(verification.code, verification.detail);
    return {
      ok: true,
      dryRun: true,
      plan: {
        operation: "commit",
        message: verification.finalMessage,
        stagingMode: verification.stagingMode,
        includePaths: verification.includePaths,
        changedPaths: verification.status.changedPaths,
      },
      taskId: selected.taskId,
    };
  }

  const intent = resolveCommitIntent(input, selected);
  if ("ok" in intent) return intent;
  const task = input.store.getTask(selected.taskId);
  if (task === undefined) return failure("task-not-found", `task was not found: ${selected.taskId}`);
  if (task.lifecycleState !== "active")
    return failure("task-not-active", `managed commit requires an active task, found ${task.lifecycleState}`);
  if (input.nawabari === undefined || selected.nawabariSessionId === undefined)
    return failure("nawabari-unavailable", "managed commit requires an attached Nawabari execution boundary");
  const nawabari = input.nawabari;
  const sessionId = selected.nawabariSessionId;
  const workspaceRoot = selected.executionWorkspaceRoot ?? input.workspaceRoot;
  const before = await observeNawabariCheckpoint({ nawabari, cwd: workspaceRoot, sessionId });
  if (!before.ok) return before;
  const resources = intent.includePaths ?? checkpointResources(before.evidence);

  let receipt: CommitReconciliationRecord;
  try {
    receipt = input.store.beginCommitReconciliation({
      taskId: selected.taskId,
      instanceId: selected.instanceId,
      nawabariSessionId: sessionId,
      branchName: selected.expectedBranch!,
      beforeCommit: before.head,
      resources,
      message: intent.finalMessage,
    });
  } catch (error) {
    return failure(
      "commit-reconciliation-persistence-failed",
      `commit intent could not be persisted before Nawabari mutation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (receipt.state === "ambiguous")
    return commitRecoveryFailure(
      "commit-result-ambiguous",
      receipt.detail ?? "commit intent is already ambiguous; refusing another external mutation",
      receipt,
    );
  if (receipt.state === "succeeded" || receipt.state === "reconciled")
    return reconcileKnownCommit(input, selected, receipt, { recovered: true });

  let shadow: ShadowComparison;
  let legacyDecision: ShadowComparison["legacyDecision"] = "unavailable";
  try {
    let authorization = await nawabari.authorize({
      cwd: workspaceRoot,
      sessionId,
      operation: "commit",
      resources,
    });
    if (authorization.allowed !== true && authorization.code === "INSUFFICIENT_CLAIM_MODE") {
      // A launch-time execution boundary may hold only Manager's known
      // `**:read` claim (Manager starts read-only until semantic scope is
      // declared). `task commit` is the declared write intent for exactly
      // these resources, so it is the boundary that atomically replaces
      // that known claim with concrete exclusive-write access and retries
      // authorization once before failing closed. The replacement is one
      // atomic `session update` call (Nawabari 0.4.1's
      // `claim_set_replacement` boundary): Nawabari owns the transition, so
      // Mottainai never exposes a caller-created empty or partially rebuilt
      // claim set. Any prior claim set other than the known `**:read`
      // launch state is unrecognized authority — Mottainai does not guess
      // how to transform it, so escalation fails closed without mutating
      // anything. A rejected update leaves the prior set unchanged and
      // requires no restoration; only a successful update whose retried
      // authorization then denies or throws needs the prior set restored,
      // itself through one atomic update.
      const priorClaims = await nawabari.listClaims({ cwd: workspaceRoot, sessionId });
      if (!isKnownManagerLaunchClaimSet(priorClaims))
        throw new NawabariExecutionError(
          "nawabari-claim-authority-unrecognized",
          `commit escalation only recognizes the Manager's known **:read launch claim; observed prior claim set ${JSON.stringify(priorClaims)}`,
        );
      const desiredClaims: ExecutionClaim[] = resources.map((resource) => ({
        resource,
        mode: "exclusive-write" as const,
      }));
      await nawabari.updateClaims({ cwd: workspaceRoot, sessionId, claims: desiredClaims });
      try {
        authorization = await nawabari.authorize({
          cwd: workspaceRoot,
          sessionId,
          operation: "commit",
          resources,
        });
      } catch (error) {
        await restorePriorNawabariClaims(
          nawabari,
          workspaceRoot,
          sessionId,
          priorClaims,
          `Nawabari authorization after claim escalation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      if (authorization.allowed !== true)
        await restorePriorNawabariClaims(
          nawabari,
          workspaceRoot,
          sessionId,
          priorClaims,
          "Nawabari denied the commit after claim escalation",
        );
    }
    legacyDecision = await boundedLegacyDecision(verifyCommit(operation));
    shadow = {
      legacyDecision,
      nawabariDecision: authorization.allowed === true ? "allow" : "deny",
      agreement: shadowDecisionsAgree(legacyDecision, authorization.allowed === true ? "allow" : "deny"),
    };
    if (authorization.allowed !== true)
      return {
        ...failure("nawabari-rejected", "Nawabari denied the commit after authorization"),
        shadow,
      };
    const committed = await nawabari.commit({
      cwd: workspaceRoot,
      sessionId,
      message: intent.finalMessage,
      resources,
    });
    const commitSha = commitResultSha(committed);
    if (commitSha === undefined) {
      try {
        input.store.markCommitReconciliationAmbiguous(selected.taskId, "Nawabari commit returned no result SHA");
      } catch {
        // Preserve the external-boundary failure even if ambiguity persistence fails.
      }
      return commitRecoveryFailure("commit-result-ambiguous", "Nawabari commit returned no result SHA", receipt, {
        state: "ambiguous",
      });
    }

    try {
      receipt = input.store.recordCommitResult(selected.taskId, commitSha);
    } catch (error) {
      return commitRecoveryFailure(
        "commit-result-persistence-failed",
        `Nawabari committed ${commitSha}, but the result receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
        receipt,
        { state: "ambiguous", commitSha },
      );
    }
    return reconcileKnownCommit(input, selected, receipt, {
      nawabariResult: committed,
      shadow,
      recovered: false,
    });
  } catch (error) {
    return {
      ...failure(
        error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
        error instanceof Error ? error.message : String(error),
      ),
      shadow: shadowFailure(error, legacyDecision),
      recovery: recoveryDiagnostic(receipt),
    };
  }
}

export interface PushWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  remote?: string;
  remoteBranch?: string;
  force?: boolean;
  createUpstream?: boolean;
  allowRemoteBehind?: boolean;
  allowDiverged?: boolean;
  dryRun?: boolean;
}

interface PushIntent {
  remote: string;
  branch: string;
  force: boolean;
  createUpstream: boolean;
}

function resolvePushIntent(
  input: PushWorkflowInput,
  selected: ResolvedWorkflowTask,
): PushIntent | WorkflowWriteFailure {
  const remote = input.remote ?? "origin";
  if (!SAFE_REMOTE_NAME.test(remote))
    return failure("invalid-remote", "remote must be a local Git remote name without URL or credential syntax");

  const branch = input.remoteBranch ?? selected.expectedBranch;
  if (branch === undefined) return failure("invalid-remote-branch", "Nawabari push requires an explicit branch target");
  const branchFailure = validateBranchNameSyntax(branch, input.policy);
  if (branchFailure !== undefined) return failure("invalid-remote-branch", branchFailure.detail);

  const force = input.force === true;
  const policyDecision = decideProtectedBranchOperation({
    policy: input.policy,
    branch,
    operation: force ? "forcePush" : "directPush",
    repository: { isPrimaryCheckout: false },
  });
  if (!policyDecision.allowed)
    return failure("protected-branch", `push to protected branch ${branch} denied: ${policyDecision.reason}`);

  return { remote, branch, force, createUpstream: input.createUpstream === true };
}

type PushEvidence = {
  sourceCommit: string;
  remote: string;
  branch: string;
  target: string;
  targetRef: string;
  observedRemoteSha: string | undefined;
  relation: string;
  evidenceComplete: boolean;
};

function resultString(result: NawabariCommandResult, fields: readonly string[], label: string): string {
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`Nawabari push evidence is missing ${label}`);
}

function pushEvidence(result: NawabariCommandResult): PushEvidence {
  const sourceCommit = result.source_sha ?? result.sourceSha;
  const targetRef = result.target_ref ?? result.targetRef;
  const observed = "observed_remote_sha" in result ? result.observed_remote_sha : result.observedRemoteSha;
  if (typeof sourceCommit !== "string" || sourceCommit.length === 0)
    throw new Error("Nawabari push evidence is missing source commit generation");
  if (typeof targetRef !== "string" || targetRef.length === 0)
    throw new Error("Nawabari push evidence is missing target ref");
  if (!("observed_remote_sha" in result) && !("observedRemoteSha" in result))
    throw new Error("Nawabari push evidence is missing observed remote generation");
  if (observed !== null && observed !== undefined && (typeof observed !== "string" || observed.length === 0))
    throw new Error("Nawabari push evidence has an invalid observed remote generation");
  const relation = result.relation;
  if (typeof relation !== "string" || !["no-upstream", "up-to-date", "ahead", "behind", "diverged"].includes(relation))
    throw new Error("Nawabari push evidence has an invalid relation");
  const remote = resultString(result, ["remote"], "remote");
  const branch = resultString(result, ["branch"], "branch");
  const target = result.target;
  if (typeof target !== "string" || target.length === 0)
    throw new Error("Nawabari push evidence is missing target identity");
  if (observed === undefined) throw new Error("Nawabari push evidence is missing observed remote generation");
  return {
    sourceCommit,
    remote,
    branch,
    target,
    targetRef,
    observedRemoteSha: observed === null ? undefined : observed,
    relation,
    evidenceComplete: true,
  };
}

function pushIdentityMismatch(receipt: PushReconciliationRecord, evidence: PushEvidence): string | undefined {
  const mismatches = [
    receipt.sourceCommit !== evidence.sourceCommit ? "source commit" : undefined,
    receipt.remote !== evidence.remote ? "remote" : undefined,
    receipt.targetBranch !== evidence.branch ? "target branch" : undefined,
    receipt.targetRef !== evidence.targetRef ? "target ref" : undefined,
    `${receipt.remote}/${receipt.targetBranch}` !== evidence.target ? "target" : undefined,
  ].filter((value): value is string => value !== undefined);
  return mismatches.length === 0 ? undefined : mismatches.join(", ");
}

function pushReconciliationFailure(detail: string): WorkflowWriteFailure {
  return failure("push-reconciliation-ambiguous", detail);
}

async function completePushedLifecycle(input: {
  pushInput: PushWorkflowInput;
  selected: ResolvedWorkflowTask;
  nawabari: NawabariExecutionClient;
  pushed: NawabariCommandResult;
  shadow: ShadowComparison;
  recovered: boolean;
}): Promise<WorkflowWriteResult> {
  const { pushInput, selected, nawabari } = input;
  const workspaceRoot = selected.executionWorkspaceRoot ?? pushInput.workspaceRoot;
  try {
    const evidence = await nawabari.checkpoint({
      cwd: workspaceRoot,
      sessionId: selected.nawabariSessionId!,
    });
    reconcileCheckpoint(pushInput.store, selected.instanceId, selected.expectedBranch, evidence);
    const transitioned = await transitionTaskForWorkspace({
      ...contextInput(pushInput, selected, ["committed"]),
      policy: pushInput.policy,
      to: "pushed",
    });
    if (!transitioned.ok) return transitioned;
    const reconciliation = pushInput.store.markPushReconciled(selected.taskId);
    return {
      ok: true,
      task: transitioned.task,
      push: {
        ok: true,
        executionEvidence: evidence,
        nawabari: input.pushed,
        shadow: input.shadow,
        recovered: input.recovered,
        reconciliation,
      },
      taskId: selected.taskId,
    };
  } catch (error) {
    try {
      pushInput.store.markPushAmbiguous(selected.taskId, error instanceof Error ? error.message : String(error));
    } catch {
      // Preserve the original persistence/observation failure.
    }
    return failure(
      error instanceof NawabariExecutionError ? error.code : "push-reconciliation-persistence-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function recoverPushReconciliation(input: {
  pushInput: PushWorkflowInput;
  selected: ResolvedWorkflowTask;
  receipt: PushReconciliationRecord;
}): Promise<{ ok: true; receipt: PushReconciliationRecord; pushed: NawabariCommandResult } | WorkflowWriteFailure> {
  const { pushInput, selected, receipt } = input;
  const nawabari = pushInput.nawabari!;
  const workspaceRoot = selected.executionWorkspaceRoot ?? pushInput.workspaceRoot;
  const checkpoint = await observeNawabariCheckpoint({
    nawabari,
    cwd: workspaceRoot,
    sessionId: receipt.nawabariSessionId,
  });
  if (!checkpoint.ok) {
    pushInput.store.markPushAmbiguous(selected.taskId, checkpoint.detail);
    return checkpoint;
  }
  if (checkpoint.head !== receipt.sourceCommit) {
    const detail = `push recovery source commit ${receipt.sourceCommit} is not the Nawabari checkpoint HEAD (${checkpoint.head})`;
    pushInput.store.markPushAmbiguous(selected.taskId, detail);
    return pushReconciliationFailure(detail);
  }

  if (!receipt.evidenceComplete && receipt.resultRemoteSha !== undefined) {
    const detail = "Nawabari push.v1 remote-generation evidence was not persisted; refusing blind retry";
    pushInput.store.markPushAmbiguous(selected.taskId, detail);
    return pushReconciliationFailure(detail);
  }

  const commitReceipt = pushInput.store.getCommitReconciliation(selected.taskId);
  const resources = commitReceipt?.resources.length ? commitReceipt.resources : ALL_NAWABARI_RESOURCES;
  try {
    const authorization = await nawabari.authorize({
      cwd: workspaceRoot,
      sessionId: receipt.nawabariSessionId,
      operation: "push",
      resources,
    });
    if (authorization.allowed !== true) {
      const detail = "Nawabari denied remote push reconciliation observation";
      pushInput.store.markPushAmbiguous(selected.taskId, detail);
      return pushReconciliationFailure(detail);
    }

    // Nawabari's push.v1 performs the authoritative generation inspection. Recovery
    // never reuses the original force/upstream intent: force is disabled and the
    // target must already be at the recorded source generation. Thus an advanced
    // remote is rejected by Nawabari before any overwrite can be attempted.
    const observed = await nawabari.push({
      cwd: workspaceRoot,
      sessionId: receipt.nawabariSessionId,
      remote: receipt.remote,
      branch: receipt.targetBranch,
      resources,
      force: false,
      createUpstream: false,
    });
    const evidence = pushEvidence(observed);
    const mismatch = pushIdentityMismatch(receipt, evidence);
    if (
      mismatch !== undefined ||
      evidence.relation !== "up-to-date" ||
      evidence.observedRemoteSha !== receipt.sourceCommit
    ) {
      const detail =
        mismatch === undefined
          ? `remote generation is not the recorded source (relation=${evidence.relation}, observed=${evidence.observedRemoteSha ?? "missing"})`
          : `Nawabari push evidence identity mismatch: ${mismatch}`;
      pushInput.store.markPushAmbiguous(selected.taskId, detail);
      return pushReconciliationFailure(detail);
    }

    const recorded = pushInput.store.recordPushResult({
      taskId: selected.taskId,
      sourceCommit: receipt.sourceCommit,
      remote: receipt.remote,
      targetBranch: receipt.targetBranch,
      targetRef: receipt.targetRef,
      recoveryObservedRemoteSha: evidence.observedRemoteSha,
      resultRemoteSha: receipt.sourceCommit,
      relation: evidence.relation,
      evidenceComplete: evidence.evidenceComplete,
    });
    return { ok: true, receipt: recorded, pushed: observed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      pushInput.store.markPushAmbiguous(selected.taskId, detail);
    } catch {
      // Preserve the original bounded external-observation failure.
    }
    return pushReconciliationFailure(`Nawabari remote reconciliation failed: ${detail}`);
  }
}

export async function pushWorkflowTask(input: PushWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  const force = input.force === true;
  const createUpstream = input.createUpstream === true;
  const workspaceRoot = selected.executionWorkspaceRoot ?? input.workspaceRoot;
  const operation: PushOperationInput = {
    ...contextInput(input, selected, ["committed"]),
    policy: input.policy,
    remote: input.remote,
    remoteBranch: input.remoteBranch,
    force,
    createUpstream,
    pushPolicy: {
      // This delegates the protected-branch decision to the workflow policy API;
      // it is not an invocation-level weakening of that policy.
      allowProtectedBranch: true,
      allowForcePush: force,
      allowUpstreamCreation: createUpstream,
      allowRemoteBehind: input.allowRemoteBehind === true,
      allowDiverged: input.allowDiverged === true,
    },
  };
  if (input.dryRun === true) {
    const verification = await verifyPush(operation);
    if (!verification.ok) return failure(verification.code, verification.detail);
    return {
      ok: true,
      dryRun: true,
      plan: {
        operation: "push",
        remote: verification.remote,
        remoteBranch: verification.remoteBranch,
        relation: verification.relation,
        arguments: verification.pushArguments,
      },
      taskId: selected.taskId,
    };
  }

  const intent = resolvePushIntent(input, selected);
  if ("ok" in intent) return intent;
  if (input.nawabari === undefined || selected.nawabariSessionId === undefined)
    return failure("nawabari-unavailable", "managed push requires an attached Nawabari execution boundary");
  const nawabari = input.nawabari;
  const sessionId = selected.nawabariSessionId;
  const task = input.store.getTask(selected.taskId);
  if (task === undefined) return failure("task-not-found", `task was not found: ${selected.taskId}`);
  const existingReceipt = input.store.getPushReconciliation(selected.taskId);
  if (task.lifecycleState === "pushed")
    return {
      ok: true,
      task,
      taskId: selected.taskId,
      push: { ok: true, reconciled: true, reconciliation: existingReceipt },
    };
  if (task.lifecycleState !== "committed")
    return failure("task-not-committed", `managed push requires a committed task, found ${task.lifecycleState}`);
  if (
    existingReceipt !== undefined &&
    (existingReceipt.remote !== intent.remote || existingReceipt.targetBranch !== intent.branch)
  ) {
    return pushReconciliationFailure("push retry target differs from the immutable persisted target");
  }

  if (existingReceipt !== undefined && existingReceipt.state !== "prepared") {
    const recovered = await recoverPushReconciliation({ pushInput: input, selected, receipt: existingReceipt });
    if (!recovered.ok) return recovered;
    return await completePushedLifecycle({
      pushInput: input,
      selected,
      nawabari: input.nawabari,
      pushed: recovered.pushed,
      shadow: { legacyDecision: "unavailable", nawabariDecision: "allow", agreement: false },
      recovered: true,
    });
  }

  let receipt = existingReceipt;
  let legacyDecision: ShadowComparison["legacyDecision"] = "unavailable";
  if (receipt === undefined) {
    const source = await observeNawabariCheckpoint({ nawabari, cwd: workspaceRoot, sessionId });
    if (!source.ok) return source;
    receipt = input.store.beginPushReconciliation({
      taskId: selected.taskId,
      instanceId: selected.instanceId,
      nawabariSessionId: sessionId as PushReconciliationRecord["nawabariSessionId"],
      sourceCommit: source.head,
      remote: intent.remote,
      targetBranch: intent.branch,
      targetRef: `refs/heads/${intent.branch}`,
      forceRequested: intent.force,
      createUpstream: intent.createUpstream,
    });
  }

  if (receipt === undefined)
    return failure("push-reconciliation-unavailable", "push reconciliation intent was not persisted");
  const current = await observeNawabariCheckpoint({ nawabari, cwd: workspaceRoot, sessionId });
  if (!current.ok) {
    try {
      input.store.markPushAmbiguous(selected.taskId, current.detail);
    } catch {
      // Preserve the companion/evidence failure.
    }
    return current;
  }
  if (receipt.sourceCommit !== current.head) {
    const detail = "push source commit changed after reconciliation intent was persisted";
    input.store.markPushAmbiguous(selected.taskId, detail);
    return pushReconciliationFailure(detail);
  }
  try {
    receipt = input.store.markPushAttempting(selected.taskId);
    const commitReceipt = input.store.getCommitReconciliation(selected.taskId);
    const resources = commitReceipt?.resources.length ? commitReceipt.resources : ALL_NAWABARI_RESOURCES;
    const authorization = await nawabari.authorize({
      cwd: workspaceRoot,
      sessionId: receipt.nawabariSessionId,
      operation: "push",
      resources,
    });
    legacyDecision = await boundedLegacyDecision(verifyPush(operation));
    const shadow: ShadowComparison = {
      legacyDecision,
      nawabariDecision: authorization.allowed === true ? "allow" : "deny",
      agreement: shadowDecisionsAgree(legacyDecision, authorization.allowed === true ? "allow" : "deny"),
    };
    if (authorization.allowed !== true) {
      input.store.markPushAmbiguous(
        selected.taskId,
        "Nawabari denied the push after reconciliation intent was recorded",
      );
      return { ...failure("nawabari-rejected", "Nawabari denied the push after authorization"), shadow };
    }
    const pushed = await nawabari.push({
      cwd: workspaceRoot,
      sessionId: receipt.nawabariSessionId,
      remote: receipt.remote,
      branch: receipt.targetBranch,
      resources,
      force: receipt.forceRequested,
      createUpstream: receipt.createUpstream,
    });
    const evidence = pushEvidence(pushed);
    const mismatch = pushIdentityMismatch(receipt, evidence);
    if (mismatch !== undefined) throw new Error(`Nawabari push evidence identity mismatch: ${mismatch}`);
    receipt = input.store.recordPushResult({
      taskId: selected.taskId,
      sourceCommit: receipt.sourceCommit,
      remote: receipt.remote,
      targetBranch: receipt.targetBranch,
      targetRef: receipt.targetRef,
      observedRemoteSha: evidence.observedRemoteSha,
      resultRemoteSha: evidence.sourceCommit,
      relation: evidence.relation,
      evidenceComplete: evidence.evidenceComplete,
    });
    return await completePushedLifecycle({
      pushInput: input,
      selected,
      nawabari,
      pushed,
      shadow,
      recovered: false,
    });
  } catch (error) {
    try {
      input.store.markPushAmbiguous(selected.taskId, error instanceof Error ? error.message : String(error));
    } catch {
      // Preserve the original failure if the state backend is also unavailable.
    }
    return {
      ...failure(
        error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
        error instanceof Error ? error.message : String(error),
      ),
      shadow: shadowFailure(error, legacyDecision),
    };
  }
}

function parseGithubRepository(value: string): RepositoryIdentity | undefined {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/^ssh:\/\/git@github\.com\//u, "")
    .replace(/\.git$/u, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) return undefined;
  const [namespace, name] = normalized.split("/");
  if (namespace === undefined || name === undefined) return undefined;
  return { provider: "github", id: `${namespace}/${name}`, namespace, name };
}

export async function resolveGithubRepository(
  workspaceRoot: string,
  requested?: string,
): Promise<WorkflowWriteResult<{ repository: RepositoryIdentity }>> {
  if (requested !== undefined) {
    const repository = parseGithubRepository(requested);
    return repository === undefined
      ? failure("repository-identity-ambiguous", "repository must be an explicit GitHub owner/name")
      : { ok: true, repository };
  }
  const remote = await runGitCommand(workspaceRoot, ["remote", "get-url", "origin"]);
  if (!remote.usable || remote.result.exitCode !== 0)
    return failure("repository-identity-ambiguous", "origin GitHub remote could not be resolved");
  const repository = parseGithubRepository(remote.result.stdout.trim());
  return repository === undefined
    ? failure("repository-identity-ambiguous", "origin is not an unambiguous GitHub owner/name remote")
    : { ok: true, repository };
}

export interface OpenPullRequestWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  title: string;
  repository?: string;
  issueReference?: string;
  sections?: Readonly<Record<string, string | readonly string[]>>;
  acceptanceCriteria?: readonly string[];
  providerDraft?: boolean;
  dryRun?: boolean;
}

function pullRequestDraft(input: OpenPullRequestWorkflowInput): PullRequestBodyDraft | WorkflowWriteFailure {
  const title = nonEmpty(input.title, "title");
  if (typeof title !== "string") return title;
  if (
    input.sections !== undefined &&
    (typeof input.sections !== "object" || input.sections === null || Array.isArray(input.sections))
  )
    return failure("invalid-input", "sections must be an object");
  const sections = input.sections ?? {};
  for (const [heading, value] of Object.entries(sections)) {
    if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      return failure("invalid-input", `sections.${heading} must be a string or string array`);
    }
  }
  if (input.issueReference !== undefined && typeof input.issueReference !== "string")
    return failure("invalid-input", "issueReference must be a string");
  if (
    input.acceptanceCriteria !== undefined &&
    (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.some((item) => typeof item !== "string"))
  )
    return failure("invalid-input", "acceptanceCriteria must be an array of strings");
  return {
    ...(input.issueReference === undefined ? {} : { issue: { reference: input.issueReference } }),
    sections,
    ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
  };
}

export async function openWorkflowTaskPullRequest(
  input: OpenPullRequestWorkflowInput,
  dependencies: WorkflowWriteDependencies = {},
): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  const context = await verifyWorkflowContext(contextInput(input, selected, ["pushed", "pull-request-open"]));
  if (!context.ok) return failure(context.code, context.detail);
  const repositoryResult = await resolveGithubRepository(input.workspaceRoot, input.repository);
  if (!repositoryResult.ok) return repositoryResult;
  const draft = pullRequestDraft(input);
  if ("reason" in draft) return draft;
  const validDraft = draft;
  const adapter =
    dependencies.pullRequestAdapter ??
    new GhInariPullRequestAdapter({
      workspaceRoot: input.workspaceRoot,
      ...(dependencies.ghInariClient === undefined ? {} : { client: dependencies.ghInariClient }),
      ...(dependencies.githubAdapter === undefined ? {} : { lookupAdapter: dependencies.githubAdapter }),
    });
  const head: RevisionIdentity = { name: context.branch, revision: context.headCommit };
  const base: RevisionIdentity = { name: context.task.baseBranch, revision: context.task.baseCommit };
  if (input.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      plan: {
        operation: "open-pr",
        title: input.title,
        repository: repositoryResult.repository,
        head,
        base,
        fields: validDraft,
      },
      taskId: selected.taskId,
    };
  }
  const opened = await openWorkflowPullRequest({
    adapter,
    store: input.store,
    taskId: selected.taskId,
    repository: repositoryResult.repository,
    title: input.title,
    head,
    base,
    draft: validDraft,
    providerDraft: input.providerDraft,
  });
  if (!opened.ok)
    return {
      ...failure(opened.reason, opened.detail),
      ...(opened.provider === undefined ? {} : { provider: opened.provider }),
      ...(opened.providerCreated === undefined ? {} : { providerCreated: opened.providerCreated }),
    };
  return {
    ok: true,
    task: opened.task,
    pullRequest: opened.pullRequest,
    record: opened.record,
    reused: opened.reused,
    taskId: selected.taskId,
  };
}

async function transitionWorkflowTask(
  input: WorkflowTaskSelector & {
    policy: WorkflowPolicyDocument;
    to: "merged" | "abandoned";
    allowedLifecycleStates: readonly LifecycleState[];
    dryRun?: boolean;
    allowIdempotentTerminalState?: boolean;
  },
  dependencies: WorkflowWriteDependencies = {},
): Promise<WorkflowWriteResult> {
  // A merged task is the durable retry boundary. It may no longer have an
  // active current session after a prior close attempt, so retry the close
  // handoff directly instead of requiring the old active-worktree context.
  if (input.to === "merged" && input.taskId !== undefined) {
    const existing = input.store.getTask(input.taskId as TaskId);
    if (existing?.lifecycleState === "merged") {
      if (input.dryRun === true)
        return { ok: true, dryRun: true, task: existing, taskId: existing.taskId, transition: input.to };
      if (input.nawabari === undefined)
        return failure("nawabari-unavailable", "merged task close retry requires the Nawabari execution boundary");
      const records = input.store.listPullRequestRecordsForTask(existing.taskId);
      if (records.length !== 1)
        return failure("provider-state-ambiguous", `task ${existing.taskId} does not have exactly one provider record`);
      const closed = await closeNawabariExecution({
        workspaceRoot: input.workspaceRoot,
        store: input.store,
        client: input.nawabari,
        task: existing,
        providerRecord: records[0]!,
      });
      if (!closed.ok) return { ...closed, task: existing, taskId: existing.taskId };
      return {
        ok: true,
        task: existing,
        taskId: existing.taskId,
        transition: input.to,
        close: { alreadyClosed: closed.alreadyClosed, sessionId: existing.nawabariSessionId },
      };
    }
  }
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  const githubAdapter =
    input.to === "merged"
      ? (dependencies.githubAdapter ?? new GithubAdapter({ workspaceRoot: input.workspaceRoot }))
      : undefined;
  const result: WorkspaceTaskTransitionResult = await transitionTaskForWorkspace({
    ...contextInput(input, selected, input.allowedLifecycleStates),
    policy: input.policy,
    to: input.to,
    dryRun: input.dryRun,
    allowIdempotentTerminalState: input.allowIdempotentTerminalState,
    ...(githubAdapter === undefined ? {} : { pullRequestObserver: workflowPullRequestObserver(githubAdapter) }),
  });
  if (!result.ok) return result;
  if (input.to === "merged" && input.dryRun !== true) {
    if (input.nawabari === undefined)
      return failure("nawabari-unavailable", "merged task close requires the Nawabari execution boundary");
    const records = input.store.listPullRequestRecordsForTask(result.task.taskId);
    if (records.length !== 1)
      return failure(
        "provider-state-ambiguous",
        `task ${result.task.taskId} does not have exactly one provider record`,
      );
    const closed = await closeNawabariExecution({
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      client: input.nawabari,
      task: result.task,
      providerRecord: records[0]!,
      expectedBranch: result.context.branch,
    });
    if (!closed.ok) return { ...closed, task: result.task, taskId: selected.taskId, transition: input.to };
    return {
      ok: true,
      dryRun: false,
      task: result.task,
      taskId: selected.taskId,
      transition: input.to,
      close: { alreadyClosed: closed.alreadyClosed, sessionId: selected.nawabariSessionId },
    };
  }
  return { ok: true, dryRun: input.dryRun === true, task: result.task, taskId: selected.taskId, transition: input.to };
}

export function finishWorkflowTask(
  input: WorkflowTaskSelector & { policy: WorkflowPolicyDocument; dryRun?: boolean },
  dependencies: WorkflowWriteDependencies = {},
): Promise<WorkflowWriteResult> {
  return transitionWorkflowTask(
    {
      ...input,
      to: "merged",
      allowedLifecycleStates: ["pull-request-open", "merged"],
      allowIdempotentTerminalState: true,
    },
    dependencies,
  );
}

export function abandonWorkflowTask(
  input: WorkflowTaskSelector & { policy: WorkflowPolicyDocument; dryRun?: boolean },
  dependencies: WorkflowWriteDependencies = {},
): Promise<WorkflowWriteResult> {
  return transitionWorkflowTask(
    {
      ...input,
      to: "abandoned",
      allowedLifecycleStates: ["active", "committed", "pushed", "pull-request-open", "orphaned", "abandoned"],
      allowIdempotentTerminalState: true,
    },
    dependencies,
  );
}

export interface CleanupWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  dryRun?: boolean;
  idempotencyKey?: string;
  plan?: CleanupPlan;
  owner?: string;
}

export interface NawabariCleanupPlan {
  authority: "nawabari";
  planId: string;
  taskId: TaskId;
  sessionId: string;
  decision: "caller-permitted" | "blocked";
  reason: string;
}

export async function cleanupWorkflowTask(
  input: CleanupWorkflowInput,
  dependencies: WorkflowWriteDependencies = {},
): Promise<
  WorkflowWriteResult<{
    plan: CleanupPlan | NawabariCleanupPlan;
    execution?: Record<string, unknown>;
    task?: unknown;
    taskId?: TaskId;
    dryRun?: boolean;
  }>
> {
  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey))
    return failure("invalid-input", "idempotencyKey must be a bounded branch-safe token");
  if (input.plan !== undefined)
    return failure("legacy-cleanup-plan-retired", "legacy Mottainai cleanup plans are retired; use Nawabari cleanup");
  if (input.taskId !== undefined) {
    const existing = input.store.getTask(input.taskId as TaskId);
    if (existing?.lifecycleState === "cleaned" && existing.nawabariSessionId !== undefined) {
      const authority = await resolveNawabariAuthority(input);
      const authorityFailure = explicitTaskAuthorityFailure(authority, existing.taskId);
      if (authorityFailure !== undefined) return authorityFailure;
      const plan: NawabariCleanupPlan = {
        authority: "nawabari",
        planId: input.idempotencyKey ?? `cleanup-${existing.taskId}`,
        taskId: existing.taskId,
        sessionId: existing.nawabariSessionId,
        decision: "caller-permitted",
        reason: "task cleanup was already completed by Nawabari",
      };
      return {
        ok: true,
        ...(input.dryRun === true ? { dryRun: true } : { execution: { status: "already-completed" } }),
        plan,
        task: existing,
        taskId: existing.taskId,
      };
    }
  }
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;

  if (input.nawabari === undefined || selected.nawabariSessionId === undefined)
    return failure("nawabari-unavailable", "managed cleanup requires an attached Nawabari execution boundary");
  {
    const task = input.store.getTask(selected.taskId);
    if (task === undefined) return failure("task-not-found", `task was not found: ${selected.taskId}`);
    const allowed =
      task.lifecycleState === "merged" || task.lifecycleState === "abandoned" || task.lifecycleState === "orphaned";
    const plan: NawabariCleanupPlan = {
      authority: "nawabari",
      planId: input.idempotencyKey ?? `cleanup-${selected.taskId}`,
      taskId: selected.taskId,
      sessionId: selected.nawabariSessionId,
      decision: allowed ? "caller-permitted" : "blocked",
      reason: allowed
        ? `task lifecycle ${task.lifecycleState} permits a cleanup request`
        : `task lifecycle ${task.lifecycleState} does not permit cleanup`,
    };
    if (!allowed)
      return { ok: false, reason: "cleanup-plan-blocked", detail: plan.reason, plan, dryRun: input.dryRun === true };
    if (input.dryRun === true) return { ok: true, dryRun: true, plan };
    try {
      const physical = await input.nawabari.cleanup({
        cwd: selected.executionWorkspaceRoot ?? input.workspaceRoot,
        sessionId: selected.nawabariSessionId,
      });
      const transitioned = input.store.updateTaskLifecycleState(selected.taskId, "cleaned");
      return { ok: true, plan, execution: physical, task: transitioned, taskId: selected.taskId };
    } catch (error) {
      return failure(
        error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
