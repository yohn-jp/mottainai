import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { resolveRepositoryIdentity } from "../workflow/domain/identity.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import { transitionTask } from "../workflow/domain/task-lifecycle.js";
import type { ManagerSessionId, TaskId } from "../workflow/state/store.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";
import { ManagerError, ManagerSessionService } from "./service.js";

class ContinueRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: string[] = [];
  readonly terminated: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.44.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.sessions.has(sessionName) ? "running" : "absent";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    this.started.push(input.args.at(-1) ?? "");
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

function fixture(t: TestContext): {
  service: ManagerSessionService;
  runtime: ContinueRuntime;
  store: ReturnType<typeof createWorkflowStore>;
  sessionId: ManagerSessionId;
  taskId: TaskId;
} {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const identity = resolveRepositoryIdentity(root);
  if (!identity.ok) throw new Error("repository identity resolution failed");
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: "continue-task",
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("task reservation failed");
  assert.equal(transitionTask(store, reserved.task.taskId, "active").ok, true);

  const authority: ManagerExecutionAuthority = {
    async start() {
      throw new Error("not used");
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      const task = context.taskId === undefined ? undefined : store.getTask(context.taskId);
      return {
        semanticLifecycleState: task?.lifecycleState ?? "unbound",
        status: undefined,
        receipt: undefined,
      };
    },
  };
  const runtime = new ContinueRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  const sessionId = "00000000-0000-4000-8000-000000000548" as ManagerSessionId;
  const session = store.createManagerSession({
    sessionId,
    workspaceRoot: root,
    taskId: reserved.task.taskId,
    executionSessionId: "nawabari-session-548",
    executionMode: "task-bound",
    worktreePath: root,
    branchName: "feat/continue-task",
    agentKind: "codex",
    launchProfile: "codex",
    instruction: "initial instruction",
    launchCommand: "codex",
    launchArgs: ["--", "initial instruction"],
    runtimeName: "mottainai-continue-runtime",
    lifecycleState: "running",
    runtimeState: "running",
    semanticLifecycleState: "active",
  });
  runtime.sessions.add(session.runtimeName);
  return { service, runtime, store, sessionId, taskId: reserved.task.taskId };
}

test("Manager continue relaunches the same task-bound session with the follow-up", async (t) => {
  const { service, runtime, sessionId, taskId } = fixture(t);
  const continued = await service.continueWork(sessionId, "follow-up instruction");

  assert.equal(continued.sessionId, sessionId);
  assert.equal(continued.taskId, taskId);
  assert.match(continued.instruction, /initial instruction[\s\S]*follow-up instruction/u);
  assert.equal(continued.launchArgs.at(-1), continued.instruction);
  assert.equal(continued.restartCount, 1);
  assert.deepEqual(runtime.terminated, [continued.runtimeName]);
  assert.deepEqual(runtime.started, [continued.instruction]);
});

test("Manager continue serializes concurrent follow-ups without losing either instruction", async (t) => {
  const { service, runtime, store, sessionId } = fixture(t);

  await Promise.all([
    service.continueWork(sessionId, "first concurrent follow-up"),
    service.continueWork(sessionId, "second concurrent follow-up"),
  ]);

  const current = store.getManagerSession(sessionId);
  assert.ok(current);
  assert.match(
    current.instruction,
    /initial instruction[\s\S]*first concurrent follow-up[\s\S]*second concurrent follow-up/u,
  );
  assert.equal(current.restartCount, 2);
  assert.equal(runtime.terminated.length, 2);
  assert.equal(runtime.started.length, 2);
  assert.match(runtime.started[0] ?? "", /first concurrent follow-up/u);
  assert.doesNotMatch(runtime.started[0] ?? "", /second concurrent follow-up/u);
  assert.match(runtime.started[1] ?? "", /first concurrent follow-up[\s\S]*second concurrent follow-up/u);
});

test("Manager continue rejects a terminal task without touching the runtime", async (t) => {
  const { service, runtime, store, sessionId, taskId } = fixture(t);
  assert.equal(transitionTask(store, taskId, "committed").ok, true);

  await assert.rejects(
    service.continueWork(sessionId, "must not run"),
    (error: unknown) => error instanceof ManagerError && error.code === "session_continue_rejected",
  );
  assert.deepEqual(runtime.terminated, []);
  assert.deepEqual(runtime.started, []);
});
