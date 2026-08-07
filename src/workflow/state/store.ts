import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";

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

  /** backend 固有のリソース解放（DB クローズ等）。プロセス終了時 best-effort で呼ぶ。 */
  close(): void;
}
