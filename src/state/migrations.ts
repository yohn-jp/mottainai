import type { DatabaseSync } from "node:sqlite";
import { addSecondaryDiagnostic, DIRECT_BOUNDARIES } from "../boundary.js";
import type { BoundaryOperations } from "../boundary.js";

/**
 * 1 migration = 1 version。`up` は単一 transaction 内で実行され、失敗時は
 * ロールバックする。将来のスキーマ変更はこの配列に追記するだけでよく、
 * 既存 migration の内容は変更しない（適用済み環境との整合性のため）。
 */
export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync, boundaries?: BoundaryOperations) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema: sessions, read_evidence, read_decisions",
    up: (db) => {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );

        CREATE TABLE read_evidence (
          evidence_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX idx_read_evidence_session ON read_evidence (session_id);

        CREATE TABLE read_decisions (
          decision_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          path TEXT NOT NULL,
          action TEXT NOT NULL,
          file_class TEXT NOT NULL,
          capability TEXT NOT NULL,
          policy_code TEXT NOT NULL,
          reason TEXT NOT NULL,
          stage TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_read_decisions_session ON read_decisions (session_id);
      `);
    },
  },
  {
    version: 2,
    description: "workflow: repository_sources, repository_instances, repository_paths",
    up: (db) => {
      db.exec(`
        CREATE TABLE repository_sources (
          source_id TEXT PRIMARY KEY,
          root_commit_digest TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE repository_instances (
          instance_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES repository_sources (source_id),
          git_common_dir TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX idx_repository_instances_source ON repository_instances (source_id);

        CREATE TABLE repository_paths (
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          canonical_path TEXT NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (instance_id, canonical_path)
        );
        -- instance あたり is_current=1 の行を高々 1 つに制約する
        -- （WorkflowSqliteStateStore.observeRepositoryInstance の move 検出は
        -- 単一行の SELECT に依存しており、複数行が current だと非決定的になる）。
        -- instance_id 単体の lookup は主キー (instance_id, canonical_path) の
        -- 先頭列で足りるため、別途の非 unique index は張らない。
        CREATE UNIQUE INDEX idx_repository_paths_current ON repository_paths (instance_id) WHERE is_current = 1;
      `);
    },
  },
  {
    version: 3,
    description: "workflow: hook_checkpoints (hook bypass / direct-Git divergence detection)",
    up: (db) => {
      db.exec(`
        -- instance+branch ごとに「最後に pre-commit/pre-push hook を経由して
        -- policy check を通過した commit SHA」を記録する。次回チェック時に
        -- 記録済み SHA が現在の branch tip の ancestor でなければ、hook を
        -- 経由しない変更（--no-verify・hook 未対応クライアント・直接の
        -- ref 書き換え等）が発生したと判定できる。detection のみがこの
        -- Child Issue の範囲であり、報告・repair は Child Issue 8 が担う。
        CREATE TABLE hook_checkpoints (
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          branch TEXT NOT NULL,
          last_checked_commit TEXT NOT NULL,
          checked_at INTEGER NOT NULL,
          PRIMARY KEY (instance_id, branch)
        );
      `);
    },
  },
  {
    version: 4,
    description: "workflow: tasks, worktrees (Issue-bound task/worktree lifecycle)",
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          task_slug TEXT NOT NULL,
          issue_ref TEXT,
          lifecycle_state TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          -- worktrees.(task_id, instance_id) の複合 FK が参照する対象。task_id は
          -- 単独でも PRIMARY KEY で一意だが、worktree 側が task と別の instance を
          -- 指す不整合（task_id は正しいが instance_id が食い違う行）を FK 制約自体で
          -- 防ぐには、参照先にも複合 UNIQUE が必要。
          UNIQUE (task_id, instance_id)
        );
        CREATE INDEX idx_tasks_instance ON tasks (instance_id);
        -- issue_ref の一意性は multipleActiveTasksPerIssue/issueRequired という policy 次第で
        -- 可変な制約なので、DB の静的 UNIQUE index にはできない。呼び出し側
        -- （WorkflowSqliteStateStore.reserveTask）が同一 BEGIN IMMEDIATE トランザクション内で
        -- SELECT してから INSERT することで一意性を保証する。この index は絞り込みの高速化のみが目的。
        CREATE INDEX idx_tasks_issue_ref ON tasks (instance_id, issue_ref);

        CREATE TABLE worktrees (
          worktree_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          status TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          -- task_id 単独 FK + instance_id 単独 FK では、worktree が「task A に属する
          -- ふりをしつつ instance B を名乗る」不整合行を作れてしまう（task-to-instance
          -- membership が強制されない）。複合 FK で常に同じ tasks 行に属する
          -- (task_id, instance_id) の組だけを許可する。
          FOREIGN KEY (task_id, instance_id) REFERENCES tasks (task_id, instance_id)
        );
        CREATE INDEX idx_worktrees_task ON worktrees (task_id);
        -- branch/path の一意性は policy に関わらず常に静的制約（同じ branch/path が同時に
        -- 2つの生きた worktree を裏付けることはあり得ない）。status='removed' の行は
        -- 過去の履歴として残すため index の対象から外し、2プロセス同時 reserveWorktree の
        -- race を UNIQUE 制約違反というエラー経路で安全に検出できるようにする。
        CREATE UNIQUE INDEX idx_worktrees_branch ON worktrees (instance_id, branch_name) WHERE status != 'removed';
        CREATE UNIQUE INDEX idx_worktrees_path ON worktrees (instance_id, canonical_path) WHERE status != 'removed';
      `);
    },
  },
  {
    version: 5,
    description: "workflow: provider-neutral pull request records",
    up: (db) => {
      db.exec(`
        CREATE TABLE pr_records (
          record_id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks (task_id) ON DELETE SET NULL,
          provider TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          pr_number INTEGER NOT NULL CHECK (pr_number > 0),
          url TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (provider, repository_id, pr_number)
        );
        CREATE UNIQUE INDEX idx_pr_records_task ON pr_records (task_id) WHERE task_id IS NOT NULL;
        CREATE INDEX idx_pr_records_repository ON pr_records (provider, repository_id);
        CREATE INDEX idx_pr_records_lifecycle ON pr_records (lifecycle_state);
      `);
    },
  },
  {
    version: 6,
    description: "workflow: validation_evidence (trusted record of validation results per commit)",
    up: (db) => {
      db.exec(`
        -- instance+commit+validation-kind ごとに「実際に実行された検証の結果」を
        -- 記録する。push.ts の requiredValidationEvidence gate はこのテーブルの
        -- 内容だけを信頼する — 呼び出し側が渡す evidence オブジェクトは
        -- 一切信頼しない。書き込みは検証を実際に実行した trusted caller
        -- （CLI/MCP のテスト実行ステップ等）のみが行う想定。
        CREATE TABLE validation_evidence (
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          head_commit TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          PRIMARY KEY (instance_id, head_commit, name)
        );
      `);
    },
  },
  {
    version: 7,
    description: "workflow: monotonic task versions for cleanup TOCTOU checks",
    up: (db) => {
      db.exec("ALTER TABLE tasks ADD COLUMN task_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    version: 8,
    description: "workflow: cleanup leases for crash recovery",
    up: (db) => {
      db.exec(`
        CREATE TABLE cleanup_leases (
          operation_id TEXT PRIMARY KEY,
          plan_digest TEXT NOT NULL,
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          task_id TEXT NOT NULL REFERENCES tasks (task_id),
          worktree_id TEXT REFERENCES worktrees (worktree_id),
          owner TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'mutating', 'verifying', 'committed', 'failed')),
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_actions_json TEXT NOT NULL DEFAULT '[]',
          last_error TEXT
        );
        CREATE INDEX idx_cleanup_leases_resource
          ON cleanup_leases (instance_id, task_id, worktree_id, updated_at);
        CREATE INDEX idx_cleanup_leases_expiry
          ON cleanup_leases (state, expires_at);
      `);
    },
  },
  {
    version: 9,
    description: "workflow: privacy-safe guardrail audit records",
    up: (db) => {
      db.exec(`
        CREATE TABLE audit_records (
          audit_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'observe')),
          rule_id TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          instance_id TEXT REFERENCES repository_instances (instance_id),
          task_id TEXT REFERENCES tasks (task_id) ON DELETE SET NULL,
          policy_provenance TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          recorded_at INTEGER NOT NULL
        );
        CREATE INDEX idx_audit_records_recorded_at ON audit_records (recorded_at);
        CREATE INDEX idx_audit_records_operation ON audit_records (operation, decision);
        CREATE INDEX idx_audit_records_instance ON audit_records (instance_id, task_id);
      `);
    },
  },
  {
    version: 10,
    description: "workflow: repository-scoped pull request records",
    up: (db) => {
      db.exec(`
        ALTER TABLE pr_records ADD COLUMN instance_id TEXT REFERENCES repository_instances (instance_id);
        UPDATE pr_records
        SET instance_id = (
          SELECT tasks.instance_id FROM tasks WHERE tasks.task_id = pr_records.task_id
        )
        WHERE instance_id IS NULL AND task_id IS NOT NULL;
        CREATE INDEX idx_pr_records_instance ON pr_records (instance_id, task_id);
      `);
    },
  },
  {
    version: 11,
    description: "workflow: enforce audit task-instance membership",
    up: (db) => {
      db.exec(`
        CREATE TRIGGER audit_records_task_instance_insert
        BEFORE INSERT ON audit_records
        FOR EACH ROW
        WHEN NEW.task_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.task_id = NEW.task_id
              AND tasks.instance_id = NEW.instance_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'audit record task and instance do not match');
        END;

        CREATE TRIGGER audit_records_task_instance_update
        BEFORE UPDATE OF task_id, instance_id ON audit_records
        FOR EACH ROW
        WHEN NEW.task_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.task_id = NEW.task_id
              AND tasks.instance_id = NEW.instance_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'audit record task and instance do not match');
        END;
      `);
    },
  },
  {
    version: 12,
    description: "workflow: idempotent task-start keys",
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN start_idempotency_key TEXT;
        CREATE UNIQUE INDEX idx_tasks_start_idempotency
          ON tasks (instance_id, start_idempotency_key)
          WHERE start_idempotency_key IS NOT NULL;
      `);
    },
  },
  {
    version: 13,
    description: "workflow: check_runs (managed validation governor executions, issue #184)",
    up: (db) => {
      db.exec(`
        -- managed check（issue #184 validation governor）の実行記録。repository instance +
        -- worktree で分離し、同じ (check, state fingerprint, config digest) の組に対して
        -- 直近の PASSED 行だけが reuse の根拠になる（governor.ts の findReusableCheckRun）。
        -- FAILED 行は再利用対象にならないので実行のたびに新しい行として残る。
        CREATE TABLE check_runs (
          run_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES repository_instances (instance_id),
          worktree_id TEXT NOT NULL,
          check_id TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          state_fingerprint TEXT NOT NULL,
          config_digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
          execution TEXT NOT NULL CHECK (execution IN ('executed', 'reused')),
          started_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          summary TEXT NOT NULL,
          artifact_ref TEXT,
          provenance_reason_code TEXT NOT NULL,
          provenance_explanation TEXT NOT NULL
        );
        CREATE INDEX idx_check_runs_reuse
          ON check_runs (instance_id, worktree_id, check_id, state_fingerprint, config_digest, recorded_at DESC)
          WHERE status = 'passed';
        CREATE INDEX idx_check_runs_latest
          ON check_runs (instance_id, worktree_id, check_id, recorded_at DESC);
      `);
    },
  },
  {
    version: 14,
    description: "manager: durable Zellij-backed agent session records",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS manager_sessions (
          session_id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          task_id TEXT,
          worktree_id TEXT,
          worktree_path TEXT NOT NULL,
          branch_name TEXT,
          agent_kind TEXT NOT NULL CHECK (agent_kind = 'codex'),
          launch_command TEXT NOT NULL,
          launch_args_json TEXT NOT NULL,
          runtime_name TEXT NOT NULL UNIQUE,
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('starting', 'running', 'exited', 'stopped', 'failed')),
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          exit_code INTEGER,
          termination_state TEXT CHECK (termination_state IS NULL OR termination_state IN ('running', 'exited', 'stopped', 'failed')),
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_manager_sessions_workspace ON manager_sessions (workspace_root, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_manager_sessions_task ON manager_sessions (task_id);
      `);
    },
  },
  {
    version: 15,
    description: "workflow: opaque Nawabari execution-session references",
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN nawabari_session_id TEXT;
        CREATE UNIQUE INDEX idx_tasks_nawabari_session
          ON tasks (nawabari_session_id)
          WHERE nawabari_session_id IS NOT NULL;
      `);
    },
  },
  {
    // Keep this migration independent of issue #181's v15 task-reference migration.
    // It can therefore be applied on either side of that concurrent change.
    version: 16,
    description: "manager: launch profiles and bounded runtime reconciliation projection",
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_manager_sessions_workspace;
        DROP INDEX IF EXISTS idx_manager_sessions_task;

        CREATE TABLE manager_sessions_v16 (
          session_id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          task_id TEXT,
          execution_session_id TEXT,
          execution_mode TEXT NOT NULL CHECK (execution_mode IN ('task-bound', 'workspace')),
          worktree_id TEXT,
          worktree_path TEXT NOT NULL,
          branch_name TEXT,
          task_slug TEXT,
          issue_ref TEXT,
          branch_type TEXT,
          agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'claude')),
          launch_profile TEXT NOT NULL CHECK (launch_profile IN ('codex', 'claude')),
          instruction TEXT NOT NULL,
          model TEXT,
          launch_command TEXT NOT NULL,
          launch_args_json TEXT NOT NULL,
          runtime_name TEXT NOT NULL UNIQUE,
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('starting', 'running', 'exited', 'stopped', 'failed')),
          runtime_state TEXT NOT NULL CHECK (runtime_state IN ('starting', 'running', 'detached', 'exited', 'failed', 'stopped', 'stale')),
          semantic_lifecycle_state TEXT NOT NULL CHECK (semantic_lifecycle_state IN ('unbound', 'planned', 'active', 'committed', 'pushed', 'pull-request-open', 'merged', 'abandoned', 'orphaned', 'cleaned')),
          attachable INTEGER NOT NULL CHECK (attachable IN (0, 1)),
          reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('synced', 'drifted', 'unresolved')),
          reconciliation_message TEXT,
          latest_status TEXT,
          latest_receipt_json TEXT,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          runtime_observed_at INTEGER,
          restart_count INTEGER NOT NULL DEFAULT 0,
          exit_code INTEGER,
          termination_state TEXT CHECK (termination_state IS NULL OR termination_state IN ('running', 'exited', 'stopped', 'failed')),
          error_message TEXT
        );

        INSERT INTO manager_sessions_v16 (
          session_id, workspace_root, task_id, execution_session_id, execution_mode, worktree_id, worktree_path, branch_name,
          task_slug, issue_ref, branch_type, agent_kind, launch_profile, instruction, model,
          launch_command, launch_args_json, runtime_name, lifecycle_state, runtime_state,
          semantic_lifecycle_state, attachable, reconciliation_state, latest_status,
          started_at, updated_at, finished_at, exit_code, termination_state, error_message
        )
        SELECT
          session_id, workspace_root, task_id, NULL, CASE WHEN task_id IS NULL THEN 'workspace' ELSE 'task-bound' END, worktree_id, worktree_path, branch_name,
          NULL, NULL, NULL, agent_kind, 'codex', '', NULL,
          launch_command, launch_args_json, runtime_name, lifecycle_state,
          lifecycle_state, CASE WHEN task_id IS NULL THEN 'unbound' ELSE 'active' END,
          CASE WHEN lifecycle_state = 'running' THEN 1 ELSE 0 END, 'synced',
          error_message, started_at, updated_at,
          CASE WHEN lifecycle_state IN ('exited', 'stopped', 'failed') THEN updated_at ELSE NULL END,
          exit_code, termination_state, error_message
        FROM manager_sessions;

        DROP TABLE manager_sessions;
        ALTER TABLE manager_sessions_v16 RENAME TO manager_sessions;
        CREATE INDEX idx_manager_sessions_workspace ON manager_sessions (workspace_root, started_at DESC, session_id DESC);
        CREATE INDEX idx_manager_sessions_task ON manager_sessions (task_id);
        CREATE INDEX idx_manager_sessions_runtime ON manager_sessions (workspace_root, runtime_state, started_at DESC);
      `);
    },
  },
  {
    version: 17,
    description: "workflow: durable Nawabari task-start reconciliation records",
    up: (db) => {
      db.exec(`
        CREATE TABLE task_start_reconciliations (
          task_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          task_label TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          nawabari_session_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'session-created', 'attached', 'active', 'abandoned', 'orphaned')),
          detail TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (task_id, instance_id) REFERENCES tasks (task_id, instance_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_task_start_reconciliation_session
          ON task_start_reconciliations (nawabari_session_id)
          WHERE nawabari_session_id IS NOT NULL;
        CREATE INDEX idx_task_start_reconciliation_instance
          ON task_start_reconciliations (instance_id, state, updated_at DESC);
      `);
    },
  },
  {
    version: 18,
    description: "workflow: durable Nawabari push reconciliation evidence",
    up: (db) => {
      db.exec(`
        CREATE TABLE push_reconciliations (
          operation_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          nawabari_session_id TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          remote TEXT NOT NULL,
          target_branch TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          force_requested INTEGER NOT NULL,
          create_upstream INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('prepared', 'attempting', 'succeeded', 'ambiguous', 'reconciled')),
          observed_remote_sha TEXT,
          recovery_observed_remote_sha TEXT,
          result_remote_sha TEXT,
          relation TEXT,
          evidence_complete INTEGER NOT NULL DEFAULT 0,
          detail TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (task_id, instance_id) REFERENCES tasks (task_id, instance_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_push_reconciliations_task ON push_reconciliations (task_id);
        CREATE INDEX idx_push_reconciliations_instance_state
          ON push_reconciliations (instance_id, state, updated_at DESC);
      `);
    },
  },
];

function appliedVersions(db: DatabaseSync): Set<number> {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[];
  return new Set(rows.map((row) => row.version));
}

/** 未適用の migration を version 昇順に適用する。冪等（適用済みなら何もしない）。 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: Migration[] = MIGRATIONS,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): void {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  // Apply the lowest unapplied migration, rather than only versions greater
  // than MAX(version). This keeps independently developed migrations
  // composable: #186 may land its Manager projection before #181's v15
  // Nawabari task-reference migration, and the latter must still be applied.
  for (;;) {
    boundaries.file("sqlite.begin", () => db.exec("BEGIN IMMEDIATE"));
    let migration: Migration | undefined;
    try {
      // Re-read applied versions inside the write-locked transaction: a
      // snapshot taken before BEGIN IMMEDIATE can be stale when another
      // process committed the same migration while this one waited for the
      // lock, which would otherwise re-run `up` and violate its assumptions.
      const applied = appliedVersions(db);
      migration = ordered.find((candidate) => !applied.has(candidate.version));
      if (migration === undefined) {
        db.exec("COMMIT");
        return;
      }

      migration.up(db, boundaries);
      boundaries.file("sqlite.migration.after", () => undefined);
      boundaries.file("sqlite.version.record", () => {
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration!.version,
          Date.now(),
        );
      });
      boundaries.file("sqlite.commit", () => db.exec("COMMIT"));
    } catch (err) {
      let rollbackError: unknown;
      try {
        boundaries.file("sqlite.rollback", () => db.exec("ROLLBACK"));
      } catch (error) {
        rollbackError = error;
        // A seam failure may happen before SQLite executes the rollback. Keep the
        // handle retryable with one direct best-effort cleanup attempt.
        try {
          db.exec("ROLLBACK");
        } catch (fallbackError) {
          rollbackError = fallbackError;
        }
      }
      if (migration === undefined) throw err;
      const wrapped = new Error(
        `migration ${migration.version} (${migration.description}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      if (rollbackError !== undefined) throw addSecondaryDiagnostic(wrapped, "sqlite.rollback", rollbackError);
      throw wrapped;
    }
  }
}
