import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../../state/migrations.js";
import { resolveStateDbPath } from "../../state/paths.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type {
  RepositorySourceId,
  ObserveRepositoryInstanceInput,
  ObserveRepositoryInstanceResult,
  RepositoryInstanceRecord,
  RepositoryPathRecord,
  RepositorySourceRecord,
  WorkflowStateStore,
} from "./store.js";

export interface WorkflowSqliteStateStoreOptions {
  /** 明示指定時はこのパスを使う。省略時は resolveStateDbPath() を使う（session 用と同じ DB ファイルを共有）。 */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** state directory / DB ファイルを所有者のみ読める権限に絞る（対応 Unix のみ）。 */
function restrictToOwner(targetPath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function toSourceRecord(row: Record<string, unknown>): RepositorySourceRecord {
  return {
    sourceId: row.source_id as RepositorySourceId,
    rootCommitDigest: row.root_commit_digest as RootCommitDigest,
    createdAt: row.created_at as number,
  };
}

function toInstanceRecord(row: Record<string, unknown>): RepositoryInstanceRecord {
  return {
    instanceId: row.instance_id as RepositoryInstanceId,
    sourceId: row.source_id as RepositorySourceId,
    gitCommonDir: row.git_common_dir as string,
    createdAt: row.created_at as number,
    lastSeenAt: row.last_seen_at as number,
  };
}

function toPathRecord(row: Record<string, unknown>): RepositoryPathRecord {
  return {
    instanceId: row.instance_id as RepositoryInstanceId,
    canonicalPath: row.canonical_path as string,
    isCurrent: (row.is_current as number) === 1,
    observedAt: row.observed_at as number,
  };
}

/**
 * SQLite backed WorkflowStateStore。session 用 SqliteStateStore と同じ DB
 * ファイル・migration 機構を共有する（別ファイルに分けると schema_migrations
 * の適用順序管理が二重化するため）。
 */
export class WorkflowSqliteStateStore implements WorkflowStateStore {
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;

  constructor(options: WorkflowSqliteStateStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveStateDbPath(options.env ?? process.env);
  }

  init(): void {
    if (this.db !== undefined) return;
    const isFileBacked = this.dbPath !== ":memory:";
    if (isFileBacked) {
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      restrictToOwner(dir, 0o700);
    }
    const db = new DatabaseSync(this.dbPath);
    try {
      if (isFileBacked) restrictToOwner(this.dbPath, 0o600);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrations(db);
      if (isFileBacked) {
        restrictToOwner(`${this.dbPath}-wal`, 0o600);
        restrictToOwner(`${this.dbPath}-shm`, 0o600);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
  }

  private handle(): DatabaseSync {
    if (this.db === undefined) throw new Error("WorkflowSqliteStateStore.init() must be called before use");
    return this.db;
  }

  observeRepositoryInstance(input: ObserveRepositoryInstanceInput): ObserveRepositoryInstanceResult {
    const db = this.handle();
    const now = input.observedAt ?? Date.now();

    let result!: ObserveRepositoryInstanceResult;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingSourceRow = db
        .prepare("SELECT * FROM repository_sources WHERE root_commit_digest = ?")
        .get(input.rootCommitDigest) as Record<string, unknown> | undefined;
      if (existingSourceRow === undefined) {
        const newSourceId = crypto.randomUUID() as RepositorySourceId;
        db.prepare("INSERT INTO repository_sources (source_id, root_commit_digest, created_at) VALUES (?, ?, ?)")
          .run(newSourceId, input.rootCommitDigest, now);
      }
      const source = toSourceRecord(
        db.prepare("SELECT * FROM repository_sources WHERE root_commit_digest = ?").get(input.rootCommitDigest) as Record<
          string,
          unknown
        >,
      );

      const existingInstance = db.prepare("SELECT * FROM repository_instances WHERE instance_id = ?").get(input.instanceId) as
        | Record<string, unknown>
        | undefined;

      if (existingInstance === undefined) {
        // instance marker ファイル削除後の再観測や、同一パスへの再 clone では
        // 新しい instanceId が発行されるが、旧 instance 行がまだ同じ
        // git_common_dir を保持している可能性がある（UNIQUE 制約対象）。
        // 旧 instance 自体は削除せず（repository_paths の履歴を保つ）、
        // git_common_dir 列だけを一意な退避値へ書き換えて新 instance に明け渡す。
        const staleInstance = db
          .prepare("SELECT instance_id FROM repository_instances WHERE git_common_dir = ?")
          .get(input.gitCommonDir) as { instance_id: string } | undefined;
        if (staleInstance !== undefined && staleInstance.instance_id !== input.instanceId) {
          db.prepare("UPDATE repository_instances SET git_common_dir = ? WHERE instance_id = ?").run(
            `${input.gitCommonDir}#superseded-by:${input.instanceId}`,
            staleInstance.instance_id,
          );
        }
        db.prepare(
          "INSERT INTO repository_instances (instance_id, source_id, git_common_dir, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        ).run(input.instanceId, source.sourceId, input.gitCommonDir, now, now);
      } else {
        db.prepare("UPDATE repository_instances SET last_seen_at = ? WHERE instance_id = ?").run(now, input.instanceId);
      }
      const instance = toInstanceRecord(
        db.prepare("SELECT * FROM repository_instances WHERE instance_id = ?").get(input.instanceId) as Record<string, unknown>,
      );

      const currentPathRow = db
        .prepare("SELECT canonical_path FROM repository_paths WHERE instance_id = ? AND is_current = 1")
        .get(input.instanceId) as { canonical_path: string } | undefined;
      const previousCurrentPath = currentPathRow?.canonical_path;
      const moved = previousCurrentPath !== undefined && previousCurrentPath !== input.canonicalWorktreePath;

      if (previousCurrentPath === undefined) {
        db.prepare(
          "INSERT INTO repository_paths (instance_id, canonical_path, is_current, observed_at) VALUES (?, ?, 1, ?)",
        ).run(input.instanceId, input.canonicalWorktreePath, now);
      } else if (moved) {
        db.prepare(
          "UPDATE repository_paths SET is_current = 0 WHERE instance_id = ? AND canonical_path = ?",
        ).run(input.instanceId, previousCurrentPath);
        db.prepare(
          `INSERT INTO repository_paths (instance_id, canonical_path, is_current, observed_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT (instance_id, canonical_path) DO UPDATE SET is_current = 1, observed_at = excluded.observed_at`,
        ).run(input.instanceId, input.canonicalWorktreePath, now);
      }

      db.exec("COMMIT");
      result = { source, instance, moved, previousCurrentPath };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の観測エラーを保持する
      }
      throw err;
    }
    return result;
  }

  getRepositorySource(sourceId: RepositorySourceId): RepositorySourceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM repository_sources WHERE source_id = ?").get(sourceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toSourceRecord(row);
  }

  getRepositorySourceByDigest(rootCommitDigest: RootCommitDigest): RepositorySourceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM repository_sources WHERE root_commit_digest = ?").get(rootCommitDigest) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toSourceRecord(row);
  }

  getRepositoryInstance(instanceId: RepositoryInstanceId): RepositoryInstanceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM repository_instances WHERE instance_id = ?").get(instanceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toInstanceRecord(row);
  }

  getRepositoryInstanceByCommonDir(gitCommonDir: string): RepositoryInstanceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM repository_instances WHERE git_common_dir = ?").get(gitCommonDir) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toInstanceRecord(row);
  }

  listRepositoryPaths(instanceId: RepositoryInstanceId): RepositoryPathRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM repository_paths WHERE instance_id = ? ORDER BY observed_at ASC")
      .all(instanceId) as Record<string, unknown>[];
    return rows.map(toPathRecord);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
