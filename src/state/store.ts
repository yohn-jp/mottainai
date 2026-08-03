/**
 * 永続 state の抽象。実装（SQLite 等）を差し替え可能にするため、呼び出し側は
 * この interface だけに依存する。責務は初期段階として session / read evidence /
 * read decision / schema migration に限定する（telemetry・review は次段階）。
 */

export interface SessionRecord {
  sessionId: string;
  repositoryId: string;
  worktreeId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface NewSession {
  sessionId: string;
  repositoryId: string;
  worktreeId: string;
  createdAt?: number;
}

export interface ReadEvidenceRecord {
  evidenceId: string;
  sessionId: string;
  repositoryId: string;
  worktreeId: string;
  provider: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface NewReadEvidenceRecord {
  evidenceId: string;
  sessionId: string;
  repositoryId: string;
  worktreeId: string;
  provider: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface ReadDecisionRecord {
  decisionId: string;
  sessionId: string;
  path: string;
  action: string;
  fileClass: string;
  capability: string;
  policyCode: string;
  reason: string;
  stage: string;
  createdAt: number;
}

export interface NewReadDecisionRecord {
  decisionId: string;
  sessionId: string;
  path: string;
  action: string;
  fileClass: string;
  capability: string;
  policyCode: string;
  reason: string;
  stage: string;
  createdAt?: number;
}

export interface ListReadDecisionsFilter {
  sessionId?: string;
  limit?: number;
}

/**
 * 全 backend 共通の契約。将来の telemetry / review 追加時もこの interface に
 * メソッドを足す形で拡張し、既存メソッドの意味は変えない。
 */
export interface StateStore {
  /** backend 固有の初期化（DB オープン・migration 適用）。呼び出し前は他メソッドを使わない。 */
  init(): void;

  createSession(input: NewSession): SessionRecord;
  getSession(sessionId: string): SessionRecord | undefined;
  touchSession(sessionId: string, lastSeenAt?: number): void;

  recordReadEvidence(input: NewReadEvidenceRecord): ReadEvidenceRecord;
  getReadEvidence(evidenceId: string): ReadEvidenceRecord | undefined;

  recordReadDecision(input: NewReadDecisionRecord): ReadDecisionRecord;
  listReadDecisions(filter?: ListReadDecisionsFilter): ReadDecisionRecord[];

  /** backend 固有のリソース解放（DB クローズ等）。プロセス終了時 best-effort で呼ぶ。 */
  close(): void;
}
