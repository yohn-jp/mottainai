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
];

function currentVersion(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

/** 未適用の migration を version 昇順に適用する。冪等（適用済みなら何もしない）。 */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const applied = currentVersion(db);
  const pending = migrations.filter((migration) => migration.version > applied).sort((left, right) => left.version - right.version);
  const recordApplied = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.up(db);
      recordApplied.run(migration.version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} (${migration.description}) failed: ${(err as Error).message}`);
    }
  }
}
