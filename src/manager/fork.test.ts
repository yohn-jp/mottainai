import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { fakeNawabari } from "../test-support/nawabari-fixture.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";
import { ManagerSessionService } from "./service.js";
import type {
  AttachCanonForkLaunchInput,
  CanonCheckpointFreshnessInputs,
  CanonForkLaunchRecord,
} from "../workflow/state/store.js";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";

class FailForkAttachmentStore extends WorkflowSqliteStateStore {
  failNextAttachment = true;

  override attachCanonForkLaunch(input: AttachCanonForkLaunchInput): CanonForkLaunchRecord {
    if (this.failNextAttachment) {
      this.failNextAttachment = false;
      throw new Error("injected fork attachment persistence failure");
    }
    return super.attachCanonForkLaunch(input);
  }
}

class ForkRuntime implements ZellijRuntime {
  readonly sessions = new Set<string>();
  readonly started: string[] = [];
  constructor(private readonly failStart = false) {}
  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.0.0" };
  }
  async inspect(name: string): Promise<ZellijObservedState> {
    return this.sessions.has(name) ? "running" : "absent";
  }
  async start(input: { sessionName: string }): Promise<void> {
    if (this.failStart) throw new Error("injected zellij failure");
    this.started.push(input.sessionName);
    this.sessions.add(input.sessionName);
  }
  async attach(): Promise<void> {}
  async terminate(name: string): Promise<void> {
    this.sessions.delete(name);
  }
  binaryName(): string {
    return "fake-zellij";
  }
}

const PREFIX_ID = "cp1:" + "a".repeat(64);

function checkpointFreshness(artifactGeneration = "artifact-1"): CanonCheckpointFreshnessInputs {
  return {
    repository: "repo-1",
    task: "task-1",
    base: "base-1",
    source: "source-1",
    artifactGeneration,
  };
}

test("Manager fork launches distinct Nawabari/Zellij attachments and preserves Canon identity", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
    execution_state_id: "es1:" + "b".repeat(64),
    attachmentGeneration: 1,
  });
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { calls });
  const runtime = new ForkRuntime();
  const service = new ManagerSessionService({ workspaceRoot: root, store, runtime, nawabari });
  await service.initialize();

  const first = await service.fork({
    checkpointId: parent.checkpointId,
    freshness,
    instruction: "fork one",
    branchName: "feat/928-canon-fork-one",
    issueRef: "928",
    taskSlug: "canon-fork-one",
    base: "main",
    idempotencyKey: "fork-one",
  });
  const second = await service.fork({
    checkpointId: parent.checkpointId,
    freshness,
    instruction: "fork two",
    branchName: "feat/928-canon-fork-two",
    issueRef: "928",
    taskSlug: "canon-fork-two",
    base: "main",
    idempotencyKey: "fork-two",
  });

  assert.notEqual(first.executionSessionId, second.executionSessionId);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.equal(runtime.started.length, 2);
  const children = store.listCanonCheckpoints({ parentCheckpointId: parent.checkpointId });
  assert.equal(children.length, 2);
  assert.deepEqual(new Set(children.map((child) => child.prefix_id)), new Set([PREFIX_ID]));
  assert.equal(new Set(children.map((child) => child.execution_state_id)).size, 2);
  assert.deepEqual(new Set(store.listCanonForkLaunches().map((launch) => launch.state)), new Set(["launched"]));
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 2);
});

test("stale Canon parent is rejected before any fork physical mutation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "stale-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  store.reconcileCanonCheckpoint({
    checkpointId: parent.checkpointId,
    freshness: checkpointFreshness("artifact-2"),
  });
  const calls: string[][] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new ForkRuntime(),
    nawabari: fakeNawabari(root, { calls }),
  });
  await assert.rejects(
    service.fork({
      checkpointId: parent.checkpointId,
      freshness,
      instruction: "must not launch",
      branchName: "feat/928-canon-fork-stale",
      issueRef: "928",
      taskSlug: "canon-fork-stale",
      base: "main",
    }),
    /stale/u,
  );
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 0);
});

test("Zellij failure records a failed fork and never reports a running child", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "zellij-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new ForkRuntime(true),
    nawabari: fakeNawabari(root),
  });
  await assert.rejects(
    service.fork({
      checkpointId: parent.checkpointId,
      freshness,
      instruction: "zellij fails",
      branchName: "feat/928-canon-fork-zellij-fails",
      issueRef: "928",
      taskSlug: "canon-fork-zellij-fails",
      base: "main",
    }),
    /injected zellij failure/u,
  );
  const launch = store.listCanonForkLaunches()[0];
  assert.equal(launch?.state, "failed");
  assert.equal(
    store.listManagerSessions(root).some((session) => session.runtimeState === "running"),
    false,
  );
});

test("Nawabari failure records a failed plan without a running child", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "nawabari-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  const calls: string[][] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new ForkRuntime(),
    nawabari: fakeNawabari(root, { calls, failSessionCreate: { message: "injected Nawabari failure" } }),
  });
  await assert.rejects(
    service.fork({
      checkpointId: parent.checkpointId,
      freshness,
      instruction: "Nawabari fails",
      branchName: "feat/928-canon-fork-nawabari-fails",
      issueRef: "928",
      taskSlug: "canon-fork-nawabari-fails",
    }),
    /injected Nawabari failure/u,
  );
  assert.equal(store.listCanonForkLaunches()[0]?.state, "failed");
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 1);
});

test("attachment mismatch fails closed and cleans the newly-created physical session", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "mismatched-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  const calls: string[][] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new ForkRuntime(),
    nawabari: fakeNawabari(root, {
      calls,
      afterSessionCreate: (session) => {
        session.branch = String(session.branch) + "-mismatch";
      },
    }),
  });
  await assert.rejects(
    service.fork({
      checkpointId: parent.checkpointId,
      freshness,
      instruction: "attachment mismatches",
      branchName: "feat/928-canon-fork-attachment-mismatch",
      issueRef: "928",
      taskSlug: "canon-fork-attachment-mismatch",
    }),
    /attachment branch mismatched/u,
  );
  assert.equal(store.listCanonForkLaunches()[0]?.state, "failed");
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 1);
});

test("fork attachment persistence failure cleans physical state and cannot report running", async (t) => {
  const root = createTempGitRepo(t);
  const store = new FailForkAttachmentStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "persistence-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  const calls: string[][] = [];
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new ForkRuntime(),
    nawabari: fakeNawabari(root, { calls }),
  });
  await assert.rejects(
    service.fork({
      checkpointId: parent.checkpointId,
      freshness,
      instruction: "persistence fails",
      branchName: "feat/928-canon-fork-persistence-fails",
      issueRef: "928",
      taskSlug: "canon-fork-persistence-fails",
    }),
    /injected fork attachment persistence failure/u,
  );
  assert.equal(store.listCanonForkLaunches()[0]?.state, "failed");
  assert.equal(store.listManagerSessions(root).length, 0);
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 1);
});

test("restart reconciles a launched fork from existing Nawabari/Zellij evidence without duplication", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const freshness = checkpointFreshness();
  const parent = store.recordCanonCheckpoint({
    checkpointId: "restart-fork-parent",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness,
  });
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { calls });
  const runtime = new ForkRuntime();
  const first = new ManagerSessionService({ workspaceRoot: root, store, runtime, nawabari });
  await first.initialize();
  await first.fork({
    checkpointId: parent.checkpointId,
    freshness,
    instruction: "restart me",
    branchName: "feat/928-canon-fork-restart",
    issueRef: "928",
    taskSlug: "canon-fork-restart",
  });
  const launch = store.listCanonForkLaunches()[0]!;
  fs.mkdirSync(launch.worktreePath!, { recursive: true });
  const createsBeforeRestart = calls.filter((args) => args[0] === "session" && args[1] === "create").length;
  const startsBeforeRestart = runtime.started.length;
  const restarted = new ManagerSessionService({ workspaceRoot: root, store, runtime, nawabari });
  await restarted.initialize();
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, createsBeforeRestart);
  assert.equal(runtime.started.length, startsBeforeRestart);
  assert.equal(store.listCanonForkLaunches()[0]?.state, "launched");
  assert.equal(store.listManagerSessions(root)[0]?.runtimeState, "running");
});
