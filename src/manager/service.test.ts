import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import type { ZellijRuntime, ZellijObservedState } from "./zellij.js";
import { ManagerSessionService } from "./service.js";

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
