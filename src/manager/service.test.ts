import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import type { ZellijRuntime, ZellijObservedState } from "./zellij.js";
import { buildManagerLaunchInvocation, ManagerError, ManagerSessionService } from "./service.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";

class FakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: { sessionName: string; cwd: string; command: string; args: readonly string[] }[] = [];
  readonly terminated: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.0.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.sessions.has(sessionName) ? "running" : "absent";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    this.started.push(input);
    this.sessions.add(input.sessionName);
  }

  async attach(sessionName: string): Promise<void> {
    if (!this.sessions.has(sessionName)) throw new Error("missing fake session");
  }

  async terminate(sessionName: string): Promise<void> {
    this.terminated.push(sessionName);
    this.sessions.delete(sessionName);
  }
}

test("Manager starts concurrent task-bound Codex sessions on distinct managed worktrees", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const [first, second] = await Promise.all([
    service.start({ instruction: "first; $(not shell)", taskSlug: "first-task", issueRef: "801", branchType: "fix" }),
    service.start({ instruction: "second", taskSlug: "second-task", issueRef: "802", branchType: "fix" }),
  ]);
  assert.equal(first.agentKind, "codex");
  assert.equal(second.agentKind, "codex");
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.runtimeName, second.runtimeName);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.equal(first.lifecycleState, "running");
  assert.equal(second.lifecycleState, "running");
  assert.deepEqual(
    runtime.started.map((entry) => entry.command),
    ["codex", "codex"],
  );
  assert.deepEqual(
    runtime.started.find((entry) => entry.args.includes("first; $(not shell)"))?.args,
    ["--", "first; $(not shell)"],
  );
  assert.ok(runtime.started.every((entry) => entry.cwd.includes(".mottainai/worktrees")));

  runtime.sessions.delete(first.runtimeName);
  const reconciled = await service.list();
  assert.equal(reconciled.find((session) => session.sessionId === first.sessionId)?.lifecycleState, "exited");
  const stopped = await service.stop(second.sessionId);
  assert.equal(stopped.lifecycleState, "stopped");
  assert.deepEqual(runtime.terminated, [second.runtimeName]);
});

test("Manager records failed launches without leaving a running runtime claim", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  runtime.start = async () => {
    throw new Error("fake launch failed");
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  await assert.rejects(service.start({ instruction: "fail" }), /fake launch failed/);
  const sessions = await service.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.lifecycleState, "failed");
  assert.equal(runtime.sessions.size, 0);
});

test("Manager reconciles a deleted managed worktree as failed and terminates its selected runtime", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({
    instruction: "missing worktree",
    taskSlug: "missing-worktree",
    issueRef: "803",
    branchType: "fix",
  });
  runGit(["worktree", "remove", "--force", session.worktreePath], root);
  const reconciled = await service.list();
  assert.equal(reconciled[0]?.lifecycleState, "failed");
  assert.deepEqual(runtime.terminated, [session.runtimeName]);
});

test("launch profiles construct deterministic argv without shell interpolation", () => {
  assert.deepEqual(
    buildManagerLaunchInvocation({
      agentKind: "codex",
      model: "o4-mini",
      instruction: "$(not shell); --flag",
    }),
    { agentKind: "codex", command: "codex", args: ["--model", "o4-mini", "--", "$(not shell); --flag"] },
  );
  assert.deepEqual(
    buildManagerLaunchInvocation({ agentKind: "claude", instruction: "review this" }),
    { agentKind: "claude", command: "claude", args: ["--print", "--", "review this"] },
  );
});

test("Manager starts Claude sessions and exposes bounded status/filter projections", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ agentKind: "claude", instruction: "claude task", issueRef: undefined });
  assert.equal(session.agentKind, "claude");
  assert.equal(session.launchProfile, "claude");
  assert.deepEqual(session.launchArgs, ["--print", "--", "claude task"]);
  assert.equal(session.runtimeState, "running");
  assert.equal((await service.list({ agentKind: "claude", limit: 1 })).length, 1);
  assert.equal((await service.list({ agentKind: "codex" })).length, 0);
});

test("Manager restart reuses the selected persisted execution context only after runtime disappearance", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const firstService = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await firstService.initialize();
  const created = await firstService.start({ instruction: "restart me" });
  runtime.sessions.delete(created.runtimeName);

  const restartedManager = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await restartedManager.initialize();
  const stale = await restartedManager.get(created.sessionId);
  assert.equal(stale.runtimeState, "stale");
  assert.equal(stale.reconciliationState, "unresolved");
  const relaunched = await restartedManager.restart(created.sessionId);
  assert.equal(relaunched.runtimeState, "running");
  assert.equal(relaunched.restartCount, 1);
  assert.equal(relaunched.worktreePath, created.worktreePath);
});

test("Manager rejects restart when the runtime name is present but its managed identity is unresolved", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ instruction: "identity check" });
  runtime.sessions.delete(session.runtimeName);
  const stale = await service.get(session.sessionId);
  assert.equal(stale.runtimeState, "stale");
  runtime.sessions.add(session.runtimeName);
  await assert.rejects(
    service.restart(session.sessionId),
    (error: unknown) => error instanceof ManagerError && error.code === "session_restart_rejected",
  );
});

test("Manager restart is rejected after semantic task completion", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const authority: ManagerExecutionAuthority = {
    async start(input) {
      return {
        context: {
          taskId: undefined,
          executionSessionId: undefined,
          worktreeId: undefined,
          worktreePath: input.workspaceRoot,
          branchName: undefined,
          taskSlug: undefined,
          issueRef: undefined,
          branchType: undefined,
          semanticLifecycleState: "merged",
        },
      };
    },
    async validate() { return { ok: true }; },
    async observe(context) { return { semanticLifecycleState: context.semanticLifecycleState, status: "task is merged", receipt: undefined }; },
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  await service.initialize();
  const session = await service.start({ instruction: "completed semantic task" });
  runtime.sessions.delete(session.runtimeName);
  await service.get(session.sessionId);
  await assert.rejects(service.restart(session.sessionId), /semantic task lifecycle is merged/);
});
