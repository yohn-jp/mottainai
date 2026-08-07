import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type { LifecycleState } from "../domain/lifecycle.js";

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

export interface TaskRecord {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  taskSlug: string;
  issueRef: string | undefined;
  lifecycleState: LifecycleState;
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
  updatedAt: number;
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

export interface ReserveTaskInput {
  instanceId: RepositoryInstanceId;
  taskSlug: string;
  issueRef: string | undefined;
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

export interface WorkflowStateStore {
  /** backend 固有の初期化（DB オープン・migration 適用）。呼び出し前は他メソッドを使わない。 */
  init(): void;

  /**
   * repository source/instance を観測結果として記録する（存在しなければ作成、
   * あれば last_seen_at 更新）。canonicalWorktreePath が instance の現在の
   * current path と異なる場合、旧 path を is_current=0 にし新 path を
   * is_current=1 として追記する（移動検出、履歴は保持）。
   */
  observeRepositoryInstance(input: ObserveRepositoryInstanceInput): ObserveRepositoryInstanceResult;

  getRepositorySource(sourceId: RepositorySourceId): RepositorySourceRecord | undefined;
  getRepositorySourceByDigest(rootCommitDigest: RootCommitDigest): RepositorySourceRecord | undefined;
  getRepositoryInstance(instanceId: RepositoryInstanceId): RepositoryInstanceRecord | undefined;
  getRepositoryInstanceByCommonDir(gitCommonDir: string): RepositoryInstanceRecord | undefined;
  listRepositoryPaths(instanceId: RepositoryInstanceId): RepositoryPathRecord[];

  /**
   * hook がある branch の commit で policy check を通過したことを記録する
   * （pre-commit/pre-push hook 自身、または将来の CLI/MCP 経路から呼ぶ）。
   * 同じ (instanceId, branch) の既存行があれば上書きする。
   */
  recordHookCheckpoint(input: RecordHookCheckpointInput): HookCheckpointRecord;
  getHookCheckpoint(instanceId: RepositoryInstanceId, branch: string): HookCheckpointRecord | undefined;

  /**
   * task を `planned` 状態で予約する。`allowMultipleActiveTasksPerIssue: false` かつ
   * `issueRef` 指定時、同一 (instanceId, issueRef) に未終了（cleaned/abandoned 以外）の
   * task が既にあれば拒否する。単一の `BEGIN IMMEDIATE` トランザクション内で SELECT→INSERT
   * するため、2 プロセス同時呼び出しでも一方の transaction が他方の commit/rollback を
   * 待つことで一意性が保証される（git/gh 等の外部プロセス呼び出しはこの中で行わない）。
   */
  reserveTask(input: ReserveTaskInput): ReserveTaskResult;

  /**
   * worktree を `reserved` 状態で予約する。branch_name/canonical_path の一意性は
   * migration 側の UNIQUE partial index（status != 'removed'）が保証するため、
   * ここでは INSERT を試み、制約違反時に既存行を読み直して衝突理由を構造化して返す。
   */
  reserveWorktree(input: ReserveWorktreeInput): ReserveWorktreeResult;

  /** 外部 `git worktree add` 成功後に呼ぶ。`reserved`→`active` に更新する。 */
  activateWorktree(worktreeId: WorktreeId, activatedAt?: number): WorktreeRecord;

  /** 予約後に外部操作が失敗した場合の補償ロールバック。 */
  deleteReservedTask(taskId: TaskId): void;
  /** 予約後に外部操作が失敗した場合の補償ロールバック。 */
  deleteReservedWorktree(worktreeId: WorktreeId): void;

  updateTaskLifecycleState(taskId: TaskId, next: LifecycleState, updatedAt?: number): TaskRecord;
  getTask(taskId: TaskId): TaskRecord | undefined;
  getActiveTaskByIssueRef(instanceId: RepositoryInstanceId, issueRef: string): TaskRecord | undefined;
  listWorktreesForTask(taskId: TaskId): WorktreeRecord[];

  /** backend 固有のリソース解放（DB クローズ等）。プロセス終了時 best-effort で呼ぶ。 */
  close(): void;
}
