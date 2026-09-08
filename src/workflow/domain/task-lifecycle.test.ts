import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { RepositoryInstanceId, RootCommitDigest } from "./identity.js";
import { transitionFailureDetail, transitionTask } from "./task-lifecycle.js";

const instanceId = "inst-1" as RepositoryInstanceId;

function reserveActiveTask(store: ReturnType<typeof createWorkflowStore>, taskSlug: string) {
  store.observeRepositoryInstance({
    rootCommitDigest: `digest-${taskSlug}` as RootCommitDigest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const reserved = store.reserveTask({
    instanceId,
    taskSlug,
    issueRef: undefined,
    baseBranch: "main",
    baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  if (!reserved.ok) throw new Error("expected reserveTask to succeed in test setup");
  return store.updateTaskLifecycleState(reserved.task.taskId, "active");
}

test("transitionTask applies a legal transition and advances the task version", (t) => {
  const store = createWorkflowStore(t);
  const active = reserveActiveTask(store, "task-a");

  const result = transitionTask(store, active.taskId, "committed");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.lifecycleState, "committed");
  assert.equal(result.task.version, active.version + 1);
});

test("transitionTask rejects an illegal transition with a structured blocker, not a thrown error", (t) => {
  const store = createWorkflowStore(t);
  const active = reserveActiveTask(store, "task-a");

  const result = transitionTask(store, active.taskId, "merged");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.blocked.currentState, "active");
  assert.equal(result.blocked.requestedTransition, "merged");
  assert.ok(result.blocked.allowedNextTransitions.includes("committed"));
  assert.match(transitionFailureDetail(result), /no direct transition from active to merged/);

  // The task itself must be untouched by a blocked transition.
  assert.equal(store.getTask(active.taskId)?.lifecycleState, "active");
  assert.equal(store.getTask(active.taskId)?.version, active.version);
});

test("transitionTask surfaces a structured conflict (never a silent second success) when it loses a CAS race", (t) => {
  const store = createWorkflowStore(t);
  const active = reserveActiveTask(store, "task-a");

  // Simulate the race Issue #867 describes: between this call observing the task
  // as `active`@v(active.version) and issuing its own CAS write, a concurrent
  // process wins the race and advances the task to "committed" first. `beforeCasWrite`
  // exists exactly for forcing this interleaving deterministically (see task-lifecycle.ts
  // and the real two-OS-process reproduction in task-lifecycle.concurrency.test.ts). The
  // guarded UPDATE must therefore affect zero rows, and transitionTask must report a
  // structured conflict rather than silently overwriting the winner.
  let winner: ReturnType<typeof store.updateTaskLifecycleState> | undefined;
  const result = transitionTask(store, active.taskId, "committed", {
    beforeCasWrite: () => {
      winner = store.updateTaskLifecycleState(active.taskId, "committed");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "conflict");
  if (result.kind !== "conflict") return;
  assert.equal(result.conflict.taskId, active.taskId);
  assert.equal(result.conflict.expectedLifecycle, "active");
  assert.equal(result.conflict.expectedVersion, active.version);
  assert.equal(result.conflict.requestedTransition, "committed");
  assert.equal(result.conflict.current.lifecycleState, "committed");
  assert.ok(winner !== undefined);
  assert.equal(result.conflict.current.version, winner?.version);
  assert.match(transitionFailureDetail(result), /lifecycle changed concurrently/);

  // The winner's committed state must survive untouched — exactly one
  // transition took effect, never a second silent overwrite by the loser.
  assert.equal(store.getTask(active.taskId)?.version, winner?.version);
});
