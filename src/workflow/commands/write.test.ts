import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { commitWorkflowTask, cleanupWorkflowTask } from "./write.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startTask } from "../domain/task.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";

test("commit dry-run returns the domain verification plan without changing Git or lifecycle state", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "write-dry-run",
    branchType: "fix",
    issueRef: "40",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) return;
  fs.appendFileSync(path.join(started.worktree.canonicalPath, "file.txt"), "planned\n");
  const before = runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath);
  const result = await commitWorkflowTask({
    workspaceRoot: started.worktree.canonicalPath,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "planned workflow commit" },
    dryRun: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.dryRun, true);
    assert.equal((result.plan as { operation: string }).operation, "commit");
  }
  assert.equal(runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath), before);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "active");
});

test("task start idempotency key reuses the exact active task and worktree", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const input = {
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "retryable-start",
    branchType: "fix",
    issueRef: "40",
    idempotencyKey: "start-write-test",
  } as const;
  const first = await startTask(input);
  assert.equal(first.ok, true);
  if (!first.ok || first.worktree === undefined) return;
  const repeated = await startTask(input);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  if (repeated.ok) {
    assert.equal(repeated.reused, true);
    assert.equal(repeated.task.taskId, first.task.taskId);
    assert.equal(repeated.worktree?.worktreeId, first.worktree.worktreeId);
  }
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listWorktrees().filter((worktree) => worktree.status === "active").length, 1);
});

test("cleanup idempotency key reuses the same cleanup operation without a second deletion", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS["strict-worktree"],
    taskSlug: "write-cleanup",
    branchType: "fix",
    issueRef: "40",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) return;
  store.updateTaskLifecycleState(started.task.taskId, "abandoned");
  const preview = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    dryRun: true,
    idempotencyKey: "cleanup-write-preview",
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  if (preview.ok) assert.equal(preview.dryRun, true);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "abandoned");
  assert.equal(fs.existsSync(started.worktree.canonicalPath), true);

  const first = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    idempotencyKey: "cleanup-write-test",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "cleaned");
  assert.equal(fs.existsSync(started.worktree.canonicalPath), false);

  const repeated = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    idempotencyKey: "cleanup-write-test",
  });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  if (repeated.ok) assert.equal(repeated.execution?.status, "already-completed");
});
