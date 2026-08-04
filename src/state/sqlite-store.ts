import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.js";
import { resolveStateDbPath } from "./paths.js";
import type {
  ListReadDecisionsFilter,
  NewReadDecisionRecord,
  NewReadEvidenceRecord,
  NewSession,
  ReadDecisionRecord,
  ReadEvidenceRecord,
  SessionRecord,
  StateStore,
} from "./store.js";

export interface SqliteStateStoreOptions {
  /** 明示指定時はこのパスを使う。省略時は resolveStateDbPath() を使う。 */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_DECISION_LIMIT = 100;
const MAX_DECISION_LIMIT = 1000;

/** filter.limit を bounded な正の整数に丸める。呼び出し元の型注釈は実行時の値までは保証しない。 */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DECISION_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_DECISION_LIMIT);
}

/** state directory / DB ファイル / WAL sidecar を所有者のみ読める権限に絞る（対応 Unix のみ）。 */
function restrictToOwner(targetPath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function toSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    sessionId: row.session_id as string,
    repositoryId: row.repository_id as string,
    worktreeId: row.worktree_id as string,
    createdAt: row.created_at as number,
    lastSeenAt: row.last_seen_at as number,
  };
}

function toReadEvidenceRecord(row: Record<string, unknown>): ReadEvidenceRecord {
  return {
    evidenceId: row.evidence_id as string,
    sessionId: row.session_id as string,
    repositoryId: row.repository_id as string,
    worktreeId: row.worktree_id as string,
    provider: row.provider as string,
    path: row.path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    reason: row.reason as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
  };
}

function toReadDecisionRecord(row: Record<string, unknown>): ReadDecisionRecord {
  return {
    decisionId: row.decision_id as string,
    sessionId: row.session_id as string,
    path: row.path as string,
    action: row.action as string,
    fileClass: row.file_class as string,
    capability: row.capability as string,
    policyCode: row.policy_code as string,
    reason: row.reason as string,
    stage: row.stage as string,
    createdAt: row.created_at as number,
  };
}

/**
 * SQLite backed StateStore。`node:sqlite`（Node 22+、experimental）を使う。
 * 追加の native 依存を増やさないための選択。DB は resolveStateDbPath() が返す
 * OS state directory 配下に置く（呼び出し側が dbPath を明示すればそちらを使う）。
 */
export class SqliteStateStore implements StateStore {
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;

  constructor(options: SqliteStateStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveStateDbPath(options.env ?? process.env);
  }

  init(): void {
    if (this.db !== undefined) return;
    const isFileBacked = this.dbPath !== ":memory:";
    if (isFileBacked) {
      const dir = path.dirname(this.dbPath);
      // mkdirSync の mode は umask の影響を受け、既存ディレクトリには適用されないため明示的に chmod する。
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
        // WAL sidecar は書き込みが発生するまで存在しないことがあるため best-effort（無ければ無視）。
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
    if (this.db === undefined) throw new Error("SqliteStateStore.init() must be called before use");
    return this.db;
  }

  createSession(input: NewSession): SessionRecord {
    const db = this.handle();
    const now = input.createdAt ?? Date.now();
    db.prepare(
      "INSERT INTO sessions (session_id, repository_id, worktree_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.sessionId, input.repositoryId, input.worktreeId, now, now);
    return { sessionId: input.sessionId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, createdAt: now, lastSeenAt: now };
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toSessionRecord(row);
  }

  touchSession(sessionId: string, lastSeenAt: number = Date.now()): void {
    this.handle().prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(lastSeenAt, sessionId);
  }

  recordReadEvidence(input: NewReadEvidenceRecord): ReadEvidenceRecord {
    this.handle().prepare(
      `INSERT INTO read_evidence
        (evidence_id, session_id, repository_id, worktree_id, provider, path, start_line, end_line, reason, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.evidenceId,
      input.sessionId,
      input.repositoryId,
      input.worktreeId,
      input.provider,
      input.path,
      input.startLine,
      input.endLine,
      input.reason,
      input.createdAt,
      input.expiresAt,
    );
    return { ...input };
  }

  getReadEvidence(evidenceId: string): ReadEvidenceRecord | undefined {
    const row = this.handle().prepare("SELECT * FROM read_evidence WHERE evidence_id = ?").get(evidenceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toReadEvidenceRecord(row);
  }

  recordReadDecision(input: NewReadDecisionRecord): ReadDecisionRecord {
    const createdAt = input.createdAt ?? Date.now();
    this.handle().prepare(
      `INSERT INTO read_decisions
        (decision_id, session_id, path, action, file_class, capability, policy_code, reason, stage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.decisionId,
      input.sessionId,
      input.path,
      input.action,
      input.fileClass,
      input.capability,
      input.policyCode,
      input.reason,
      input.stage,
      createdAt,
    );
    return { ...input, createdAt };
  }

  listReadDecisions(filter: ListReadDecisionsFilter = {}): ReadDecisionRecord[] {
    const db = this.handle();
    const limit = normalizeLimit(filter.limit);
    // decision_id は呼び出し側が渡す文字列（UUID 等）で挿入順を表さないため、
    // 同一 created_at の安定順序には挿入順を表す rowid を tie-breaker に使う。
    const where = filter.sessionId === undefined ? "" : "WHERE session_id = ? ";
    const params = filter.sessionId === undefined ? [limit] : [filter.sessionId, limit];
    const rows = db.prepare(
      `SELECT * FROM read_decisions ${where}ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...params) as Record<string, unknown>[];
    return rows.map(toReadDecisionRecord);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
