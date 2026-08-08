import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, MIGRATIONS } from "./migrations.js";

test("applyMigrations discovers and applies one ordered migration per transaction", () => {
  const db = new DatabaseSync(":memory:");
  const applied: number[] = [];
  try {
    applyMigrations(db, [
      { version: 2, description: "second", up: () => { applied.push(2); } },
      { version: 1, description: "first", up: () => { applied.push(1); } },
    ]);

    assert.deepEqual(applied, [1, 2]);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 2);

    applyMigrations(db, [
      { version: 1, description: "first", up: () => { applied.push(1); } },
      { version: 2, description: "second", up: () => { applied.push(2); } },
    ]);
    assert.deepEqual(applied, [1, 2]);
  } finally {
    db.close();
  }
});

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS);
  return db;
}

function seedInstance(db: DatabaseSync, instanceId: string, gitCommonDir: string): void {
  db.prepare("INSERT INTO repository_sources (source_id, root_commit_digest, created_at) VALUES (?, ?, ?)")
    .run(`source-${instanceId}`, `digest-${instanceId}`, 0);
  db.prepare(
    "INSERT INTO repository_instances (instance_id, source_id, git_common_dir, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(instanceId, `source-${instanceId}`, gitCommonDir, 0, 0);
}

function seedTask(db: DatabaseSync, taskId: string, instanceId: string): void {
  db.prepare(
    `INSERT INTO tasks (task_id, instance_id, task_slug, issue_ref, lifecycle_state, base_branch, base_commit, created_at, updated_at)
     VALUES (?, ?, 'slug', NULL, 'planned', 'main', 'deadbeef', 0, 0)`,
  ).run(taskId, instanceId);
}

test("version 6 creates tasks/worktrees/pr_records/validation_evidence tables reachable after migration", () => {
  const db = freshDb();
  try {
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 6);
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get("task-1") as { lifecycle_state: string };
    assert.equal(task.lifecycle_state, "planned");
  } finally {
    db.close();
  }
});

test("validation_evidence PRIMARY KEY rejects a duplicate (instance, commit, name) row", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    const insert = db.prepare(
      "INSERT INTO validation_evidence (instance_id, head_commit, name, status, recorded_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("instance-1", "deadbeef", "tests", "passed", 0);
    assert.throws(() => insert.run("instance-1", "deadbeef", "tests", "passed", 1));
    assert.doesNotThrow(() =>
      db
        .prepare(
          "INSERT INTO validation_evidence (instance_id, head_commit, name, status, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (instance_id, head_commit, name) DO UPDATE SET status = excluded.status, recorded_at = excluded.recorded_at",
        )
        .run("instance-1", "deadbeef", "tests", "failed", 2),
    );
    const row = db
      .prepare("SELECT status FROM validation_evidence WHERE instance_id = ? AND head_commit = ? AND name = ?")
      .get("instance-1", "deadbeef", "tests") as { status: string };
    assert.equal(row.status, "failed");
  } finally {
    db.close();
  }
});

test("worktrees UNIQUE index rejects a second live worktree on the same branch_name", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    seedTask(db, "task-2", "instance-1");
    const insert = db.prepare(
      `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
       VALUES (?, ?, 'instance-1', 'task/dup', ?, 'active', 'main', 'deadbeef', 0, 0)`,
    );
    insert.run("worktree-1", "task-1", "/repo/.worktrees/task-dup-1");
    assert.throws(() => insert.run("worktree-2", "task-2", "/repo/.worktrees/task-dup-2"));
  } finally {
    db.close();
  }
});

test("worktrees UNIQUE index rejects a second live worktree on the same canonical_path", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    seedTask(db, "task-2", "instance-1");
    const insert = db.prepare(
      `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
       VALUES (?, ?, 'instance-1', ?, '/repo/.worktrees/shared-path', 'active', 'main', 'deadbeef', 0, 0)`,
    );
    insert.run("worktree-1", "task-1", "task/one");
    assert.throws(() => insert.run("worktree-2", "task-2", "task/two"));
  } finally {
    db.close();
  }
});

test("worktrees composite FK rejects a row whose instance_id does not match its task's instance_id", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo-a/.git");
    seedInstance(db, "instance-2", "/repo-b/.git");
    seedTask(db, "task-1", "instance-1");
    assert.throws(() =>
      db.prepare(
        `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
         VALUES ('worktree-1', 'task-1', 'instance-2', 'task/mismatch', '/repo/.worktrees/mismatch', 'active', 'main', 'deadbeef', 0, 0)`,
      ).run(),
    );
  } finally {
    db.close();
  }
});

test("worktrees UNIQUE index allows reuse of a branch_name/canonical_path once the prior row is removed", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    seedTask(db, "task-2", "instance-1");
    db.prepare(
      `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
       VALUES ('worktree-1', 'task-1', 'instance-1', 'task/reused', '/repo/.worktrees/reused', 'active', 'main', 'deadbeef', 0, 0)`,
    ).run();
    db.prepare("UPDATE worktrees SET status = 'removed' WHERE worktree_id = ?").run("worktree-1");
    assert.doesNotThrow(() =>
      db.prepare(
        `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
         VALUES ('worktree-2', 'task-2', 'instance-1', 'task/reused', '/repo/.worktrees/reused', 'active', 'main', 'deadbeef', 0, 0)`,
      ).run(),
    );
  } finally {
    db.close();
  }
});
