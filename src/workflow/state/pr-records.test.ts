import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, MIGRATIONS } from "../../state/migrations.js";
import type { PullRequestRecordId, TaskId } from "./store.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

test("pr_records migration is append-only and stores no body or credential columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db);
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1]?.version, 5);
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
