import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";
import type { CreateManagerSessionInput, ManagerSessionRecord } from "../workflow/state/store.js";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import { ManagerSessionService } from "./service.js";
import { defaultTaskRunInstruction, runManagedTask } from "../workflow/domain/managed-task-run.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";

class FakeRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: string[] = [];
  failStarts = 0;

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.40.0" };
  }

  async inspect(sessionName: string): Promise<ZellijObservedState> {
    return this.sessions.has(sessionName) ? "running" : "absent";
  }

  async start(input: { sessionName: string; cwd: string; command: string; args: readonly string[] }): Promise<void> {
    this.started.push(input.sessionName);
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      throw new Error("injected runtime launch failure");
    }
    this.sessions.add(input.sessionName);
  }

  async attach(): Promise<void> {}

  async terminate(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
  }

  binaryName(): string {
    return "fake-zellij";
  }
}

class FailManagerPersistenceOnceStore extends WorkflowSqliteStateStore {
  failNextManagerInsert = true;

  override createManagerSession(input: CreateManagerSessionInput): ManagerSessionRecord {
    if (this.failNextManagerInsert) {
      this.failNextManagerInsert = false;
      throw new Error("injected manager persistence failure");
    }
    return super.createManagerSession(input);
  }
}

function input(root: string, store: WorkflowSqliteStateStore, runtime: FakeRuntime, idempotencyKey: string) {
  const nawabari = new NawabariExecutionClient();
  const manager = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime,
    nawabari,
    agentCommands: { pi: { command: "fake-pi" } },
  });
  return {
    workspaceRoot: root,
    store,
    nawabari,
    manager,
    taskSlug: "run-task",
    issueRef: "333",
    branchType: "feat",
    agentKind: "pi",
    instruction: defaultTaskRunInstruction("333"),
    idempotencyKey,
  };
}

test("task run retries a persisted Manager record without creating another task or runtime identity", async (t) => {
  const root = createTempGitRepo(t);
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const runtime = new FakeRuntime();
  runtime.failStarts = 1;
  const first = await runManagedTask(input(root, store, runtime, "task-run-retry-runtime"));

  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.recoverable, true);
  assert.ok(first.task?.taskId);
  assert.ok(first.execution?.sessionId);
  assert.ok(first.manager?.sessionId);

  const second = await runManagedTask(input(root, store, runtime, "task-run-retry-runtime"));
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;
  assert.equal(second.task?.taskId, first.task?.taskId);
  assert.equal(second.execution.sessionId, first.execution?.sessionId);
  assert.equal(second.manager.sessionId, first.manager?.sessionId);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 1);
  assert.equal(runtime.started.length, 2);
});

test("task run retries a failure before task creation without inventing an external identity", async (t) => {
  const root = createTempGitRepo(t);
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const runtime = new FakeRuntime();
  let attempts = 0;
  const authority: ManagerExecutionAuthority = {
    async start() {
      attempts += 1;
      throw new Error("injected task-start failure before reservation");
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: undefined, receipt: undefined };
    },
  };
  const nawabari = new NawabariExecutionClient();
  const manager = new ManagerSessionService({ workspaceRoot: root, store, runtime, nawabari, executionAuthority: authority });
  const runInput = input(root, store, runtime, "task-run-before-task");
  runInput.manager = manager;
  runInput.nawabari = nawabari;

  const first = await runManagedTask(runInput);
  const second = await runManagedTask(runInput);
  for (const result of [first, second]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.recoverable, false);
      assert.equal(result.task, undefined);
      assert.equal(result.execution, undefined);
      assert.equal(result.manager, undefined);
    }
  }
  assert.equal(attempts, 2);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.equal(runtime.started.length, 0);
});

test("task run recovers after task/execution creation but before Manager persistence", async (t) => {
  const root = createTempGitRepo(t);
  const store = new FailManagerPersistenceOnceStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const runtime = new FakeRuntime();
  const first = await runManagedTask(input(root, store, runtime, "task-run-retry-persistence"));

  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.recoverable, true);
  assert.ok(first.task?.taskId);
  assert.ok(first.execution?.sessionId);
  assert.equal(first.manager, undefined);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 0);

  const second = await runManagedTask(input(root, store, runtime, "task-run-retry-persistence"));
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;
  assert.equal(second.task?.taskId, first.task?.taskId);
  assert.equal(second.execution.sessionId, first.execution?.sessionId);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listManagerSessions(root).length, 1);
  assert.equal(runtime.started.length, 1);
});
