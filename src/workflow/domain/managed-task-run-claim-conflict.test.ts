import assert from "node:assert/strict";
import test from "node:test";
import { ManagerError } from "../../manager/service.js";
import type { TaskRecord, WorkflowStateStore } from "../state/store.js";
import { explainTaskRunClaimConflict } from "./managed-task-run.js";

function task(sessionId: string): TaskRecord {
  return {
    taskId: "task-498" as TaskRecord["taskId"],
    instanceId: "instance-498" as TaskRecord["instanceId"],
    taskSlug: "launch-guidance",
    issueRef: "498",
    nawabariSessionId: sessionId as TaskRecord["nawabariSessionId"],
    lifecycleState: "active",
    version: 1,
    baseBranch: "main",
    baseCommit: "abc123",
    createdAt: 1,
    updatedAt: 1,
  };
}

function store(tasks: TaskRecord[]): WorkflowStateStore {
  return {
    listTasks: () => tasks,
    listManagerSessions: () => [],
  } as unknown as WorkflowStateStore;
}

function conflict(sessionId: string): ManagerError {
  return new ManagerError("claim_conflict", "Nawabari reports an active conflicting claim", 409, {
    claimPreflight: {
      conflicts: [
        {
          requested: { resource: "**", mode: "read" },
          existing: {
            sessionId,
            resource: "**",
            mode: "exclusive-write",
            branch: "fix/498-launch-guidance",
            claimId: "claim-1",
          },
        },
      ],
    },
  });
}

test("explains when task run is layered onto the same task already owned by task start", () => {
  const message = explainTaskRunClaimConflict({
    store: store([task("session-498")]),
    workspaceRoot: "/repo",
    taskSlug: "launch-guidance",
    issueRef: "498",
    error: conflict("session-498"),
  });
  assert.ok(message);
  assert.match(message, /Cannot layer task run onto the same active task\/worktree/u);
  assert.match(message, /task start already owns task task-498/u);
  assert.match(message, /Nawabari session session-498/u);
  assert.match(message, /reuse|Continue/iu);
  assert.match(message, /mottainai skill choose-task-launch/u);
});

test("does not misclassify an unrelated Nawabari claim conflict", () => {
  const message = explainTaskRunClaimConflict({
    store: store([task("another-session")]),
    workspaceRoot: "/repo",
    taskSlug: "launch-guidance",
    issueRef: "498",
    error: conflict("session-498"),
  });
  assert.equal(message, undefined);
});
