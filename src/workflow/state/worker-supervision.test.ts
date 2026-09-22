import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ManagerRuntimeId, ManagerSessionId, TaskId } from "./store.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

const sessionId = "manager-session-worker-1" as ManagerSessionId;
const runtimeId = "local" as ManagerRuntimeId;
const taskId = "task-worker-1" as TaskId;

const binding = {
  identity: {
    managerSessionId: sessionId,
    runtimeId,
    taskId,
    executionSessionId: "execution-worker-1",
    provider: "provider-neutral",
  },
  boundAt: "2026-01-01T00:00:00.000Z",
} as const;

const status = {
  lifecycleState: "running",
  phase: "executing",
  activity: { kind: "working", label: "bounded status" },
  progress: { completed: 2, current: "step-3", remaining: 4 },
  attention: "none",
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  context: { usedTokens: 120, limitTokens: 1_000 },
} as const;

const observation = {
  binding,
  status,
  observedAt: "2026-01-01T00:00:01.000Z",
} as const;

function openStore(dbPath: string): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  return store;
}

function seedManagerState(store: WorkflowSqliteStateStore): void {
  store.createManagerSession({
    sessionId,
    runtimeId,
    workspaceRoot: "/workspace",
    worktreePath: "/workspace/worktree",
    agentKind: "codex",
    launchCommand: "codex",
    launchArgs: ["codex"],
    runtimeName: "worker-runtime",
    startedAt: 2,
  });
}

test("worker supervision persists and reloads bounded state without changing Manager state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-worker-supervision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.sqlite3");

  const store = openStore(dbPath);
  seedManagerState(store);
  const recorded = store.recordWorkerSupervision({
    observation,
    diagnosticEvent: {
      kind: "status",
      binding,
      status,
      observedAt: "2026-01-01T00:00:02.000Z",
    },
    recordedAt: 10,
  });
  assert.equal(recorded.managerSessionId, sessionId);
  assert.equal(recorded.schemaVersion, 1);
  assert.equal(recorded.binding.identity.provider, "provider-neutral");
  assert.equal(recorded.latestStatus.progress.current, "step-3");
  assert.equal(recorded.latestObservation.observedAt, observation.observedAt);
  assert.deepEqual(recorded.diagnosticEvents[0], {
    kind: "status",
    observedAt: "2026-01-01T00:00:02.000Z",
    phase: "executing",
    activity: "working",
    attention: "none",
  });
  store.close();

  const reopened = openStore(dbPath);
  const reloaded = reopened.getWorkerSupervision(sessionId);
  assert.equal(reloaded?.latestLifecycleState, "running");
  assert.deepEqual(reloaded?.binding, binding);
  assert.deepEqual(reloaded?.latestObservation, observation);
  assert.equal(reloaded?.diagnosticEvents.length, 1);
  assert.equal(reopened.getManagerSession(sessionId)?.runtimeName, "worker-runtime");
  reopened.close();
});

test("worker supervision rejects transcript/reasoning payloads and retains only body-free diagnostic metadata", () => {
  const store = openStore(":memory:");
  const unsafeObservation = {
    ...observation,
    status: { ...status, transcript: "raw transcript", reasoning: "private reasoning" },
  } as never;
  assert.throws(() => store.recordWorkerSupervision({ observation: unsafeObservation }), /transcript|reasoning/u);

  const failed = store.recordWorkerSupervision({
    observation,
    diagnosticEvent: {
      kind: "failed",
      binding,
      blocker: { code: "runtime-failed", detail: "raw diagnostic detail is not retained" },
      observedAt: "2026-01-01T00:00:03.000Z",
    },
  });
  assert.deepEqual(failed.diagnosticEvents[0], {
    kind: "failed",
    observedAt: "2026-01-01T00:00:03.000Z",
    blockerCode: "runtime-failed",
  });
  assert.equal("detail" in failed.diagnosticEvents[0]!, false);
  store.close();
});

test("control audit is separate from observation and stale observations cannot invent liveness", () => {
  const store = openStore(":memory:");
  store.recordWorkerSupervision({ observation });
  const audit = store.recordWorkerControlAudit({
    binding,
    operation: "steer",
    requestedAt: "2026-01-01T00:00:04.000Z",
    acceptedAt: "2026-01-01T00:00:05.000Z",
    recordedAt: 5,
  });
  assert.equal(audit.operation, "steer");
  assert.equal(store.listWorkerControlAudit(sessionId)[0]?.acceptedAt, "2026-01-01T00:00:05.000Z");

  const stale = store.recordWorkerSupervision({
    observation: {
      ...observation,
      status: { ...status, lifecycleState: "completed", phase: "complete" },
      observedAt: "2025-12-31T23:59:59.000Z",
    },
  });
  assert.equal(stale.latestLifecycleState, "running");
  assert.equal(stale.latestObservation.observedAt, observation.observedAt);
  assert.equal(store.listWorkerControlAudit(sessionId).length, 1);
  store.close();
});
