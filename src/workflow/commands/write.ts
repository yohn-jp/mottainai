import { renderPullRequestBody, type PullRequestBodyDraft } from "../domain/pr-render.js";
import { createCleanupPlan, type CleanupPlan, type CleanupPullRequestObserver } from "../domain/cleanup-plan.js";
import { verifyCommit, type CommitOperationInput, type StructuredCommitMessage } from "../git/commit.js";
import { runGitCommand, verifyWorkflowContext, type WorkflowContextInput } from "../git/context.js";
import { verifyPush, type PushOperationInput } from "../git/push.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import {
  getTaskStatusForWorkspace,
  transitionTaskForWorkspace,
  type WorkflowPullRequestObserver,
  type WorkspaceTaskTransitionResult,
} from "../domain/task.js";
import type { RepositoryIdentity, RevisionIdentity } from "../providers/model.js";
import { GithubAdapter, openWorkflowPullRequest } from "../providers/github.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { TaskId, WorktreeId, WorkflowStateStore } from "../state/store.js";
import { NawabariExecutionError, type NawabariExecutionClient } from "../nawabari.js";

export interface WorkflowWriteDependencies {
  githubAdapter?: GithubAdapter;
  /** Required by production managed mutation paths after the authority cutover. */
  nawabari?: NawabariExecutionClient;
}

export interface WorkflowTaskSelector {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId?: string;
  nawabari?: NawabariExecutionClient;
  /** Require the authoritative local execution boundary for a mutating operation. */
  requireNawabari?: boolean;
}

export interface ResolvedWorkflowTask {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  worktreeId: WorktreeId | undefined;
  expectedBranch: string | undefined;
  executionWorkspaceRoot?: string;
  nawabariSessionId?: string;
}

export type WorkflowWriteFailure = {
  ok: false;
  reason: string;
  detail: string;
  shadow?: ShadowComparison;
};

export interface ShadowComparison {
  legacyDecision: "allow" | "deny";
  nawabariDecision: "allow" | "deny" | "unavailable";
  agreement: boolean;
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

function shadowFailure(error: unknown, legacyDecision: ShadowComparison["legacyDecision"] = "allow"): ShadowComparison {
  const nawabariDecision =
    error instanceof NawabariExecutionError && error.code === "nawabari-rejected" ? "deny" : "unavailable";
  return { legacyDecision, nawabariDecision, agreement: false };
}

/** Resolve an omitted task only when the current workspace identifies exactly one active task. */
export async function resolveWorkflowTask(
  input: WorkflowTaskSelector,
): Promise<WorkflowWriteResult<ResolvedWorkflowTask>> {
  if (input.taskId !== undefined) {
    const taskIdValue = nonEmpty(input.taskId, "taskId");
    if (typeof taskIdValue !== "string") return taskIdValue;
    const task = input.store.getTask(taskIdValue as TaskId);
    if (task === undefined) return failure("task-not-found", `task was not found: ${taskIdValue}`);
    return taskContext(input, task);
  }

  const located = await getTaskStatusForWorkspace(input.workspaceRoot, input.store);
  if (!located.ok) return failure("repository-identity-unavailable", located.reason);
  if (!located.active)
    return failure("task-identity-ambiguous", "no active workflow task is associated with the current worktree");
  return taskContext(input, located.status.task);
}

async function taskContext(
  input: WorkflowTaskSelector,
  task: { taskId: TaskId; instanceId: RepositoryInstanceId },
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
      const session = await input.nawabari.showSession({
        cwd: input.workspaceRoot,
        sessionId: storedTask.nawabariSessionId,
      });
      return {
        ok: true,
        taskId: task.taskId,
        instanceId: task.instanceId,
        worktreeId: undefined,
        expectedBranch: session.branch,
        executionWorkspaceRoot: session.worktree,
        nawabariSessionId: session.sessionId,
      };
    } catch (error) {
      const code = error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed";
      return failure(code, error instanceof Error ? error.message : String(error));
    }
  }
  if (input.requireNawabari === true)
    return failure(
      "legacy-task-adoption-required",
      `task ${task.taskId} has no Nawabari session reference; adopt it before mutation`,
    );
  const worktrees = input.store.listWorktreesForTask(task.taskId).filter((worktree) => worktree.status === "active");
  if (worktrees.length > 1)
    return failure("task-identity-ambiguous", "multiple active worktrees are associated with the task");
  const worktree = worktrees[0];
  return {
    ok: true,
    taskId: task.taskId,
    instanceId: task.instanceId,
    worktreeId: worktree?.worktreeId,
    expectedBranch: worktree?.branchName,
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

export async function commitWorkflowTask(input: CommitWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask({ ...input, requireNawabari: input.dryRun !== true });
  if (!selected.ok) return selected;
  const operation: CommitOperationInput = {
    ...contextInput(input, selected),
    policy: input.policy,
    message: input.message,
    includePaths: input.includePaths,
    commitPolicy: { stagingMode: input.policy.stagingMode },
  };
  const verification = await verifyCommit(operation);
  if (!verification.ok) return failure(verification.code, verification.detail);
  if (input.dryRun === true) {
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

  if (input.nawabari === undefined || selected.nawabariSessionId === undefined)
    return failure("nawabari-unavailable", "managed commit requires an attached Nawabari execution boundary");
  const resources = verification.includePaths ?? verification.status.changedPaths.paths;
  if (resources.length === 0) return failure("empty-diff", "Nawabari commit requires at least one changed resource");
  try {
    const authorization = await input.nawabari.authorize({
      cwd: verification.context.workspaceRoot,
      sessionId: selected.nawabariSessionId,
      operation: "commit",
      resources,
    });
    const shadow: ShadowComparison = {
      legacyDecision: "allow",
      nawabariDecision: authorization.allowed === true ? "allow" : "deny",
      agreement: authorization.allowed === true,
    };
    if (!shadow.agreement)
      return {
        ...failure("nawabari-rejected", "Nawabari denied the commit after legacy verification"),
        shadow,
      };
    const committed = await input.nawabari.commit({
      cwd: verification.context.workspaceRoot,
      sessionId: selected.nawabariSessionId,
      message: verification.finalMessage,
      resources,
    });
    const evidence = await input.nawabari.checkpoint({
      cwd: verification.context.workspaceRoot,
      sessionId: selected.nawabariSessionId,
    });
    reconcileCheckpoint(input.store, selected.instanceId, selected.expectedBranch, evidence);
    const transitioned = await transitionTaskForWorkspace({
      ...contextInput(input, selected),
      policy: input.policy,
      to: "committed",
    });
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      task: transitioned.task,
      taskId: selected.taskId,
      commit: {
        ok: true,
        commitId:
          typeof committed.commitSha === "string"
            ? committed.commitSha
            : typeof committed.commit_sha === "string"
              ? committed.commit_sha
              : undefined,
        message: verification.finalMessage,
        executionEvidence: evidence,
        nawabari: committed,
        shadow,
      },
    };
  } catch (error) {
    return {
      ...failure(
        error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
        error instanceof Error ? error.message : String(error),
      ),
      shadow: shadowFailure(error),
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

async function pushResources(workspaceRoot: string, baseCommit: string): Promise<string[]> {
  const observed = await runGitCommand(workspaceRoot, ["diff", "--name-only", "-z", `${baseCommit}..HEAD`]);
  if (!observed.usable || observed.result.exitCode !== 0)
    throw new Error("could not derive committed resource paths for Nawabari push");
  // NUL-delimited output preserves paths verbatim, including ones containing
  // newlines, quotes, or a leading "-" that a newline-split/trim would corrupt.
  const paths = observed.result.stdout.split("\0").filter((value) => value.length > 0);
  // A push can be a retry after a successful external commit. Keep the claim
  // request conservative rather than inventing a narrower path set.
  return paths.length === 0 ? ["**"] : paths;
}

export async function pushWorkflowTask(input: PushWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask({ ...input, requireNawabari: input.dryRun !== true });
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
  const verification = await verifyPush(operation);
  if (input.dryRun === true) {
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

  if (input.nawabari === undefined || selected.nawabariSessionId === undefined)
    return failure("nawabari-unavailable", "managed push requires an attached Nawabari execution boundary");
  const task = input.store.getTask(selected.taskId);
  if (task === undefined) return failure("task-not-found", `task was not found: ${selected.taskId}`);
  if (task.lifecycleState !== "committed")
    return failure("task-not-committed", `managed push requires a committed task, found ${task.lifecycleState}`);
  const remote = input.remote ?? "origin";
  const branch = input.remoteBranch ?? selected.expectedBranch;
  if (branch === undefined) return failure("invalid-remote-branch", "Nawabari push requires an explicit branch target");
  const policyDecision = decideProtectedBranchOperation({
    policy: input.policy,
    branch,
    operation: force ? "forcePush" : "directPush",
    // Nawabari provisions task sessions in a dedicated worktree. Physical
    // checkout identity remains Nawabari-owned; this is only governance intent.
    repository: { isPrimaryCheckout: false },
  });
  const legacyDecision: ShadowComparison["legacyDecision"] = verification.ok ? "allow" : "deny";
  if (!policyDecision.allowed)
    return {
      ...failure("protected-branch", `push to protected branch ${branch} denied: ${policyDecision.reason}`),
      shadow: { legacyDecision, nawabariDecision: "unavailable", agreement: false },
    };
  // Legacy verification is read-only shadow evidence after cutover. Its local
  // upstream/divergence/dirty decisions never authorize or veto the mutation;
  // Nawabari is the sole authority for those facts.
  const resources = await pushResources(workspaceRoot, task.baseCommit);
  try {
    const authorization = await input.nawabari.authorize({
      cwd: workspaceRoot,
      sessionId: selected.nawabariSessionId,
      operation: "push",
      resources,
    });
    const shadow: ShadowComparison = {
      legacyDecision,
      nawabariDecision: authorization.allowed === true ? "allow" : "deny",
      agreement: (authorization.allowed === true) === (legacyDecision === "allow"),
    };
    if (!shadow.agreement && authorization.allowed !== true) {
      return {
        ...failure("nawabari-rejected", "Nawabari denied the push after legacy verification"),
        shadow,
      };
    }
    const pushed = await input.nawabari.push({
      cwd: workspaceRoot,
      sessionId: selected.nawabariSessionId,
      remote,
      branch,
      resources,
      force,
      createUpstream,
    });
    const evidence = await input.nawabari.checkpoint({
      cwd: workspaceRoot,
      sessionId: selected.nawabariSessionId,
    });
    reconcileCheckpoint(input.store, selected.instanceId, selected.expectedBranch, evidence);
    const transitioned = await transitionTaskForWorkspace({
      ...contextInput(input, selected, ["committed"]),
      policy: input.policy,
      to: "pushed",
    });
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      task: transitioned.task,
      push: { ok: true, executionEvidence: evidence, nawabari: pushed, shadow },
      taskId: selected.taskId,
    };
  } catch (error) {
    return {
      ...failure(
        error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed",
        error instanceof Error ? error.message : String(error),
      ),
      shadow: shadowFailure(error),
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
  const adapter = dependencies.githubAdapter ?? new GithubAdapter({ workspaceRoot: input.workspaceRoot });
  const head: RevisionIdentity = { name: context.branch, revision: context.headCommit };
  const base: RevisionIdentity = { name: context.task.baseBranch, revision: context.task.baseCommit };
  const rendered = renderPullRequestBody(draft, input.policy.pullRequest);
  if (!rendered.ok) return failure("render-rejected", rendered.errors.join("; "));
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
        body: rendered.body,
      },
      taskId: selected.taskId,
    };
  }
  const opened = await openWorkflowPullRequest({
    adapter,
    store: input.store,
    taskId: selected.taskId,
    policy: input.policy,
    repository: repositoryResult.repository,
    title: input.title,
    head,
    base,
    draft: validDraft,
    providerDraft: input.providerDraft,
  });
  if (!opened.ok) return failure(opened.reason, opened.detail);
  return {
    ok: true,
    task: opened.task,
    pullRequest: opened.pullRequest,
    record: opened.record,
    reused: opened.reused,
    renderedBody: opened.renderedBody,
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

function validateProvidedCleanupPlan(
  plan: CleanupPlan,
  selected: ResolvedWorkflowTask,
  idempotencyKey: string | undefined,
): WorkflowWriteFailure | undefined {
  if (
    typeof plan !== "object" ||
    plan === null ||
    typeof plan.planId !== "string" ||
    typeof plan.planDigest !== "string"
  )
    return failure("invalid-input", "plan must be a complete cleanup plan");
  if (
    plan.task === undefined ||
    plan.task.taskId !== selected.taskId ||
    plan.task.instanceId !== selected.instanceId ||
    plan.repository === undefined ||
    plan.repository.instanceId !== selected.instanceId
  )
    return failure(
      "cleanup-plan-identity-mismatch",
      "cleanup plan does not belong to the selected task and repository",
    );
  if (idempotencyKey !== undefined && plan.planId !== idempotencyKey)
    return failure("cleanup-plan-identity-mismatch", "cleanup plan planId does not match idempotencyKey");
  return undefined;
}

function cleanupObserver(adapter: GithubAdapter): CleanupPullRequestObserver {
  return async (record) => {
    if (record.provider !== "github")
      return { state: "unknown", detail: `unsupported pull-request provider: ${record.provider}` };
    const observed = await adapter.viewPullRequest(record.prNumber, { provider: "github", id: record.repositoryId });
    if (!observed.ok) return { state: "unknown", detail: observed.error.message };
    const state = observed.value.lifecycleState;
    if (state === "merged") return { state: "merged", headSha: observed.value.head.revision };
    if (state === "open" || state === "draft") return { state: "open", headSha: observed.value.head.revision };
    if (state === "closed") return { state: "closed-unmerged", headSha: observed.value.head.revision };
    return { state: "unknown", detail: "provider returned an unknown pull-request lifecycle state" };
  };
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
  if (input.taskId !== undefined) {
    const existing = input.store.getTask(input.taskId as TaskId);
    if (existing?.lifecycleState === "cleaned" && existing.nawabariSessionId !== undefined) {
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
  const selected = await resolveWorkflowTask({ ...input, requireNawabari: input.dryRun !== true });
  if (!selected.ok) return selected;

  // Planning is a read-only orchestration operation. Legacy rows may still be
  // inspected here, but no legacy cleanup executor remains after cutover.
  if (input.dryRun === true && selected.nawabariSessionId === undefined) {
    if (input.plan !== undefined) {
      const planFailure = validateProvidedCleanupPlan(input.plan, selected, input.idempotencyKey);
      if (planFailure !== undefined) return planFailure;
    }
    const adapter = dependencies.githubAdapter ?? new GithubAdapter({ workspaceRoot: input.workspaceRoot });
    const planResult =
      input.plan === undefined
        ? await createCleanupPlan({
            workspaceRoot: input.workspaceRoot,
            store: input.store,
            taskId: selected.taskId,
            policy: input.policy.cleanup,
            protectedBranchPolicy: input.policy,
            idempotencyKey: input.idempotencyKey,
            pullRequestObserver: cleanupObserver(adapter),
          })
        : { ok: input.plan.status !== "blocked", plan: input.plan };
    return planResult.ok
      ? { ok: true, dryRun: true, plan: planResult.plan }
      : {
          ok: false,
          reason: "cleanup-plan-blocked",
          detail: planResult.plan.blockers.map((item) => item.detail).join("; "),
          dryRun: true,
          plan: planResult.plan,
        };
  }
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
