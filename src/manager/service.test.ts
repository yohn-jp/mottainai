import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import type { ZellijRuntime, ZellijObservedState } from "./zellij.js";
import { buildManagerLaunchInvocation, ManagerError, ManagerSessionService } from "./service.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import type { ManagerSessionId } from "../workflow/state/store.js";

class FakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: { sessionName: string; cwd: string; command: string; args: readonly string[] }[] = [];
  readonly attached: string[] = [];
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
    this.attached.push(sessionName);
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
  assert.equal(runtime.started.length, 2);
  assert.deepEqual(
    runtime.started.map((entry) => entry.command),
    ["codex", "codex"],
  );
  assert.deepEqual(runtime.started.find((entry) => entry.args.includes("first; $(not shell)"))?.args, [
    "--",
    "first; $(not shell)",
  ]);
  // The canonical worktree root belongs to Nawabari; Manager only consumes
  // the returned launch directory and must not prescribe Mottainai's former root.
  assert.ok(runtime.started.every((entry) => entry.cwd !== root));

  await service.openTerminal(first.sessionId);
  assert.deepEqual(runtime.attached, [first.runtimeName]);
  const stopped = await service.stop(second.sessionId);
  assert.equal(stopped.lifecycleState, "stopped");
  assert.deepEqual(runtime.terminated, [second.runtimeName]);
  assert.equal(runtime.sessions.has(first.runtimeName), true);
  runtime.sessions.delete(first.runtimeName);
  const reconciled = await service.list();
  assert.equal(reconciled.find((session) => session.sessionId === first.sessionId)?.lifecycleState, "exited");
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
  assert.deepEqual(buildManagerLaunchInvocation({ agentKind: "claude", instruction: "review this" }), {
    agentKind: "claude",
    command: "claude",
    args: ["--", "review this"],
  });
  assert.deepEqual(
    buildManagerLaunchInvocation({
      agentKind: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4",
      instruction: "$(not shell); opaque Pi instruction",
    }),
    {
      agentKind: "pi",
      command: "pi",
      args: ["--provider", "anthropic", "--model", "claude-sonnet-4", "--", "$(not shell); opaque Pi instruction"],
    },
  );
});

test("Manager launches and persists Pi as an explicit profile in the Nawabari execution context", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    agentCommands: { pi: { command: "fake-pi" } },
  });
  await service.initialize();
  const session = await service.start({
    agentKind: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4",
    instruction: "preserve $(this) as an argv value",
    taskSlug: "pi-task",
    issueRef: "901",
    branchType: "feat",
  });

  assert.equal(session.agentKind, "pi");
  assert.equal(session.launchProfile, "pi");
  assert.equal(session.executionMode, "task-bound");
  assert.ok(session.taskId);
  assert.equal(session.provider, "anthropic");
  assert.notEqual(session.worktreePath, root);
  assert.deepEqual(session.launchArgs, [
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4",
    "--",
    "preserve $(this) as an argv value",
  ]);
  assert.deepEqual(runtime.started[0], {
    sessionName: session.runtimeName,
    cwd: session.worktreePath,
    command: "fake-pi",
    args: session.launchArgs,
  });
  assert.equal((await service.list({ agentKind: "pi" })).length, 1);
  assert.equal(store.getManagerSession(session.sessionId)?.provider, "anthropic");

  runtime.sessions.delete(session.runtimeName);
  const stale = await service.get(session.sessionId);
  assert.equal(stale.runtimeState, "stale");
  const restarted = await service.restart(session.sessionId);
  assert.equal(restarted.runtimeState, "running");
  assert.equal(restarted.provider, "anthropic");
  assert.deepEqual(runtime.started.at(-1), {
    sessionName: session.runtimeName,
    cwd: session.worktreePath,
    command: "fake-pi",
    args: session.launchArgs,
  });
});

test("Missing Pi fails explicitly without falling back to another agent", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  runtime.start = async (input) => {
    if (input.command === "pi") throw new Error("pi executable not found");
    runtime.started.push(input);
    runtime.sessions.add(input.sessionName);
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  await assert.rejects(service.start({ agentKind: "pi", instruction: "must not fallback" }), /pi executable not found/);
  const [session] = await service.list();
  assert.equal(session?.agentKind, "pi");
  assert.equal(session?.launchCommand, "pi");
  assert.equal(session?.lifecycleState, "failed");
  assert.equal(runtime.started.length, 0);
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
  assert.deepEqual(session.launchArgs, ["--", "claude task"]);
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
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: "task is merged", receipt: undefined };
    },
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  await service.initialize();
  const session = await service.start({ instruction: "completed semantic task" });
  runtime.sessions.delete(session.runtimeName);
  await service.get(session.sessionId);
  await assert.rejects(service.restart(session.sessionId), /semantic task lifecycle is merged/);
});

test("Manager serializes restart and stop operations for the selected session", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const session = await service.start({ instruction: "serialize me" });
  await service.stop(session.sessionId);

  let releaseStart!: () => void;
  let signalStart!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  runtime.start = async (input) => {
    runtime.started.push(input);
    signalStart();
    await startGate;
    runtime.sessions.add(input.sessionName);
  };

  const restarted = service.restart(session.sessionId);
  await startEntered;
  const duplicateRestart = service.restart(session.sessionId);
  const stopped = service.stop(session.sessionId);
  releaseStart();

  assert.equal((await restarted).runtimeState, "running");
  await assert.rejects(duplicateRestart, /restart is only valid for a non-running managed runtime/);
  assert.equal((await stopped).runtimeState, "stopped");
  assert.equal(runtime.started.length, 2, "only the initial start and one restart may launch an agent");
});

test("Manager refreshes stopped-session semantics before deciding whether restart is valid", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  let semanticLifecycleState: "active" | "merged" = "active";
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
          semanticLifecycleState,
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe() {
      return { semanticLifecycleState, status: `task is ${semanticLifecycleState}`, receipt: undefined };
    },
  };
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, executionAuthority: authority });
  await service.initialize();
  const session = await service.start({ instruction: "do not relaunch completed work" });
  await service.stop(session.sessionId);
  semanticLifecycleState = "merged";

  await assert.rejects(service.restart(session.sessionId), /semantic task lifecycle is merged/);
  assert.equal(store.getManagerSession(session.sessionId)?.semanticLifecycleState, "merged");
});

test("Manager keeps an older active session visible ahead of the bounded recent history", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const runtime = new FakeRuntime();
  const activeId = "00000000-0000-4000-8000-000000000001" as ManagerSessionId;
  const activeRuntime = "mottainai-00000000-0000-4000-8000-000000000001";
  store.createManagerSession({
    sessionId: activeId,
    workspaceRoot: root,
    worktreePath: root,
    agentKind: "codex",
    launchCommand: "codex",
    launchArgs: ["--", "active"],
    runtimeName: activeRuntime,
    lifecycleState: "running",
    runtimeState: "running",
    startedAt: 1,
  });
  runtime.sessions.add(activeRuntime);
  for (let index = 0; index < 501; index += 1) {
    const suffix = String(index + 2).padStart(12, "0");
    store.createManagerSession({
      sessionId: `00000000-0000-4000-8000-${suffix}` as ManagerSessionId,
      workspaceRoot: root,
      worktreePath: root,
      agentKind: "codex",
      launchCommand: "codex",
      launchArgs: ["--", "recent"],
      runtimeName: `mottainai-00000000-0000-4000-8000-${suffix}`,
      lifecycleState: "stopped",
      runtimeState: "stopped",
      startedAt: index + 2,
    });
  }

  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime });
  await service.initialize();
  const listed = await service.list();
  assert.equal(service.health().sessions.active, 1);
  assert.equal(listed.length, 500);
  assert.equal(listed[0]?.sessionId, activeId);
});
