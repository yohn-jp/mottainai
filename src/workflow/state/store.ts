import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type { PullRequestLifecycleState } from "../providers/model.js";

/**
 * Git workflow 専用の永続 state 抽象。`src/state/store.ts` の StateStore
 * （session / read-evidence 用）とは責務が別なので拡張せず並行 interface とする。
 * 将来のリポジトリ単位 DB 分割でも workflow-domain API が変わらないことを狙う。
 */

/**
 * DB が発行する opaque な source identity。`RootCommitDigest`（Git 由来の
 * ヒント値、衝突しうる）とは別物 — source_id は初回観測時に発行され、以降は
 * root_commit_digest → source_id の lookup で再利用される。
 */
export type RepositorySourceId = string & { readonly __brand: "RepositorySourceId" };

export interface RepositorySourceRecord {
  sourceId: RepositorySourceId;
  rootCommitDigest: RootCommitDigest;
  createdAt: number;
}

export interface RepositoryInstanceRecord {
  instanceId: RepositoryInstanceId;
  sourceId: RepositorySourceId;
  gitCommonDir: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RepositoryPathRecord {
  instanceId: RepositoryInstanceId;
  canonicalPath: string;
  isCurrent: boolean;
  observedAt: number;
}

/** Version of the durable repository-principal allocation schema. */
export const REPOSITORY_PRINCIPAL_SCHEMA_VERSION = 1 as const;

/** States are intentionally monotonic until an explicit cleanup proof exists. */
export const REPOSITORY_PRINCIPAL_LIFECYCLE_STATES = ["active", "quarantined", "available"] as const;
export type RepositoryPrincipalLifecycleState = (typeof REPOSITORY_PRINCIPAL_LIFECYCLE_STATES)[number];

/**
 * Durable Unix identity assigned to one canonical repository instance.
 * `instanceId` is the only semantic key; all Unix fields are implementation
 * assignments and must not be used as repository authority.
 */
export interface RepositoryPrincipalRecord {
  allocationId: string;
  instanceId: RepositoryInstanceId;
  uid: number;
  gid: number;
  internalUsername: string;
  lifecycleState: RepositoryPrincipalLifecycleState;
  schemaVersion: typeof REPOSITORY_PRINCIPAL_SCHEMA_VERSION;
  allocatedAt: number;
  releasedAt: number | undefined;
  cleanupProvenAt: number | undefined;
}

export interface AllocateRepositoryPrincipalInput {
  instanceId: RepositoryInstanceId;
  /** Inclusive unprivileged UID/GID range. Defaults to 10000..60000. */
  minId?: number;
  maxId?: number;
  allocatedAt?: number;
}

export type AllocateRepositoryPrincipalResult =
  | { ok: true; principal: RepositoryPrincipalRecord }
  | { ok: false; reason: "invalid-range" | "no-identities-available" | "repository-not-eligible"; detail: string };

export interface ReleaseRepositoryPrincipalInput {
  instanceId: RepositoryInstanceId;
  releasedAt?: number;
}

export interface ProveRepositoryPrincipalCleanupInput {
  instanceId: RepositoryInstanceId;
  provenAt?: number;
}

export interface ListRepositoryPrincipalsOptions {
  limit?: number;
  lifecycleStates?: readonly RepositoryPrincipalLifecycleState[];
}

export interface ObserveRepositoryInstanceInput {
  rootCommitDigest: RootCommitDigest;
  instanceId: RepositoryInstanceId;
  gitCommonDir: string;
  canonicalWorktreePath: string;
  observedAt?: number;
}

export interface ObserveRepositoryInstanceResult {
  source: RepositorySourceRecord;
  instance: RepositoryInstanceRecord;
  /** この観測で instance の current path が変わった（＝移動を検出した）場合 true。 */
  moved: boolean;
  previousCurrentPath: string | undefined;
}

export type TaskId = string & { readonly __brand: "TaskId" };
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
/** Opaque reference only; Nawabari owns the referenced session record. */
export type NawabariSessionId = string & { readonly __brand: "NawabariSessionId" };
export type PullRequestRecordId = string & { readonly __brand: "PullRequestRecordId" };

export const NAWABARI_CLOSE_RECONCILIATION_STATES = ["pending", "closed", "blocked"] as const;
export type NawabariCloseReconciliationState = (typeof NAWABARI_CLOSE_RECONCILIATION_STATES)[number];

export type ManagerSessionId = string & { readonly __brand: "ManagerSessionId" };
export type ManagerExecutionMode = "task-bound" | "workspace";
/** Canonical identity of one isolated Runtime target.  This is deliberately
 * separate from Zellij's display/session name and from repository metadata. */
export type ManagerRuntimeId = string & { readonly __brand: "ManagerRuntimeId" };
export const MANAGER_RUNTIME_TARGET_KINDS = ["local", "remote", "existing"] as const;
export type ManagerRuntimeTargetKind = (typeof MANAGER_RUNTIME_TARGET_KINDS)[number];
export const MANAGER_RUNTIME_AVAILABILITY_STATES = ["configured", "available", "unavailable", "stale"] as const;
export type ManagerRuntimeAvailabilityState = (typeof MANAGER_RUNTIME_AVAILABILITY_STATES)[number];

/** Durable Manager-owned Runtime identity/configuration projection.
 * Credentials and credential-bearing configuration are intentionally absent. */
export interface ManagerRuntimeRecord {
  runtimeId: ManagerRuntimeId;
  targetKind: ManagerRuntimeTargetKind;
  displayName: string;
  address: string;
  configProvenance: string | undefined;
  state: ManagerRuntimeAvailabilityState;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | undefined;
}

export interface RegisterManagerRuntimeInput {
  runtimeId: ManagerRuntimeId;
  targetKind: ManagerRuntimeTargetKind;
  displayName: string;
  address: string;
  configProvenance?: string;
  state?: ManagerRuntimeAvailabilityState;
  registeredAt?: number;
}

export interface UpdateManagerRuntimeInput {
  displayName?: string;
  address?: string;
  configProvenance?: string | null;
  state?: ManagerRuntimeAvailabilityState;
  lastSeenAt?: number | null;
  updatedAt?: number;
}

export const MANAGER_AGENT_KINDS = ["codex", "claude", "pi"] as const;
export type ManagerAgentKind = (typeof MANAGER_AGENT_KINDS)[number];
export const MANAGER_RUNTIME_STATES = [
  "starting",
  "running",
  "detached",
  "exited",
  "failed",
  "stopped",
  "stale",
] as const;
export type ManagerRuntimeState = (typeof MANAGER_RUNTIME_STATES)[number];
export const MANAGER_RECONCILIATION_STATES = ["synced", "drifted", "unresolved"] as const;
export type ManagerReconciliationState = (typeof MANAGER_RECONCILIATION_STATES)[number];
export const MANAGER_SESSION_LIFECYCLE_STATES = ["starting", "running", "exited", "stopped", "failed"] as const;
export type ManagerSessionLifecycleState = (typeof MANAGER_SESSION_LIFECYCLE_STATES)[number];

export interface ManagerSessionReceipt {
  code: string;
  message: string;
  source: "manager" | "zellij" | "workflow" | "runtime";
  recordedAt: number;
}

export interface ManagerSessionRecord {
  sessionId: ManagerSessionId;
  runtimeId: ManagerRuntimeId;
  workspaceRoot: string;
  /** Stable caller-owned operation key used to retry one managed task run. */
  idempotencyKey: string | undefined;
  taskId: TaskId | undefined;
  /** Opaque external execution reference; ownership remains outside Manager. */
  executionSessionId: string | undefined;
  executionMode: ManagerExecutionMode;
  worktreeId: WorktreeId | undefined;
  worktreePath: string;
  branchName: string | undefined;
  agentKind: ManagerAgentKind;
  launchProfile: ManagerAgentKind;
  instruction: string;
  provider: string | undefined;
  model: string | undefined;
  taskSlug: string | undefined;
  issueRef: string | undefined;
  branchType: string | undefined;
  launchCommand: string;
  launchArgs: string[];
  runtimeName: string;
  lifecycleState: ManagerSessionLifecycleState;
  runtimeState: ManagerRuntimeState;
  semanticLifecycleState: LifecycleState | "unbound";
  attachable: boolean;
  reconciliationState: ManagerReconciliationState;
  reconciliationMessage: string | undefined;
  latestStatus: string | undefined;
  latestReceipt: ManagerSessionReceipt | undefined;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | undefined;
  runtimeObservedAt: number | undefined;
  restartCount: number;
  exitCode: number | undefined;
  terminationState: "running" | "exited" | "stopped" | "failed" | undefined;
  errorMessage: string | undefined;
}

export interface CreateManagerSessionInput {
  sessionId: ManagerSessionId;
  runtimeId?: ManagerRuntimeId;
  workspaceRoot: string;
  idempotencyKey?: string;
  taskId?: TaskId;
  executionSessionId?: string;
  executionMode?: ManagerExecutionMode;
  worktreeId?: WorktreeId;
  worktreePath: string;
  branchName?: string;
  agentKind: ManagerAgentKind;
  launchProfile?: ManagerAgentKind;
  instruction?: string;
  provider?: string;
  model?: string;
  taskSlug?: string;
  issueRef?: string;
  branchType?: string;
  launchCommand: string;
  launchArgs: readonly string[];
  runtimeName: string;
  lifecycleState?: ManagerSessionLifecycleState;
  runtimeState?: ManagerRuntimeState;
  semanticLifecycleState?: LifecycleState | "unbound";
  attachable?: boolean;
  reconciliationState?: ManagerReconciliationState;
  reconciliationMessage?: string | null;
  latestStatus?: string | null;
  latestReceipt?: ManagerSessionReceipt;
  startedAt?: number;
}

export interface UpdateManagerSessionInput {
  instruction?: string;
  launchCommand?: string;
  launchArgs?: readonly string[];
  lifecycleState?: ManagerSessionLifecycleState;
  runtimeState?: ManagerRuntimeState;
  semanticLifecycleState?: LifecycleState | "unbound";
  attachable?: boolean;
  reconciliationState?: ManagerReconciliationState;
  reconciliationMessage?: string | null;
  latestStatus?: string | null;
  latestReceipt?: ManagerSessionReceipt;
  exitCode?: number | null;
  finishedAt?: number | null;
  runtimeObservedAt?: number | null;
  restartCount?: number;
  terminationState?: ManagerSessionRecord["terminationState"];
  errorMessage?: string | null;
  updatedAt?: number;
}

export interface ListManagerSessionsOptions {
  limit?: number;
  runtimeStates?: readonly ManagerRuntimeState[];
}

export interface TaskRecord {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  taskSlug: string;
  issueRef: string | undefined;
  /** Opaque reference to Nawabari's authoritative local execution session. */
  nawabariSessionId?: NawabariSessionId;
  /** Stable caller key for an idempotent task-start operation, when supplied. */
  startIdempotencyKey?: string;
  lifecycleState: LifecycleState;
  /** Monotonic optimistic-concurrency version. */
  version: number;
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
  updatedAt: number;
}

/** Durable state for the task-start boundary with Nawabari. */
export const TASK_START_RECONCILIATION_STATES = [
  "reserved",
  "session-created",
  "attached",
  "active",
  "abandoned",
  "orphaned",
] as const;
export type TaskStartReconciliationState = (typeof TASK_START_RECONCILIATION_STATES)[number];

export interface TaskStartReconciliationRecord {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  taskLabel: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  nawabariSessionId?: NawabariSessionId;
  state: TaskStartReconciliationState;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

/** Durable identity/evidence for the externally-effectful push boundary. */
export const PUSH_RECONCILIATION_STATES = ["prepared", "attempting", "succeeded", "ambiguous", "reconciled"] as const;
export type PushReconciliationState = (typeof PUSH_RECONCILIATION_STATES)[number];

export interface PushReconciliationRecord {
  operationId: string;
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  sourceCommit: string;
  remote: string;
  targetBranch: string;
  targetRef: string;
  forceRequested: boolean;
  createUpstream: boolean;
  state: PushReconciliationState;
  observedRemoteSha?: string;
  recoveryObservedRemoteSha?: string;
  resultRemoteSha?: string;
  relation?: string;
  evidenceComplete: boolean;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

/** Durable state for the Nawabari-backed commit boundary. */
export const COMMIT_RECONCILIATION_STATES = ["not-attempted", "succeeded", "ambiguous", "reconciled"] as const;
export type CommitReconciliationState = (typeof COMMIT_RECONCILIATION_STATES)[number];

export interface CommitReconciliationRecord {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  branchName: string;
  /** HEAD observed immediately before the external commit request. */
  beforeCommit: string;
  /** Exact resource claim sent to Nawabari. */
  resources: string[];
  /** Exact rendered commit message sent to Nawabari. */
  message: string;
  state: CommitReconciliationState;
  /** SHA returned by Nawabari after a successful commit. */
  commitSha?: string;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

/** Durable handoff state between provider integration and Nawabari session close. */
export interface NawabariCloseReconciliationRecord {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  providerRecordId: PullRequestRecordId;
  integratedRevision?: string;
  state: NawabariCloseReconciliationState;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BeginPushReconciliationInput {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  sourceCommit: string;
  remote: string;
  targetBranch: string;
  targetRef: string;
  forceRequested: boolean;
  createUpstream: boolean;
  createdAt?: number;
}

export interface RecordPushResultInput {
  taskId: TaskId;
  sourceCommit: string;
  remote: string;
  targetBranch: string;
  targetRef: string;
  observedRemoteSha?: string;
  recoveryObservedRemoteSha?: string;
  resultRemoteSha: string;
  relation: string;
  evidenceComplete: boolean;
  recordedAt?: number;
}

export interface BeginCommitReconciliationInput {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  branchName: string;
  beforeCommit: string;
  resources: readonly string[];
  message: string;
  createdAt?: number;
}

export interface BeginTaskStartReconciliationInput {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  taskLabel: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  createdAt?: number;
}

export type WorktreeStatus = "reserved" | "active" | "removed";

export interface WorktreeRecord {
  worktreeId: WorktreeId;
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  branchName: string;
  canonicalPath: string;
  status: WorktreeStatus;
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
  updatedAt: number;
}

export interface PullRequestRecord {
  recordId: PullRequestRecordId;
  taskId: TaskId | undefined;
  /** Repository instance that owns this PR record; absent only for legacy unscoped rows. */
  instanceId: RepositoryInstanceId | undefined;
  provider: string;
  repositoryId: string;
  prNumber: number;
  url: string;
  headSha: string;
  /** Provider-authoritative integrated revision, available after merge. */
  mergeRevision: string | undefined;
  lifecycleState: PullRequestLifecycleState;
  createdAt: number;
  updatedAt: number;
}

export const GUARDRAIL_AUDIT_DECISIONS = ["allow", "deny", "observe"] as const;
export type GuardrailAuditDecision = (typeof GUARDRAIL_AUDIT_DECISIONS)[number];
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface GuardrailAuditRecord {
  auditId: string;
  operation: string;
  decision: GuardrailAuditDecision;
  ruleId: string;
  reasonCode: string;
  instanceId: RepositoryInstanceId | undefined;
  taskId: TaskId | undefined;
  policyProvenance: string | undefined;
  metadata: AuditMetadata;
  recordedAt: number;
}

export interface RecordGuardrailDecisionInput {
  operation: string;
  decision: GuardrailAuditDecision;
  ruleId: string;
  reasonCode: string;
  instanceId?: RepositoryInstanceId;
  taskId?: TaskId;
  policyProvenance?: string;
  metadata?: AuditMetadata;
  recordedAt?: number;
}

export interface ListGuardrailAuditRecordsOptions {
  instanceId?: RepositoryInstanceId;
  taskId?: TaskId;
  since?: number;
  until?: number;
}

export interface RecordPullRequestInput {
  taskId?: TaskId;
  /** Optional for legacy callers; task-bound records derive and validate this identity from the task. */
  instanceId?: RepositoryInstanceId;
  provider: string;
  repositoryId: string;
  prNumber: number;
  url: string;
  headSha: string;
  mergeRevision?: string;
  lifecycleState: PullRequestLifecycleState;
  recordedAt?: number;
}

export interface BeginNawabariCloseReconciliationInput {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  nawabariSessionId: NawabariSessionId;
  providerRecordId: PullRequestRecordId;
  integratedRevision?: string;
  createdAt?: number;
}

export interface ReserveTaskInput {
  instanceId: RepositoryInstanceId;
  taskSlug: string;
  issueRef: string | undefined;
  /** Stable caller key used to make task creation retry-safe. */
  startIdempotencyKey?: string;
  baseBranch: string;
  baseCommit: string;
  /** false の場合、同一 (instanceId, issueRef) に既存の未終了 task があれば拒否する。 */
  allowMultipleActiveTasksPerIssue: boolean;
  reservedAt?: number;
}

export type ReserveTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "issue-already-claimed"; existingTask: TaskRecord };

export interface ReserveWorktreeInput {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  branchName: string;
  canonicalPath: string;
  baseBranch: string;
  baseCommit: string;
  reservedAt?: number;
}

export type ReserveWorktreeResult =
  | { ok: true; worktree: WorktreeRecord }
  | { ok: false; reason: "branch-collision" | "path-collision"; existingWorktree: WorktreeRecord };

export interface HookCheckpointRecord {
  instanceId: RepositoryInstanceId;
  branch: string;
  lastCheckedCommit: string;
  checkedAt: number;
}

export interface RecordHookCheckpointInput {
  instanceId: RepositoryInstanceId;
  branch: string;
  commit: string;
  checkedAt?: number;
}

/**
 * 実際に検証（テスト・型チェック等）を実行した trusted caller だけが書き込む、
 * commit 単位の検証結果記録。`src/workflow/git/push.ts` の
 * `requiredValidationEvidence` gate はこのテーブルの内容だけを信頼し、
 * push 呼び出し側が渡す evidence オブジェクトは一切信頼しない。
 */
export interface ValidationEvidenceRecord {
  instanceId: RepositoryInstanceId;
  headCommit: string;
  name: string;
  status: "passed" | "failed";
  recordedAt: number;
}

export interface RecordValidationEvidenceInput {
  instanceId: RepositoryInstanceId;
  headCommit: string;
  name: string;
  status: "passed" | "failed";
  recordedAt?: number;
}

/**
 * Managed check governor（issue #184）の永続実行記録。`validation_evidence` は push gate
 * が信頼する commit 単位の pass/fail サマリだが、reuse 判定に必要な fingerprint/config
 * digest/duration/artifact 参照までは持たない。ここではそれらを別テーブルとして持ち、
 * governor が PASS を `validation_evidence` へも橋渡しする（`recordValidationEvidence` 経由）。
 */
export type CheckRunStatus = "passed" | "failed";
/**
 * `"reused"` is reserved for a future reuse-audit trail — governor.ts's current reuse path
 * (`runManagedCheck` matching a prior `status='passed'` row) cites the existing row's data
 * directly in the receipt and never inserts a new `"reused"` row, to avoid unbounded growth
 * from repeated no-op reuse. Only `"executed"` rows are persisted today.
 */
export type CheckRunExecution = "executed" | "reused";

export interface CheckRunProvenance {
  reasonCode: string;
  explanation: string;
}

export interface CheckRunRecord {
  runId: string;
  instanceId: RepositoryInstanceId;
  /** managed worktree が無い呼び出しは `""` を使う（repository instance 単位で分離される）。 */
  worktreeId: string;
  checkId: string;
  commandDigest: string;
  stateFingerprint: string;
  configDigest: string;
  status: CheckRunStatus;
  execution: CheckRunExecution;
  startedAt: number;
  durationMs: number;
  recordedAt: number;
  summary: string;
  artifactRef: string | undefined;
  provenance: CheckRunProvenance;
}

export interface RecordCheckRunInput {
  runId: string;
  instanceId: RepositoryInstanceId;
  worktreeId: string;
  checkId: string;
  commandDigest: string;
  stateFingerprint: string;
  configDigest: string;
  status: CheckRunStatus;
  execution: CheckRunExecution;
  startedAt: number;
  durationMs: number;
  summary: string;
  artifactRef?: string;
  provenance: CheckRunProvenance;
  recordedAt?: number;
}

export interface ListCheckRunsFilter {
  instanceId: RepositoryInstanceId;
  worktreeId: string;
  checkId?: string;
  limit?: number;
}

export const CLEANUP_LEASE_STATES = ["reserved", "mutating", "verifying", "committed", "failed"] as const;
export type CleanupLeaseState = (typeof CLEANUP_LEASE_STATES)[number];

export interface CleanupLeaseRecord {
  operationId: string;
  planDigest: string;
  instanceId: RepositoryInstanceId;
  taskId: TaskId;
  worktreeId: WorktreeId | undefined;
  owner: string;
  state: CleanupLeaseState;
  acquiredAt: number;
  expiresAt: number;
  updatedAt: number;
  completedActionIds: string[];
  lastError: string | undefined;
}

export interface ReserveCleanupLeaseInput {
  operationId: string;
  planDigest: string;
  instanceId: RepositoryInstanceId;
  taskId: TaskId;
  worktreeId?: WorktreeId;
  owner: string;
  expiresAt: number;
  acquiredAt?: number;
}

export type ReserveCleanupLeaseResult =
  | { ok: true; lease: CleanupLeaseRecord }
  | { ok: false; reason: "active-lease" | "plan-digest-mismatch"; existingLease: CleanupLeaseRecord };

export interface MarkCleanupLeaseInput {
  operationId: string;
  state: CleanupLeaseState;
  /** 楽観ガード。ストア内の state と一致しない更新は拒否される。 */
  expectedState?: CleanupLeaseState;
  completedActionIds?: readonly string[];
  lastError?: string;
  updatedAt?: number;
}

export interface CommitCleanupInput {
  operationId: string;
  planDigest: string;
  instanceId: RepositoryInstanceId;
  taskId: TaskId;
  worktreeId?: WorktreeId;
  expectedTaskVersion: number;
  expectedLifecycle: LifecycleState;
  completedActionIds: readonly string[];
  committedAt?: number;
}

export interface CommitCleanupResult {
  task: TaskRecord;
  worktree: WorktreeRecord | undefined;
  lease: CleanupLeaseRecord;
}

/**
 * Physical ownership operations from the pre-Nawabari workflow. They remain
 * available only to migration/reference fixtures and the retired legacy
 * implementation; managed callers must not receive this capability.
 */
export interface LegacyPhysicalWorkflowStateStore {
  reserveWorktree(input: ReserveWorktreeInput): ReserveWorktreeResult;
  activateWorktree(worktreeId: WorktreeId, activatedAt?: number): WorktreeRecord;
  deleteReservedWorktree(worktreeId: WorktreeId): void;
  markWorktreeRemoved(worktreeId: WorktreeId, updatedAt?: number): WorktreeRecord;
  reserveCleanupLease(input: ReserveCleanupLeaseInput): ReserveCleanupLeaseResult;
  markCleanupLease(input: MarkCleanupLeaseInput): CleanupLeaseRecord;
  commitCleanup(input: CommitCleanupInput): CommitCleanupResult;
}

export interface WorkflowStateStore {
  /** backend 固有の初期化（DB オープン・migration 適用）。呼び出し前は他メソッドを使わない。 */
  init(): void;

  /**
   * repository source/instance を観測結果として記録する（存在しなければ作成、
   * あれば last_seen_at 更新）。既存 instance の common-dir が変わった場合は、
   * 旧 common-dir が消滅したことを確認できるときだけ新しい値へ更新する。
   * 旧 common-dir が残っている、または新 common-dir が別 instance に占有されて
   * いる場合は fail-closed で拒否する。canonicalWorktreePath が instance の
   * 現在の current path と異なる場合、旧 path を is_current=0 にし新 path を
   * is_current=1 として追記する（移動検出、履歴は保持）。
   */
  observeRepositoryInstance(input: ObserveRepositoryInstanceInput): ObserveRepositoryInstanceResult;

  getRepositorySource(sourceId: RepositorySourceId): RepositorySourceRecord | undefined;
  getRepositorySourceByDigest(rootCommitDigest: RootCommitDigest): RepositorySourceRecord | undefined;
  getRepositoryInstance(instanceId: RepositoryInstanceId): RepositoryInstanceRecord | undefined;
  getRepositoryInstanceByCommonDir(gitCommonDir: string): RepositoryInstanceRecord | undefined;
  listRepositoryPaths(instanceId: RepositoryInstanceId): RepositoryPathRecord[];
  listRepositorySources(): RepositorySourceRecord[];
  listRepositoryInstances(): RepositoryInstanceRecord[];

  /** Allocate/reconcile the stable Unix principal for one canonical repository identity. */
  allocateRepositoryPrincipal(input: AllocateRepositoryPrincipalInput): AllocateRepositoryPrincipalResult;
  /** Release an allocation into quarantine; IDs remain unavailable until cleanup is proven. */
  releaseRepositoryPrincipal(input: ReleaseRepositoryPrincipalInput): RepositoryPrincipalRecord;
  /** Explicitly prove residual ownership cleanup and make the identity reusable. */
  proveRepositoryPrincipalCleanup(input: ProveRepositoryPrincipalCleanupInput): RepositoryPrincipalRecord;
  getRepositoryPrincipal(instanceId: RepositoryInstanceId): RepositoryPrincipalRecord | undefined;
  listRepositoryPrincipals(options?: ListRepositoryPrincipalsOptions): RepositoryPrincipalRecord[];

  /**
   * hook がある branch の commit で policy check を通過したことを記録する
   * （pre-commit/pre-push hook 自身、または将来の CLI/MCP 経路から呼ぶ）。
   * 同じ (instanceId, branch) の既存行があれば上書きする。
   */
  recordHookCheckpoint(input: RecordHookCheckpointInput): HookCheckpointRecord;
  getHookCheckpoint(instanceId: RepositoryInstanceId, branch: string): HookCheckpointRecord | undefined;

  /** trusted caller が検証結果を記録する。同じ (instanceId, headCommit, name) の既存行は上書きする。 */
  recordValidationEvidence(input: RecordValidationEvidenceInput): ValidationEvidenceRecord;
  /** 指定 commit に記録済みの検証結果を name ごとに引く。未記録の name は結果に含まれない。 */
  listValidationEvidence(instanceId: RepositoryInstanceId, headCommit: string): ValidationEvidenceRecord[];

  /** Managed check governor（issue #184）の実行結果を記録する。runId は呼び出し側が発行する。 */
  recordCheckRun(input: RecordCheckRunInput): CheckRunRecord;
  /**
   * 指定 (instance, worktree, check, fingerprint, config) に一致する直近の PASSED 実行を返す。
   * status='failed' の記録は決して再利用対象にならない（issue #184: "silently converting
   * failed checks into passes" を除外）。一致が無ければ undefined — 呼び出し側は必ず実行する。
   */
  findReusableCheckRun(
    instanceId: RepositoryInstanceId,
    worktreeId: string,
    checkId: string,
    stateFingerprint: string,
    configDigest: string,
  ): CheckRunRecord | undefined;
  /** 受信 receipt/observability 用に直近の実行を新しい順で返す（bounded）。 */
  listCheckRuns(filter: ListCheckRunsFilter): CheckRunRecord[];

  /**
   * task を `planned` 状態で予約する。`allowMultipleActiveTasksPerIssue: false` かつ
   * `issueRef` 指定時、同一 (instanceId, issueRef) に未終了（cleaned/abandoned 以外）の
   * task が既にあれば拒否する。単一の `BEGIN IMMEDIATE` トランザクション内で SELECT→INSERT
   * するため、2 プロセス同時呼び出しでも一方の transaction が他方の commit/rollback を
   * 待つことで一意性が保証される（git/gh 等の外部プロセス呼び出しはこの中で行わない）。
   */
  reserveTask(input: ReserveTaskInput): ReserveTaskResult;

  /** Create or recover the durable intent for one Nawabari-backed task start. */
  beginTaskStartReconciliation(input: BeginTaskStartReconciliationInput): TaskStartReconciliationRecord;
  /** Persist the external session identity immediately after Nawabari creates it. */
  recordTaskStartSession(
    taskId: TaskId,
    sessionId: NawabariSessionId,
    updatedAt?: number,
  ): TaskStartReconciliationRecord;
  /** Advance the task-start reconciliation projection with a bounded diagnostic. */
  updateTaskStartReconciliation(
    taskId: TaskId,
    state: TaskStartReconciliationState,
    detail?: string,
    updatedAt?: number,
  ): TaskStartReconciliationRecord;
  getTaskStartReconciliation(taskId: TaskId): TaskStartReconciliationRecord | undefined;

  /** Reserve immutable push identity before crossing the Nawabari mutation boundary. */
  beginPushReconciliation(input: BeginPushReconciliationInput): PushReconciliationRecord;
  /** Mark the reserved operation as having entered the external mutation boundary. */
  markPushAttempting(taskId: TaskId, updatedAt?: number): PushReconciliationRecord;
  /** Persist Nawabari's bounded push evidence before checkpoint/lifecycle persistence. */
  recordPushResult(input: RecordPushResultInput): PushReconciliationRecord;
  /** Record a bounded fail-closed diagnostic without changing immutable push identity. */
  markPushAmbiguous(taskId: TaskId, detail: string, updatedAt?: number): PushReconciliationRecord;
  /** Mark the local lifecycle reconciliation complete after identity/evidence checks. */
  markPushReconciled(taskId: TaskId, updatedAt?: number): PushReconciliationRecord;
  getPushReconciliation(taskId: TaskId): PushReconciliationRecord | undefined;

  /** Create or recover the durable intent for one Nawabari-backed commit. */
  beginCommitReconciliation(input: BeginCommitReconciliationInput): CommitReconciliationRecord;
  /** Persist the immutable result identity immediately after Nawabari reports success. */
  recordCommitResult(taskId: TaskId, commitSha: string, updatedAt?: number): CommitReconciliationRecord;
  /** Mark a commit receipt ambiguous without discarding a known result SHA. */
  markCommitReconciliationAmbiguous(taskId: TaskId, detail: string, updatedAt?: number): CommitReconciliationRecord;
  /** Mark the local lifecycle reconciliation complete after result identity verification. */
  markCommitReconciliationReconciled(taskId: TaskId, updatedAt?: number): CommitReconciliationRecord;
  getCommitReconciliation(taskId: TaskId): CommitReconciliationRecord | undefined;

  /** Create or recover the durable provider-to-Nawabari close handoff. */
  beginNawabariCloseReconciliation(input: BeginNawabariCloseReconciliationInput): NawabariCloseReconciliationRecord;
  /** Persist the physical close result without changing task semantic state. */
  markNawabariCloseReconciliation(
    taskId: TaskId,
    state: Exclude<NawabariCloseReconciliationState, "pending">,
    detail?: string,
    updatedAt?: number,
  ): NawabariCloseReconciliationRecord;
  getNawabariCloseReconciliation(taskId: TaskId): NawabariCloseReconciliationRecord | undefined;
  listNawabariCloseReconciliations(instanceId?: RepositoryInstanceId): NawabariCloseReconciliationRecord[];

  /** 予約後に外部操作が失敗した場合の補償ロールバック。 */
  deleteReservedTask(taskId: TaskId): void;

  updateTaskLifecycleState(taskId: TaskId, next: LifecycleState, updatedAt?: number): TaskRecord;
  /** Attach exactly one external execution session; never stores its ownership fields locally. */
  attachNawabariSession(taskId: TaskId, sessionId: NawabariSessionId, updatedAt?: number): TaskRecord;
  getTask(taskId: TaskId): TaskRecord | undefined;
  getActiveTaskByIssueRef(instanceId: RepositoryInstanceId, issueRef: string): TaskRecord | undefined;
  listTasks(instanceId?: RepositoryInstanceId): TaskRecord[];
  listWorktreesForTask(taskId: TaskId): WorktreeRecord[];
  /** instance 全体の worktree 一覧（task を横断）。衝突・stale metadata 検出のために使う。 */
  listWorktreesForInstance(instanceId: RepositoryInstanceId): WorktreeRecord[];
  listWorktrees(instanceId?: RepositoryInstanceId): WorktreeRecord[];
  createManagerSession(input: CreateManagerSessionInput): ManagerSessionRecord;
  /** Register/reconcile one canonical Runtime identity without persisting credentials. */
  registerManagerRuntime(input: RegisterManagerRuntimeInput): ManagerRuntimeRecord;
  getManagerRuntime(runtimeId: ManagerRuntimeId): ManagerRuntimeRecord | undefined;
  listManagerRuntimes(): ManagerRuntimeRecord[];
  updateManagerRuntime(runtimeId: ManagerRuntimeId, input: UpdateManagerRuntimeInput): ManagerRuntimeRecord;
  getManagerSession(sessionId: ManagerSessionId): ManagerSessionRecord | undefined;
  listManagerSessions(workspaceRoot?: string, options?: ListManagerSessionsOptions): ManagerSessionRecord[];
  updateManagerSession(sessionId: ManagerSessionId, input: UpdateManagerSessionInput): ManagerSessionRecord;
  /** `reserved`/`mutating`/`verifying` の期限切れを reconciliation が検出するための全件参照。 */
  listCleanupLeases(instanceId?: RepositoryInstanceId): CleanupLeaseRecord[];
  getCleanupLease(operationId: string): CleanupLeaseRecord | undefined;
  getActiveCleanupLease(
    instanceId: RepositoryInstanceId,
    taskId: TaskId,
    worktreeId: WorktreeId | undefined,
    now?: number,
  ): CleanupLeaseRecord | undefined;
  /** 外部 provider 成功後に、body/raw response を含めず PR の照合用 metadata だけ記録する。 */
  recordPullRequest(input: RecordPullRequestInput): PullRequestRecord;
  getPullRequestRecord(recordId: PullRequestRecordId): PullRequestRecord | undefined;
  getPullRequestByProviderRepositoryNumber(
    provider: string,
    repositoryId: string,
    prNumber: number,
  ): PullRequestRecord | undefined;
  listPullRequestRecordsForTask(taskId: TaskId): PullRequestRecord[];
  updatePullRequestLifecycleState(
    recordId: PullRequestRecordId,
    lifecycleState: PullRequestLifecycleState,
    updatedAt?: number,
  ): PullRequestRecord;
  /** Persist the provider's authoritative integrated revision after merge observation. */
  recordPullRequestMergeRevision(
    recordId: PullRequestRecordId,
    mergeRevision: string,
    updatedAt?: number,
  ): PullRequestRecord;
  listPullRequestRecords(): PullRequestRecord[];

  recordGuardrailDecision(input: RecordGuardrailDecisionInput): GuardrailAuditRecord;
  listGuardrailAuditRecords(options?: ListGuardrailAuditRecordsOptions): GuardrailAuditRecord[];

  /** backend 固有のリソース解放（DB クローズ等）。プロセス終了時 best-effort で呼ぶ。 */
  close(): void;
}
