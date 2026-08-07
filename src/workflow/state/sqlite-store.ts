import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../../state/migrations.js";
import { resolveStateDbPath } from "../../state/paths.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type {
  RepositorySourceId,
  HookCheckpointRecord,
  ObserveRepositoryInstanceInput,
  ObserveRepositoryInstanceResult,
  RecordHookCheckpointInput,
  RepositoryInstanceRecord,
  RepositoryPathRecord,
  RepositorySourceRecord,
  ReserveTaskInput,
  ReserveTaskResult,
  ReserveWorktreeInput,
  ReserveWorktreeResult,
  TaskId,
  TaskRecord,
  WorkflowStateStore,
  WorktreeId,
  WorktreeRecord,
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

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    taskSlug: row.task_slug as string,
    issueRef: (row.issue_ref as string | null) ?? undefined,
    lifecycleState: row.lifecycle_state as LifecycleState,
    baseBranch: row.base_branch as string,
    baseCommit: row.base_commit as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toWorktreeRecord(row: Record<string, unknown>): WorktreeRecord {
  return {
    worktreeId: row.worktree_id as WorktreeId,
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    branchName: row.branch_name as string,
    canonicalPath: row.canonical_path as string,
    status: row.status as WorktreeRecord["status"],
    baseBranch: row.base_branch as string,
    baseCommit: row.base_commit as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** UNIQUE 制約違反を collision として扱うための判定。node:sqlite は専用の error class を
 * 公開しないため、code + message 文字列でマッチする（sanity script で確認済みの実挙動）。 */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" && err.message.includes("UNIQUE constraint failed");
}

function toHookCheckpointRecord(row: Record<string, unknown>): HookCheckpointRecord {
  return {
    instanceId: row.instance_id as RepositoryInstanceId,
    branch: row.branch as string,
    lastCheckedCommit: row.last_checked_commit as string,
    checkedAt: row.checked_at as number,
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

  recordHookCheckpoint(input: RecordHookCheckpointInput): HookCheckpointRecord {
    const db = this.handle();
    const checkedAt = input.checkedAt ?? Date.now();
    db.prepare(
      `INSERT INTO hook_checkpoints (instance_id, branch, last_checked_commit, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (instance_id, branch) DO UPDATE SET last_checked_commit = excluded.last_checked_commit, checked_at = excluded.checked_at`,
    ).run(input.instanceId, input.branch, input.commit, checkedAt);
    return { instanceId: input.instanceId, branch: input.branch, lastCheckedCommit: input.commit, checkedAt };
  }

  getHookCheckpoint(instanceId: RepositoryInstanceId, branch: string): HookCheckpointRecord | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM hook_checkpoints WHERE instance_id = ? AND branch = ?")
      .get(instanceId, branch) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toHookCheckpointRecord(row);
  }

  reserveTask(input: ReserveTaskInput): ReserveTaskResult {
    const db = this.handle();
    const now = input.reservedAt ?? Date.now();

    let result!: ReserveTaskResult;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!input.allowMultipleActiveTasksPerIssue && input.issueRef !== undefined) {
        const existingRow = db
          .prepare(
            "SELECT * FROM tasks WHERE instance_id = ? AND issue_ref = ? AND lifecycle_state NOT IN ('cleaned', 'abandoned')",
          )
          .get(input.instanceId, input.issueRef) as Record<string, unknown> | undefined;
        if (existingRow !== undefined) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "issue-already-claimed", existingTask: toTaskRecord(existingRow) };
        }
      }

      const taskId = crypto.randomUUID() as TaskId;
      db.prepare(
        `INSERT INTO tasks (task_id, instance_id, task_slug, issue_ref, lifecycle_state, base_branch, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
      ).run(taskId, input.instanceId, input.taskSlug, input.issueRef ?? null, input.baseBranch, input.baseCommit, now, now);
      const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown>;
      db.exec("COMMIT");
      result = { ok: true, task: toTaskRecord(row) };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の予約エラーを保持する
      }
      throw err;
    }
    return result;
  }

  reserveWorktree(input: ReserveWorktreeInput): ReserveWorktreeResult {
    const db = this.handle();
    const now = input.reservedAt ?? Date.now();

    db.exec("BEGIN IMMEDIATE");
    try {
      const worktreeId = crypto.randomUUID() as WorktreeId;
      db.prepare(
        `INSERT INTO worktrees (worktree_id, task_id, instance_id, branch_name, canonical_path, status, base_branch, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
      ).run(worktreeId, input.taskId, input.instanceId, input.branchName, input.canonicalPath, input.baseBranch, input.baseCommit, now, now);
      const row = db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as Record<string, unknown>;
      db.exec("COMMIT");
      return { ok: true, worktree: toWorktreeRecord(row) };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の予約エラーを保持する
      }
      if (!isUniqueConstraintError(err)) throw err;

      const branchConflict = db
        .prepare("SELECT * FROM worktrees WHERE instance_id = ? AND branch_name = ? AND status != 'removed'")
        .get(input.instanceId, input.branchName) as Record<string, unknown> | undefined;
      if (branchConflict !== undefined) {
        return { ok: false, reason: "branch-collision", existingWorktree: toWorktreeRecord(branchConflict) };
      }
      const pathConflict = db
        .prepare("SELECT * FROM worktrees WHERE instance_id = ? AND canonical_path = ? AND status != 'removed'")
        .get(input.instanceId, input.canonicalPath) as Record<string, unknown> | undefined;
      if (pathConflict !== undefined) {
        return { ok: false, reason: "path-collision", existingWorktree: toWorktreeRecord(pathConflict) };
      }
      throw err;
    }
  }

  activateWorktree(worktreeId: WorktreeId, activatedAt?: number): WorktreeRecord {
    const db = this.handle();
    const now = activatedAt ?? Date.now();
    db.prepare("UPDATE worktrees SET status = 'active', updated_at = ? WHERE worktree_id = ?").run(now, worktreeId);
    const row = db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`worktree not found: ${worktreeId}`);
    return toWorktreeRecord(row);
  }

  deleteReservedTask(taskId: TaskId): void {
    this.handle().prepare("DELETE FROM tasks WHERE task_id = ? AND lifecycle_state = 'planned'").run(taskId);
  }

  deleteReservedWorktree(worktreeId: WorktreeId): void {
    this.handle().prepare("DELETE FROM worktrees WHERE worktree_id = ? AND status = 'reserved'").run(worktreeId);
  }

  updateTaskLifecycleState(taskId: TaskId, next: LifecycleState, updatedAt?: number): TaskRecord {
    const db = this.handle();
    const now = updatedAt ?? Date.now();
    db.prepare("UPDATE tasks SET lifecycle_state = ?, updated_at = ? WHERE task_id = ?").run(next, now, taskId);
    const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`task not found: ${taskId}`);
    return toTaskRecord(row);
  }

  getTask(taskId: TaskId): TaskRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTaskRecord(row);
  }

  getActiveTaskByIssueRef(instanceId: RepositoryInstanceId, issueRef: string): TaskRecord | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM tasks WHERE instance_id = ? AND issue_ref = ? AND lifecycle_state NOT IN ('cleaned', 'abandoned')")
      .get(instanceId, issueRef) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTaskRecord(row);
  }

  listWorktreesForTask(taskId: TaskId): WorktreeRecord[] {
    const rows = this.handle().prepare("SELECT * FROM worktrees WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<
      string,
      unknown
    >[];
    return rows.map(toWorktreeRecord);
  }

  listWorktreesForInstance(instanceId: RepositoryInstanceId): WorktreeRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM worktrees WHERE instance_id = ? ORDER BY created_at ASC")
      .all(instanceId) as Record<string, unknown>[];
    return rows.map(toWorktreeRecord);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
