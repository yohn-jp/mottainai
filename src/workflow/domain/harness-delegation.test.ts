import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { ManagerSessionService } from "../../manager/service.js";
import type { ZellijObservedState, ZellijRuntime } from "../../manager/zellij.js";
import { NawabariExecutionClient } from "../nawabari.js";
import { resolveRepositoryIdentity } from "./identity.js";
import { transitionTask } from "./task-lifecycle.js";
import type { ManagerExecutionAuthority } from "./manager-execution.js";
import { HarnessDelegationService } from "./harness-delegation.js";
import type { ManagerSessionId, TaskId, WorkflowStateStore } from "../state/store.js";

class FakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly forced = new Map<string, ZellijObservedState>();
  readonly terminated: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.44.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.forced.get(sessionName) ?? (this.sessions.has(sessionName) ? "running" : "absent");
  }

  async start(input: { sessionName: string }): Promise<void> {
    this.sessions.add(input.sessionName);
  }

  async attach(): Promise<void> {}

  async terminate(sessionName: string): Promise<void> {
    this.terminated.push(sessionName);
    this.sessions.delete(sessionName);
  }

  binaryName(): string {
    return "fake-zellij";
  }
}

/**
 * Hermetic harness stack: a real ManagerSessionService (so idempotency,
 * lifecycle, and stop/reconcile logic run for real) with a fake execution
 * authority standing in for Nawabari, and a real HarnessDelegationService on
 * top of it.
 */
function buildHarness(t: TestContext): {
  root: string;
  store: WorkflowStateStore;
  runtime: FakeRuntime;
  harness: HarnessDelegationService;
} {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) throw new Error("repository identity resolution failed");
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const authority: ManagerExecutionAuthority = {
    async start(input) {
      if (input.taskSlug === undefined) {
        return {
          context: {
            taskId: undefined,
            executionSessionId: undefined,
            worktreeId: undefined,
            worktreePath: root,
            branchName: undefined,
            taskSlug: undefined,
            issueRef: undefined,
            branchType: undefined,
            semanticLifecycleState: "unbound",
          },
        };
      }
      const reserved = store.reserveTask({
        instanceId: identity.identity.instanceId,
        taskSlug: input.taskSlug,
        issueRef: input.issueRef,
        baseBranch: "main",
        baseCommit: runGit(["rev-parse", "HEAD"], root),
        allowMultipleActiveTasksPerIssue: true,
      });
      if (!reserved.ok) throw new Error(`task already reserved: ${reserved.existingTask.taskId}`);
      const active = transitionTask(store, reserved.task.taskId, "active");
      if (!active.ok) throw new Error(active.blocked.blockingRule);
      return {
        context: {
          taskId: reserved.task.taskId,
          executionSessionId: `nawabari-${reserved.task.taskId}`,
          worktreeId: undefined,
          worktreePath: root,
          branchName: `feat/${input.taskSlug}`,
          taskSlug: input.taskSlug,
          issueRef: input.issueRef,
          branchType: input.branchType,
          semanticLifecycleState: active.task.lifecycleState,
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      const task = context.taskId === undefined ? undefined : store.getTask(context.taskId);
      return { semanticLifecycleState: task?.lifecycleState ?? "unbound", status: undefined, receipt: undefined };
    },
  };
  const runtime = new FakeRuntime();
  const manager = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  const harness = new HarnessDelegationService({
    defaultWorkspaceRoot: root,
    store: async () => store,
    nawabari: new NawabariExecutionClient(),
    managerForWorkspace: async () => manager,
  });
  return { root, store, runtime, harness };
}

test("delegate rejects reusing an idempotency key for a materially different request", async (t) => {
  const { root, store, harness } = buildHarness(t);
  const first = await harness.delegate({
    goal: "goal A",
    idempotencyKey: "harness-idem-conflict",
    constraints: { taskSlug: "idem-conflict-task", issueRef: "700" },
  });
  assert.equal(first.ok, true);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 1);

  const conflicting = await harness.delegate({
    goal: "goal B - materially different instruction",
    idempotencyKey: "harness-idem-conflict",
    constraints: { taskSlug: "idem-conflict-task", issueRef: "700" },
  });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error?.class, "lifecycle_conflict");
  assert.equal(conflicting.error?.code, "idempotency_conflict");
  // The reused key must never silently reuse the prior work for a different
  // request, nor create a second, incorrect work item.
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 1);
});

test("delegate accepts an identical retry on the same idempotency key as the original work", async (t) => {
  const { root, store, harness } = buildHarness(t);
  const request = {
    goal: "identical retry goal",
    idempotencyKey: "harness-idem-retry",
    constraints: { taskSlug: "idem-retry-task", issueRef: "701" },
  };
  const first = await harness.delegate(request);
  assert.equal(first.ok, true);
  const retry = await harness.delegate(request);
  assert.equal(retry.ok, true);
  assert.equal(retry.work?.workId, first.work?.workId);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 1);
});

test("cancelWork never reports cancelled while the managed runtime stop is refused/unresolved", async (t) => {
  const { root, store, runtime, harness } = buildHarness(t);
  const delegated = await harness.delegate({
    goal: "work to cancel",
    idempotencyKey: "harness-cancel-refused",
    constraints: { taskSlug: "cancel-refused-task", issueRef: "702" },
  });
  assert.equal(delegated.ok, true);
  const workId = delegated.work!.workId;
  const sessions = store.listManagerSessions(root);
  assert.equal(sessions.length, 1);
  const runtimeName = sessions[0]!.runtimeName;

  // Identity verification failure: Manager's stop refuses to terminate.
  runtime.forced.set(runtimeName, "unresolved");
  const refused = await harness.cancelWork({ workId, reason: "verification failure" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "blocked");
  assert.equal(refused.error?.class, "lifecycle_conflict");
  assert.equal(refused.error?.code, "cancel_stop_unresolved");
  // The task must stay non-terminal: cancellation was never committed while
  // the runtime's identity could not be verified as stopped.
  assert.equal(store.getTask(workId as TaskId)?.lifecycleState, "active");
  assert.deepEqual(runtime.terminated, []);

  // Once the runtime is confirmably non-active, retrying cancel must succeed
  // and only then does the harness report terminal cancellation.
  runtime.forced.set(runtimeName, "exited");
  const cancelled = await harness.cancelWork({ workId, reason: "confirmed exited" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.getTask(workId as TaskId)?.lifecycleState, "abandoned");
});

test("inspect resolves the single canonical active Manager session when a historical row shares the task", async (t) => {
  const { root, store, harness } = buildHarness(t);
  const delegated = await harness.delegate({
    goal: "canonical session work",
    idempotencyKey: "harness-canonical-session",
    constraints: { taskSlug: "canonical-task", issueRef: "703" },
  });
  assert.equal(delegated.ok, true);
  const workId = delegated.work!.workId;

  // A stopped, historical session row for the same task must not make
  // control ambiguous - only one session is actually active.
  store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000901" as ManagerSessionId,
    workspaceRoot: root,
    taskId: workId as TaskId,
    executionSessionId: "nawabari-historical-901",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/canonical-task",
    agentKind: "codex",
    launchProfile: "codex",
    instruction: "stale historical instruction",
    launchCommand: "codex",
    launchArgs: ["--", "stale historical instruction"],
    runtimeName: "mottainai-canonical-historical",
    lifecycleState: "stopped",
    runtimeState: "stopped",
    semanticLifecycleState: "active",
  });
  assert.equal(store.listManagerSessions(root).filter((session) => session.taskId === workId).length, 2);

  const inspected = await harness.inspect(workId);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.work?.workId, workId);
});

test("inspect fails closed only on genuine ambiguity: two simultaneously active Manager sessions for one task", async (t) => {
  const { root, store, harness } = buildHarness(t);
  const delegated = await harness.delegate({
    goal: "ambiguous session work",
    idempotencyKey: "harness-ambiguous-session",
    constraints: { taskSlug: "ambiguous-task", issueRef: "704" },
  });
  assert.equal(delegated.ok, true);
  const workId = delegated.work!.workId;

  // A second, simultaneously active session claims the same task: genuine,
  // unresolvable ambiguity over which runtime actually owns control.
  store.createManagerSession({
    sessionId: "00000000-0000-4000-8000-000000000902" as ManagerSessionId,
    workspaceRoot: root,
    taskId: workId as TaskId,
    executionSessionId: "nawabari-active-902",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/ambiguous-task",
    agentKind: "codex",
    launchProfile: "codex",
    instruction: "second active instruction",
    launchCommand: "codex",
    launchArgs: ["--", "second active instruction"],
    runtimeName: "mottainai-ambiguous-second",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
  });

  const inspected = await harness.inspect(workId);
  assert.equal(inspected.ok, false);
  assert.equal(inspected.status, "blocked");
  assert.equal(inspected.error?.class, "lifecycle_conflict");
  assert.equal(inspected.error?.code, "multiple_manager_sessions");
});
