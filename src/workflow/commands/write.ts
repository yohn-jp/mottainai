import { renderPullRequestBody, type PullRequestBodyDraft } from "../domain/pr-render.js";
import { createCleanupPlan, type CleanupPlan, type CleanupPullRequestObserver } from "../domain/cleanup-plan.js";
import { executeCleanup, type CleanupExecutionResult } from "../domain/cleanup-execute.js";
import { commitTask, verifyCommit, type CommitOperationInput, type StructuredCommitMessage } from "../git/commit.js";
import { runGitCommand, verifyWorkflowContext, type WorkflowContextInput } from "../git/context.js";
import { pushTask, verifyPush, type PushOperationInput } from "../git/push.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import {
  getTaskStatusForWorkspace,
  transitionTaskForWorkspace,
  type WorkspaceTaskTransitionResult,
} from "../domain/task.js";
import type { RepositoryIdentity, RevisionIdentity } from "../providers/model.js";
import { GithubAdapter, openWorkflowPullRequest } from "../providers/github.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type { TaskId, WorktreeId, WorkflowStateStore } from "../state/store.js";

export interface WorkflowWriteDependencies {
  githubAdapter?: GithubAdapter;
}

export interface WorkflowTaskSelector {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId?: string;
}

export interface ResolvedWorkflowTask {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  worktreeId: WorktreeId | undefined;
  expectedBranch: string | undefined;
}

export type WorkflowWriteFailure = {
  ok: false;
  reason: string;
  detail: string;
};

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

/** Resolve an omitted task only when the current workspace identifies exactly one active task. */
export async function resolveWorkflowTask(
  input: WorkflowTaskSelector,
): Promise<WorkflowWriteResult<ResolvedWorkflowTask>> {
  if (input.taskId !== undefined) {
    const taskIdValue = nonEmpty(input.taskId, "taskId");
    if (typeof taskIdValue !== "string") return taskIdValue;
    const task = input.store.getTask(taskIdValue as TaskId);
    if (task === undefined) return failure("task-not-found", `task was not found: ${taskIdValue}`);
    return taskContext(input.store, task);
  }

  const located = await getTaskStatusForWorkspace(input.workspaceRoot, input.store);
  if (!located.ok) return failure("repository-identity-unavailable", located.reason);
  if (!located.active)
    return failure("task-identity-ambiguous", "no active workflow task is associated with the current worktree");
  return taskContext(input.store, located.status.task);
}

function taskContext(
  store: WorkflowStateStore,
  task: { taskId: TaskId; instanceId: RepositoryInstanceId },
): WorkflowWriteResult<ResolvedWorkflowTask> {
  const worktrees = store.listWorktreesForTask(task.taskId).filter((worktree) => worktree.status === "active");
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
    workspaceRoot: input.workspaceRoot,
    store: input.store,
    taskId: task.taskId,
    repositoryInstanceId: task.instanceId,
    worktreeId: task.worktreeId,
    expectedBranch: task.expectedBranch,
    ...(allowedLifecycleStates === undefined ? {} : { allowedLifecycleStates }),
  };
}

export interface CommitWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  message: StructuredCommitMessage;
  includePaths?: readonly string[];
  dryRun?: boolean;
}

export async function commitWorkflowTask(input: CommitWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
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

  const committed = await commitTask(operation);
  if (!committed.ok) return failure(committed.code, committed.detail);
  const transitioned = await transitionTaskForWorkspace({
    ...contextInput(input, selected),
    policy: input.policy,
    to: "committed",
  });
  if (!transitioned.ok) return transitioned;
  return { ok: true, task: transitioned.task, commit: committed, taskId: selected.taskId };
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

export async function pushWorkflowTask(input: PushWorkflowInput): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  const force = input.force === true;
  const createUpstream = input.createUpstream === true;
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
  if (!verification.ok) return failure(verification.code, verification.detail);
  if (input.dryRun === true) {
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

  const pushed = await pushTask(operation);
  if (!pushed.ok) return failure(pushed.code, pushed.detail);
  const transitioned = await transitionTaskForWorkspace({
    ...contextInput(input, selected, ["committed"]),
    policy: input.policy,
    to: "pushed",
  });
  if (!transitioned.ok) return transitioned;
  return { ok: true, task: transitioned.task, push: pushed, taskId: selected.taskId };
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
  if (input.sections !== undefined && (typeof input.sections !== "object" || input.sections === null || Array.isArray(input.sections)))
    return failure("invalid-input", "sections must be an object");
  const sections = input.sections ?? {};
  for (const [heading, value] of Object.entries(sections)) {
    if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      return failure("invalid-input", `sections.${heading} must be a string or string array`);
    }
  }
  if (input.issueReference !== undefined && typeof input.issueReference !== "string")
    return failure("invalid-input", "issueReference must be a string");
  if (input.acceptanceCriteria !== undefined && (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.some((item) => typeof item !== "string")))
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
  },
): Promise<WorkflowWriteResult> {
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
  const result: WorkspaceTaskTransitionResult = await transitionTaskForWorkspace({
    ...contextInput(input, selected, input.allowedLifecycleStates),
    policy: input.policy,
    to: input.to,
    dryRun: input.dryRun,
  });
  if (!result.ok) return result;
  return { ok: true, dryRun: input.dryRun === true, task: result.task, taskId: selected.taskId, transition: input.to };
}

export function finishWorkflowTask(
  input: WorkflowTaskSelector & { policy: WorkflowPolicyDocument; dryRun?: boolean },
): Promise<WorkflowWriteResult> {
  return transitionWorkflowTask({ ...input, to: "merged", allowedLifecycleStates: ["pull-request-open"] });
}

export function abandonWorkflowTask(
  input: WorkflowTaskSelector & { policy: WorkflowPolicyDocument; dryRun?: boolean },
): Promise<WorkflowWriteResult> {
  return transitionWorkflowTask({
    ...input,
    to: "abandoned",
    allowedLifecycleStates: ["active", "committed", "pushed", "pull-request-open", "orphaned"],
  });
}

export interface CleanupWorkflowInput extends WorkflowTaskSelector {
  policy: WorkflowPolicyDocument;
  dryRun?: boolean;
  idempotencyKey?: string;
  plan?: CleanupPlan;
  owner?: string;
}

function validateProvidedCleanupPlan(
  plan: CleanupPlan,
  selected: ResolvedWorkflowTask,
  idempotencyKey: string | undefined,
): WorkflowWriteFailure | undefined {
  if (typeof plan !== "object" || plan === null || typeof plan.planId !== "string" || typeof plan.planDigest !== "string")
    return failure("invalid-input", "plan must be a complete cleanup plan");
  if (
    plan.task === undefined ||
    plan.task.taskId !== selected.taskId ||
    plan.task.instanceId !== selected.instanceId ||
    plan.repository === undefined ||
    plan.repository.instanceId !== selected.instanceId
  )
    return failure("cleanup-plan-identity-mismatch", "cleanup plan does not belong to the selected task and repository");
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
): Promise<WorkflowWriteResult<{ plan: CleanupPlan; execution?: CleanupExecutionResult; dryRun?: boolean }>> {
  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey))
    return failure("invalid-input", "idempotencyKey must be a bounded branch-safe token");
  const selected = await resolveWorkflowTask(input);
  if (!selected.ok) return selected;
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
  if (input.dryRun === true) {
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
  const execution = await executeCleanup({
    plan: planResult.plan,
    store: input.store,
    owner: input.owner,
    pullRequestObserver: cleanupObserver(adapter),
  });
  return execution.ok
    ? { ok: true, plan: planResult.plan, execution }
    : {
        ok: false,
        reason: "cleanup-blocked",
        detail: execution.cleanupError ?? execution.blockers.map((item) => item.detail).join("; "),
        plan: planResult.plan,
        execution,
      };
}
