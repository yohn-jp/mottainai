import type { DatabaseSync } from "node:sqlite";

/**
 * 1 migration = 1 version。`up` は単一 transaction 内で実行され、失敗時は
 * ロールバックする。将来のスキーマ変更はこの配列に追記するだけでよく、
 * 既存 migration の内容は変更しない（適用済み環境との整合性のため）。
 */
export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
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
];

function currentVersion(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

/** 未適用の migration を version 昇順に適用する。冪等（適用済みなら何もしない）。 */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    let migration: Migration | undefined;
    try {
      const applied = currentVersion(db);
      migration = ordered.find((candidate) => candidate.version > applied);
      if (migration === undefined) {
        db.exec("COMMIT");
        return;
      }

      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の migration エラーを保持する
      }
      if (migration === undefined) throw err;
      throw new Error(`migration ${migration.version} (${migration.description}) failed: ${(err as Error).message}`);
    }
  }
}
