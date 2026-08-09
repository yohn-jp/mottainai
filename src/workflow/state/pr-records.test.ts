import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { applyMigrations, MIGRATIONS } from "../../state/migrations.js";
import type { PullRequestRecordId, TaskId } from "./store.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

test("pr_records migration is append-only and stores no body or credential columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db);
    assert.ok(
      MIGRATIONS.some((migration) => migration.version === 5),
      "pr_records is introduced by migration version 5",
    );
    const columns = (db.prepare("PRAGMA table_info(pr_records)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    assert.deepEqual(columns, [
      "record_id",
      "task_id",
      "provider",
      "repository_id",
      "pr_number",
      "url",
      "head_sha",
      "lifecycle_state",
      "created_at",
      "updated_at",
      "instance_id",
    ]);
    assert.equal(
      columns.some((column) => /body|token|credential|raw/i.test(column)),
      false,
    );
  } finally {
    db.close();
  }
});

test("PR records are queryable and lifecycle state can be reconciled", () => {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  try {
    const record = store.recordPullRequest({
      provider: "github",
      repositoryId: "org/repository",
      prNumber: 36,
      url: "https://github.com/org/repository/pull/36",
      headSha: "abc123",
      lifecycleState: "open",
    });
    assert.equal(store.getPullRequestRecord(record.recordId)?.headSha, "abc123");
    assert.equal(store.getPullRequestByProviderRepositoryNumber("github", "org/repository", 36)?.url, record.url);
    const updated = store.updatePullRequestLifecycleState(record.recordId, "merged");
    assert.equal(updated.lifecycleState, "merged");
    assert.deepEqual(store.listPullRequestRecordsForTask("missing-task" as TaskId), []);
    assert.equal(store.getPullRequestRecord("missing-record" as PullRequestRecordId), undefined);
  } finally {
    store.close();
  }
});

test("recording the same pull request twice is idempotent and rejects a conflicting identity", () => {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  try {
    const input = {
      provider: "github",
      repositoryId: "org/repository",
      prNumber: 36,
      url: "https://github.com/org/repository/pull/36",
      headSha: "abc123",
      lifecycleState: "open" as const,
    };
    const first = store.recordPullRequest(input);
    const second = store.recordPullRequest(input);
    assert.equal(second.recordId, first.recordId);
    assert.throws(() => store.recordPullRequest({ ...input, headSha: "def456" }), /different identity/);
    assert.throws(
      () => store.recordPullRequest({ ...input, instanceId: "scoped-instance" as RepositoryInstanceId }),
      /different identity/,
    );
    assert.throws(
      () => store.recordPullRequest({ ...input, taskId: "missing-task" as TaskId, prNumber: 37 }),
      /task not found/,
    );
  } finally {
    store.close();
  }
});

test("task-bound PR records retain the task repository instance and reject a cross-instance association", () => {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  try {
    const first = store.observeRepositoryInstance({
      rootCommitDigest: "digest-one" as RootCommitDigest,
      instanceId: "instance-one" as RepositoryInstanceId,
      gitCommonDir: "/one/.git",
      canonicalWorktreePath: "/one",
      observedAt: 0,
    });
    store.observeRepositoryInstance({
      rootCommitDigest: "digest-two" as RootCommitDigest,
      instanceId: "instance-two" as RepositoryInstanceId,
      gitCommonDir: "/two/.git",
      canonicalWorktreePath: "/two",
      observedAt: 0,
    });
    const taskResult = store.reserveTask({
      instanceId: first.instance.instanceId,
      taskSlug: "task",
      issueRef: "1",
      baseBranch: "main",
      baseCommit: "base",
      allowMultipleActiveTasksPerIssue: true,
      reservedAt: 0,
    });
    assert.equal(taskResult.ok, true);
    const record = store.recordPullRequest({
      taskId: taskResult.task.taskId,
      provider: "github",
      repositoryId: "org/repository",
      prNumber: 1,
      url: "https://github.com/org/repository/pull/1",
      headSha: "head",
      lifecycleState: "open",
    });
    assert.equal(record.instanceId, first.instance.instanceId);
    assert.throws(
      () =>
        store.recordPullRequest({
          taskId: taskResult.task.taskId,
          instanceId: "instance-two" as RepositoryInstanceId,
          provider: "github",
          repositoryId: "org/other",
          prNumber: 2,
          url: "https://github.com/org/other/pull/2",
          headSha: "head",
          lifecycleState: "open",
        }),
      /task repository mismatch/,
    );
  } finally {
    store.close();
  }
});
