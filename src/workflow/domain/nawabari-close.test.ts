import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startNawabariTask } from "./nawabari-task.js";
import { closeNawabariExecution } from "./nawabari-close.js";
import { fakeNawabari } from "../../test-support/nawabari-fixture.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";

async function mergedFixture(t: TestContext, beforeSessionClose?: () => void) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls, beforeSessionClose });
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "close-reconciliation",
    branchType: "fix",
    issueRef: "378",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("fixture setup failed");
  store.recordPullRequest({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 378,
    url: "https://github.com/org/repository/pull/378",
    headSha: "head-sha",
    mergeRevision: "integrated-sha",
    lifecycleState: "merged",
  });
  store.updateTaskLifecycleState(started.task.taskId, "merged");
  return { root, store, nawabari, calls, task: store.getTask(started.task.taskId)! };
}

test("close uses inspected task identity and forwards the authoritative merge revision", async (t) => {
  const fixture = await mergedFixture(t);
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const result = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const inspectIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "inspect");
  const closeIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "close");
  assert.ok(inspectIndex >= 0);
  assert.ok(closeIndex > inspectIndex);
  assert.deepEqual(fixture.calls[closeIndex], [
    "session",
    "close",
    "--session",
    fixture.task.nawabariSessionId,
    "--integrated-revision",
    "integrated-sha",
    "--json",
  ]);
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");
});

test("a close blocker durably keeps the task merged and the same identity retries", async (t) => {
  let attempts = 0;
  const fixture = await mergedFixture(t, () => {
    attempts += 1;
    if (attempts === 1) throw new Error("DIRTY_WORKTREE: review changes remain");
  });
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const first = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.reason, "cleanup-blocked");
  assert.equal(fixture.store.getTask(fixture.task.taskId)?.lifecycleState, "merged");
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "blocked");

  const second = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.store.getTask(fixture.task.taskId)!,
    providerRecord: fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");
  assert.equal(attempts, 2);
});
