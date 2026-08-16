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

test("applyMigrations still applies an independently added lower version after a higher one", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db, [{ version: 2, description: "later", up: () => undefined }]);
    applyMigrations(db, [
      { version: 1, description: "concurrent", up: (database) => database.exec("CREATE TABLE concurrent_migration (value TEXT)") },
      { version: 2, description: "later", up: () => { throw new Error("must not rerun"); } },
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 2);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'concurrent_migration'").get());
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

test("workflow tables including task-start reconciliation are reachable after migration to the latest version", () => {
  const db = freshDb();
  try {
    const latestVersion = Math.max(...MIGRATIONS.map((migration) => migration.version));
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, latestVersion);
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get("task-1") as { lifecycle_state: string };
    assert.equal(task.lifecycle_state, "planned");
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_start_reconciliations'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commit_reconciliations'").get());
  } finally {
    db.close();
  }
});

test("manager Pi migration preserves existing Codex session records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 19));
    db.prepare(
      `INSERT INTO manager_sessions
        (session_id, workspace_root, execution_mode, worktree_path, agent_kind, launch_profile, instruction,
         launch_command, launch_args_json, runtime_name, lifecycle_state, runtime_state, semantic_lifecycle_state,
         attachable, reconciliation_state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "codex-session",
      "/repo",
      "workspace",
      "/repo",
      "codex",
      "codex",
      "keep this record",
      "codex",
      '["--", "keep this record"]',
      "mottainai-codex-session",
      "running",
      "running",
      "unbound",
      1,
      "synced",
      1,
      1,
    );

    applyMigrations(db, MIGRATIONS);
    const row = db
      .prepare(
        "SELECT agent_kind, launch_profile, instruction, provider, idempotency_key FROM manager_sessions WHERE session_id = ?",
      )
      .get("codex-session") as {
      agent_kind: string;
      launch_profile: string;
      instruction: string;
      provider: string | null;
      idempotency_key: string | null;
    };
    assert.deepEqual({ ...row }, {
      agent_kind: "codex",
      launch_profile: "codex",
      instruction: "keep this record",
      provider: null,
      idempotency_key: null,
    });
  } finally {
    db.close();
  }
});

test("version 7 adds a monotonic task_version column defaulting to 1", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    const task = db.prepare("SELECT task_version FROM tasks WHERE task_id = ?").get("task-1") as {
      task_version: number;
    };
    assert.equal(task.task_version, 1);
  } finally {
    db.close();
  }
});

test("version 8 creates cleanup_leases reachable after migration", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo/.git");
    seedTask(db, "task-1", "instance-1");
    db.prepare(
      `INSERT INTO cleanup_leases
        (operation_id, plan_digest, instance_id, task_id, worktree_id, owner, state, acquired_at, expires_at, updated_at)
       VALUES ('op-1', 'digest-1', 'instance-1', 'task-1', NULL, 'owner-1', 'reserved', 0, 1000, 0)`,
    ).run();
    const lease = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get("op-1") as {
      state: string;
    };
    assert.equal(lease.state, "reserved");
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

test("audit records enforce task-instance membership while preserving task deletion", () => {
  const db = freshDb();
  try {
    seedInstance(db, "instance-1", "/repo-a/.git");
    seedInstance(db, "instance-2", "/repo-b/.git");
    seedTask(db, "task-1", "instance-1");
    const insert = db.prepare(
      `INSERT INTO audit_records
        (audit_id, operation, decision, rule_id, reason_code, instance_id, task_id, policy_provenance, metadata_json, recorded_at)
       VALUES (?, 'cleanup', 'deny', 'cleanup-safety', 'mismatch', ?, ?, NULL, '{}', 0)`,
    );
    insert.run("audit-valid", "instance-1", "task-1");
    assert.throws(() => insert.run("audit-invalid", "instance-2", "task-1"));
    assert.throws(() =>
      db.prepare("UPDATE audit_records SET instance_id = ? WHERE audit_id = ?").run("instance-2", "audit-valid"),
    );

    db.prepare("DELETE FROM tasks WHERE task_id = ?").run("task-1");
    const deletedTask = db
      .prepare("SELECT task_id, instance_id FROM audit_records WHERE audit_id = ?")
      .get("audit-valid") as {
      task_id: string | null;
      instance_id: string | null;
    };
    assert.equal(deletedTask.task_id, null);
    assert.equal(deletedTask.instance_id, "instance-1");
  } finally {
    db.close();
  }
});
