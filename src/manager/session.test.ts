import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../test-support/tmp-dir.js";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";
import type { ManagerSessionId, TaskId } from "../workflow/state/store.js";

test("Manager session records persist launch metadata and lifecycle across store restart", (t) => {
  const directory = createTempDir(t, "mottainai-manager-session-");
  const dbPath = path.join(directory, "state.sqlite3");
  const sessionId = "12345678-1234-4234-8234-123456789abc" as ManagerSessionId;
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  const created = store.createManagerSession({
    sessionId,
    workspaceRoot: "/repo",
    taskId: "task-1" as TaskId,
    worktreePath: "/repo/.mottainai/worktrees/fix-1-task",
    branchName: "fix/1-task",
    agentKind: "codex",
    launchCommand: "codex",
    launchArgs: ["instruction with spaces", "$(not shell)"] as const,
    runtimeName: "mottainai-12345678-1234-4234-8234-123456789abc",
    startedAt: 100,
  });
  assert.equal(created.lifecycleState, "starting");
  store.updateManagerSession(sessionId, { lifecycleState: "running", terminationState: "running", updatedAt: 200 });
  store.close();

  const reopened = new WorkflowSqliteStateStore({ dbPath });
  reopened.init();
  t.after(() => reopened.close());
  const restored = reopened.getManagerSession(sessionId);
  assert.deepEqual(restored?.launchArgs, ["instruction with spaces", "$(not shell)"]);
  assert.equal(restored?.taskId, "task-1");
  assert.equal(restored?.lifecycleState, "running");
  assert.equal(reopened.listManagerSessions("/repo").length, 1);
});
