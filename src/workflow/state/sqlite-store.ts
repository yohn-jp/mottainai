import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addSecondaryDiagnostic, DIRECT_BOUNDARIES } from "../../boundary.js";
import type { BoundaryOperations } from "../../boundary.js";
import { applyMigrations } from "../../state/migrations.js";
import type { Migration } from "../../state/migrations.js";
import { resolveStateDbPath } from "../../state/paths.js";
import { sanitizeAuditMetadata } from "../domain/audit.js";
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
  PullRequestRecord,
  PullRequestRecordId,
  RecordPullRequestInput,
  ReserveTaskInput,
  ReserveTaskResult,
  ReserveWorktreeInput,
  ReserveWorktreeResult,
  RecordValidationEvidenceInput,
  CleanupLeaseRecord,
  CleanupLeaseState,
  CommitCleanupInput,
  CommitCleanupResult,
  GuardrailAuditRecord,
  GuardrailAuditDecision,
  ListGuardrailAuditRecordsOptions,
  MarkCleanupLeaseInput,
  RecordGuardrailDecisionInput,
  ReserveCleanupLeaseInput,
  ReserveCleanupLeaseResult,
  TaskId,
  TaskRecord,
  ValidationEvidenceRecord,
  WorkflowStateStore,
  WorktreeId,
  WorktreeRecord,
} from "./store.js";

export interface WorkflowSqliteStateStoreOptions {
  /** 明示指定時はこのパスを使う。省略時は resolveStateDbPath() を使う（session 用と同じ DB ファイルを共有）。 */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal deterministic fault-test seam; not loaded from runtime config. */
  boundaries?: BoundaryOperations;
  /** Internal migration fixture seam used by rollback tests. */
  migrations?: Migration[];
}

/** state directory / DB ファイルを所有者のみ読める権限に絞る。 */
function restrictToOwner(targetPath: string, mode: number): void {
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
    version: (row.task_version as number | undefined) ?? 1,
    baseBranch: row.base_branch as string,
    baseCommit: row.base_commit as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toCleanupLeaseRecord(row: Record<string, unknown>): CleanupLeaseRecord {
  let completedActionIds: string[];
  try {
    const parsed: unknown = JSON.parse(String(row.completed_actions_json ?? "[]"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
      throw new Error("invalid completed action list");
    completedActionIds = [...parsed];
  } catch (err) {
    throw new Error(`invalid cleanup lease action state: ${(err as Error).message}`);
  }
  return {
    operationId: row.operation_id as string,
    planDigest: row.plan_digest as string,
    instanceId: row.instance_id as RepositoryInstanceId,
    taskId: row.task_id as TaskId,
    worktreeId: (row.worktree_id as WorktreeId | null) ?? undefined,
    owner: row.owner as string,
    state: row.state as CleanupLeaseState,
    acquiredAt: row.acquired_at as number,
    expiresAt: row.expires_at as number,
    updatedAt: row.updated_at as number,
    completedActionIds,
    lastError: (row.last_error as string | null) ?? undefined,
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
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    err.message.includes("UNIQUE constraint failed")
  );
}

/**
 * `PRAGMA journal_mode = WAL` への初回切替は DB ファイルへの排他ロックを要求する。
 * 複数プロセスが同時に同じ file-backed DB へ初回 `init()` すると、`busy_timeout`
 * 設定後でも "database is locked" や "disk I/O error" が発生しうる（node:sqlite の
 * DatabaseSync コンストラクタ自体はロック取得を待たない）。init 全体を対象に
 * 短い同期リトライを行うことで、他プロセスの初回接続完了を待ってから続行する。
 */
function isRetryableSqliteInitError(err: unknown): boolean {
  if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ERR_SQLITE_ERROR") return false;
  return /database is locked|disk I\/O error|SQLITE_BUSY/i.test(err.message);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const SQLITE_INIT_MAX_ATTEMPTS = 5;
const SQLITE_INIT_RETRY_DELAY_MS = 50;

function toHookCheckpointRecord(row: Record<string, unknown>): HookCheckpointRecord {
  return {
    instanceId: row.instance_id as RepositoryInstanceId,
    branch: row.branch as string,
    lastCheckedCommit: row.last_checked_commit as string,
    checkedAt: row.checked_at as number,
  };
}

function toValidationEvidenceRecord(row: Record<string, unknown>): ValidationEvidenceRecord {
  return {
    instanceId: row.instance_id as RepositoryInstanceId,
    headCommit: row.head_commit as string,
    name: row.name as string,
    status: row.status as ValidationEvidenceRecord["status"],
    recordedAt: row.recorded_at as number,
  };
}

const AUDIT_MAX_FIELD_LENGTH = 128;
const AUDIT_SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

function boundedAuditField(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${field} contains control characters`);
  if (normalized.length > AUDIT_MAX_FIELD_LENGTH || !AUDIT_SAFE_IDENTIFIER.test(normalized))
    throw new Error(`${field} must be a safe audit identifier`);
  return normalized;
}

function toAuditMetadata(value: unknown): Record<string, string | number | boolean | null> {
  try {
    return { ...sanitizeAuditMetadata(value) };
  } catch {
    return {};
  }
}

function toAuditRecord(row: Record<string, unknown>): GuardrailAuditRecord {
  let metadata: Record<string, string | number | boolean | null> = {};
  try {
    metadata = toAuditMetadata(JSON.parse(String(row.metadata_json ?? "{}")));
  } catch {
    metadata = {};
  }
  return {
    auditId: row.audit_id as string,
    operation: row.operation as string,
    decision: row.decision as GuardrailAuditDecision,
    ruleId: row.rule_id as string,
    reasonCode: row.reason_code as string,
    instanceId: (row.instance_id as RepositoryInstanceId | null) ?? undefined,
    taskId: (row.task_id as TaskId | null) ?? undefined,
    policyProvenance: (row.policy_provenance as string | null) ?? undefined,
    metadata,
    recordedAt: row.recorded_at as number,
  };
}

/**
 * SQLite backed WorkflowStateStore。session 用 SqliteStateStore と同じ DB
 * ファイル・migration 機構を共有する（別ファイルに分けると schema_migrations
 * の適用順序管理が二重化するため）。
 */
export class WorkflowSqliteStateStore implements WorkflowStateStore {
  private readonly dbPath: string;
  private readonly boundaries: BoundaryOperations;
  private readonly migrations: Migration[];
  private db: DatabaseSync | undefined;

  constructor(options: WorkflowSqliteStateStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveStateDbPath(options.env ?? process.env);
    this.boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
    this.migrations = options.migrations ?? [];
  }

  init(): void {
    if (this.db !== undefined) return;
    const isFileBacked = this.dbPath !== ":memory:";
    if (isFileBacked) {
      const dir = path.dirname(this.dbPath);
      this.boundaries.file("sqlite.directory.create", () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }));
      this.boundaries.file("sqlite.directory.permission", () => restrictToOwner(dir, 0o700));
    }

    for (let attempt = 1; ; attempt += 1) {
      const db = this.boundaries.file("sqlite.open", () => new DatabaseSync(this.dbPath));
      try {
        if (isFileBacked) this.boundaries.file("sqlite.file.permission", () => restrictToOwner(this.dbPath, 0o600));
        // busy_timeout 未設定だと、他プロセスが BEGIN IMMEDIATE で書き込みロックを
        // 保持している間、即座に "database is locked" で失敗する（node:sqlite の
        // DatabaseSync は既定でリトライしない）。task.ts の 2 プロセス同時
        // reserveTask/reserveWorktree がロック解放を待って安全に直列化されるよう、
        // ロック待ちを許容する。
        this.boundaries.file("sqlite.busy-timeout", () => db.exec("PRAGMA busy_timeout = 5000"));
        // journal_mode=WAL への初回切替自体は busy_timeout の対象外の排他ロックを
        // 要求しうるため、その失敗はここで同期リトライする（下記 catch）。
        this.boundaries.file("sqlite.journal", () => db.exec("PRAGMA journal_mode = WAL"));
        this.boundaries.file("sqlite.foreign-keys", () => db.exec("PRAGMA foreign_keys = ON"));
        this.boundaries.file("sqlite.migrations", () =>
          applyMigrations(db, this.migrations.length === 0 ? undefined : this.migrations, this.boundaries),
        );
        if (isFileBacked) {
          this.boundaries.file("sqlite.wal.permission", () => restrictToOwner(`${this.dbPath}-wal`, 0o600));
          this.boundaries.file("sqlite.shm.permission", () => restrictToOwner(`${this.dbPath}-shm`, 0o600));
        }
      } catch (err) {
        try {
          this.boundaries.file("sqlite.close.after-init-failure", () => db.close());
        } catch (closeError) {
          try {
            db.close();
          } catch {
            // Keep the injected cleanup failure as the recorded secondary error.
          }
          throw addSecondaryDiagnostic(err, "sqlite.close.after-init-failure", closeError);
        }
        if (isFileBacked && isRetryableSqliteInitError(err) && attempt < SQLITE_INIT_MAX_ATTEMPTS) {
          sleepSync(SQLITE_INIT_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw err;
      }
      this.db = db;
      return;
    }
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
        db.prepare("INSERT INTO repository_sources (source_id, root_commit_digest, created_at) VALUES (?, ?, ?)").run(
          newSourceId,
          input.rootCommitDigest,
          now,
        );
      }
      const source = toSourceRecord(
        db
          .prepare("SELECT * FROM repository_sources WHERE root_commit_digest = ?")
          .get(input.rootCommitDigest) as Record<string, unknown>,
      );

      const existingInstance = db
        .prepare("SELECT * FROM repository_instances WHERE instance_id = ?")
        .get(input.instanceId) as Record<string, unknown> | undefined;

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
        db.prepare("SELECT * FROM repository_instances WHERE instance_id = ?").get(input.instanceId) as Record<
          string,
          unknown
        >,
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
        db.prepare("UPDATE repository_paths SET is_current = 0 WHERE instance_id = ? AND canonical_path = ?").run(
          input.instanceId,
          previousCurrentPath,
        );
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
    const row = this.handle()
      .prepare("SELECT * FROM repository_sources WHERE root_commit_digest = ?")
      .get(rootCommitDigest) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toSourceRecord(row);
  }

  getRepositoryInstance(instanceId: RepositoryInstanceId): RepositoryInstanceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM repository_instances WHERE instance_id = ?").get(instanceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toInstanceRecord(row);
  }

  getRepositoryInstanceByCommonDir(gitCommonDir: string): RepositoryInstanceRecord | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM repository_instances WHERE git_common_dir = ?")
      .get(gitCommonDir) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toInstanceRecord(row);
  }

  listRepositoryPaths(instanceId: RepositoryInstanceId): RepositoryPathRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM repository_paths WHERE instance_id = ? ORDER BY observed_at ASC")
      .all(instanceId) as Record<string, unknown>[];
    return rows.map(toPathRecord);
  }

  listRepositorySources(): RepositorySourceRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM repository_sources ORDER BY created_at ASC, source_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toSourceRecord);
  }

  listRepositoryInstances(): RepositoryInstanceRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM repository_instances ORDER BY created_at ASC, instance_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toInstanceRecord);
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

  recordValidationEvidence(input: RecordValidationEvidenceInput): ValidationEvidenceRecord {
    const db = this.handle();
    const recordedAt = input.recordedAt ?? Date.now();
    db.prepare(
      `INSERT INTO validation_evidence (instance_id, head_commit, name, status, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (instance_id, head_commit, name) DO UPDATE SET status = excluded.status, recorded_at = excluded.recorded_at`,
    ).run(input.instanceId, input.headCommit, input.name, input.status, recordedAt);
    return {
      instanceId: input.instanceId,
      headCommit: input.headCommit,
      name: input.name,
      status: input.status,
      recordedAt,
    };
  }

  listValidationEvidence(instanceId: RepositoryInstanceId, headCommit: string): ValidationEvidenceRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM validation_evidence WHERE instance_id = ? AND head_commit = ?")
      .all(instanceId, headCommit) as Record<string, unknown>[];
    return rows.map(toValidationEvidenceRecord);
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
        `INSERT INTO tasks (task_id, instance_id, task_slug, issue_ref, lifecycle_state, task_version, base_branch, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'planned', 1, ?, ?, ?, ?)`,
      ).run(
        taskId,
        input.instanceId,
        input.taskSlug,
        input.issueRef ?? null,
        input.baseBranch,
        input.baseCommit,
        now,
        now,
      );
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
      ).run(
        worktreeId,
        input.taskId,
        input.instanceId,
        input.branchName,
        input.canonicalPath,
        input.baseBranch,
        input.baseCommit,
        now,
        now,
      );
      const row = db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as Record<
        string,
        unknown
      >;
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
    // status='reserved' を条件に含めないと、既に removed（削除済み履歴）の worktree を
    // 誤って active へ復活させてしまう（branch/path が別 worktree に再利用済みなら
    // UNIQUE 制約違反にもなりうる）。activate できるのは予約直後の reserved 行のみ。
    const result = db
      .prepare("UPDATE worktrees SET status = 'active', updated_at = ? WHERE worktree_id = ? AND status = 'reserved'")
      .run(now, worktreeId);
    if (result.changes === 0) throw new Error(`worktree not found or not in reserved state: ${worktreeId}`);
    const row = db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as Record<string, unknown>;
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
    db.prepare(
      "UPDATE tasks SET lifecycle_state = ?, task_version = task_version + 1, updated_at = ? WHERE task_id = ?",
    ).run(next, now, taskId);
    const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`task not found: ${taskId}`);
    return toTaskRecord(row);
  }

  getTask(taskId: TaskId): TaskRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toTaskRecord(row);
  }

  getActiveTaskByIssueRef(instanceId: RepositoryInstanceId, issueRef: string): TaskRecord | undefined {
    const row = this.handle()
      .prepare(
        "SELECT * FROM tasks WHERE instance_id = ? AND issue_ref = ? AND lifecycle_state NOT IN ('cleaned', 'abandoned')",
      )
      .get(instanceId, issueRef) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTaskRecord(row);
  }

  listTasks(instanceId?: RepositoryInstanceId): TaskRecord[] {
    const rows =
      instanceId === undefined
        ? this.handle().prepare("SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC").all()
        : this.handle()
            .prepare("SELECT * FROM tasks WHERE instance_id = ? ORDER BY created_at ASC, task_id ASC")
            .all(instanceId);
    return (rows as Record<string, unknown>[]).map(toTaskRecord);
  }

  listWorktreesForTask(taskId: TaskId): WorktreeRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM worktrees WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(toWorktreeRecord);
  }

  listWorktreesForInstance(instanceId: RepositoryInstanceId): WorktreeRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM worktrees WHERE instance_id = ? ORDER BY created_at ASC")
      .all(instanceId) as Record<string, unknown>[];
    return rows.map(toWorktreeRecord);
  }

  listWorktrees(instanceId?: RepositoryInstanceId): WorktreeRecord[] {
    const rows =
      instanceId === undefined
        ? this.handle().prepare("SELECT * FROM worktrees ORDER BY created_at ASC, worktree_id ASC").all()
        : this.handle()
            .prepare("SELECT * FROM worktrees WHERE instance_id = ? ORDER BY created_at ASC, worktree_id ASC")
            .all(instanceId);
    return (rows as Record<string, unknown>[]).map(toWorktreeRecord);
  }

  listCleanupLeases(instanceId?: RepositoryInstanceId): CleanupLeaseRecord[] {
    const rows =
      instanceId === undefined
        ? this.handle().prepare("SELECT * FROM cleanup_leases ORDER BY updated_at ASC, operation_id ASC").all()
        : this.handle()
            .prepare("SELECT * FROM cleanup_leases WHERE instance_id = ? ORDER BY updated_at ASC, operation_id ASC")
            .all(instanceId);
    return (rows as Record<string, unknown>[]).map((row) => toCleanupLeaseRecord(row as Record<string, unknown>));
  }

  markWorktreeRemoved(worktreeId: WorktreeId, updatedAt?: number): WorktreeRecord {
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare("UPDATE worktrees SET status = 'removed', updated_at = ? WHERE worktree_id = ? AND status != 'removed'")
      .run(now, worktreeId);
    if (result.changes === 0) {
      const row = this.handle().prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new Error(`worktree not found: ${worktreeId}`);
      return toWorktreeRecord(row);
    }
    const row = this.handle().prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(worktreeId) as Record<
      string,
      unknown
    >;
    return toWorktreeRecord(row);
  }

  reserveCleanupLease(input: ReserveCleanupLeaseInput): ReserveCleanupLeaseResult {
    const db = this.handle();
    const now = input.acquiredAt ?? Date.now();
    const worktreeId = input.worktreeId ?? null;

    db.exec("BEGIN IMMEDIATE");
    try {
      const operationRow = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(input.operationId) as
        | Record<string, unknown>
        | undefined;
      if (operationRow !== undefined) {
        const operation = toCleanupLeaseRecord(operationRow);
        if (
          operation.planDigest !== input.planDigest ||
          operation.instanceId !== input.instanceId ||
          operation.taskId !== input.taskId ||
          operation.worktreeId !== input.worktreeId
        ) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "plan-digest-mismatch", existingLease: operation };
        }
        if (operation.state === "committed") {
          db.exec("COMMIT");
          return { ok: true, lease: operation };
        }
        if (operation.state !== "failed" && operation.expiresAt > now) {
          if (operation.owner !== input.owner) {
            db.exec("ROLLBACK");
            return { ok: false, reason: "active-lease", existingLease: operation };
          }
          db.exec("COMMIT");
          return { ok: true, lease: operation };
        }

        const recoveryState =
          operation.state === "mutating" || operation.state === "verifying" ? operation.state : "reserved";
        db.prepare(
          `UPDATE cleanup_leases
           SET state = ?, owner = ?, expires_at = ?, updated_at = ?,
               completed_actions_json = ?, last_error = ?
           WHERE operation_id = ?`,
        ).run(
          recoveryState,
          input.owner,
          input.expiresAt,
          now,
          recoveryState === "reserved" ? "[]" : JSON.stringify(operation.completedActionIds),
          recoveryState === "reserved" ? null : (operation.lastError ?? null),
          input.operationId,
        );
        const renewed = db
          .prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?")
          .get(input.operationId) as Record<string, unknown>;
        db.exec("COMMIT");
        return { ok: true, lease: toCleanupLeaseRecord(renewed) };
      }

      const activeRow = db
        .prepare(
          `SELECT * FROM cleanup_leases
           WHERE instance_id = ? AND task_id = ?
             AND ((worktree_id = ?) OR (worktree_id IS NULL AND ? IS NULL))
             AND state IN ('reserved', 'mutating', 'verifying')
             AND expires_at > ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(input.instanceId, input.taskId, worktreeId, worktreeId, now) as Record<string, unknown> | undefined;
      if (activeRow !== undefined) {
        db.exec("ROLLBACK");
        return { ok: false, reason: "active-lease", existingLease: toCleanupLeaseRecord(activeRow) };
      }

      db.prepare(
        `INSERT INTO cleanup_leases
          (operation_id, plan_digest, instance_id, task_id, worktree_id, owner, state, acquired_at, expires_at, updated_at, completed_actions_json)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, '[]')`,
      ).run(
        input.operationId,
        input.planDigest,
        input.instanceId,
        input.taskId,
        worktreeId,
        input.owner,
        now,
        input.expiresAt,
        now,
      );
      const row = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(input.operationId) as Record<
        string,
        unknown
      >;
      db.exec("COMMIT");
      return { ok: true, lease: toCleanupLeaseRecord(row) };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の lease 予約エラーを保持する
      }
      throw err;
    }
  }

  getCleanupLease(operationId: string): CleanupLeaseRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(operationId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toCleanupLeaseRecord(row);
  }

  getActiveCleanupLease(
    instanceId: RepositoryInstanceId,
    taskId: TaskId,
    worktreeId: WorktreeId | undefined,
    now = Date.now(),
  ): CleanupLeaseRecord | undefined {
    const normalizedWorktreeId = worktreeId ?? null;
    const row = this.handle()
      .prepare(
        `SELECT * FROM cleanup_leases
         WHERE instance_id = ? AND task_id = ?
           AND ((worktree_id = ?) OR (worktree_id IS NULL AND ? IS NULL))
           AND state IN ('reserved', 'mutating', 'verifying') AND expires_at > ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(instanceId, taskId, normalizedWorktreeId, normalizedWorktreeId, now) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toCleanupLeaseRecord(row);
  }

  markCleanupLease(input: MarkCleanupLeaseInput): CleanupLeaseRecord {
    const db = this.handle();
    const now = input.updatedAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(input.operationId) as
        | Record<string, unknown>
        | undefined;
      if (currentRow === undefined) throw new Error(`cleanup lease not found: ${input.operationId}`);
      const current = toCleanupLeaseRecord(currentRow);
      if (input.expectedState !== undefined && current.state !== input.expectedState) {
        throw new Error(
          `cleanup lease state changed concurrently: ${input.operationId} (expected ${input.expectedState}, found ${current.state})`,
        );
      }
      const completedActionIds =
        input.completedActionIds === undefined ? current.completedActionIds : [...new Set(input.completedActionIds)];
      const lastError = input.lastError === undefined ? current.lastError : input.lastError;
      const result = db
        .prepare(
          `UPDATE cleanup_leases
           SET state = ?, updated_at = ?, completed_actions_json = ?, last_error = ?
           WHERE operation_id = ?${input.expectedState === undefined ? "" : " AND state = ?"}`,
        )
        .run(
          ...(input.expectedState === undefined
            ? ([input.state, now, JSON.stringify(completedActionIds), lastError ?? null, input.operationId] as const)
            : ([
                input.state,
                now,
                JSON.stringify(completedActionIds),
                lastError ?? null,
                input.operationId,
                input.expectedState,
              ] as const)),
        );
      if (result.changes === 0)
        throw new Error(
          `cleanup lease state changed concurrently: ${input.operationId} (expected ${input.expectedState})`,
        );
      const row = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(input.operationId) as Record<
        string,
        unknown
      >;
      db.exec("COMMIT");
      return toCleanupLeaseRecord(row);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の lease 更新エラーを保持する
      }
      throw err;
    }
  }

  commitCleanup(input: CommitCleanupInput): CommitCleanupResult {
    const db = this.handle();
    const now = input.committedAt ?? Date.now();
    const completedActionIds = [...new Set(input.completedActionIds)];
    db.exec("BEGIN IMMEDIATE");
    try {
      const leaseRow = db.prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?").get(input.operationId) as
        | Record<string, unknown>
        | undefined;
      if (leaseRow === undefined) throw new Error(`cleanup lease not found: ${input.operationId}`);
      const lease = toCleanupLeaseRecord(leaseRow);
      if (
        lease.planDigest !== input.planDigest ||
        lease.instanceId !== input.instanceId ||
        lease.taskId !== input.taskId ||
        lease.worktreeId !== input.worktreeId
      ) {
        throw new Error(`cleanup lease identity mismatch: ${input.operationId}`);
      }
      if (lease.state === "committed") {
        db.exec("COMMIT");
        return {
          task: toTaskRecord(
            db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(input.taskId) as Record<string, unknown>,
          ),
          worktree:
            input.worktreeId === undefined
              ? undefined
              : toWorktreeRecord(
                  db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(input.worktreeId) as Record<
                    string,
                    unknown
                  >,
                ),
          lease,
        };
      }
      if (lease.state !== "verifying") {
        throw new Error(`cleanup lease is not verified: ${input.operationId} (${lease.state})`);
      }

      const taskRow = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(input.taskId) as
        | Record<string, unknown>
        | undefined;
      if (taskRow === undefined) throw new Error(`task not found: ${input.taskId}`);
      const currentTask = toTaskRecord(taskRow);
      if (currentTask.instanceId !== input.instanceId) throw new Error(`task repository mismatch: ${input.taskId}`);
      if (currentTask.lifecycleState !== "cleaned") {
        if (
          currentTask.version !== input.expectedTaskVersion ||
          currentTask.lifecycleState !== input.expectedLifecycle
        ) {
          throw new Error(`task changed during cleanup: ${input.taskId}`);
        }
        db.prepare(
          "UPDATE tasks SET lifecycle_state = 'cleaned', task_version = task_version + 1, updated_at = ? WHERE task_id = ? AND task_version = ? AND lifecycle_state = ?",
        ).run(now, input.taskId, input.expectedTaskVersion, input.expectedLifecycle);
      }

      let worktree: WorktreeRecord | undefined;
      if (input.worktreeId !== undefined) {
        const worktreeRow = db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(input.worktreeId) as
          | Record<string, unknown>
          | undefined;
        if (worktreeRow === undefined) throw new Error(`worktree not found: ${input.worktreeId}`);
        const currentWorktree = toWorktreeRecord(worktreeRow);
        if (currentWorktree.taskId !== input.taskId || currentWorktree.instanceId !== input.instanceId) {
          throw new Error(`worktree cleanup association mismatch: ${input.worktreeId}`);
        }
        if (currentWorktree.status !== "removed") {
          db.prepare("UPDATE worktrees SET status = 'removed', updated_at = ? WHERE worktree_id = ?").run(
            now,
            input.worktreeId,
          );
        }
        const finalWorktreeRow = db
          .prepare("SELECT * FROM worktrees WHERE worktree_id = ?")
          .get(input.worktreeId) as Record<string, unknown>;
        worktree = toWorktreeRecord(finalWorktreeRow);
      }

      db.prepare(
        `UPDATE cleanup_leases
         SET state = 'committed', expires_at = ?, updated_at = ?, completed_actions_json = ?, last_error = NULL
         WHERE operation_id = ?`,
      ).run(now, now, JSON.stringify(completedActionIds), input.operationId);
      const finalTaskRow = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(input.taskId) as Record<
        string,
        unknown
      >;
      const finalLeaseRow = db
        .prepare("SELECT * FROM cleanup_leases WHERE operation_id = ?")
        .get(input.operationId) as Record<string, unknown>;
      db.exec("COMMIT");
      return { task: toTaskRecord(finalTaskRow), worktree, lease: toCleanupLeaseRecord(finalLeaseRow) };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の cleanup commit エラーを保持する
      }
      throw err;
    }
  }

  private toPullRequestRecord(row: Record<string, unknown>): PullRequestRecord {
    return {
      recordId: row.record_id as PullRequestRecordId,
      taskId: (row.task_id as TaskId | null) ?? undefined,
      instanceId: (row.instance_id as RepositoryInstanceId | null) ?? undefined,
      provider: row.provider as string,
      repositoryId: row.repository_id as string,
      prNumber: row.pr_number as number,
      url: row.url as string,
      headSha: row.head_sha as string,
      lifecycleState: row.lifecycle_state as PullRequestRecord["lifecycleState"],
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  recordPullRequest(input: RecordPullRequestInput): PullRequestRecord {
    const db = this.handle();
    const now = input.recordedAt ?? Date.now();

    let result!: PullRequestRecord;
    db.exec("BEGIN IMMEDIATE");
    try {
      const task =
        input.taskId === undefined
          ? undefined
          : (db.prepare("SELECT instance_id FROM tasks WHERE task_id = ?").get(input.taskId) as
              | { instance_id: RepositoryInstanceId }
              | undefined);
      if (input.taskId !== undefined && task === undefined) throw new Error(`task not found: ${input.taskId}`);
      if (task !== undefined && input.instanceId !== undefined && input.instanceId !== task.instance_id) {
        throw new Error(`pull request task repository mismatch: ${input.taskId}`);
      }
      const instanceId = input.instanceId ?? task?.instance_id;
      const existing = db
        .prepare("SELECT * FROM pr_records WHERE provider = ? AND repository_id = ? AND pr_number = ?")
        .get(input.provider, input.repositoryId, input.prNumber) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        const existingRecord = this.toPullRequestRecord(existing);
        if (
          existingRecord.headSha !== input.headSha ||
          existingRecord.taskId !== input.taskId ||
          existingRecord.instanceId !== instanceId
        ) {
          throw new Error(
            `pull request record already exists with different identity: ${input.provider}/${input.repositoryId}#${input.prNumber}`,
          );
        }
        db.exec("COMMIT");
        return existingRecord;
      }

      const recordId = crypto.randomUUID() as PullRequestRecordId;
      db.prepare(
        `INSERT INTO pr_records
          (record_id, task_id, instance_id, provider, repository_id, pr_number, url, head_sha, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recordId,
        input.taskId ?? null,
        instanceId ?? null,
        input.provider,
        input.repositoryId,
        input.prNumber,
        input.url,
        input.headSha,
        input.lifecycleState,
        now,
        now,
      );
      const row = db.prepare("SELECT * FROM pr_records WHERE record_id = ?").get(recordId) as Record<string, unknown>;
      db.exec("COMMIT");
      result = this.toPullRequestRecord(row);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の state 書き込みエラーを保持する
      }
      throw err;
    }
    return result;
  }

  getPullRequestRecord(recordId: PullRequestRecordId): PullRequestRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM pr_records WHERE record_id = ?").get(recordId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.toPullRequestRecord(row);
  }

  getPullRequestByProviderRepositoryNumber(
    provider: string,
    repositoryId: string,
    prNumber: number,
  ): PullRequestRecord | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM pr_records WHERE provider = ? AND repository_id = ? AND pr_number = ?")
      .get(provider, repositoryId, prNumber) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.toPullRequestRecord(row);
  }

  listPullRequestRecordsForTask(taskId: TaskId): PullRequestRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM pr_records WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.toPullRequestRecord(row));
  }

  updatePullRequestLifecycleState(
    recordId: PullRequestRecordId,
    lifecycleState: PullRequestRecord["lifecycleState"],
    updatedAt?: number,
  ): PullRequestRecord {
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare("UPDATE pr_records SET lifecycle_state = ?, updated_at = ? WHERE record_id = ?")
      .run(lifecycleState, now, recordId);
    if (result.changes === 0) throw new Error(`pull request record not found: ${recordId}`);
    const row = this.handle().prepare("SELECT * FROM pr_records WHERE record_id = ?").get(recordId) as Record<
      string,
      unknown
    >;
    return this.toPullRequestRecord(row);
  }

  listPullRequestRecords(): PullRequestRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM pr_records ORDER BY created_at ASC, record_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toPullRequestRecord(row));
  }

  recordGuardrailDecision(input: RecordGuardrailDecisionInput): GuardrailAuditRecord {
    const db = this.handle();
    const auditId = crypto.randomUUID();
    const recordedAt = input.recordedAt ?? Date.now();
    const operation = boundedAuditField(input.operation, "operation");
    const ruleId = boundedAuditField(input.ruleId, "ruleId");
    const reasonCode = boundedAuditField(input.reasonCode, "reasonCode");
    const policyProvenance =
      input.policyProvenance === undefined ? null : boundedAuditField(input.policyProvenance, "policyProvenance");
    const metadata = toAuditMetadata(input.metadata);
    db.prepare(
      `INSERT INTO audit_records
        (audit_id, operation, decision, rule_id, reason_code, instance_id, task_id, policy_provenance, metadata_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      auditId,
      operation,
      input.decision,
      ruleId,
      reasonCode,
      input.instanceId ?? null,
      input.taskId ?? null,
      policyProvenance,
      JSON.stringify(metadata),
      recordedAt,
    );
    const row = db.prepare("SELECT * FROM audit_records WHERE audit_id = ?").get(auditId) as Record<string, unknown>;
    return toAuditRecord(row);
  }

  listGuardrailAuditRecords(options: ListGuardrailAuditRecordsOptions = {}): GuardrailAuditRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (options.instanceId !== undefined) {
      conditions.push("instance_id = ?");
      values.push(options.instanceId);
    }
    if (options.taskId !== undefined) {
      conditions.push("task_id = ?");
      values.push(options.taskId);
    }
    if (options.since !== undefined) {
      conditions.push("recorded_at >= ?");
      values.push(options.since);
    }
    if (options.until !== undefined) {
      conditions.push("recorded_at <= ?");
      values.push(options.until);
    }
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM audit_records${where} ORDER BY recorded_at ASC, audit_id ASC`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(toAuditRecord);
  }

  close(): void {
    const db = this.db;
    this.db = undefined;
    if (db !== undefined) this.boundaries.file("sqlite.close", () => db.close());
  }
}
