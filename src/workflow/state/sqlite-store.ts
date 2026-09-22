import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { addSecondaryDiagnostic, DIRECT_BOUNDARIES } from "../../boundary.js";
import type { BoundaryOperations } from "../../boundary.js";
import { applyMigrations } from "../../state/migrations.js";
import type { Migration } from "../../state/migrations.js";
import { resolveStateDbPath } from "../../state/paths.js";
import { sanitizeAuditMetadata } from "../domain/audit.js";
import {
  REPOSITORY_PRINCIPAL_SCHEMA_VERSION,
  WORKER_SUPERVISION_MAX_DIAGNOSTIC_EVENTS,
  WORKER_SUPERVISION_SCHEMA_VERSION,
} from "./store.js";
import {
  WORKER_RUNTIME_CONTROL_OPERATIONS,
  WorkerRuntimeBindingSchema,
  WorkerRuntimeControlReceiptSchema,
  WorkerRuntimeObservationEventSchema,
  WorkerRuntimeObservationSchema,
  WorkerRuntimeStatusReportInputSchema,
} from "../../manager/worker-runtime.js";
import type {
  WorkerRuntimeBinding,
  WorkerRuntimeObservationEvent,
  WorkerRuntimeObservation,
  WorkerRuntimeStatusReportInput,
} from "../../manager/worker-runtime.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type {
  RepositorySourceId,
  HookCheckpointRecord,
  ObserveRepositoryInstanceInput,
  ObserveRepositoryInstanceResult,
  AllocateRepositoryPrincipalInput,
  AllocateRepositoryPrincipalResult,
  ListRepositoryPrincipalsOptions,
  ProveRepositoryPrincipalCleanupInput,
  ReleaseRepositoryPrincipalInput,
  RepositoryPrincipalLifecycleState,
  RepositoryPrincipalRecord,
  RecordHookCheckpointInput,
  RepositoryInstanceRecord,
  RepositoryPathRecord,
  RepositorySourceRecord,
  PullRequestRecord,
  PullRequestRecordId,
  RecordPullRequestInput,
  ManagedPullRequestState,
  ManagedPullRequestStateId,
  ManagedPullRequestDerivedInput,
  ManagedPullRequestDerivedInputId,
  RecordManagedPullRequestStateInput,
  RecordManagedPullRequestDerivedInput,
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
  CanonCheckpointId,
  CanonCheckpointJsonValue,
  CanonCheckpointRecord,
  CanonCheckpointFreshnessInputs,
  CanonCheckpointLineageKind,
  CanonCheckpointState,
  GuardrailAuditRecord,
  GuardrailAuditDecision,
  ListGuardrailAuditRecordsOptions,
  ManagerSessionId,
  ManagerSessionRecord,
  ManagerSessionReceipt,
  ManagerRuntimeAvailabilityState,
  ManagerRuntimeId,
  ManagerRuntimeRecord,
  ManagerRuntimeTargetKind,
  RegisterManagerRuntimeInput,
  UpdateManagerRuntimeInput,
  MarkCleanupLeaseInput,
  NawabariSessionId,
  RecordGuardrailDecisionInput,
  RecordCanonCheckpointInput,
  ReconcileCanonCheckpointInput,
  ListCanonCheckpointsOptions,
  CanonForkLaunchRecord,
  CanonForkLaunchState,
  ListCanonForkLaunchesOptions,
  PlanCanonForkLaunchInput,
  AttachCanonForkLaunchInput,
  ReserveCleanupLeaseInput,
  ReserveCleanupLeaseResult,
  TaskId,
  TaskRecord,
  TaskStartReconciliationRecord,
  TaskStartReconciliationState,
  UpdateManagerSessionInput,
  UpdateTaskLifecycleStateExpectedInput,
  UpdateTaskLifecycleStateExpectedResult,
  ValidationEvidenceRecord,
  WorkflowStateStore,
  WorkerControlAuditRecord,
  RecordWorkerControlAuditInput,
  ListWorkerControlAuditOptions,
  ListWorkerSupervisionOptions,
  RecordWorkerSupervisionInput,
  WorkerSupervisionDiagnosticEvent,
  WorkerSupervisionRecord,
  WorktreeId,
  WorktreeRecord,
} from "./store.js";

export interface WorkflowSqliteStateStoreOptions {
  /** 明示指定時はこのパスを使う。省略時は resolveStateDbPath() を使う（session 用と同じ DB ファイルを共有）。 */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Open an existing state database without migrations, pragmas, or filesystem writes. */
  readOnly?: boolean;
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

function readOnlyDatabasePath(dbPath: string): string {
  // An immutable SQLite URI avoids creating WAL/SHM sidecars when there is no
  // concurrent writer. If sidecars already exist, use the normal read-only
  // path so an in-flight WAL remains visible to the preview.
  if (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`)) return dbPath;
  return `${pathToFileURL(dbPath).href}?immutable=1`;
}

/**
 * Worker supervision is intentionally migrated here rather than by the
 * Manager service. The tables are additive and the operation is idempotent,
 * so opening an existing workflow database preserves every prior record.
 */
function ensureWorkerSupervisionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_supervision_records (
      manager_session_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = ${WORKER_SUPERVISION_SCHEMA_VERSION}),
      binding_json TEXT NOT NULL,
      latest_lifecycle_state TEXT NOT NULL,
      latest_status_json TEXT NOT NULL,
      latest_observation_json TEXT NOT NULL,
      diagnostic_events_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_control_audit (
      audit_id TEXT PRIMARY KEY,
      manager_session_id TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('start', 'bind', 'stop', 'steer', 'input')),
      requested_at TEXT NOT NULL,
      accepted_at TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worker_control_audit_session
      ON worker_control_audit (manager_session_id, recorded_at ASC, audit_id ASC);
  `);
}

function workerTimestampMs(value: string, field: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`worker ${field} is invalid`);
  }
  return Date.parse(value);
}

function workerRecordedAt(value: number | undefined): number {
  const recordedAt = value ?? Date.now();
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) throw new Error("worker recordedAt is invalid");
  return recordedAt;
}

function workerBindingIdentityMatches(left: WorkerRuntimeBinding, right: WorkerRuntimeBinding): boolean {
  return (
    left.identity.managerSessionId === right.identity.managerSessionId &&
    left.identity.runtimeId === right.identity.runtimeId &&
    left.identity.taskId === right.identity.taskId &&
    left.identity.executionSessionId === right.identity.executionSessionId &&
    left.identity.provider === right.identity.provider
  );
}

function assertWorkerBindingIdentity(left: WorkerRuntimeBinding, right: WorkerRuntimeBinding): void {
  if (!workerBindingIdentityMatches(left, right)) throw new Error("worker binding identity mismatch");
}

function projectWorkerDiagnosticEvent(event: WorkerRuntimeObservationEvent): WorkerSupervisionDiagnosticEvent {
  const projected: WorkerSupervisionDiagnosticEvent = {
    kind: event.kind,
    observedAt: event.observedAt,
  };
  if (event.kind === "status") {
    projected.phase = event.status.phase;
    projected.activity = event.status.activity.kind;
    projected.attention = event.status.attention;
    if (event.status.blocker !== undefined) projected.blockerCode = event.status.blocker.code;
  } else if (event.kind === "failed") {
    projected.blockerCode = event.blocker.code;
  } else if (event.kind === "stopped" && event.reason !== undefined) {
    projected.reason = event.reason;
  }
  return projected;
}

function parseWorkerDiagnosticEvents(value: unknown): WorkerSupervisionDiagnosticEvent[] {
  if (!Array.isArray(value) || value.length > WORKER_SUPERVISION_MAX_DIAGNOSTIC_EVENTS)
    throw new Error("worker diagnostic events are invalid");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("worker diagnostic event is invalid");
    const candidate = entry as Record<string, unknown>;
    const allowed = new Set(["kind", "observedAt", "phase", "activity", "attention", "blockerCode", "reason"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) throw new Error("worker diagnostic event is invalid");
    if (
      !["started", "status", "stopped", "failed"].includes(String(candidate.kind)) ||
      typeof candidate.observedAt !== "string"
    ) {
      throw new Error("worker diagnostic event is invalid");
    }
    workerTimestampMs(candidate.observedAt, "diagnostic event observedAt");
    const projected: WorkerSupervisionDiagnosticEvent = {
      kind: candidate.kind as WorkerSupervisionDiagnosticEvent["kind"],
      observedAt: candidate.observedAt,
    };
    for (const field of ["phase", "activity", "blockerCode", "reason"] as const) {
      if (candidate[field] !== undefined) {
        if (typeof candidate[field] !== "string" || candidate[field].length === 0 || candidate[field].length > 512)
          throw new Error("worker diagnostic event is invalid");
        projected[field] = candidate[field];
      }
    }
    if (candidate.attention !== undefined) {
      if (!["none", "attention", "blocked"].includes(String(candidate.attention)))
        throw new Error("worker diagnostic event is invalid");
      projected.attention = candidate.attention as WorkerSupervisionDiagnosticEvent["attention"];
    }
    return projected;
  });
}

function mergeWorkerDiagnosticEvents(
  current: readonly WorkerSupervisionDiagnosticEvent[],
  next: WorkerSupervisionDiagnosticEvent | undefined,
): WorkerSupervisionDiagnosticEvent[] {
  if (next === undefined) return [...current];
  const events = [...current, next];
  events.sort((left, right) => {
    const time =
      workerTimestampMs(left.observedAt, "diagnostic event observedAt") -
      workerTimestampMs(right.observedAt, "diagnostic event observedAt");
    return time !== 0 ? time : left.kind.localeCompare(right.kind);
  });
  return events.slice(-WORKER_SUPERVISION_MAX_DIAGNOSTIC_EVENTS);
}

function parseJson(value: unknown, field: string): unknown {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`worker ${field} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toWorkerSupervisionRecord(row: Record<string, unknown>): WorkerSupervisionRecord {
  if (row.schema_version !== WORKER_SUPERVISION_SCHEMA_VERSION)
    throw new Error("worker supervision schema version is unsupported");
  const binding = WorkerRuntimeBindingSchema.parse(parseJson(row.binding_json, "binding"));
  const latestStatus = WorkerRuntimeStatusReportInputSchema.parse(parseJson(row.latest_status_json, "status"));
  const latestObservation = WorkerRuntimeObservationSchema.parse(parseJson(row.latest_observation_json, "observation"));
  assertWorkerBindingIdentity(binding, latestObservation.binding);
  if (latestStatus.lifecycleState !== latestObservation.status.lifecycleState)
    throw new Error("worker supervision status and observation disagree");
  const diagnosticEvents = parseWorkerDiagnosticEvents(parseJson(row.diagnostic_events_json, "diagnostic events"));
  return {
    managerSessionId: binding.identity.managerSessionId,
    schemaVersion: WORKER_SUPERVISION_SCHEMA_VERSION,
    binding,
    latestLifecycleState: row.latest_lifecycle_state as WorkerSupervisionRecord["latestLifecycleState"],
    latestStatus,
    latestObservation,
    diagnosticEvents,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toWorkerControlAuditRecord(row: Record<string, unknown>): WorkerControlAuditRecord {
  const binding = WorkerRuntimeBindingSchema.parse(parseJson(row.binding_json, "control binding"));
  const requestedAt = String(row.requested_at);
  workerTimestampMs(requestedAt, "control requestedAt");
  const acceptedAt = row.accepted_at === null || row.accepted_at === undefined ? undefined : String(row.accepted_at);
  if (acceptedAt !== undefined) workerTimestampMs(acceptedAt, "control acceptedAt");
  if (
    !WORKER_RUNTIME_CONTROL_OPERATIONS.includes(
      String(row.operation) as (typeof WORKER_RUNTIME_CONTROL_OPERATIONS)[number],
    )
  )
    throw new Error("worker control operation is invalid");
  return {
    auditId: String(row.audit_id),
    managerSessionId: binding.identity.managerSessionId,
    binding,
    operation: row.operation as WorkerControlAuditRecord["operation"],
    requestedAt,
    acceptedAt,
    recordedAt: row.recorded_at as number,
  };
}

const MAX_MANAGER_DIAGNOSTIC_LENGTH = 512;
const DEFAULT_REPOSITORY_PRINCIPAL_MIN_ID = 10_000;
const DEFAULT_REPOSITORY_PRINCIPAL_MAX_ID = 60_000;

function principalAllocationRange(
  input: AllocateRepositoryPrincipalInput,
): { minId: number; maxId: number } | undefined {
  const minId = input.minId ?? DEFAULT_REPOSITORY_PRINCIPAL_MIN_ID;
  const maxId = input.maxId ?? DEFAULT_REPOSITORY_PRINCIPAL_MAX_ID;
  if (!Number.isSafeInteger(minId) || !Number.isSafeInteger(maxId) || minId < 1000 || maxId > 65535 || minId > maxId)
    return undefined;
  return { minId, maxId };
}

function principalRepositoryKey(instanceId: string): boolean {
  return instanceId.length > 0 && instanceId.length <= 256 && !instanceId.includes("\0");
}

function assertPrincipalTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`repository principal ${field} is invalid`);
}
const MAX_MANAGED_PR_FIELD_LENGTH = 512;

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

function toRepositoryPrincipalRecord(row: Record<string, unknown>): RepositoryPrincipalRecord {
  const lifecycleState = row.lifecycle_state;
  if (
    row.schema_version !== REPOSITORY_PRINCIPAL_SCHEMA_VERSION ||
    typeof row.allocation_id !== "string" ||
    row.allocation_id.length < 1 ||
    typeof row.instance_id !== "string" ||
    typeof row.uid !== "number" ||
    !Number.isSafeInteger(row.uid) ||
    row.uid < 1000 ||
    row.uid > 65535 ||
    typeof row.gid !== "number" ||
    !Number.isSafeInteger(row.gid) ||
    row.gid < 1000 ||
    row.gid > 65535 ||
    typeof row.internal_username !== "string" ||
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(row.internal_username) ||
    !["active", "quarantined", "available", "retired"].includes(String(lifecycleState)) ||
    typeof row.allocated_at !== "number" ||
    !Number.isSafeInteger(row.allocated_at) ||
    (row.released_at !== null && (typeof row.released_at !== "number" || !Number.isSafeInteger(row.released_at))) ||
    (row.cleanup_proven_at !== null &&
      (typeof row.cleanup_proven_at !== "number" || !Number.isSafeInteger(row.cleanup_proven_at))) ||
    (row.reassigned_at !== null &&
      (typeof row.reassigned_at !== "number" || !Number.isSafeInteger(row.reassigned_at))) ||
    (row.reassigned_to_allocation_id !== null && typeof row.reassigned_to_allocation_id !== "string")
  ) {
    throw new Error("repository principal state is corrupt or uses an unsupported schema version");
  }
  const state = lifecycleState as RepositoryPrincipalLifecycleState;
  const releasedAt = (row.released_at as number | null) ?? undefined;
  const cleanupProvenAt = (row.cleanup_proven_at as number | null) ?? undefined;
  const reassignedAt = (row.reassigned_at as number | null) ?? undefined;
  const reassignedToAllocationId = (row.reassigned_to_allocation_id as string | null) ?? undefined;
  const validLifecycle =
    (state === "active" &&
      releasedAt === undefined &&
      cleanupProvenAt === undefined &&
      reassignedAt === undefined &&
      reassignedToAllocationId === undefined) ||
    (state === "quarantined" &&
      releasedAt !== undefined &&
      cleanupProvenAt === undefined &&
      reassignedAt === undefined &&
      reassignedToAllocationId === undefined) ||
    (state === "available" &&
      releasedAt !== undefined &&
      cleanupProvenAt !== undefined &&
      reassignedAt === undefined &&
      reassignedToAllocationId === undefined) ||
    (state === "retired" &&
      releasedAt !== undefined &&
      cleanupProvenAt !== undefined &&
      reassignedAt !== undefined &&
      reassignedToAllocationId !== undefined &&
      reassignedToAllocationId.length > 0);
  if (!validLifecycle) throw new Error("repository principal lifecycle state is corrupt");
  return {
    allocationId: row.allocation_id,
    instanceId: row.instance_id as RepositoryPrincipalRecord["instanceId"],
    uid: row.uid,
    gid: row.gid,
    internalUsername: row.internal_username,
    lifecycleState: state,
    schemaVersion: REPOSITORY_PRINCIPAL_SCHEMA_VERSION,
    allocatedAt: row.allocated_at,
    releasedAt,
    cleanupProvenAt,
    reassignedAt,
    reassignedToAllocationId,
  };
}

/** A proven reusable row must never coexist with an authoritative row on the same ID. */
function assertNoRepositoryPrincipalAmbiguity(db: DatabaseSync): void {
  const activeAvailableCollision = db
    .prepare(
      `SELECT 1 FROM repository_principals authoritative
       JOIN repository_principals available
         ON (authoritative.uid = available.uid OR authoritative.gid = available.gid)
       WHERE authoritative.lifecycle_state IN ('active', 'quarantined')
         AND available.lifecycle_state = 'available'
       LIMIT 1`,
    )
    .get();
  if (activeAvailableCollision !== undefined) {
    throw new Error(
      "repository principal allocation state is ambiguous: reusable identity overlaps an authoritative identity",
    );
  }
  const duplicateReusable = db
    .prepare(
      `SELECT 1 FROM repository_principals left_row
       JOIN repository_principals right_row
         ON left_row.allocation_id < right_row.allocation_id
        AND (left_row.uid = right_row.uid OR left_row.gid = right_row.gid)
       WHERE left_row.lifecycle_state = 'available' AND right_row.lifecycle_state = 'available'
       LIMIT 1`,
    )
    .get();
  if (duplicateReusable !== undefined) {
    throw new Error("repository principal allocation state is ambiguous: duplicate reusable identity");
  }
}

/**
 * A changed common-dir is a relocation only after the previous location has
 * disappeared. If it is still a directory, the same marker may have been
 * copied to a second repository, so observing it must fail closed.
 */
function isExistingCommonDir(gitCommonDir: string): boolean {
  try {
    return fs.statSync(gitCommonDir).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(`cannot verify previous repository common-dir ${gitCommonDir}: ${(err as Error).message}`);
  }
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

const MAX_CANON_CHECKPOINT_FIELD_LENGTH = 512;
const MAX_CANON_CHECKPOINT_JSON_DEPTH = 32;
const MAX_CANON_CHECKPOINT_JSON_ENTRIES = 256;
const CANON_PREFIX_ID_PATTERN = /^cp1:[0-9a-f]{64}$/u;
const CANON_EXECUTION_STATE_ID_PATTERN = /^es1:[0-9a-f]{64}$/u;

function canonCheckpointField(value: unknown, field: string, optional = false): string | undefined {
  if ((value === undefined || value === null) && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CANON_CHECKPOINT_FIELD_LENGTH)
    throw new Error(`Canon checkpoint ${field} is invalid`);
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`Canon checkpoint ${field} is invalid`);
  return value;
}

function canonicalCanonCheckpointJson(value: unknown, depth = 0): CanonCheckpointJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (depth >= MAX_CANON_CHECKPOINT_JSON_DEPTH) throw new Error("Canon checkpoint freshness is too deeply nested");
  if (Array.isArray(value)) {
    if (value.length > MAX_CANON_CHECKPOINT_JSON_ENTRIES) throw new Error("Canon checkpoint freshness is too large");
    return value.map((entry) => canonicalCanonCheckpointJson(entry, depth + 1));
  }
  if (typeof value !== "object" || value === undefined) throw new Error("Canon checkpoint freshness is invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CANON_CHECKPOINT_JSON_ENTRIES) throw new Error("Canon checkpoint freshness is too large");
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => {
        if (key.length > MAX_CANON_CHECKPOINT_FIELD_LENGTH || /[\u0000-\u001f\u007f]/u.test(key))
          throw new Error("Canon checkpoint freshness has an invalid key");
        return [key, canonicalCanonCheckpointJson(entry, depth + 1)];
      }),
  ) as CanonCheckpointJsonValue;
}

function canonicalCanonCheckpointFreshness(value: unknown): CanonCheckpointFreshnessInputs {
  const canonical = canonicalCanonCheckpointJson(value);
  if (typeof canonical !== "object" || canonical === null || Array.isArray(canonical))
    throw new Error("Canon checkpoint freshness must be an object");
  const record = canonical as Record<string, CanonCheckpointJsonValue>;
  for (const field of ["repository", "task", "base", "source"] as const) {
    if (!(field in record)) throw new Error(`Canon checkpoint freshness ${field} is required`);
  }
  if (!("artifactGeneration" in record)) throw new Error("Canon checkpoint freshness artifactGeneration is required");
  return record as CanonCheckpointFreshnessInputs;
}

function canonCheckpointFreshnessJson(value: CanonCheckpointFreshnessInputs): string {
  return JSON.stringify(canonicalCanonCheckpointFreshness(value));
}

function toCanonCheckpointRecord(row: Record<string, unknown>): CanonCheckpointRecord {
  const checkpointId = canonCheckpointField(row.checkpoint_id, "checkpoint_id") as CanonCheckpointId;
  const canonContractId = canonCheckpointField(row.canon_contract_id, "canon_contract_id")!;
  const canonSchemaVersion = row.canon_schema_version;
  if (!Number.isSafeInteger(canonSchemaVersion) || (canonSchemaVersion as number) <= 0)
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid schema version`);
  const prefix_id = canonCheckpointField(row.prefix_id, "prefix_id")!;
  if (!CANON_PREFIX_ID_PATTERN.test(prefix_id))
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid prefix_id`);
  const parentCheckpointId =
    row.parent_checkpoint_id === null || row.parent_checkpoint_id === undefined
      ? undefined
      : (canonCheckpointField(row.parent_checkpoint_id, "parent_checkpoint_id") as CanonCheckpointId);
  const lineageKind = row.lineage_kind as CanonCheckpointLineageKind;
  if (lineageKind !== "independent-root" && lineageKind !== "fork")
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid lineage kind`);
  if ((lineageKind === "independent-root") !== (parentCheckpointId === undefined))
    throw new Error(`Canon checkpoint ${checkpointId} has inconsistent parent lineage`);
  let freshness: CanonCheckpointFreshnessInputs;
  try {
    freshness = canonicalCanonCheckpointFreshness(JSON.parse(String(row.freshness_json)));
  } catch (error) {
    throw new Error(
      `Canon checkpoint ${checkpointId} has corrupt freshness: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const execution_state_id =
    row.execution_state_id === null || row.execution_state_id === undefined
      ? undefined
      : canonCheckpointField(row.execution_state_id, "execution_state_id");
  if (execution_state_id !== undefined && !CANON_EXECUTION_STATE_ID_PATTERN.test(execution_state_id))
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid execution_state_id`);
  const attachmentGeneration = row.attachment_generation === null ? undefined : (row.attachment_generation as number);
  if (attachmentGeneration !== undefined && (!Number.isSafeInteger(attachmentGeneration) || attachmentGeneration <= 0))
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid attachment generation`);
  const state = row.state as CanonCheckpointState;
  if (state !== "current" && state !== "stale")
    throw new Error(`Canon checkpoint ${checkpointId} has an invalid state`);
  return {
    checkpointId,
    canonContractId,
    canonSchemaVersion: canonSchemaVersion as number,
    prefix_id,
    parentCheckpointId,
    lineageKind,
    freshness,
    execution_state_id,
    attachmentGeneration,
    agentId: canonCheckpointField(row.agent_id, "agent_id", true),
    modelId: canonCheckpointField(row.model_id, "model_id", true),
    profile: canonCheckpointField(row.profile, "profile", true),
    state,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

const CANON_FORK_LAUNCH_STATES = new Set<CanonForkLaunchState>(["planned", "attached", "launched", "failed"]);

function toCanonForkLaunchRecord(row: Record<string, unknown>): CanonForkLaunchRecord {
  const forkId = canonCheckpointField(row.fork_id, "fork_id")!;
  const workspaceRoot = canonCheckpointField(row.workspace_root, "workspace_root")!;
  const parentCheckpointId = canonCheckpointField(
    row.parent_checkpoint_id,
    "parent_checkpoint_id",
  ) as CanonCheckpointId;
  const childCheckpointId = canonCheckpointField(row.child_checkpoint_id, "child_checkpoint_id") as CanonCheckpointId;
  const plannedManagerSessionId = canonCheckpointField(
    row.planned_manager_session_id,
    "planned_manager_session_id",
  ) as ManagerSessionId;
  const prefix_id = canonCheckpointField(row.prefix_id, "prefix_id")!;
  if (!CANON_PREFIX_ID_PATTERN.test(prefix_id)) throw new Error(`Canon fork ${forkId} has an invalid prefix_id`);
  let freshness: CanonCheckpointFreshnessInputs;
  try {
    freshness = canonicalCanonCheckpointFreshness(JSON.parse(String(row.freshness_json)));
  } catch (error) {
    throw new Error(
      `Canon fork ${forkId} has corrupt freshness: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const branchName = canonCheckpointField(row.branch_name, "branch_name")!;
  const base = canonCheckpointField(row.base, "base")!;
  const runtimeName = canonCheckpointField(row.runtime_name, "runtime_name")!;
  const instruction = canonCheckpointField(row.instruction, "instruction")!;
  const agentId = canonCheckpointField(row.agent_id, "agent_id")!;
  const modelId = canonCheckpointField(row.model_id, "model_id", true);
  const profile = canonCheckpointField(row.profile, "profile")!;
  const launchCommand = canonCheckpointField(row.launch_command, "launch_command")!;
  let launchArgs: string[];
  try {
    const parsed: unknown = JSON.parse(String(row.launch_args_json ?? "[]"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("invalid argv");
    launchArgs = [...parsed];
  } catch (error) {
    throw new Error(
      `Canon fork ${forkId} has invalid launch args: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const state = row.state as CanonForkLaunchState;
  if (!CANON_FORK_LAUNCH_STATES.has(state)) throw new Error(`Canon fork ${forkId} has an invalid state`);
  const execution_state_id = canonCheckpointField(row.execution_state_id, "execution_state_id", true);
  if (execution_state_id !== undefined && !CANON_EXECUTION_STATE_ID_PATTERN.test(execution_state_id))
    throw new Error(`Canon fork ${forkId} has an invalid execution_state_id`);
  const attachmentGeneration = row.attachment_generation === null ? undefined : (row.attachment_generation as number);
  if (attachmentGeneration !== undefined && (!Number.isSafeInteger(attachmentGeneration) || attachmentGeneration <= 0))
    throw new Error(`Canon fork ${forkId} has an invalid attachment generation`);
  return {
    forkId,
    workspaceRoot,
    idempotencyKey: canonCheckpointField(row.idempotency_key, "idempotency_key", true),
    parentCheckpointId,
    childCheckpointId,
    plannedManagerSessionId,
    prefix_id,
    freshness,
    branchName,
    base,
    runtimeName,
    instruction,
    agentId,
    modelId,
    profile: profile as CanonForkLaunchRecord["profile"],
    launchCommand,
    launchArgs,
    nawabariSessionId: canonCheckpointField(row.nawabari_session_id, "nawabari_session_id", true),
    worktreePath: canonCheckpointField(row.worktree_path, "worktree_path", true),
    execution_state_id,
    attachmentGeneration,
    managerSessionId: canonCheckpointField(row.manager_session_id, "manager_session_id", true) as
      | ManagerSessionId
      | undefined,
    state,
    detail: canonCheckpointField(row.detail, "detail", true),
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
    runtimeId: (row.runtime_id as ManagerRuntimeId | null) ?? ("local" as ManagerRuntimeId),
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

function toManagerRuntimeRecord(row: Record<string, unknown>): ManagerRuntimeRecord {
  return {
    runtimeId: row.runtime_id as ManagerRuntimeId,
    targetKind: row.target_kind as ManagerRuntimeTargetKind,
    displayName: row.display_name as string,
    address: row.address as string,
    configProvenance: (row.config_provenance as string | null) ?? undefined,
    state: row.state as ManagerRuntimeAvailabilityState,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastSeenAt: (row.last_seen_at as number | null) ?? undefined,
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
  private readonly readOnly: boolean;
  private readonly boundaries: BoundaryOperations;
  private readonly migrations: Migration[];
  private db: DatabaseSync | undefined;

  constructor(options: WorkflowSqliteStateStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveStateDbPath(options.env ?? process.env);
    this.readOnly = options.readOnly === true;
    this.boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
    this.migrations = options.migrations ?? [];
  }

  init(): void {
    if (this.db !== undefined) return;
    if (this.readOnly) {
      // A read-only preview must not create the state file, switch journal
      // modes, chmod anything, or apply migrations. Callers select an
      // in-memory fallback when this path does not exist.
      this.db = this.boundaries.file(
        "sqlite.open",
        () => new DatabaseSync(readOnlyDatabasePath(this.dbPath), { readOnly: true }),
      );
      return;
    }
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
        this.boundaries.file("sqlite.worker-supervision-schema", () => ensureWorkerSupervisionSchema(db));
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
        const existingCommonDir = existingInstance.git_common_dir as string;
        const conflictingInstance = db
          .prepare("SELECT instance_id FROM repository_instances WHERE git_common_dir = ? AND instance_id != ?")
          .get(input.gitCommonDir, input.instanceId) as { instance_id: string } | undefined;
        if (conflictingInstance !== undefined) {
          throw new Error(
            `repository common-dir is already owned by another instance: ${input.gitCommonDir} (${conflictingInstance.instance_id})`,
          );
        }

        if (existingCommonDir !== input.gitCommonDir) {
          if (isExistingCommonDir(existingCommonDir)) {
            throw new Error(
              `refusing ambiguous repository instance relocation: ${input.instanceId} is still present at ${existingCommonDir}`,
            );
          }
          db.prepare("UPDATE repository_instances SET git_common_dir = ?, last_seen_at = ? WHERE instance_id = ?").run(
            input.gitCommonDir,
            now,
            input.instanceId,
          );
        } else {
          db.prepare("UPDATE repository_instances SET last_seen_at = ? WHERE instance_id = ?").run(
            now,
            input.instanceId,
          );
        }
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

  allocateRepositoryPrincipal(input: AllocateRepositoryPrincipalInput): AllocateRepositoryPrincipalResult {
    if (!principalRepositoryKey(input.instanceId)) {
      return {
        ok: false,
        reason: "repository-not-eligible",
        detail: "canonical repository identity is missing or invalid",
      };
    }
    const range = principalAllocationRange(input);
    if (range === undefined) {
      return {
        ok: false,
        reason: "invalid-range",
        detail: "principal UID/GID range must be an inclusive unprivileged range",
      };
    }
    const db = this.handle();
    const allocatedAt = input.allocatedAt ?? Date.now();
    assertPrincipalTimestamp(allocatedAt, "allocation timestamp");
    db.exec("BEGIN IMMEDIATE");
    try {
      const identityRow = db
        .prepare("SELECT instance_id FROM repository_instances WHERE instance_id = ?")
        .get(input.instanceId) as { instance_id: string } | undefined;
      if (identityRow === undefined) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason: "repository-not-eligible",
          detail: "canonical repository identity has not been observed by the repository identity authority",
        };
      }
      const existingRow = db
        .prepare("SELECT * FROM repository_principals WHERE instance_id = ?")
        .get(input.instanceId) as Record<string, unknown> | undefined;
      if (existingRow !== undefined) {
        const existing = toRepositoryPrincipalRecord(existingRow);
        if (existing.lifecycleState === "active") {
          db.exec("COMMIT");
          return { ok: true, principal: existing };
        }
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason: "repository-not-eligible",
          detail: `repository principal is ${existing.lifecycleState}; explicit cleanup or reconciliation is required`,
        };
      }

      const rows = db.prepare("SELECT * FROM repository_principals").all() as Record<string, unknown>[];
      assertNoRepositoryPrincipalAmbiguity(db);
      const principals = rows.map(toRepositoryPrincipalRecord);
      const blockedUids = new Set(
        principals.filter((principal) => principal.lifecycleState !== "available").map((principal) => principal.uid),
      );
      const blockedGids = new Set(
        principals.filter((principal) => principal.lifecycleState !== "available").map((principal) => principal.gid),
      );
      const reusable = principals
        .filter(
          (principal) =>
            principal.lifecycleState === "available" &&
            !blockedUids.has(principal.uid) &&
            !blockedGids.has(principal.gid) &&
            principal.uid >= range.minId &&
            principal.uid <= range.maxId &&
            principal.gid >= range.minId &&
            principal.gid <= range.maxId,
        )
        .sort(
          (left, right) =>
            left.uid - right.uid || left.gid - right.gid || left.instanceId.localeCompare(right.instanceId),
        )[0];
      let uid = reusable?.uid;
      let gid = reusable?.gid;
      if (uid === undefined || gid === undefined) {
        for (let candidate = range.minId; candidate <= range.maxId; candidate += 1) {
          if (!blockedUids.has(candidate)) {
            uid = candidate;
            break;
          }
        }
        for (let candidate = range.minId; candidate <= range.maxId; candidate += 1) {
          if (!blockedGids.has(candidate)) {
            gid = candidate;
            break;
          }
        }
      }
      if (uid === undefined || gid === undefined) {
        db.exec("ROLLBACK");
        return { ok: false, reason: "no-identities-available", detail: "the requested principal range is exhausted" };
      }

      const internalUsername = `mottainai-repo-${crypto.randomBytes(8).toString("hex")}`;
      const allocationId = crypto.randomUUID();
      this.boundaries.storage("sqlite.repository-principal.write", () => {
        if (reusable !== undefined) {
          db.prepare(
            `UPDATE repository_principals
             SET lifecycle_state = 'retired', reassigned_at = ?, reassigned_to_allocation_id = ?
             WHERE allocation_id = ? AND lifecycle_state = 'available'`,
          ).run(allocatedAt, allocationId, reusable.allocationId);
        }
        db.prepare(
          `INSERT INTO repository_principals
           (allocation_id, instance_id, uid, gid, internal_username, lifecycle_state, schema_version, allocated_at, released_at, cleanup_proven_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
        ).run(
          allocationId,
          input.instanceId,
          uid,
          gid,
          internalUsername,
          REPOSITORY_PRINCIPAL_SCHEMA_VERSION,
          allocatedAt,
        );
      });
      const row = db
        .prepare("SELECT * FROM repository_principals WHERE instance_id = ?")
        .get(input.instanceId) as Record<string, unknown>;
      const principal = toRepositoryPrincipalRecord(row);
      this.boundaries.storage("sqlite.repository-principal.commit", () => db.exec("COMMIT"));
      return { ok: true, principal };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the allocation/persistence failure; retry remains fail-closed.
      }
      throw error;
    }
  }

  releaseRepositoryPrincipal(input: ReleaseRepositoryPrincipalInput): RepositoryPrincipalRecord {
    const db = this.handle();
    const releasedAt = input.releasedAt ?? Date.now();
    assertPrincipalTimestamp(releasedAt, "release timestamp");
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT * FROM repository_principals WHERE instance_id = ?").get(input.instanceId) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new Error("repository principal does not exist");
      const current = toRepositoryPrincipalRecord(row);
      if (current.lifecycleState !== "active") {
        db.exec("COMMIT");
        return current;
      }
      this.boundaries.storage("sqlite.repository-principal.write", () =>
        db
          .prepare(
            "UPDATE repository_principals SET lifecycle_state = 'quarantined', released_at = ?, cleanup_proven_at = NULL WHERE instance_id = ? AND lifecycle_state = 'active'",
          )
          .run(releasedAt, input.instanceId),
      );
      const updated = toRepositoryPrincipalRecord(
        db.prepare("SELECT * FROM repository_principals WHERE instance_id = ?").get(input.instanceId) as Record<
          string,
          unknown
        >,
      );
      this.boundaries.storage("sqlite.repository-principal.commit", () => db.exec("COMMIT"));
      return updated;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
    }
  }

  proveRepositoryPrincipalCleanup(input: ProveRepositoryPrincipalCleanupInput): RepositoryPrincipalRecord {
    const db = this.handle();
    const provenAt = input.provenAt ?? Date.now();
    assertPrincipalTimestamp(provenAt, "cleanup proof timestamp");
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT * FROM repository_principals WHERE instance_id = ?").get(input.instanceId) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new Error("repository principal does not exist");
      const current = toRepositoryPrincipalRecord(row);
      if (current.lifecycleState === "active")
        throw new Error("cannot prove cleanup for an active repository principal");
      if (current.lifecycleState === "available") {
        db.exec("COMMIT");
        return current;
      }
      this.boundaries.storage("sqlite.repository-principal.write", () =>
        db
          .prepare(
            "UPDATE repository_principals SET lifecycle_state = 'available', cleanup_proven_at = ? WHERE instance_id = ? AND lifecycle_state = 'quarantined'",
          )
          .run(provenAt, input.instanceId),
      );
      const updated = toRepositoryPrincipalRecord(
        db.prepare("SELECT * FROM repository_principals WHERE instance_id = ?").get(input.instanceId) as Record<
          string,
          unknown
        >,
      );
      this.boundaries.storage("sqlite.repository-principal.commit", () => db.exec("COMMIT"));
      return updated;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
    }
  }

  getRepositoryPrincipal(instanceId: RepositoryInstanceId): RepositoryPrincipalRecord | undefined {
    const db = this.handle();
    assertNoRepositoryPrincipalAmbiguity(db);
    const row = db.prepare("SELECT * FROM repository_principals WHERE instance_id = ?").get(instanceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toRepositoryPrincipalRecord(row);
  }

  listRepositoryPrincipals(options: ListRepositoryPrincipalsOptions = {}): RepositoryPrincipalRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("principal status limit must be between 1 and 100");
    const states = options.lifecycleStates;
    if (
      states !== undefined &&
      states.some((state) => !["active", "quarantined", "available", "retired"].includes(state))
    )
      throw new Error("repository principal lifecycle filter is invalid");
    const params: (string | number)[] = [];
    let query = "SELECT * FROM repository_principals";
    if (states !== undefined && states.length > 0) {
      query += ` WHERE lifecycle_state IN (${states.map(() => "?").join(", ")})`;
      params.push(...states);
    }
    query += " ORDER BY uid ASC, gid ASC, instance_id ASC LIMIT ?";
    params.push(limit);
    assertNoRepositoryPrincipalAmbiguity(this.handle());
    const rows = this.handle()
      .prepare(query)
      .all(...params) as Record<string, unknown>[];
    return rows.map(toRepositoryPrincipalRecord);
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

  updateTaskLifecycleStateIfCurrent(
    input: UpdateTaskLifecycleStateExpectedInput,
  ): UpdateTaskLifecycleStateExpectedResult {
    const db = this.handle();
    const now = input.updatedAt ?? Date.now();
    // activateWorktree/attachNawabariSession と同じ単一 UPDATE...WHERE の CAS idiom。
    // lifecycle_state/task_version を両方 WHERE に含めることで、同じ prior state を
    // 観測した 2 並行 caller のうち後勝ちの上書きを防ぐ（changes === 0 で敗者を検出）。
    const result = db
      .prepare(
        "UPDATE tasks SET lifecycle_state = ?, task_version = task_version + 1, updated_at = ? WHERE task_id = ? AND task_version = ? AND lifecycle_state = ?",
      )
      .run(input.next, now, input.taskId, input.expectedVersion, input.expectedLifecycle);
    if (result.changes === 0) {
      const current = this.getTask(input.taskId);
      if (current === undefined) throw new Error(`task not found: ${input.taskId}`);
      return { ok: false, reason: "lifecycle-conflict", current };
    }
    return { ok: true, task: this.getTask(input.taskId)! };
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

  registerManagerRuntime(input: RegisterManagerRuntimeInput): ManagerRuntimeRecord {
    const db = this.handle();
    const now = input.registeredAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = db.prepare("SELECT * FROM manager_runtimes WHERE runtime_id = ?").get(input.runtimeId) as
        | Record<string, unknown>
        | undefined;
      if (existingRow !== undefined) {
        const existing = toManagerRuntimeRecord(existingRow);
        if (existing.targetKind !== input.targetKind) {
          throw new Error(`manager Runtime identity collision: ${input.runtimeId} has a different target kind`);
        }
        if (existing.address !== input.address) {
          const conflicting = db
            .prepare("SELECT runtime_id FROM manager_runtimes WHERE address = ? AND runtime_id != ?")
            .get(input.address, input.runtimeId) as { runtime_id: string } | undefined;
          if (conflicting !== undefined)
            throw new Error(
              `manager Runtime identity collision: ${input.targetKind}/${input.address} is already ${conflicting.runtime_id}`,
            );
        }
        db.prepare(
          `UPDATE manager_runtimes
           SET display_name = ?, address = ?, config_provenance = ?, state = ?, updated_at = ?
           WHERE runtime_id = ?`,
        ).run(
          input.displayName,
          input.address,
          input.configProvenance ?? existing.configProvenance ?? null,
          input.state ?? existing.state,
          now,
          input.runtimeId,
        );
      } else {
        const conflicting = db
          .prepare("SELECT runtime_id FROM manager_runtimes WHERE address = ?")
          .get(input.address) as { runtime_id: string } | undefined;
        if (conflicting !== undefined) {
          throw new Error(
            `manager Runtime identity collision: ${input.targetKind}/${input.address} is already ${conflicting.runtime_id}`,
          );
        }
        db.prepare(
          `INSERT INTO manager_runtimes
           (runtime_id, target_kind, display_name, address, config_provenance, state, created_at, updated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          input.runtimeId,
          input.targetKind,
          input.displayName,
          input.address,
          input.configProvenance ?? null,
          input.state ?? "configured",
          now,
          now,
        );
      }
      const row = db.prepare("SELECT * FROM manager_runtimes WHERE runtime_id = ?").get(input.runtimeId) as Record<
        string,
        unknown
      >;
      db.exec("COMMIT");
      return toManagerRuntimeRecord(row);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the identity/collision error.
      }
      throw error;
    }
  }

  getManagerRuntime(runtimeId: ManagerRuntimeId): ManagerRuntimeRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM manager_runtimes WHERE runtime_id = ?").get(runtimeId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toManagerRuntimeRecord(row);
  }

  listManagerRuntimes(): ManagerRuntimeRecord[] {
    const rows = this.handle()
      .prepare("SELECT * FROM manager_runtimes ORDER BY created_at ASC, runtime_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toManagerRuntimeRecord);
  }

  updateManagerRuntime(runtimeId: ManagerRuntimeId, input: UpdateManagerRuntimeInput): ManagerRuntimeRecord {
    const db = this.handle();
    const current = this.getManagerRuntime(runtimeId);
    if (current === undefined) throw new Error(`manager Runtime not found: ${runtimeId}`);
    const address = input.address ?? current.address;
    if (address !== current.address) {
      const conflict = db
        .prepare("SELECT runtime_id FROM manager_runtimes WHERE address = ? AND runtime_id != ?")
        .get(address, runtimeId) as { runtime_id: string } | undefined;
      if (conflict !== undefined)
        throw new Error(
          `manager Runtime identity collision: ${current.targetKind}/${address} is already ${conflict.runtime_id}`,
        );
    }
    const updatedAt = input.updatedAt ?? Date.now();
    db.prepare(
      `UPDATE manager_runtimes
       SET display_name = ?, address = ?, config_provenance = ?, state = ?, last_seen_at = ?, updated_at = ?
       WHERE runtime_id = ?`,
    ).run(
      input.displayName ?? current.displayName,
      address,
      input.configProvenance === undefined ? (current.configProvenance ?? null) : input.configProvenance,
      input.state ?? current.state,
      input.lastSeenAt === undefined ? (current.lastSeenAt ?? null) : input.lastSeenAt,
      updatedAt,
      runtimeId,
    );
    return this.getManagerRuntime(runtimeId)!;
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
          (session_id, runtime_id, workspace_root, idempotency_key, task_id, execution_session_id, execution_mode, worktree_id, worktree_path, branch_name,
           task_slug, issue_ref, branch_type, agent_kind, launch_profile, instruction, provider, model,
           launch_command, launch_args_json, runtime_name, lifecycle_state, runtime_state,
           semantic_lifecycle_state, attachable, reconciliation_state, reconciliation_message,
           latest_status, latest_receipt_json, started_at, updated_at, finished_at,
           runtime_observed_at, restart_count, termination_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35)`,
      )
      .run(
        input.sessionId,
        input.runtimeId ?? ("local" as ManagerRuntimeId),
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
      const nextInstruction = input.instruction ?? current.instruction;
      const nextLaunchCommand = input.launchCommand ?? current.launchCommand;
      const nextLaunchArgs = input.launchArgs === undefined ? current.launchArgs : [...input.launchArgs];
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
         SET instruction = ?, launch_command = ?, launch_args_json = ?,
             lifecycle_state = ?, runtime_state = ?, semantic_lifecycle_state = ?, attachable = ?,
             reconciliation_state = ?, reconciliation_message = ?, latest_status = ?, latest_receipt_json = ?,
             updated_at = ?, finished_at = ?, runtime_observed_at = ?, restart_count = ?,
             exit_code = ?, termination_state = ?, error_message = ?
         WHERE session_id = ?`,
      ).run(
        nextInstruction,
        nextLaunchCommand,
        JSON.stringify(nextLaunchArgs),
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

  checkpointManagerSessionRuntimeObservedAt(sessionId: ManagerSessionId, observedAt: number): ManagerSessionRecord {
    const result = this.handle()
      .prepare(
        `UPDATE manager_sessions
         SET runtime_observed_at = CASE
           WHEN runtime_observed_at IS NULL OR runtime_observed_at < ? THEN ?
           ELSE runtime_observed_at
         END
         WHERE session_id = ?`,
      )
      .run(observedAt, observedAt, sessionId);
    if (result.changes === 0) throw new Error(`manager session not found: ${sessionId}`);
    return this.getManagerSession(sessionId)!;
  }

  recordWorkerSupervision(input: RecordWorkerSupervisionInput): WorkerSupervisionRecord {
    const observation = WorkerRuntimeObservationSchema.parse(input.observation);
    const managerSessionId = observation.binding.identity.managerSessionId;
    const diagnosticEvent =
      input.diagnosticEvent === undefined
        ? undefined
        : projectWorkerDiagnosticEvent(WorkerRuntimeObservationEventSchema.parse(input.diagnosticEvent));
    if (input.diagnosticEvent !== undefined) {
      const parsedEvent = WorkerRuntimeObservationEventSchema.parse(input.diagnosticEvent);
      assertWorkerBindingIdentity(observation.binding, parsedEvent.binding);
    }
    const recordedAt = workerRecordedAt(input.recordedAt);
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = db
        .prepare("SELECT * FROM worker_supervision_records WHERE manager_session_id = ?")
        .get(managerSessionId) as Record<string, unknown> | undefined;
      let record: WorkerSupervisionRecord;
      if (existingRow === undefined) {
        const diagnosticEvents = mergeWorkerDiagnosticEvents([], diagnosticEvent);
        db.prepare(
          `INSERT INTO worker_supervision_records
             (manager_session_id, schema_version, binding_json, latest_lifecycle_state,
              latest_status_json, latest_observation_json, diagnostic_events_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          managerSessionId,
          WORKER_SUPERVISION_SCHEMA_VERSION,
          JSON.stringify(observation.binding),
          observation.status.lifecycleState,
          JSON.stringify(observation.status),
          JSON.stringify(observation),
          JSON.stringify(diagnosticEvents),
          recordedAt,
          recordedAt,
        );
        record = toWorkerSupervisionRecord(
          db
            .prepare("SELECT * FROM worker_supervision_records WHERE manager_session_id = ?")
            .get(managerSessionId) as Record<string, unknown>,
        );
      } else {
        const current = toWorkerSupervisionRecord(existingRow);
        assertWorkerBindingIdentity(current.binding, observation.binding);
        const shouldReplaceLatest =
          workerTimestampMs(observation.observedAt, "observation observedAt") >=
          workerTimestampMs(current.latestObservation.observedAt, "observation observedAt");
        const nextBinding = shouldReplaceLatest ? observation.binding : current.binding;
        const nextStatus = shouldReplaceLatest ? observation.status : current.latestStatus;
        const nextObservation = shouldReplaceLatest ? observation : current.latestObservation;
        const nextEvents = mergeWorkerDiagnosticEvents(current.diagnosticEvents, diagnosticEvent);
        const updatedAt = Math.max(current.updatedAt, recordedAt);
        db.prepare(
          `UPDATE worker_supervision_records
             SET binding_json = ?, latest_lifecycle_state = ?, latest_status_json = ?,
                 latest_observation_json = ?, diagnostic_events_json = ?, updated_at = ?
           WHERE manager_session_id = ?`,
        ).run(
          JSON.stringify(nextBinding),
          nextStatus.lifecycleState,
          JSON.stringify(nextStatus),
          JSON.stringify(nextObservation),
          JSON.stringify(nextEvents),
          updatedAt,
          managerSessionId,
        );
        record = toWorkerSupervisionRecord(
          db
            .prepare("SELECT * FROM worker_supervision_records WHERE manager_session_id = ?")
            .get(managerSessionId) as Record<string, unknown>,
        );
      }
      db.exec("COMMIT");
      return record;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original persistence/validation error.
      }
      throw error;
    }
  }

  getWorkerSupervision(managerSessionId: ManagerSessionId): WorkerSupervisionRecord | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM worker_supervision_records WHERE manager_session_id = ?")
      .get(managerSessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toWorkerSupervisionRecord(row);
  }

  listWorkerSupervision(options: ListWorkerSupervisionOptions = {}): WorkerSupervisionRecord[] {
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined || !Number.isFinite(requestedLimit)
        ? 500
        : Math.min(Math.max(Math.trunc(requestedLimit), 1), 500);
    const rows = this.handle()
      .prepare("SELECT * FROM worker_supervision_records ORDER BY updated_at DESC, manager_session_id ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toWorkerSupervisionRecord);
  }

  recordWorkerControlAudit(input: RecordWorkerControlAuditInput): WorkerControlAuditRecord {
    const binding = WorkerRuntimeBindingSchema.parse(input.binding);
    if (!WORKER_RUNTIME_CONTROL_OPERATIONS.includes(input.operation))
      throw new Error(`worker control operation is invalid: ${input.operation}`);
    const recordedAt = workerRecordedAt(input.recordedAt);
    const requestedAt = input.requestedAt ?? new Date(recordedAt).toISOString();
    workerTimestampMs(requestedAt, "control requestedAt");
    const acceptedAt =
      input.acceptedAt === undefined
        ? undefined
        : WorkerRuntimeControlReceiptSchema.parse({ operation: input.operation, acceptedAt: input.acceptedAt })
            .acceptedAt;
    const auditId = crypto.randomUUID();
    this.handle()
      .prepare(
        `INSERT INTO worker_control_audit
          (audit_id, manager_session_id, binding_json, operation, requested_at, accepted_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        binding.identity.managerSessionId,
        JSON.stringify(binding),
        input.operation,
        requestedAt,
        acceptedAt ?? null,
        recordedAt,
      );
    return toWorkerControlAuditRecord(
      this.handle().prepare("SELECT * FROM worker_control_audit WHERE audit_id = ?").get(auditId) as Record<
        string,
        unknown
      >,
    );
  }

  listWorkerControlAudit(
    managerSessionId: ManagerSessionId,
    options: ListWorkerControlAuditOptions = {},
  ): WorkerControlAuditRecord[] {
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined || !Number.isFinite(requestedLimit)
        ? 500
        : Math.min(Math.max(Math.trunc(requestedLimit), 1), 500);
    const rows = this.handle()
      .prepare(
        `SELECT * FROM worker_control_audit
         WHERE manager_session_id = ? ORDER BY recorded_at ASC, audit_id ASC LIMIT ?`,
      )
      .all(managerSessionId, limit) as Record<string, unknown>[];
    return rows.map(toWorkerControlAuditRecord);
  }

  recordCanonCheckpoint(input: RecordCanonCheckpointInput): CanonCheckpointRecord {
    const checkpointId = canonCheckpointField(
      input.checkpointId ?? crypto.randomUUID(),
      "checkpointId",
    ) as CanonCheckpointId;
    const canonContractId = canonCheckpointField(
      input.canonContractId ?? "mottainai.execution-canon.v1",
      "canonContractId",
    )!;
    if (!Number.isSafeInteger(input.canonSchemaVersion) || input.canonSchemaVersion <= 0)
      throw new Error("Canon checkpoint canonSchemaVersion must be a positive integer");
    if (!CANON_PREFIX_ID_PATTERN.test(input.prefix_id)) throw new Error("Canon checkpoint prefix_id is invalid");
    const parentCheckpointId =
      input.parentCheckpointId === undefined
        ? undefined
        : (canonCheckpointField(input.parentCheckpointId, "parentCheckpointId") as CanonCheckpointId);
    if (input.lineageKind === "independent-root" && parentCheckpointId !== undefined)
      throw new Error("independent-root Canon checkpoint must not have a parent");
    if (input.lineageKind === "fork" && parentCheckpointId === undefined)
      throw new Error("fork Canon checkpoint requires a parent");
    const freshness = canonicalCanonCheckpointFreshness(input.freshness);
    const freshnessJson = canonCheckpointFreshnessJson(freshness);
    if (input.execution_state_id !== undefined && !CANON_EXECUTION_STATE_ID_PATTERN.test(input.execution_state_id))
      throw new Error("Canon checkpoint execution_state_id is invalid");
    if (
      input.attachmentGeneration !== undefined &&
      (!Number.isSafeInteger(input.attachmentGeneration) || input.attachmentGeneration <= 0)
    )
      throw new Error("Canon checkpoint attachmentGeneration must be a positive integer");
    const agentId = canonCheckpointField(input.agentId, "agentId", true);
    const modelId = canonCheckpointField(input.modelId, "modelId", true);
    const profile = canonCheckpointField(input.profile, "profile", true);
    const recordedAt = input.recordedAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = db.prepare("SELECT * FROM canon_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as
        | Record<string, unknown>
        | undefined;
      if (existingRow !== undefined) {
        const existing = toCanonCheckpointRecord(existingRow);
        const sameIdentity =
          existing.canonContractId === canonContractId &&
          existing.canonSchemaVersion === input.canonSchemaVersion &&
          existing.prefix_id === input.prefix_id &&
          existing.parentCheckpointId === parentCheckpointId &&
          existing.lineageKind === input.lineageKind &&
          JSON.stringify(existing.freshness) === freshnessJson &&
          existing.execution_state_id === input.execution_state_id &&
          existing.attachmentGeneration === input.attachmentGeneration &&
          existing.agentId === agentId &&
          existing.modelId === modelId &&
          existing.profile === profile;
        if (!sameIdentity) throw new Error(`Canon checkpoint already exists with different identity: ${checkpointId}`);
        db.exec("COMMIT");
        return existing;
      }

      if (parentCheckpointId !== undefined) {
        const parentRow = db
          .prepare("SELECT * FROM canon_checkpoints WHERE checkpoint_id = ?")
          .get(parentCheckpointId) as Record<string, unknown> | undefined;
        if (parentRow === undefined) throw new Error(`Canon checkpoint parent not found: ${parentCheckpointId}`);
        const parent = toCanonCheckpointRecord(parentRow);
        if (parent.state !== "current") throw new Error(`Canon checkpoint parent is stale: ${parentCheckpointId}`);
        if (JSON.stringify(parent.freshness) !== freshnessJson) {
          db.prepare(
            `WITH RECURSIVE descendants(checkpoint_id) AS (
               SELECT ?
               UNION ALL
               SELECT child.checkpoint_id FROM canon_checkpoints child JOIN descendants parent
                 ON child.parent_checkpoint_id = parent.checkpoint_id
             )
             UPDATE canon_checkpoints SET state = 'stale', updated_at = ?
             WHERE checkpoint_id IN (SELECT checkpoint_id FROM descendants)`,
          ).run(parentCheckpointId, recordedAt);
          db.exec("COMMIT");
          throw new Error(`Canon checkpoint parent freshness is stale: ${parentCheckpointId}`);
        }
      }

      db.prepare(
        `INSERT INTO canon_checkpoints
          (checkpoint_id, canon_contract_id, canon_schema_version, prefix_id, parent_checkpoint_id, lineage_kind,
           freshness_json, execution_state_id, attachment_generation, agent_id, model_id, profile, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
      ).run(
        checkpointId,
        canonContractId,
        input.canonSchemaVersion,
        input.prefix_id,
        parentCheckpointId ?? null,
        input.lineageKind,
        freshnessJson,
        input.execution_state_id ?? null,
        input.attachmentGeneration ?? null,
        agentId ?? null,
        modelId ?? null,
        profile ?? null,
        recordedAt,
        recordedAt,
      );
      const row = db.prepare("SELECT * FROM canon_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as Record<
        string,
        unknown
      >;
      const result = toCanonCheckpointRecord(row);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the bounded checkpoint error.
      }
      throw error;
    }
  }

  getCanonCheckpoint(checkpointId: CanonCheckpointId): CanonCheckpointRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM canon_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toCanonCheckpointRecord(row);
  }

  listCanonCheckpoints(options: ListCanonCheckpointsOptions = {}): CanonCheckpointRecord[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.prefix_id !== undefined) {
      clauses.push("prefix_id = ?");
      parameters.push(options.prefix_id);
    }
    if (options.parentCheckpointId !== undefined) {
      clauses.push("parent_checkpoint_id = ?");
      parameters.push(options.parentCheckpointId);
    }
    if (options.lineageKind !== undefined) {
      clauses.push("lineage_kind = ?");
      parameters.push(options.lineageKind);
    }
    if (options.state !== undefined) {
      clauses.push("state = ?");
      parameters.push(options.state);
    }
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined || !Number.isFinite(requestedLimit)
        ? 500
        : Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000);
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM canon_checkpoints${where} ORDER BY created_at ASC, checkpoint_id ASC LIMIT ?`)
      .all(...parameters, limit) as Record<string, unknown>[];
    return rows.map(toCanonCheckpointRecord);
  }

  listCanonCheckpointAncestry(checkpointId: CanonCheckpointId): CanonCheckpointRecord[] {
    const ancestry: CanonCheckpointRecord[] = [];
    const seen = new Set<string>();
    let currentId: CanonCheckpointId | undefined = checkpointId;
    while (currentId !== undefined) {
      if (seen.has(currentId)) throw new Error(`Canon checkpoint ancestry contains a cycle: ${currentId}`);
      seen.add(currentId);
      if (seen.size > 256) throw new Error("Canon checkpoint ancestry exceeds its bound");
      const current = this.getCanonCheckpoint(currentId);
      if (current === undefined) throw new Error(`Canon checkpoint parent not found: ${currentId}`);
      ancestry.push(current);
      currentId = current.parentCheckpointId;
    }
    return ancestry.reverse();
  }

  reconcileCanonCheckpoint(input: ReconcileCanonCheckpointInput): CanonCheckpointRecord {
    const current = this.getCanonCheckpoint(input.checkpointId);
    if (current === undefined) throw new Error(`Canon checkpoint not found: ${input.checkpointId}`);
    const freshnessJson = canonCheckpointFreshnessJson(input.freshness);
    const ancestry = this.listCanonCheckpointAncestry(input.checkpointId);
    const parentStale = ancestry.slice(0, -1).some((record) => record.state === "stale");
    const nextState: CanonCheckpointState =
      current.state === "stale" || parentStale || JSON.stringify(current.freshness) !== freshnessJson
        ? "stale"
        : "current";
    const reconciledAt = input.reconciledAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (nextState === "stale") {
        db.prepare(
          `WITH RECURSIVE descendants(checkpoint_id) AS (
             SELECT ?
             UNION ALL
             SELECT child.checkpoint_id FROM canon_checkpoints child JOIN descendants parent
               ON child.parent_checkpoint_id = parent.checkpoint_id
           )
           UPDATE canon_checkpoints SET state = 'stale', updated_at = ?
           WHERE checkpoint_id IN (SELECT checkpoint_id FROM descendants)`,
        ).run(input.checkpointId, reconciledAt);
      } else {
        db.prepare("UPDATE canon_checkpoints SET state = 'current', updated_at = ? WHERE checkpoint_id = ?").run(
          reconciledAt,
          input.checkpointId,
        );
      }
      const row = db
        .prepare("SELECT * FROM canon_checkpoints WHERE checkpoint_id = ?")
        .get(input.checkpointId) as Record<string, unknown>;
      const result = toCanonCheckpointRecord(row);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the bounded checkpoint error.
      }
      throw error;
    }
  }

  planCanonForkLaunch(input: PlanCanonForkLaunchInput): CanonForkLaunchRecord {
    const forkId = canonCheckpointField(input.forkId, "forkId")!;
    const workspaceRoot = canonCheckpointField(input.workspaceRoot, "workspaceRoot")!;
    const parentCheckpointId = canonCheckpointField(
      input.parentCheckpointId,
      "parentCheckpointId",
    ) as CanonCheckpointId;
    const childCheckpointId = canonCheckpointField(input.childCheckpointId, "childCheckpointId") as CanonCheckpointId;
    const plannedManagerSessionId = canonCheckpointField(
      input.plannedManagerSessionId,
      "plannedManagerSessionId",
    ) as ManagerSessionId;
    const prefix_id = canonCheckpointField(input.prefix_id, "prefix_id")!;
    if (!CANON_PREFIX_ID_PATTERN.test(prefix_id)) throw new Error("Canon fork prefix_id is invalid");
    const freshness = canonicalCanonCheckpointFreshness(input.freshness);
    const freshnessJson = canonCheckpointFreshnessJson(freshness);
    const branchName = canonCheckpointField(input.branchName, "branchName")!;
    const base = canonCheckpointField(input.base, "base")!;
    const runtimeName = canonCheckpointField(input.runtimeName, "runtimeName")!;
    const instruction = canonCheckpointField(input.instruction, "instruction")!;
    const agentId = canonCheckpointField(input.agentId, "agentId")!;
    const modelId = canonCheckpointField(input.modelId, "modelId", true);
    const profile = canonCheckpointField(input.profile, "profile")!;
    const launchCommand = canonCheckpointField(input.launchCommand, "launchCommand")!;
    const launchArgs = input.launchArgs.map((value, index) => canonCheckpointField(value, `launchArgs[${index}]`)!);
    const idempotencyKey = canonCheckpointField(input.idempotencyKey, "idempotencyKey", true);
    const parent = this.getCanonCheckpoint(parentCheckpointId);
    if (parent === undefined) throw new Error(`Canon fork parent checkpoint not found: ${parentCheckpointId}`);
    if (parent.state !== "current") throw new Error(`Canon fork parent checkpoint is stale: ${parentCheckpointId}`);
    if (parent.prefix_id !== prefix_id) throw new Error(`Canon fork parent prefix_id mismatch: ${parentCheckpointId}`);
    const plannedAt = input.plannedAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow =
        idempotencyKey === undefined
          ? (db.prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(forkId) as
              | Record<string, unknown>
              | undefined)
          : (db
              .prepare("SELECT * FROM canon_fork_launches WHERE workspace_root = ? AND idempotency_key = ?")
              .get(workspaceRoot, idempotencyKey) as Record<string, unknown> | undefined);
      if (existingRow !== undefined) {
        const existing = toCanonForkLaunchRecord(existingRow);
        const sameIdentity =
          existing.forkId === forkId &&
          existing.parentCheckpointId === parentCheckpointId &&
          existing.childCheckpointId === childCheckpointId &&
          existing.plannedManagerSessionId === plannedManagerSessionId &&
          existing.prefix_id === prefix_id &&
          JSON.stringify(existing.freshness) === freshnessJson &&
          existing.branchName === branchName &&
          existing.base === base &&
          existing.runtimeName === runtimeName &&
          existing.instruction === instruction &&
          existing.agentId === agentId &&
          existing.modelId === modelId &&
          existing.profile === profile &&
          existing.launchCommand === launchCommand &&
          JSON.stringify(existing.launchArgs) === JSON.stringify(launchArgs);
        if (!sameIdentity) throw new Error(`Canon fork launch already exists with different identity: ${forkId}`);
        db.exec("COMMIT");
        return existing;
      }
      db.prepare(
        `INSERT INTO canon_fork_launches
          (fork_id, workspace_root, idempotency_key, parent_checkpoint_id, child_checkpoint_id, planned_manager_session_id, prefix_id,
           branch_name, base, runtime_name, instruction, agent_id, model_id, profile, launch_command,
           freshness_json,
           launch_args_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      ).run(
        forkId,
        workspaceRoot,
        idempotencyKey ?? null,
        parentCheckpointId,
        childCheckpointId,
        plannedManagerSessionId,
        prefix_id,
        branchName,
        base,
        runtimeName,
        instruction,
        agentId,
        modelId ?? null,
        profile,
        launchCommand,
        freshnessJson,
        JSON.stringify(launchArgs),
        plannedAt,
        plannedAt,
      );
      const result = toCanonForkLaunchRecord(
        db.prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(forkId) as Record<string, unknown>,
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
    }
  }

  getCanonForkLaunch(forkId: string): CanonForkLaunchRecord | undefined {
    const id = canonCheckpointField(forkId, "forkId")!;
    const row = this.handle().prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toCanonForkLaunchRecord(row);
  }

  listCanonForkLaunches(options: ListCanonForkLaunchesOptions = {}): CanonForkLaunchRecord[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.workspaceRoot !== undefined) {
      clauses.push("workspace_root = ?");
      parameters.push(canonCheckpointField(options.workspaceRoot, "workspaceRoot")!);
    }
    if (options.state !== undefined) {
      if (!CANON_FORK_LAUNCH_STATES.has(options.state)) throw new Error("Canon fork launch state is invalid");
      clauses.push("state = ?");
      parameters.push(options.state);
    }
    if (options.parentCheckpointId !== undefined) {
      clauses.push("parent_checkpoint_id = ?");
      parameters.push(options.parentCheckpointId);
    }
    if (options.idempotencyKey !== undefined) {
      clauses.push("idempotency_key = ?");
      parameters.push(options.idempotencyKey);
    }
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined || !Number.isFinite(requestedLimit)
        ? 500
        : Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000);
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM canon_fork_launches${where} ORDER BY created_at ASC, fork_id ASC LIMIT ?`)
      .all(...parameters, limit) as Record<string, unknown>[];
    return rows.map(toCanonForkLaunchRecord);
  }

  attachCanonForkLaunch(input: AttachCanonForkLaunchInput): CanonForkLaunchRecord {
    const forkId = canonCheckpointField(input.forkId, "forkId")!;
    const nawabariSessionId = canonCheckpointField(input.nawabariSessionId, "nawabariSessionId")!;
    const worktreePath = canonCheckpointField(input.worktreePath, "worktreePath")!;
    const execution_state_id = canonCheckpointField(input.execution_state_id, "execution_state_id")!;
    if (!CANON_EXECUTION_STATE_ID_PATTERN.test(execution_state_id))
      throw new Error("Canon fork execution_state_id is invalid");
    if (!Number.isSafeInteger(input.attachmentGeneration) || input.attachmentGeneration <= 0)
      throw new Error("Canon fork attachmentGeneration must be a positive integer");
    const attachedAt = input.attachedAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCanonForkLaunch(forkId);
      if (current === undefined) throw new Error(`Canon fork launch not found: ${forkId}`);
      if (current.state === "failed") throw new Error(`Canon fork launch is failed: ${forkId}`);
      if (current.state === "launched") {
        if (
          current.nawabariSessionId !== nawabariSessionId ||
          current.worktreePath !== worktreePath ||
          current.execution_state_id !== execution_state_id
        )
          throw new Error(`Canon fork launch attachment mismatch: ${forkId}`);
        db.exec("COMMIT");
        return current;
      }
      const child = this.getCanonCheckpoint(current.childCheckpointId);
      if (child === undefined) throw new Error(`Canon fork child checkpoint is missing: ${current.childCheckpointId}`);
      if (child.prefix_id !== current.prefix_id || child.execution_state_id !== execution_state_id)
        throw new Error(`Canon fork child checkpoint identity mismatch: ${forkId}`);
      db.prepare(
        `UPDATE canon_fork_launches
         SET nawabari_session_id = ?, worktree_path = ?, execution_state_id = ?, attachment_generation = ?,
             state = 'attached', detail = NULL, updated_at = ?
         WHERE fork_id = ?`,
      ).run(nawabariSessionId, worktreePath, execution_state_id, input.attachmentGeneration, attachedAt, forkId);
      const result = toCanonForkLaunchRecord(
        db.prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(forkId) as Record<string, unknown>,
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
    }
  }

  launchCanonForkLaunch(
    forkId: string,
    managerSessionId: ManagerSessionId,
    launchedAt?: number,
  ): CanonForkLaunchRecord {
    const id = canonCheckpointField(forkId, "forkId")!;
    const managerId = canonCheckpointField(managerSessionId, "managerSessionId") as ManagerSessionId;
    const updatedAt = launchedAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCanonForkLaunch(id);
      if (current === undefined) throw new Error(`Canon fork launch not found: ${id}`);
      if (current.state === "failed") throw new Error(`Canon fork launch is failed: ${id}`);
      if (current.managerSessionId !== undefined && current.managerSessionId !== managerId)
        throw new Error(`Canon fork launch manager session mismatch: ${id}`);
      if (current.state === "planned") throw new Error(`Canon fork launch is not attached: ${id}`);
      db.prepare(
        `UPDATE canon_fork_launches
         SET manager_session_id = ?, state = 'launched', detail = NULL, updated_at = ?
         WHERE fork_id = ?`,
      ).run(managerId, updatedAt, id);
      const result = toCanonForkLaunchRecord(
        db.prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(id) as Record<string, unknown>,
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
    }
  }

  failCanonForkLaunch(forkId: string, detail: string, failedAt?: number): CanonForkLaunchRecord {
    const id = canonCheckpointField(forkId, "forkId")!;
    const boundedDetail = canonCheckpointField(detail, "detail")!;
    const updatedAt = failedAt ?? Date.now();
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCanonForkLaunch(id);
      if (current === undefined) throw new Error(`Canon fork launch not found: ${id}`);
      if (current.state === "launched") {
        db.exec("COMMIT");
        return current;
      }
      db.prepare("UPDATE canon_fork_launches SET state = 'failed', detail = ?, updated_at = ? WHERE fork_id = ?").run(
        boundedDetail,
        updatedAt,
        id,
      );
      const result = toCanonForkLaunchRecord(
        db.prepare("SELECT * FROM canon_fork_launches WHERE fork_id = ?").get(id) as Record<string, unknown>,
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the primary persistence failure.
      }
      throw error;
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

  private toManagedPullRequestState(row: Record<string, unknown>): ManagedPullRequestState {
    return {
      stateId: row.state_id as ManagedPullRequestStateId,
      taskId: (row.task_id as TaskId | null) ?? undefined,
      instanceId: (row.instance_id as RepositoryInstanceId | null) ?? undefined,
      provider: row.provider as string,
      repositoryId: row.repository_id as string,
      prNumber: row.pr_number as number,
      generation: {
        repository: row.generation_repository as string,
        prNumber: row.generation_pr_number as number,
        headSha: row.generation_head_sha as string,
      },
      coarseState: row.coarse_state as ManagedPullRequestState["coarseState"],
      observationSource: row.observation_source as string,
      observationContract: row.observation_contract as string,
      observationOperation: row.observation_operation as string,
      observationRef: row.observation_ref as string,
      observationDigest: (row.observation_digest as string | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private toManagedPullRequestDerivedInput(row: Record<string, unknown>): ManagedPullRequestDerivedInput {
    return {
      inputId: row.input_id as ManagedPullRequestDerivedInputId,
      stateId: row.state_id as ManagedPullRequestStateId,
      kind: row.kind as ManagedPullRequestDerivedInput["kind"],
      generation: {
        repository: row.generation_repository as string,
        prNumber: row.generation_pr_number as number,
        headSha: row.generation_head_sha as string,
      },
      state: row.state as ManagedPullRequestDerivedInput["state"],
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

  recordManagedPullRequestState(input: RecordManagedPullRequestStateInput): ManagedPullRequestState {
    if (input.provider.trim().length === 0) throw new Error("managed pull-request provider must not be empty");
    if (input.repositoryId.trim().length === 0)
      throw new Error("managed pull-request repository identity must not be empty");
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0)
      throw new Error("managed pull-request number must be a positive integer");
    if (input.generation.repository !== input.repositoryId || input.generation.prNumber !== input.prNumber)
      throw new Error("managed pull-request generation identity does not match the PR identity");
    if (input.generation.headSha.trim().length === 0 || input.generation.headSha !== input.generation.headSha.trim())
      throw new Error("managed pull-request generation head must not be empty");
    for (const [field, value] of [
      ["observationSource", input.observationSource],
      ["observationContract", input.observationContract],
      ["observationOperation", input.observationOperation],
      ["observationRef", input.observationRef],
      ["observationDigest", input.observationDigest],
    ] as const) {
      if (value !== undefined && (value.trim().length === 0 || value.length > MAX_MANAGED_PR_FIELD_LENGTH))
        throw new Error(`managed pull-request ${field} is invalid or exceeds its bound`);
    }

    const db = this.handle();
    const now = input.recordedAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const task =
        input.taskId === undefined
          ? undefined
          : (db.prepare("SELECT instance_id FROM tasks WHERE task_id = ?").get(input.taskId) as
              | { instance_id: RepositoryInstanceId }
              | undefined);
      if (input.taskId !== undefined && task === undefined) throw new Error(`task not found: ${input.taskId}`);
      if (task !== undefined && input.instanceId !== undefined && input.instanceId !== task.instance_id)
        throw new Error(`managed pull-request task repository mismatch: ${input.taskId}`);
      const instanceId = input.instanceId ?? task?.instance_id;
      const existing = db
        .prepare("SELECT * FROM managed_pr_states WHERE provider = ? AND repository_id = ? AND pr_number = ?")
        .get(input.provider, input.repositoryId, input.prNumber) as Record<string, unknown> | undefined;

      if (existing !== undefined) {
        const current = this.toManagedPullRequestState(existing);
        if (current.taskId !== input.taskId || current.instanceId !== instanceId)
          throw new Error("managed pull-request state already exists with different task identity");
        const rollover = current.generation.headSha !== input.generation.headSha;
        if (rollover) {
          db.prepare(
            "UPDATE managed_pr_derived_inputs SET state = 'stale', updated_at = ? WHERE state_id = ? AND generation_head_sha <> ?",
          ).run(now, current.stateId, input.generation.headSha);
        }
        db.prepare(
          `UPDATE managed_pr_states SET
             generation_repository = ?, generation_pr_number = ?, generation_head_sha = ?, coarse_state = ?,
             observation_source = ?, observation_contract = ?, observation_operation = ?, observation_ref = ?,
             observation_digest = ?, updated_at = ? WHERE state_id = ?`,
        ).run(
          input.generation.repository,
          input.generation.prNumber,
          input.generation.headSha,
          input.coarseState,
          input.observationSource,
          input.observationContract,
          input.observationOperation,
          input.observationRef,
          input.observationDigest ?? null,
          now,
          current.stateId,
        );
        const row = db.prepare("SELECT * FROM managed_pr_states WHERE state_id = ?").get(current.stateId) as Record<
          string,
          unknown
        >;
        db.exec("COMMIT");
        return this.toManagedPullRequestState(row);
      }

      const stateId = crypto.randomUUID() as ManagedPullRequestStateId;
      db.prepare(
        `INSERT INTO managed_pr_states
          (state_id, task_id, instance_id, provider, repository_id, pr_number,
           generation_repository, generation_pr_number, generation_head_sha, coarse_state,
           observation_source, observation_contract, observation_operation, observation_ref, observation_digest,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stateId,
        input.taskId ?? null,
        instanceId ?? null,
        input.provider,
        input.repositoryId,
        input.prNumber,
        input.generation.repository,
        input.generation.prNumber,
        input.generation.headSha,
        input.coarseState,
        input.observationSource,
        input.observationContract,
        input.observationOperation,
        input.observationRef,
        input.observationDigest ?? null,
        now,
        now,
      );
      const row = db.prepare("SELECT * FROM managed_pr_states WHERE state_id = ?").get(stateId) as Record<
        string,
        unknown
      >;
      db.exec("COMMIT");
      return this.toManagedPullRequestState(row);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の state 書き込みエラーを保持する
      }
      throw error;
    }
  }

  getManagedPullRequestState(
    provider: string,
    repositoryId: string,
    prNumber: number,
  ): ManagedPullRequestState | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM managed_pr_states WHERE provider = ? AND repository_id = ? AND pr_number = ?")
      .get(provider, repositoryId, prNumber) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.toManagedPullRequestState(row);
  }

  getManagedPullRequestStateForTask(taskId: TaskId): ManagedPullRequestState | undefined {
    const row = this.handle()
      .prepare("SELECT * FROM managed_pr_states WHERE task_id = ? ORDER BY updated_at DESC, state_id DESC LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.toManagedPullRequestState(row);
  }

  listManagedPullRequestStates(instanceId?: RepositoryInstanceId): ManagedPullRequestState[] {
    const rows = (
      instanceId === undefined
        ? this.handle().prepare("SELECT * FROM managed_pr_states ORDER BY created_at ASC, state_id ASC").all()
        : this.handle()
            .prepare("SELECT * FROM managed_pr_states WHERE instance_id = ? ORDER BY created_at ASC, state_id ASC")
            .all(instanceId)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.toManagedPullRequestState(row));
  }

  recordManagedPullRequestDerivedInput(input: RecordManagedPullRequestDerivedInput): ManagedPullRequestDerivedInput {
    const db = this.handle();
    const now = input.recordedAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const stateRow = db.prepare("SELECT * FROM managed_pr_states WHERE state_id = ?").get(input.stateId) as
        | Record<string, unknown>
        | undefined;
      if (stateRow === undefined) throw new Error(`managed pull-request state not found: ${input.stateId}`);
      const state = this.toManagedPullRequestState(stateRow);
      if (
        state.generation.repository !== input.generation.repository ||
        state.generation.prNumber !== input.generation.prNumber ||
        state.generation.headSha !== input.generation.headSha
      )
        throw new Error("managed pull-request derived input belongs to a stale generation");
      const inputId = crypto.randomUUID() as ManagedPullRequestDerivedInputId;
      db.prepare(
        `INSERT INTO managed_pr_derived_inputs
          (input_id, state_id, kind, generation_repository, generation_pr_number, generation_head_sha, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
      ).run(
        inputId,
        input.stateId,
        input.kind,
        input.generation.repository,
        input.generation.prNumber,
        input.generation.headSha,
        now,
        now,
      );
      const row = db.prepare("SELECT * FROM managed_pr_derived_inputs WHERE input_id = ?").get(inputId) as Record<
        string,
        unknown
      >;
      db.exec("COMMIT");
      return this.toManagedPullRequestDerivedInput(row);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 元の state 書き込みエラーを保持する
      }
      throw error;
    }
  }

  listManagedPullRequestDerivedInputs(stateId: ManagedPullRequestStateId): ManagedPullRequestDerivedInput[] {
    const rows = this.handle()
      .prepare("SELECT * FROM managed_pr_derived_inputs WHERE state_id = ? ORDER BY created_at ASC, input_id ASC")
      .all(stateId) as Record<string, unknown>[];
    return rows.map((row) => this.toManagedPullRequestDerivedInput(row));
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
