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
  BeginNawabariCloseReconciliationInput,
  NawabariCloseReconciliationRecord,
  NawabariCloseReconciliationState,
  ReserveTaskInput,
  ReserveTaskResult,
  BeginTaskStartReconciliationInput,
  BeginPushReconciliationInput,
  PushReconciliationRecord,
  PushReconciliationState,
  RecordPushResultInput,
  BeginCommitReconciliationInput,
  CommitReconciliationRecord,
  CommitReconciliationState,
  ReserveWorktreeInput,
  ReserveWorktreeResult,
  RecordValidationEvidenceInput,
  CheckRunRecord,
  ListCheckRunsFilter,
  RecordCheckRunInput,
  CleanupLeaseRecord,
  CleanupLeaseState,
  CommitCleanupInput,
  CommitCleanupResult,
  CreateManagerSessionInput,
  GuardrailAuditRecord,
  GuardrailAuditDecision,
  ListGuardrailAuditRecordsOptions,
  ManagerSessionId,
  ManagerSessionRecord,
  ManagerSessionReceipt,
  MarkCleanupLeaseInput,
  NawabariSessionId,
  RecordGuardrailDecisionInput,
  ReserveCleanupLeaseInput,
  ReserveCleanupLeaseResult,
  TaskId,
  TaskRecord,
  TaskStartReconciliationRecord,
  TaskStartReconciliationState,
  UpdateManagerSessionInput,
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

const MAX_MANAGER_DIAGNOSTIC_LENGTH = 512;

function managerDiagnostic(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value).slice(0, MAX_MANAGER_DIAGNOSTIC_LENGTH);
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
    ...(row.nawabari_session_id === null || row.nawabari_session_id === undefined
      ? {}
      : { nawabariSessionId: row.nawabari_session_id as TaskRecord["nawabariSessionId"] }),
    ...(row.start_idempotency_key === null || row.start_idempotency_key === undefined
      ? {}
      : { startIdempotencyKey: row.start_idempotency_key as string }),
    lifecycleState: row.lifecycle_state as LifecycleState,
    version: (row.task_version as number | undefined) ?? 1,
    baseBranch: row.base_branch as string,
    baseCommit: row.base_commit as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toTaskStartReconciliationRecord(row: Record<string, unknown>): TaskStartReconciliationRecord {
  return {
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    taskLabel: row.task_label as string,
    branchName: row.branch_name as string,
    baseBranch: row.base_branch as string,
    baseCommit: row.base_commit as string,
    ...(row.nawabari_session_id === null || row.nawabari_session_id === undefined
      ? {}
      : { nawabariSessionId: row.nawabari_session_id as TaskStartReconciliationRecord["nawabariSessionId"] }),
    state: row.state as TaskStartReconciliationState,
    ...(row.detail === null || row.detail === undefined ? {} : { detail: row.detail as string }),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toPushReconciliationRecord(row: Record<string, unknown>): PushReconciliationRecord {
  return {
    operationId: row.operation_id as string,
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    nawabariSessionId: row.nawabari_session_id as PushReconciliationRecord["nawabariSessionId"],
    sourceCommit: row.source_commit as string,
    remote: row.remote as string,
    targetBranch: row.target_branch as string,
    targetRef: row.target_ref as string,
    forceRequested: (row.force_requested as number) === 1,
    createUpstream: (row.create_upstream as number) === 1,
    state: row.state as PushReconciliationState,
    ...(row.observed_remote_sha === null || row.observed_remote_sha === undefined
      ? {}
      : { observedRemoteSha: row.observed_remote_sha as string }),
    ...(row.recovery_observed_remote_sha === null || row.recovery_observed_remote_sha === undefined
      ? {}
      : { recoveryObservedRemoteSha: row.recovery_observed_remote_sha as string }),
    ...(row.result_remote_sha === null || row.result_remote_sha === undefined
      ? {}
      : { resultRemoteSha: row.result_remote_sha as string }),
    ...(row.relation === null || row.relation === undefined ? {} : { relation: row.relation as string }),
    evidenceComplete: (row.evidence_complete as number) === 1,
    ...(row.detail === null || row.detail === undefined ? {} : { detail: row.detail as string }),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toCommitReconciliationRecord(row: Record<string, unknown>): CommitReconciliationRecord {
  let resources: string[];
  try {
    const parsed: unknown = JSON.parse(String(row.resources_json ?? "[]"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
      throw new Error("invalid resource list");
    resources = [...parsed];
  } catch (error) {
    throw new Error(
      `invalid commit reconciliation resources: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    nawabariSessionId: row.nawabari_session_id as CommitReconciliationRecord["nawabariSessionId"],
    branchName: row.branch_name as string,
    beforeCommit: row.before_commit as string,
    resources,
    message: row.message as string,
    state: row.state as CommitReconciliationState,
    ...(row.commit_sha === null || row.commit_sha === undefined ? {} : { commitSha: row.commit_sha as string }),
    ...(row.detail === null || row.detail === undefined ? {} : { detail: row.detail as string }),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toNawabariCloseReconciliationRecord(row: Record<string, unknown>): NawabariCloseReconciliationRecord {
  return {
    taskId: row.task_id as TaskId,
    instanceId: row.instance_id as RepositoryInstanceId,
    nawabariSessionId: row.nawabari_session_id as NawabariCloseReconciliationRecord["nawabariSessionId"],
    providerRecordId: row.provider_record_id as PullRequestRecordId,
    ...(row.integrated_revision === null || row.integrated_revision === undefined
      ? {}
      : { integratedRevision: row.integrated_revision as string }),
    state: row.state as NawabariCloseReconciliationState,
    ...(row.detail === null || row.detail === undefined ? {} : { detail: row.detail as string }),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function assertPushIdentity(existing: PushReconciliationRecord, input: RecordPushResultInput): void {
  const mismatches = [
    existing.sourceCommit !== input.sourceCommit ? "source commit" : undefined,
    existing.remote !== input.remote ? "remote" : undefined,
    existing.targetBranch !== input.targetBranch ? "target branch" : undefined,
    existing.targetRef !== input.targetRef ? "target ref" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) throw new Error(`push reconciliation identity mismatch: ${mismatches.join(", ")}`);
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

function toManagerSessionRecord(row: Record<string, unknown>): ManagerSessionRecord {
  let launchArgs: string[];
  try {
    const parsed: unknown = JSON.parse(String(row.launch_args_json ?? "[]"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("invalid argv");
    launchArgs = [...parsed];
  } catch (error) {
    throw new Error(`invalid manager session launch args: ${error instanceof Error ? error.message : String(error)}`);
  }
  let latestReceipt: ManagerSessionReceipt | undefined;
  if (typeof row.latest_receipt_json === "string" && row.latest_receipt_json.length > 0) {
    try {
      const parsed: unknown = JSON.parse(row.latest_receipt_json);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).code === "string" &&
        typeof (parsed as Record<string, unknown>).message === "string" &&
        ["manager", "zellij", "workflow", "runtime"].includes(String((parsed as Record<string, unknown>).source)) &&
        typeof (parsed as Record<string, unknown>).recordedAt === "number"
      ) {
        latestReceipt = {
          ...(parsed as ManagerSessionReceipt),
          message: String((parsed as ManagerSessionReceipt).message).slice(0, MAX_MANAGER_DIAGNOSTIC_LENGTH),
        };
      }
    } catch {
      // A malformed optional receipt must not make the whole bounded session list unreadable.
    }
  }
  const lifecycleState = row.lifecycle_state as ManagerSessionRecord["lifecycleState"];
  const runtimeState = (row.runtime_state as ManagerSessionRecord["runtimeState"] | null) ?? lifecycleState;
  const instruction =
    typeof row.instruction === "string" && row.instruction.length > 0 ? row.instruction : (launchArgs.at(-1) ?? "");
  return {
    sessionId: row.session_id as ManagerSessionId,
    workspaceRoot: row.workspace_root as string,
    idempotencyKey: (row.idempotency_key as string | null) ?? undefined,
    taskId: (row.task_id as TaskId | null) ?? undefined,
    executionSessionId: (row.execution_session_id as string | null) ?? undefined,
    executionMode:
      (row.execution_mode as ManagerSessionRecord["executionMode"] | null) ??
      (row.task_id === null ? "workspace" : "task-bound"),
    worktreeId: (row.worktree_id as WorktreeId | null) ?? undefined,
    worktreePath: row.worktree_path as string,
    branchName: (row.branch_name as string | null) ?? undefined,
    agentKind: row.agent_kind as ManagerSessionRecord["agentKind"],
    launchProfile:
      (row.launch_profile as ManagerSessionRecord["launchProfile"] | null) ??
      (row.agent_kind as ManagerSessionRecord["agentKind"]),
    instruction,
    provider: (row.provider as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    taskSlug: (row.task_slug as string | null) ?? undefined,
    issueRef: (row.issue_ref as string | null) ?? undefined,
    branchType: (row.branch_type as string | null) ?? undefined,
    launchCommand: row.launch_command as string,
    launchArgs,
    runtimeName: row.runtime_name as string,
    lifecycleState,
    runtimeState,
    semanticLifecycleState:
      (row.semantic_lifecycle_state as ManagerSessionRecord["semanticLifecycleState"] | null) ??
      (row.task_id === null || row.task_id === undefined ? "unbound" : "active"),
    attachable:
      row.attachable === undefined || row.attachable === null
        ? runtimeState === "running" || runtimeState === "detached"
        : row.attachable === 1,
    reconciliationState: (row.reconciliation_state as ManagerSessionRecord["reconciliationState"] | null) ?? "synced",
    reconciliationMessage: managerDiagnostic(row.reconciliation_message),
    latestStatus: managerDiagnostic(row.latest_status),
    latestReceipt,
    startedAt: row.started_at as number,
    updatedAt: row.updated_at as number,
    finishedAt: (row.finished_at as number | null) ?? undefined,
    runtimeObservedAt: (row.runtime_observed_at as number | null) ?? undefined,
    restartCount: (row.restart_count as number | null) ?? 0,
    exitCode: (row.exit_code as number | null) ?? undefined,
    terminationState: (row.termination_state as ManagerSessionRecord["terminationState"] | null) ?? undefined,
    errorMessage: managerDiagnostic(row.error_message),
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

function toCheckRunRecord(row: Record<string, unknown>): CheckRunRecord {
  return {
    runId: row.run_id as string,
    instanceId: row.instance_id as RepositoryInstanceId,
    worktreeId: row.worktree_id as string,
    checkId: row.check_id as string,
    commandDigest: row.command_digest as string,
    stateFingerprint: row.state_fingerprint as string,
    configDigest: row.config_digest as string,
    status: row.status as CheckRunRecord["status"],
    execution: row.execution as CheckRunRecord["execution"],
    startedAt: row.started_at as number,
    durationMs: row.duration_ms as number,
    recordedAt: row.recorded_at as number,
    summary: row.summary as string,
    artifactRef: (row.artifact_ref as string | null) ?? undefined,
    provenance: {
      reasonCode: row.provenance_reason_code as string,
      explanation: row.provenance_explanation as string,
    },
  };
}

const DEFAULT_CHECK_RUN_LIMIT = 50;
const MAX_CHECK_RUN_LIMIT = 500;

function normalizeCheckRunLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CHECK_RUN_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_CHECK_RUN_LIMIT);
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

  recordCheckRun(input: RecordCheckRunInput): CheckRunRecord {
    const recordedAt = input.recordedAt ?? Date.now();
    this.handle()
      .prepare(
        `INSERT INTO check_runs
        (run_id, instance_id, worktree_id, check_id, command_digest, state_fingerprint, config_digest,
         status, execution, started_at, duration_ms, recorded_at, summary, artifact_ref,
         provenance_reason_code, provenance_explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.instanceId,
        input.worktreeId,
        input.checkId,
        input.commandDigest,
        input.stateFingerprint,
        input.configDigest,
        input.status,
        input.execution,
        input.startedAt,
        input.durationMs,
        recordedAt,
        input.summary,
        input.artifactRef ?? null,
        input.provenance.reasonCode,
        input.provenance.explanation,
      );
    return {
      runId: input.runId,
      instanceId: input.instanceId,
      worktreeId: input.worktreeId,
      checkId: input.checkId,
      commandDigest: input.commandDigest,
      stateFingerprint: input.stateFingerprint,
      configDigest: input.configDigest,
      status: input.status,
      execution: input.execution,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      recordedAt,
      summary: input.summary,
      artifactRef: input.artifactRef,
      provenance: input.provenance,
    };
  }

  findReusableCheckRun(
    instanceId: RepositoryInstanceId,
    worktreeId: string,
    checkId: string,
    stateFingerprint: string,
    configDigest: string,
  ): CheckRunRecord | undefined {
    const row = this.handle()
      .prepare(
        `SELECT * FROM check_runs
         WHERE instance_id = ? AND worktree_id = ? AND check_id = ? AND state_fingerprint = ? AND config_digest = ?
           AND status = 'passed'
         ORDER BY recorded_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(instanceId, worktreeId, checkId, stateFingerprint, configDigest) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toCheckRunRecord(row);
  }

  listCheckRuns(filter: ListCheckRunsFilter): CheckRunRecord[] {
    const limit = normalizeCheckRunLimit(filter.limit);
    const where =
      filter.checkId === undefined
        ? "WHERE instance_id = ? AND worktree_id = ? "
        : "WHERE instance_id = ? AND worktree_id = ? AND check_id = ? ";
    const params =
      filter.checkId === undefined
        ? [filter.instanceId, filter.worktreeId, limit]
        : [filter.instanceId, filter.worktreeId, filter.checkId, limit];
    const rows = this.handle()
      .prepare(`SELECT * FROM check_runs ${where}ORDER BY recorded_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(toCheckRunRecord);
  }

  reserveTask(input: ReserveTaskInput): ReserveTaskResult {
    const db = this.handle();
    const now = input.reservedAt ?? Date.now();

    let result!: ReserveTaskResult;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (input.startIdempotencyKey !== undefined) {
        const existingByKey = db
          .prepare("SELECT * FROM tasks WHERE instance_id = ? AND start_idempotency_key = ?")
          .get(input.instanceId, input.startIdempotencyKey) as Record<string, unknown> | undefined;
        if (existingByKey !== undefined) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "issue-already-claimed", existingTask: toTaskRecord(existingByKey) };
        }
      }
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
        `INSERT INTO tasks (task_id, instance_id, task_slug, issue_ref, start_idempotency_key, lifecycle_state, task_version, base_branch, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', 1, ?, ?, ?, ?)`,
      ).run(
        taskId,
        input.instanceId,
        input.taskSlug,
        input.issueRef ?? null,
        input.startIdempotencyKey ?? null,
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

  beginTaskStartReconciliation(input: BeginTaskStartReconciliationInput): TaskStartReconciliationRecord {
    const db = this.handle();
    const now = input.createdAt ?? Date.now();
    const existing = db.prepare("SELECT * FROM task_start_reconciliations WHERE task_id = ?").get(input.taskId) as
      | Record<string, unknown>
      | undefined;
    if (existing !== undefined) {
      const record = toTaskStartReconciliationRecord(existing);
      const identityMatches =
        record.instanceId === input.instanceId &&
        record.taskLabel === input.taskLabel &&
        record.branchName === input.branchName &&
        record.baseBranch === input.baseBranch &&
        record.baseCommit === input.baseCommit;
      if (!identityMatches) throw new Error(`task-start reconciliation identity mismatch: ${input.taskId}`);
      return record;
    }
    db.prepare(
      `INSERT INTO task_start_reconciliations
       (task_id, instance_id, task_label, branch_name, base_branch, base_commit, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    ).run(
      input.taskId,
      input.instanceId,
      input.taskLabel,
      input.branchName,
      input.baseBranch,
      input.baseCommit,
      now,
      now,
    );
    return this.getTaskStartReconciliation(input.taskId)!;
  }

  recordTaskStartSession(
    taskId: TaskId,
    sessionId: NawabariSessionId,
    updatedAt?: number,
  ): TaskStartReconciliationRecord {
    if (sessionId === undefined) throw new Error(`task-start session identity is required: ${taskId}`);
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare(
        `UPDATE task_start_reconciliations
         SET nawabari_session_id = ?, state = CASE WHEN state = 'reserved' THEN 'session-created' ELSE state END,
             updated_at = ?
         WHERE task_id = ? AND (nawabari_session_id IS NULL OR nawabari_session_id = ?)`,
      )
      .run(sessionId, now, taskId, sessionId);
    if (result.changes === 0) {
      const existing = this.getTaskStartReconciliation(taskId);
      if (existing === undefined) throw new Error(`task-start reconciliation not found: ${taskId}`);
      throw new Error(`task-start reconciliation references a different Nawabari session: ${taskId}`);
    }
    return this.getTaskStartReconciliation(taskId)!;
  }

  updateTaskStartReconciliation(
    taskId: TaskId,
    state: TaskStartReconciliationState,
    detail?: string,
    updatedAt?: number,
  ): TaskStartReconciliationRecord {
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare("UPDATE task_start_reconciliations SET state = ?, detail = ?, updated_at = ? WHERE task_id = ?")
      .run(state, detail === undefined ? null : detail.slice(0, 512), now, taskId);
    if (result.changes === 0) throw new Error(`task-start reconciliation not found: ${taskId}`);
    return this.getTaskStartReconciliation(taskId)!;
  }

  getTaskStartReconciliation(taskId: TaskId): TaskStartReconciliationRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM task_start_reconciliations WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toTaskStartReconciliationRecord(row);
  }

  beginPushReconciliation(input: BeginPushReconciliationInput): PushReconciliationRecord {
    const db = this.handle();
    const now = input.createdAt ?? Date.now();
    const existing = this.getPushReconciliation(input.taskId);
    if (existing !== undefined) {
      const mismatches = [
        existing.instanceId !== input.instanceId ? "instance" : undefined,
        existing.nawabariSessionId !== input.nawabariSessionId ? "Nawabari session" : undefined,
        existing.sourceCommit !== input.sourceCommit ? "source commit" : undefined,
        existing.remote !== input.remote ? "remote" : undefined,
        existing.targetBranch !== input.targetBranch ? "target branch" : undefined,
        existing.targetRef !== input.targetRef ? "target ref" : undefined,
      ].filter((value): value is string => value !== undefined);
      if (mismatches.length > 0) throw new Error(`push reconciliation identity mismatch: ${mismatches.join(", ")}`);
      return existing;
    }

    const operationId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO push_reconciliations
       (operation_id, task_id, instance_id, nawabari_session_id, source_commit, remote, target_branch, target_ref,
        force_requested, create_upstream, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
    ).run(
      operationId,
      input.taskId,
      input.instanceId,
      input.nawabariSessionId,
      input.sourceCommit,
      input.remote,
      input.targetBranch,
      input.targetRef,
      input.forceRequested ? 1 : 0,
      input.createUpstream ? 1 : 0,
      now,
      now,
    );
    return this.getPushReconciliation(input.taskId)!;
  }

  markPushAttempting(taskId: TaskId, updatedAt?: number): PushReconciliationRecord {
    const db = this.handle();
    const now = updatedAt ?? Date.now();
    const result = db
      .prepare(
        "UPDATE push_reconciliations SET state = 'attempting', updated_at = ? WHERE task_id = ? AND state = 'prepared'",
      )
      .run(now, taskId);
    if (result.changes === 0) {
      const existing = this.getPushReconciliation(taskId);
      if (existing === undefined) throw new Error(`push reconciliation not found: ${taskId}`);
      return existing;
    }
    return this.getPushReconciliation(taskId)!;
  }

  recordPushResult(input: RecordPushResultInput): PushReconciliationRecord {
    const db = this.handle();
    const recordedAt = input.recordedAt ?? Date.now();
    const existing = this.getPushReconciliation(input.taskId);
    if (existing === undefined) throw new Error(`push reconciliation not found: ${input.taskId}`);
    assertPushIdentity(existing, input);
    if (existing.resultRemoteSha !== undefined) {
      if (input.recoveryObservedRemoteSha !== undefined) {
        db.prepare(
          `UPDATE push_reconciliations
           SET recovery_observed_remote_sha = ?, updated_at = ?
           WHERE task_id = ?`,
        ).run(input.recoveryObservedRemoteSha, recordedAt, input.taskId);
        return this.getPushReconciliation(input.taskId)!;
      }
      if (
        existing.resultRemoteSha !== input.resultRemoteSha ||
        existing.observedRemoteSha !== input.observedRemoteSha ||
        existing.relation !== input.relation
      )
        throw new Error(`push reconciliation result mismatch: ${input.taskId}`);
      return existing;
    }
    db.prepare(
      `UPDATE push_reconciliations
           SET state = 'succeeded', observed_remote_sha = ?, result_remote_sha = ?, relation = ?, evidence_complete = ?, updated_at = ?
           WHERE task_id = ? AND result_remote_sha IS NULL`,
    ).run(
      input.observedRemoteSha ?? null,
      input.resultRemoteSha,
      input.relation,
      input.evidenceComplete ? 1 : 0,
      recordedAt,
      input.taskId,
    );
    return this.getPushReconciliation(input.taskId)!;
  }

  markPushAmbiguous(taskId: TaskId, detail: string, updatedAt?: number): PushReconciliationRecord {
    const now = updatedAt ?? Date.now();
    const bounded = detail.slice(0, 512);
    const result = this.handle()
      .prepare(
        `UPDATE push_reconciliations SET state = 'ambiguous', detail = ?, updated_at = ?
         WHERE task_id = ? AND state != 'reconciled'`,
      )
      .run(bounded, now, taskId);
    if (result.changes === 0) {
      const existing = this.getPushReconciliation(taskId);
      if (existing === undefined) throw new Error(`push reconciliation not found: ${taskId}`);
      return existing;
    }
    return this.getPushReconciliation(taskId)!;
  }

  markPushReconciled(taskId: TaskId, updatedAt?: number): PushReconciliationRecord {
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare(
        `UPDATE push_reconciliations SET state = 'reconciled', detail = NULL, updated_at = ?
         WHERE task_id = ? AND state IN ('succeeded', 'ambiguous')
           AND result_remote_sha IS NOT NULL AND evidence_complete = 1`,
      )
      .run(now, taskId);
    if (result.changes === 0) {
      const existing = this.getPushReconciliation(taskId);
      if (existing === undefined) throw new Error(`push reconciliation not found: ${taskId}`);
      return existing;
    }
    return this.getPushReconciliation(taskId)!;
  }

  getPushReconciliation(taskId: TaskId): PushReconciliationRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM push_reconciliations WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toPushReconciliationRecord(row);
  }

  beginCommitReconciliation(input: BeginCommitReconciliationInput): CommitReconciliationRecord {
    const db = this.handle();
    const now = input.createdAt ?? Date.now();
    const existing = db.prepare("SELECT * FROM commit_reconciliations WHERE task_id = ?").get(input.taskId) as
      | Record<string, unknown>
      | undefined;
    const resources = [...input.resources];
    if (existing !== undefined) {
      const record = toCommitReconciliationRecord(existing);
      const identityMatches =
        record.instanceId === input.instanceId &&
        record.nawabariSessionId === input.nawabariSessionId &&
        record.branchName === input.branchName &&
        record.beforeCommit === input.beforeCommit &&
        record.message === input.message &&
        record.resources.length === resources.length &&
        record.resources.every((resource, index) => resource === resources[index]);
      if (!identityMatches) throw new Error(`commit reconciliation identity mismatch: ${input.taskId}`);
      return record;
    }
    db.prepare(
      `INSERT INTO commit_reconciliations
       (task_id, instance_id, nawabari_session_id, branch_name, before_commit, resources_json, message, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'not-attempted', ?, ?)`,
    ).run(
      input.taskId,
      input.instanceId,
      input.nawabariSessionId,
      input.branchName,
      input.beforeCommit,
      JSON.stringify(resources),
      input.message,
      now,
      now,
    );
    return this.getCommitReconciliation(input.taskId)!;
  }

  recordCommitResult(taskId: TaskId, commitSha: string, updatedAt?: number): CommitReconciliationRecord {
    if (commitSha.trim().length === 0) throw new Error(`commit result identity is required: ${taskId}`);
    const db = this.handle();
    const existing = this.getCommitReconciliation(taskId);
    if (existing === undefined) throw new Error(`commit reconciliation not found: ${taskId}`);
    if (existing.commitSha !== undefined && existing.commitSha !== commitSha)
      throw new Error(`commit reconciliation references a different result: ${taskId}`);
    if (existing.state === "ambiguous") throw new Error(`commit reconciliation is already ambiguous: ${taskId}`);
    const now = updatedAt ?? Date.now();
    db.prepare(
      `UPDATE commit_reconciliations
       SET commit_sha = ?, state = CASE WHEN state = 'reconciled' THEN 'reconciled' ELSE 'succeeded' END,
           updated_at = ?
       WHERE task_id = ?`,
    ).run(commitSha, now, taskId);
    return this.getCommitReconciliation(taskId)!;
  }

  markCommitReconciliationAmbiguous(taskId: TaskId, detail: string, updatedAt?: number): CommitReconciliationRecord {
    const existing = this.getCommitReconciliation(taskId);
    if (existing === undefined) throw new Error(`commit reconciliation not found: ${taskId}`);
    const now = updatedAt ?? Date.now();
    this.handle()
      .prepare("UPDATE commit_reconciliations SET state = 'ambiguous', detail = ?, updated_at = ? WHERE task_id = ?")
      .run(detail.slice(0, 512), now, taskId);
    return this.getCommitReconciliation(taskId)!;
  }

  markCommitReconciliationReconciled(taskId: TaskId, updatedAt?: number): CommitReconciliationRecord {
    const existing = this.getCommitReconciliation(taskId);
    if (existing === undefined) throw new Error(`commit reconciliation not found: ${taskId}`);
    if (existing.commitSha === undefined) throw new Error(`commit reconciliation has no result: ${taskId}`);
    if (existing.state === "ambiguous") throw new Error(`commit reconciliation is ambiguous: ${taskId}`);
    const now = updatedAt ?? Date.now();
    this.handle()
      .prepare("UPDATE commit_reconciliations SET state = 'reconciled', updated_at = ? WHERE task_id = ?")
      .run(now, taskId);
    return this.getCommitReconciliation(taskId)!;
  }

  getCommitReconciliation(taskId: TaskId): CommitReconciliationRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM commit_reconciliations WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toCommitReconciliationRecord(row);
  }

  beginNawabariCloseReconciliation(input: BeginNawabariCloseReconciliationInput): NawabariCloseReconciliationRecord {
    const db = this.handle();
    const now = input.createdAt ?? Date.now();
    const existing = db.prepare("SELECT * FROM nawabari_close_reconciliations WHERE task_id = ?").get(input.taskId) as
      | Record<string, unknown>
      | undefined;
    if (existing !== undefined) {
      const record = toNawabariCloseReconciliationRecord(existing);
      const identityMatches =
        record.instanceId === input.instanceId &&
        record.nawabariSessionId === input.nawabariSessionId &&
        record.providerRecordId === input.providerRecordId &&
        (input.integratedRevision === undefined ||
          record.integratedRevision === undefined ||
          record.integratedRevision === input.integratedRevision);
      if (!identityMatches) throw new Error(`Nawabari close reconciliation identity mismatch: ${input.taskId}`);
      if (record.integratedRevision === undefined && input.integratedRevision !== undefined) {
        db.prepare(
          "UPDATE nawabari_close_reconciliations SET integrated_revision = ?, updated_at = ? WHERE task_id = ?",
        ).run(input.integratedRevision, now, input.taskId);
        return this.getNawabariCloseReconciliation(input.taskId)!;
      }
      return record;
    }
    db.prepare(
      `INSERT INTO nawabari_close_reconciliations
       (task_id, instance_id, nawabari_session_id, provider_record_id, integrated_revision, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      input.taskId,
      input.instanceId,
      input.nawabariSessionId,
      input.providerRecordId,
      input.integratedRevision ?? null,
      now,
      now,
    );
    return this.getNawabariCloseReconciliation(input.taskId)!;
  }

  markNawabariCloseReconciliation(
    taskId: TaskId,
    state: Exclude<NawabariCloseReconciliationState, "pending">,
    detail?: string,
    updatedAt?: number,
  ): NawabariCloseReconciliationRecord {
    const existing = this.getNawabariCloseReconciliation(taskId);
    if (existing === undefined) throw new Error(`Nawabari close reconciliation not found: ${taskId}`);
    const now = updatedAt ?? Date.now();
    // "closed" is a terminal state: two concurrent close attempts can both observe
    // "pending", and a later failure from one must never regress the durable result
    // an earlier success already recorded (which would produce a false cleanup blocker).
    this.handle()
      .prepare(
        "UPDATE nawabari_close_reconciliations SET state = ?, detail = ?, updated_at = ? WHERE task_id = ? AND state != 'closed'",
      )
      .run(state, detail === undefined ? null : detail.slice(0, 512), now, taskId);
    return this.getNawabariCloseReconciliation(taskId)!;
  }

  getNawabariCloseReconciliation(taskId: TaskId): NawabariCloseReconciliationRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM nawabari_close_reconciliations WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toNawabariCloseReconciliationRecord(row);
  }

  listNawabariCloseReconciliations(instanceId?: RepositoryInstanceId): NawabariCloseReconciliationRecord[] {
    const rows = (
      instanceId === undefined
        ? this.handle()
            .prepare("SELECT * FROM nawabari_close_reconciliations ORDER BY created_at ASC, task_id ASC")
            .all()
        : this.handle()
            .prepare(
              "SELECT * FROM nawabari_close_reconciliations WHERE instance_id = ? ORDER BY created_at ASC, task_id ASC",
            )
            .all(instanceId)
    ) as Record<string, unknown>[];
    return rows.map((row) => toNawabariCloseReconciliationRecord(row));
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

  attachNawabariSession(
    taskId: TaskId,
    sessionId: NonNullable<TaskRecord["nawabariSessionId"]>,
    updatedAt?: number,
  ): TaskRecord {
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare(
        `UPDATE tasks
         SET nawabari_session_id = ?, task_version = task_version + 1, updated_at = ?
         WHERE task_id = ? AND (nawabari_session_id IS NULL OR nawabari_session_id = ?)`,
      )
      .run(sessionId, now, taskId, sessionId);
    if (result.changes === 0) {
      const existing = this.getTask(taskId);
      if (existing === undefined) throw new Error(`task not found: ${taskId}`);
      throw new Error(`task already references a different Nawabari session: ${taskId}`);
    }
    return this.getTask(taskId)!;
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

  createManagerSession(input: CreateManagerSessionInput): ManagerSessionRecord {
    const startedAt = input.startedAt ?? Date.now();
    const lifecycleState = input.lifecycleState ?? "starting";
    const runtimeState = input.runtimeState ?? lifecycleState;
    const semanticLifecycleState = input.semanticLifecycleState ?? (input.taskId === undefined ? "unbound" : "active");
    const instruction = input.instruction ?? input.launchArgs.at(-1) ?? "";
    const launchProfile = input.launchProfile ?? input.agentKind;
    const attachable = input.attachable ?? (runtimeState === "running" || runtimeState === "detached");
    const reconciliationState = input.reconciliationState ?? "synced";
    this.handle()
      .prepare(
        `INSERT INTO manager_sessions
          (session_id, workspace_root, idempotency_key, task_id, execution_session_id, execution_mode, worktree_id, worktree_path, branch_name,
           task_slug, issue_ref, branch_type, agent_kind, launch_profile, instruction, provider, model,
           launch_command, launch_args_json, runtime_name, lifecycle_state, runtime_state,
           semantic_lifecycle_state, attachable, reconciliation_state, reconciliation_message,
           latest_status, latest_receipt_json, started_at, updated_at, finished_at,
           runtime_observed_at, restart_count, termination_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34)`,
      )
      .run(
        input.sessionId,
        input.workspaceRoot,
        input.idempotencyKey ?? null,
        input.taskId ?? null,
        input.executionSessionId ?? null,
        input.executionMode ?? (input.taskId === undefined ? "workspace" : "task-bound"),
        input.worktreeId ?? null,
        input.worktreePath,
        input.branchName ?? null,
        input.taskSlug ?? null,
        input.issueRef ?? null,
        input.branchType ?? null,
        input.agentKind,
        launchProfile,
        instruction,
        input.provider ?? null,
        input.model ?? null,
        input.launchCommand,
        JSON.stringify([...input.launchArgs]),
        input.runtimeName,
        lifecycleState,
        runtimeState,
        semanticLifecycleState,
        attachable ? 1 : 0,
        reconciliationState,
        managerDiagnostic(input.reconciliationMessage) ?? null,
        managerDiagnostic(input.latestStatus) ?? null,
        input.latestReceipt === undefined
          ? null
          : JSON.stringify({ ...input.latestReceipt, message: managerDiagnostic(input.latestReceipt.message) ?? "" }),
        startedAt,
        startedAt,
        null,
        null,
        0,
        lifecycleState === "running" ? "running" : null,
      );
    return this.getManagerSession(input.sessionId)!;
  }

  getManagerSession(sessionId: ManagerSessionId): ManagerSessionRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM manager_sessions WHERE session_id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toManagerSessionRecord(row);
  }

  listManagerSessions(
    workspaceRoot?: string,
    options: { limit?: number; runtimeStates?: readonly ManagerSessionRecord["runtimeState"][] } = {},
  ): ManagerSessionRecord[] {
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined || !Number.isFinite(requestedLimit)
        ? 500
        : Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000);
    const runtimeStates = [...new Set(options.runtimeStates ?? [])];
    if (options.runtimeStates !== undefined && runtimeStates.length === 0) return [];
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (workspaceRoot !== undefined) {
      clauses.push("workspace_root = ?");
      parameters.push(workspaceRoot);
    }
    if (runtimeStates.length > 0) {
      clauses.push(`runtime_state IN (${runtimeStates.map(() => "?").join(", ")})`);
      parameters.push(...runtimeStates);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM manager_sessions${where} ORDER BY started_at DESC, session_id DESC LIMIT ?`)
      .all(...parameters, limit) as Record<string, unknown>[];
    return rows.map(toManagerSessionRecord);
  }

  updateManagerSession(sessionId: ManagerSessionId, input: UpdateManagerSessionInput): ManagerSessionRecord {
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getManagerSession(sessionId);
      if (current === undefined) throw new Error(`manager session not found: ${sessionId}`);
      const updatedAt = input.updatedAt ?? Date.now();
      const nextState = input.lifecycleState ?? current.lifecycleState;
      const nextRuntimeState = input.runtimeState ?? current.runtimeState;
      const nextSemanticState = input.semanticLifecycleState ?? current.semanticLifecycleState;
      const nextAttachable = input.attachable ?? current.attachable;
      const nextReconciliation = input.reconciliationState ?? current.reconciliationState;
      const nextReconciliationMessage =
        input.reconciliationMessage === undefined ? current.reconciliationMessage : input.reconciliationMessage;
      const nextLatestStatus = input.latestStatus === undefined ? current.latestStatus : input.latestStatus;
      const nextReceipt = input.latestReceipt === undefined ? current.latestReceipt : input.latestReceipt;
      const nextExitCode = input.exitCode === undefined ? current.exitCode : input.exitCode;
      const nextFinishedAt = input.finishedAt === undefined ? current.finishedAt : input.finishedAt;
      const nextObservedAt =
        input.runtimeObservedAt === undefined ? current.runtimeObservedAt : input.runtimeObservedAt;
      const nextRestartCount = input.restartCount ?? current.restartCount;
      const nextTermination = input.terminationState === undefined ? current.terminationState : input.terminationState;
      const nextError = input.errorMessage === undefined ? current.errorMessage : input.errorMessage;
      db.prepare(
        `UPDATE manager_sessions
         SET lifecycle_state = ?, runtime_state = ?, semantic_lifecycle_state = ?, attachable = ?,
             reconciliation_state = ?, reconciliation_message = ?, latest_status = ?, latest_receipt_json = ?,
             updated_at = ?, finished_at = ?, runtime_observed_at = ?, restart_count = ?,
             exit_code = ?, termination_state = ?, error_message = ?
         WHERE session_id = ?`,
      ).run(
        nextState,
        nextRuntimeState,
        nextSemanticState,
        nextAttachable ? 1 : 0,
        nextReconciliation,
        managerDiagnostic(nextReconciliationMessage) ?? null,
        managerDiagnostic(nextLatestStatus) ?? null,
        nextReceipt === undefined
          ? null
          : JSON.stringify({ ...nextReceipt, message: managerDiagnostic(nextReceipt.message) ?? "" }),
        updatedAt,
        nextFinishedAt ?? null,
        nextObservedAt ?? null,
        nextRestartCount,
        nextExitCode ?? null,
        nextTermination ?? null,
        managerDiagnostic(nextError) ?? null,
        sessionId,
      );
      const updated = this.getManagerSession(sessionId)!;
      db.exec("COMMIT");
      return updated;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の更新エラーを保持する
      }
      throw err;
    }
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
      mergeRevision: (row.merge_revision as string | null) ?? undefined,
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
        if (
          input.mergeRevision !== undefined &&
          existingRecord.mergeRevision !== undefined &&
          existingRecord.mergeRevision !== input.mergeRevision
        )
          throw new Error(
            `pull request record already exists with a different merge revision: ${input.provider}/${input.repositoryId}#${input.prNumber}`,
          );
        if (existingRecord.mergeRevision === undefined && input.mergeRevision !== undefined) {
          db.prepare("UPDATE pr_records SET merge_revision = ?, updated_at = ? WHERE record_id = ?").run(
            input.mergeRevision,
            now,
            existingRecord.recordId,
          );
          const updated = db
            .prepare("SELECT * FROM pr_records WHERE record_id = ?")
            .get(existingRecord.recordId) as Record<string, unknown>;
          db.exec("COMMIT");
          return this.toPullRequestRecord(updated);
        }
        db.exec("COMMIT");
        return existingRecord;
      }

      const recordId = crypto.randomUUID() as PullRequestRecordId;
      db.prepare(
        `INSERT INTO pr_records
          (record_id, task_id, instance_id, provider, repository_id, pr_number, url, head_sha, merge_revision, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recordId,
        input.taskId ?? null,
        instanceId ?? null,
        input.provider,
        input.repositoryId,
        input.prNumber,
        input.url,
        input.headSha,
        input.mergeRevision ?? null,
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

  recordPullRequestMergeRevision(
    recordId: PullRequestRecordId,
    mergeRevision: string,
    updatedAt?: number,
  ): PullRequestRecord {
    if (mergeRevision.trim().length === 0) throw new Error("pull request merge revision must not be empty");
    const now = updatedAt ?? Date.now();
    const result = this.handle()
      .prepare(
        "UPDATE pr_records SET merge_revision = ?, updated_at = ? WHERE record_id = ? AND (merge_revision IS NULL OR merge_revision = ?)",
      )
      .run(mergeRevision, now, recordId, mergeRevision);
    if (result.changes === 0) {
      const existing = this.getPullRequestRecord(recordId);
      if (existing === undefined) throw new Error(`pull request record not found: ${recordId}`);
      if (existing.mergeRevision !== mergeRevision)
        throw new Error(`pull request merge revision identity mismatch: ${recordId}`);
      return existing;
    }
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
