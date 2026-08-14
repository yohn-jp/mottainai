import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

function openStore(): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  return store;
}

const digest = "digest-1" as RootCommitDigest;
const instanceId = "inst-1" as RepositoryInstanceId;

test("observing a new instance creates source and instance records, issuing a fresh source id", () => {
  const store = openStore();
  const result = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  assert.equal(result.source.rootCommitDigest, digest);
  assert.equal(result.instance.instanceId, instanceId);
  assert.equal(result.instance.sourceId, result.source.sourceId);
  assert.equal(result.moved, false);
  assert.equal(result.previousCurrentPath, undefined);

  assert.deepEqual(store.getRepositorySource(result.source.sourceId)?.rootCommitDigest, digest);
  assert.deepEqual(store.getRepositorySourceByDigest(digest)?.sourceId, result.source.sourceId);
  assert.deepEqual(store.getRepositoryInstance(instanceId)?.gitCommonDir, "/repo/.git");
  assert.deepEqual(store.getRepositoryInstanceByCommonDir("/repo/.git")?.instanceId, instanceId);

  const paths = store.listRepositoryPaths(instanceId);
  assert.equal(paths.length, 1);
  assert.equal(paths[0]?.canonicalPath, "/repo");
  assert.equal(paths[0]?.isCurrent, true);
  store.close();
});

test("observing the same digest twice reuses the same source id (does not mint a duplicate)", () => {
  const store = openStore();
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const otherInstanceId = "inst-2" as RepositoryInstanceId;
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId: otherInstanceId,
    gitCommonDir: "/other/.git",
    canonicalWorktreePath: "/other",
  });
  assert.equal(first.source.sourceId, second.source.sourceId);
  store.close();
});

test("observing two different digests yields two different source ids (no collision even if digest were to repeat elsewhere)", () => {
  const store = openStore();
  const digestB = "digest-2" as RootCommitDigest;
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo-a/.git",
    canonicalWorktreePath: "/repo-a",
  });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digestB,
    instanceId: "inst-2" as RepositoryInstanceId,
    gitCommonDir: "/repo-b/.git",
    canonicalWorktreePath: "/repo-b",
  });
  assert.notEqual(first.source.sourceId, second.source.sourceId);
  store.close();
});

test("re-observing the same path does not create a duplicate path row or flag a move", () => {
  const store = openStore();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/repo" });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  assert.equal(second.moved, false);
  assert.equal(store.listRepositoryPaths(instanceId).length, 1);
  store.close();
});

test("observing a new canonical path for a known instance is detected as a move", () => {
  const store = openStore();
  store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/old/repo",
  });
  const moved = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/new/repo",
  });

  assert.equal(moved.moved, true);
  assert.equal(moved.previousCurrentPath, "/old/repo");

  const paths = store.listRepositoryPaths(instanceId).sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  assert.equal(paths.length, 2);
  const oldPath = paths.find((row) => row.canonicalPath === "/old/repo");
  const newPath = paths.find((row) => row.canonicalPath === "/new/repo");
  assert.equal(oldPath?.isCurrent, false);
  assert.equal(newPath?.isCurrent, true);
  store.close();
});

test("moving back to a previously observed path flips is_current back without erroring", () => {
  const store = openStore();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/path/a" });
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/path/b" });
  const backToA = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/path/a",
  });

  assert.equal(backToA.moved, true);
  const paths = store.listRepositoryPaths(instanceId);
  assert.equal(paths.length, 2);
  const pathA = paths.find((row) => row.canonicalPath === "/path/a");
  const pathB = paths.find((row) => row.canonicalPath === "/path/b");
  assert.equal(pathA?.isCurrent, true);
  assert.equal(pathB?.isCurrent, false);
  store.close();
});

test("two instances under the same source are both tracked independently", () => {
  const store = openStore();
  const otherInstanceId = "inst-2" as RepositoryInstanceId;
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo-a/.git",
    canonicalWorktreePath: "/repo-a",
  });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId: otherInstanceId,
    gitCommonDir: "/repo-b/.git",
    canonicalWorktreePath: "/repo-b",
  });

  assert.equal(store.getRepositoryInstance(instanceId)?.sourceId, first.source.sourceId);
  assert.equal(store.getRepositoryInstance(otherInstanceId)?.sourceId, second.source.sourceId);
  assert.notEqual(store.getRepositoryInstance(instanceId)?.instanceId, store.getRepositoryInstance(otherInstanceId)?.instanceId);
  store.close();
});

test("init() is idempotent and lookups before any observation return undefined", () => {
  const store = openStore();
  store.init();
  assert.equal(store.getRepositorySourceByDigest(digest), undefined);
  assert.equal(store.getRepositoryInstance(instanceId), undefined);
  assert.equal(store.getRepositoryInstanceByCommonDir("/nope"), undefined);
  assert.deepEqual(store.listRepositoryPaths(instanceId), []);
  store.close();
});

test("a new instance id reusing a known git_common_dir supersedes the stale instance instead of failing on the UNIQUE constraint", () => {
  const store = openStore();
  const staleInstanceId = "inst-stale" as RepositoryInstanceId;
  const freshInstanceId = "inst-fresh" as RepositoryInstanceId;
  const commonDir = "/repo/.git";

  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId: staleInstanceId, gitCommonDir: commonDir, canonicalWorktreePath: "/repo" });

  // marker ファイル削除・同一パスへの再 clone を模して、同じ git_common_dir に
  // 別の instanceId を観測させる。UNIQUE 制約で失敗せず、新 instance が
  // common-dir を引き継ぐこと（旧 instance の行自体は履歴として残ること）を確認する。
  const result = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId: freshInstanceId,
    gitCommonDir: commonDir,
    canonicalWorktreePath: "/repo",
  });

  assert.equal(result.instance.instanceId, freshInstanceId);
  assert.equal(store.getRepositoryInstanceByCommonDir(commonDir)?.instanceId, freshInstanceId);

  const staleRecord = store.getRepositoryInstance(staleInstanceId);
  assert.notEqual(staleRecord?.gitCommonDir, commonDir);
  store.close();
});

test("file-backed store persists across close/reopen with owner-only permissions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-sqlite-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "state.sqlite3");

  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/repo" });
  store.close();

  assert.ok(fs.existsSync(dbPath));
  const mode = fs.statSync(dbPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const dirMode = fs.statSync(dir).mode & 0o777;
  assert.equal(dirMode, 0o700);

  const reopened = new WorkflowSqliteStateStore({ dbPath });
  reopened.init();
  assert.equal(reopened.getRepositoryInstanceByCommonDir("/repo/.git")?.instanceId, instanceId);
  reopened.close();
});

function openStoreWithInstance(): WorkflowSqliteStateStore {
  const store = openStore();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/repo" });
  return store;
}

test("recordHookCheckpoint stores a checkpoint retrievable by instance and branch", () => {
  const store = openStoreWithInstance();
  const result = store.recordHookCheckpoint({ instanceId, branch: "main", commit: "abc123", checkedAt: 1000 });
  assert.equal(result.instanceId, instanceId);
  assert.equal(result.branch, "main");
  assert.equal(result.lastCheckedCommit, "abc123");
  assert.equal(result.checkedAt, 1000);

  const fetched = store.getHookCheckpoint(instanceId, "main");
  assert.equal(fetched?.lastCheckedCommit, "abc123");
  assert.equal(fetched?.checkedAt, 1000);
});

test("getHookCheckpoint returns undefined when no checkpoint has been recorded", () => {
  const store = openStoreWithInstance();
  assert.equal(store.getHookCheckpoint(instanceId, "main"), undefined);
});

test("recordHookCheckpoint overwrites the previous checkpoint for the same instance+branch", () => {
  const store = openStoreWithInstance();
  store.recordHookCheckpoint({ instanceId, branch: "main", commit: "first", checkedAt: 1000 });
  store.recordHookCheckpoint({ instanceId, branch: "main", commit: "second", checkedAt: 2000 });
  const fetched = store.getHookCheckpoint(instanceId, "main");
  assert.equal(fetched?.lastCheckedCommit, "second");
  assert.equal(fetched?.checkedAt, 2000);
});

test("hook checkpoints are tracked independently per branch", () => {
  const store = openStoreWithInstance();
  store.recordHookCheckpoint({ instanceId, branch: "main", commit: "main-sha", checkedAt: 1000 });
  store.recordHookCheckpoint({ instanceId, branch: "feature/x", commit: "feature-sha", checkedAt: 1000 });
  assert.equal(store.getHookCheckpoint(instanceId, "main")?.lastCheckedCommit, "main-sha");
  assert.equal(store.getHookCheckpoint(instanceId, "feature/x")?.lastCheckedCommit, "feature-sha");
});

test("reserveTask creates a task in the planned state", () => {
  const store = openStoreWithInstance();
  const result = store.reserveTask({
    instanceId, taskSlug: "my-task", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.lifecycleState, "planned");
  assert.equal(result.task.issueRef, "33");
  assert.equal(store.getTask(result.task.taskId)?.taskId, result.task.taskId);
});


test("task-start reconciliation records the external session before attachment and is idempotent", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "reconcile-task");
  const first = store.beginTaskStartReconciliation({
    taskId: task.taskId,
    instanceId,
    taskLabel: `mottainai-task-${task.taskId}`,
    branchName: "fix/33-reconcile-task",
    baseBranch: "main",
    baseCommit: "deadbeef",
    createdAt: 100,
  });
  assert.equal(first.state, "reserved");
  const recorded = store.recordTaskStartSession(task.taskId, "session-reconcile" as never, 200);
  assert.equal(recorded.state, "session-created");
  assert.equal(recorded.nawabariSessionId, "session-reconcile");
  assert.equal(store.getTask(task.taskId)?.nawabariSessionId, undefined);
  assert.deepEqual(
    store.beginTaskStartReconciliation({
      taskId: task.taskId,
      instanceId,
      taskLabel: `mottainai-task-${task.taskId}`,
      branchName: "fix/33-reconcile-task",
      baseBranch: "main",
      baseCommit: "deadbeef",
    }),
    recorded,
  );
  store.deleteReservedTask(task.taskId);
  assert.equal(store.getTaskStartReconciliation(task.taskId), undefined);
});

test("commit reconciliation preserves the result identity and refuses a different operation", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "commit-reconcile-task");
  const first = store.beginCommitReconciliation({
    taskId: task.taskId,
    instanceId,
    nawabariSessionId: "session-commit" as never,
    branchName: "fix/194-commit-reconcile-task",
    beforeCommit: "before-sha",
    resources: ["file.txt"],
    message: "commit message",
    createdAt: 100,
  });
  assert.equal(first.state, "not-attempted");
  assert.deepEqual(
    store.beginCommitReconciliation({
      taskId: task.taskId,
      instanceId,
      nawabariSessionId: "session-commit" as never,
      branchName: "fix/194-commit-reconcile-task",
      beforeCommit: "before-sha",
      resources: ["file.txt"],
      message: "commit message",
    }),
    first,
  );
  const succeeded = store.recordCommitResult(task.taskId, "commit-sha", 200);
  assert.equal(succeeded.state, "succeeded");
  assert.equal(succeeded.commitSha, "commit-sha");
  assert.throws(() =>
    store.beginCommitReconciliation({
      taskId: task.taskId,
      instanceId,
      nawabariSessionId: "session-commit" as never,
      branchName: "fix/194-other-branch",
      beforeCommit: "before-sha",
      resources: ["file.txt"],
      message: "commit message",
    }),
  );
  const reconciled = store.markCommitReconciliationReconciled(task.taskId, 300);
  assert.equal(reconciled.state, "reconciled");
  assert.equal(store.getCommitReconciliation(task.taskId)?.commitSha, "commit-sha");
});

test("reserveTask rejects a second active task for the same issue when multipleActiveTasksPerIssue is disallowed", () => {
  const store = openStoreWithInstance();
  const first = store.reserveTask({
    instanceId, taskSlug: "task-a", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(first.ok, true);
  const second = store.reserveTask({
    instanceId, taskSlug: "task-b", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "issue-already-claimed");
  assert.equal(first.ok && second.existingTask.taskId, first.ok ? first.task.taskId : undefined);
});

test("reserveTask allows a second active task for the same issue when multipleActiveTasksPerIssue is allowed", () => {
  const store = openStoreWithInstance();
  store.reserveTask({
    instanceId, taskSlug: "task-a", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  const second = store.reserveTask({
    instanceId, taskSlug: "task-b", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(second.ok, true);
});

test("reserveTask allows a claimed issue to be reclaimed once the prior task is cleaned/abandoned", () => {
  const store = openStoreWithInstance();
  const first = store.reserveTask({
    instanceId, taskSlug: "task-a", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  store.updateTaskLifecycleState(first.task.taskId, "abandoned");
  const second = store.reserveTask({
    instanceId, taskSlug: "task-b", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(second.ok, true);
});

function reserveTask(store: WorkflowSqliteStateStore, taskSlug: string) {
  const result = store.reserveTask({
    instanceId, taskSlug, issueRef: undefined, baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  if (!result.ok) throw new Error("expected reserveTask to succeed in test setup");
  return result.task;
}

test("reserveWorktree creates a worktree in the reserved state", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  const result = store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/task-a", canonicalPath: "/repo/.worktrees/task-a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktree.status, "reserved");
  assert.equal(result.worktree.branchName, "task/task-a");
});

test("reserveWorktree rejects a branch_name collision and reports the existing worktree", () => {
  const store = openStoreWithInstance();
  const taskA = reserveTask(store, "task-a");
  const taskB = reserveTask(store, "task-b");
  const first = store.reserveWorktree({
    taskId: taskA.taskId, instanceId, branchName: "task/dup", canonicalPath: "/repo/.worktrees/a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(first.ok, true);
  const second = store.reserveWorktree({
    taskId: taskB.taskId, instanceId, branchName: "task/dup", canonicalPath: "/repo/.worktrees/b",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "branch-collision");
  assert.equal(first.ok && second.existingWorktree.worktreeId, first.ok ? first.worktree.worktreeId : undefined);
});

test("reserveWorktree rejects a canonical_path collision and reports the existing worktree", () => {
  const store = openStoreWithInstance();
  const taskA = reserveTask(store, "task-a");
  const taskB = reserveTask(store, "task-b");
  const first = store.reserveWorktree({
    taskId: taskA.taskId, instanceId, branchName: "task/a", canonicalPath: "/repo/.worktrees/dup",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(first.ok, true);
  const second = store.reserveWorktree({
    taskId: taskB.taskId, instanceId, branchName: "task/b", canonicalPath: "/repo/.worktrees/dup",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "path-collision");
});

test("activateWorktree transitions a reserved worktree to active", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  const reserved = store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/task-a", canonicalPath: "/repo/.worktrees/task-a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const activated = store.activateWorktree(reserved.worktree.worktreeId);
  assert.equal(activated.status, "active");
});

test("activateWorktree rejects a worktree that is not in the reserved state (already-active row is not re-activated silently)", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  const reserved = store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/task-a", canonicalPath: "/repo/.worktrees/task-a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  store.activateWorktree(reserved.worktree.worktreeId);
  // 一度 active になった行を再度 activateWorktree に渡すのは、reserved 以外の状態
  // （将来 Child Issue 7 が追加する removed を含む）を誤って書き換えないことの代理検証。
  assert.throws(() => store.activateWorktree(reserved.worktree.worktreeId), /not in reserved state/);
});

test("activateWorktree rejects an unknown worktree id", () => {
  const store = openStoreWithInstance();
  assert.throws(() => store.activateWorktree("does-not-exist" as never));
});

test("deleteReservedWorktree removes the row and frees its branch/path for reuse", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  const reserved = store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/task-a", canonicalPath: "/repo/.worktrees/task-a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  store.deleteReservedWorktree(reserved.worktree.worktreeId);
  assert.equal(store.listWorktreesForTask(task.taskId).length, 0);

  const taskB = reserveTask(store, "task-b");
  const reclaimed = store.reserveWorktree({
    taskId: taskB.taskId, instanceId, branchName: "task/task-a", canonicalPath: "/repo/.worktrees/task-a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(reclaimed.ok, true);
});

test("deleteReservedTask removes a planned task but does not touch tasks past planned", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  store.deleteReservedTask(task.taskId);
  assert.equal(store.getTask(task.taskId), undefined);
});

test("updateTaskLifecycleState updates and returns the task", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  const updated = store.updateTaskLifecycleState(task.taskId, "active");
  assert.equal(updated.lifecycleState, "active");
  assert.equal(store.getTask(task.taskId)?.lifecycleState, "active");
});

test("getActiveTaskByIssueRef returns undefined once the task is cleaned/abandoned", () => {
  const store = openStoreWithInstance();
  const result = store.reserveTask({
    instanceId, taskSlug: "task-a", issueRef: "33", baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.getActiveTaskByIssueRef(instanceId, "33")?.taskId, result.task.taskId);
  store.updateTaskLifecycleState(result.task.taskId, "abandoned");
  assert.equal(store.getActiveTaskByIssueRef(instanceId, "33"), undefined);
});

test("listWorktreesForTask returns all worktrees for a task ordered by creation", () => {
  const store = openStoreWithInstance();
  const task = reserveTask(store, "task-a");
  store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/one", canonicalPath: "/repo/.worktrees/one",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: "task/two", canonicalPath: "/repo/.worktrees/two",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  const worktrees = store.listWorktreesForTask(task.taskId);
  assert.equal(worktrees.length, 2);
});

test("listWorktreesForInstance returns worktrees across multiple tasks", () => {
  const store = openStoreWithInstance();
  const taskA = reserveTask(store, "task-a");
  const taskB = reserveTask(store, "task-b");
  store.reserveWorktree({
    taskId: taskA.taskId, instanceId, branchName: "task/a", canonicalPath: "/repo/.worktrees/a",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  store.reserveWorktree({
    taskId: taskB.taskId, instanceId, branchName: "task/b", canonicalPath: "/repo/.worktrees/b",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(store.listWorktreesForInstance(instanceId).length, 2);
});

function reserveTaskWithWorktree(store: WorkflowSqliteStateStore, taskSlug: string) {
  const task = reserveTask(store, taskSlug);
  const worktree = store.reserveWorktree({
    taskId: task.taskId, instanceId, branchName: `task/${taskSlug}`, canonicalPath: `/repo/.worktrees/${taskSlug}`,
    baseBranch: "main", baseCommit: "deadbeef",
  });
  if (!worktree.ok) throw new Error("expected reserveWorktree to succeed in test setup");
  return { task, worktree: worktree.worktree };
}

test("reserveCleanupLease creates a new lease in the reserved state", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  const result = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.state, "reserved");
  assert.equal(result.lease.owner, "owner-1");
  assert.deepEqual(store.getCleanupLease("op-1"), result.lease);
});

test("reserveCleanupLease rejects a plan digest mismatch for an existing operation id", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  const result = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-2", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "plan-digest-mismatch");
});

test("reserveCleanupLease reuses an unexpired lease held by the same owner", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  const first = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  const second = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 100, expiresAt: 2000,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.lease.state, "reserved");
});

test("reserveCleanupLease rejects an unexpired lease held by a different owner instead of returning ok:true", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  const result = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-2", acquiredAt: 100, expiresAt: 2000,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "active-lease");
  assert.equal(result.existingLease.owner, "owner-1");
});

test("reserveCleanupLease reuses an already-committed lease regardless of owner", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  const first = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  store.markCleanupLease({ operationId: "op-1", state: "verifying" });
  store.commitCleanup({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: [],
  });
  const reused = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-2", acquiredAt: 100, expiresAt: 2000,
  });
  assert.equal(reused.ok, true);
  if (!reused.ok) return;
  assert.equal(reused.lease.state, "committed");
});

test("reserveCleanupLease recovers an expired mutating lease back into mutating, preserving completed actions", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 10,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating", completedActionIds: ["remove-worktree"] });
  const recovered = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-2", acquiredAt: 1000, expiresAt: 2000,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(recovered.lease.state, "mutating");
  assert.equal(recovered.lease.owner, "owner-2");
  assert.deepEqual(recovered.lease.completedActionIds, ["remove-worktree"]);
});

test("reserveCleanupLease recovers a failed lease back into reserved, clearing completed actions", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "failed", lastError: "boom" });
  const recovered = store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-2", acquiredAt: 100, expiresAt: 2000,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(recovered.lease.state, "reserved");
  assert.deepEqual(recovered.lease.completedActionIds, []);
  assert.equal(recovered.lease.lastError, undefined);
});

test("reserveCleanupLease rejects a second concurrent operation while an active lease holds the same resource", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  const result = store.reserveCleanupLease({
    operationId: "op-2", planDigest: "digest-2", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-2", acquiredAt: 100, expiresAt: 2000,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "active-lease");
  assert.equal(result.existingLease.operationId, "op-1");
});

test("getActiveCleanupLease returns undefined once no lease is held for the resource", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  assert.equal(store.getActiveCleanupLease(instanceId, task.taskId, worktree.worktreeId, 0), undefined);
});

test("markCleanupLease throws for an unknown operation id", () => {
  const store = openStoreWithInstance();
  assert.throws(() => store.markCleanupLease({ operationId: "missing", state: "mutating" }));
});

test("markCleanupLease succeeds when expectedState matches the stored state", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  const updated = store.markCleanupLease({ operationId: "op-1", state: "mutating", expectedState: "reserved" });
  assert.equal(updated.state, "mutating");
});

test("markCleanupLease rejects a stale expectedState as a concurrent transition", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  assert.throws(() => store.markCleanupLease({ operationId: "op-1", state: "verifying", expectedState: "reserved" }));
});

test("commitCleanup throws for an unknown operation id", () => {
  const store = openStoreWithInstance();
  assert.throws(() =>
    store.commitCleanup({
      operationId: "missing", planDigest: "digest-1", instanceId, taskId: "task-x" as never,
      expectedTaskVersion: 1, expectedLifecycle: "abandoned", completedActionIds: [],
    }),
  );
});

test("commitCleanup throws on a lease identity mismatch", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  store.markCleanupLease({ operationId: "op-1", state: "verifying" });
  assert.throws(() =>
    store.commitCleanup({
      operationId: "op-1", planDigest: "wrong-digest", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
      expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: [],
    }),
  );
});

test("commitCleanup rejects a lease that has not reached verifying (reserved, mutating, failed)", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  assert.throws(() =>
    store.commitCleanup({
      operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
      expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: [],
    }),
  );
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  assert.throws(() =>
    store.commitCleanup({
      operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
      expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: [],
    }),
  );
  store.markCleanupLease({ operationId: "op-1", state: "failed" });
  assert.throws(() =>
    store.commitCleanup({
      operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
      expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: [],
    }),
  );
});

test("commitCleanup from a verifying lease marks the task cleaned and the worktree removed", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  store.markCleanupLease({ operationId: "op-1", state: "verifying" });
  const result = store.commitCleanup({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: ["remove-worktree"],
  });
  assert.equal(result.task.lifecycleState, "cleaned");
  assert.equal(result.worktree?.status, "removed");
  assert.equal(result.lease.state, "committed");
});

test("commitCleanup is idempotent when called again on an already-committed lease", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  store.markCleanupLease({ operationId: "op-1", state: "verifying" });
  const first = store.commitCleanup({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: ["remove-worktree"],
  });
  const second = store.commitCleanup({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    expectedTaskVersion: task.version, expectedLifecycle: task.lifecycleState, completedActionIds: ["remove-worktree"],
  });
  assert.equal(second.lease.state, "committed");
  assert.equal(second.task.taskId, first.task.taskId);
  assert.equal(second.task.lifecycleState, "cleaned");
});

test("commitCleanup throws when the task changed (version/lifecycle) since planning", () => {
  const store = openStoreWithInstance();
  const { task, worktree } = reserveTaskWithWorktree(store, "task-a");
  store.reserveCleanupLease({
    operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
    owner: "owner-1", acquiredAt: 0, expiresAt: 1000,
  });
  store.markCleanupLease({ operationId: "op-1", state: "mutating" });
  store.markCleanupLease({ operationId: "op-1", state: "verifying" });
  assert.throws(() =>
    store.commitCleanup({
      operationId: "op-1", planDigest: "digest-1", instanceId, taskId: task.taskId, worktreeId: worktree.worktreeId,
      expectedTaskVersion: task.version + 1, expectedLifecycle: task.lifecycleState, completedActionIds: [],
    }),
  );
});

function recordCheckRunInput(overrides: Partial<Parameters<WorkflowSqliteStateStore["recordCheckRun"]>[0]> = {}) {
  return {
    runId: "cr-1",
    instanceId,
    worktreeId: "wt-1",
    checkId: "test",
    commandDigest: "cmd-digest-1",
    stateFingerprint: "sf-1",
    configDigest: "cfg-1",
    status: "passed" as const,
    execution: "executed" as const,
    startedAt: 1000,
    durationMs: 500,
    summary: "test passed",
    provenance: { reasonCode: "no-matching-prior-success", explanation: "first execution" },
    ...overrides,
  };
}

test("recordCheckRun persists a run retrievable via listCheckRuns", () => {
  const store = openStoreWithInstance();
  const recorded = store.recordCheckRun(recordCheckRunInput());
  assert.equal(recorded.runId, "cr-1");
  assert.equal(recorded.status, "passed");
  assert.equal(recorded.execution, "executed");

  const listed = store.listCheckRuns({ instanceId, worktreeId: "wt-1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, "cr-1");
  assert.equal(listed[0]?.artifactRef, undefined);
});

test("findReusableCheckRun returns the matching passed run for identical fingerprint and config digest", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput());
  const match = store.findReusableCheckRun(instanceId, "wt-1", "test", "sf-1", "cfg-1");
  assert.equal(match?.runId, "cr-1");
});

test("findReusableCheckRun returns undefined when the state fingerprint differs (state changed)", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput());
  assert.equal(store.findReusableCheckRun(instanceId, "wt-1", "test", "sf-2", "cfg-1"), undefined);
});

test("findReusableCheckRun returns undefined when the config digest differs (command/config changed)", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput());
  assert.equal(store.findReusableCheckRun(instanceId, "wt-1", "test", "sf-1", "cfg-2"), undefined);
});

test("findReusableCheckRun never returns a failed run (no silent fail-to-pass reuse)", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-failed", status: "failed" }));
  assert.equal(store.findReusableCheckRun(instanceId, "wt-1", "test", "sf-1", "cfg-1"), undefined);
});

test("check runs are isolated per worktree even under the same instance and check id", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-a", worktreeId: "wt-a" }));
  assert.equal(store.findReusableCheckRun(instanceId, "wt-b", "test", "sf-1", "cfg-1"), undefined);
  assert.equal(store.findReusableCheckRun(instanceId, "wt-a", "test", "sf-1", "cfg-1")?.runId, "cr-a");
});

test("findReusableCheckRun returns the most recently recorded matching passed run", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-old", recordedAt: 1000 }));
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-new", recordedAt: 2000 }));
  assert.equal(store.findReusableCheckRun(instanceId, "wt-1", "test", "sf-1", "cfg-1")?.runId, "cr-new");
});

test("listCheckRuns filters by checkId when provided", () => {
  const store = openStoreWithInstance();
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-test", checkId: "test" }));
  store.recordCheckRun(recordCheckRunInput({ runId: "cr-lint", checkId: "lint", stateFingerprint: "sf-lint" }));
  const testOnly = store.listCheckRuns({ instanceId, worktreeId: "wt-1", checkId: "test" });
  assert.deepEqual(testOnly.map((run) => run.runId), ["cr-test"]);
});
