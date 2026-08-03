import { randomUUID } from "node:crypto";

/**
 * Evidence-based Read Authorization の証拠モデル。structural exploration
 * （codegraph 等）が特定 repository/worktree/session 内の path・line-range read を
 * 正当化した記録。署名なし・DB永続化なし — session-local な軽量ストアが前提（次段階拡張用）。
 */
export interface ReadEvidence {
  evidenceId: string;
  repositoryId: string;
  worktreeId: string;
  sessionId: string;
  provider: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface NewReadEvidence {
  repositoryId: string;
  worktreeId: string;
  sessionId: string;
  provider: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  /** 省略時はストアの既定TTLを使う。 */
  ttlMs?: number;
}

export interface EvidenceStore {
  issue(input: NewReadEvidence): ReadEvidence;
  get(evidenceId: string): ReadEvidence | undefined;
}

export interface InMemoryEvidenceStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  createId?: () => string;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * session-local な ReadEvidence ストア（InMemoryArtifactStore と同型: TTL + 上限件数の
 * インメモリ Map）。プロセス再起動・セッション終了で消える。期限切れ判定は authorize 側の
 * 責務（get() は生の記録をそのまま返す。expired/not-found を区別できるようにするため）。
 */
export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly entries = new Map<string, ReadEvidence>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: InMemoryEvidenceStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  issue(input: NewReadEvidence): ReadEvidence {
    if (!Number.isInteger(input.startLine) || input.startLine < 1) {
      throw new Error("startLine must be a positive integer");
    }
    if (!Number.isInteger(input.endLine) || input.endLine < input.startLine) {
      throw new Error("endLine must be an integer >= startLine");
    }

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const now = this.now();
    const evidence: ReadEvidence = {
      evidenceId: `rev_${this.createId()}`,
      repositoryId: input.repositoryId,
      worktreeId: input.worktreeId,
      sessionId: input.sessionId,
      provider: input.provider,
      path: input.path,
      startLine: input.startLine,
      endLine: input.endLine,
      reason: input.reason,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
    };
    this.entries.set(evidence.evidenceId, evidence);
    return evidence;
  }

  get(evidenceId: string): ReadEvidence | undefined {
    return this.entries.get(evidenceId);
  }
}
