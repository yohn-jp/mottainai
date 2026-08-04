import fs from "node:fs";
import path from "node:path";
import type { EvidenceStore, ReadEvidence } from "./evidence.js";

export interface EvidenceReadRequest {
  repositoryId: string;
  worktreeId: string;
  sessionId: string;
  path: string;
  startLine: number;
  endLine: number;
  evidenceId?: string;
  /** worktree の実体ルート。allow/rewrite を返す前に必ず symlink escape をファイルシステムで検査する。 */
  worktreeRoot: string;
}

export type EvidenceAuthorizationOutcome = "allow" | "rewrite" | "rejected";

export interface EvidenceAuthorizationResult {
  outcome: EvidenceAuthorizationOutcome;
  reason: string;
  evidence?: ReadEvidence;
  rewrittenRange?: { startLine: number; endLine: number };
}

/**
 * evidenceId 付き read request を検証する（Evidence-based Read Authorization v1）。
 * ここでの "rejected" は evidence を無関係/無効として扱うだけで、Read Governor 全体の
 * deny 実装ではない。呼び出し側は rejected を「evidence なし」と同様に既存の
 * observe/warn 経路へフォールバックさせる想定（deny は次段階）。
 */
export function authorizeRead(
  request: EvidenceReadRequest,
  store: EvidenceStore,
  now: number = Date.now(),
): EvidenceAuthorizationResult {
  if (!request.evidenceId) {
    return { outcome: "rejected", reason: "no evidenceId provided" };
  }

  const evidence = store.get(request.evidenceId);
  if (!evidence) {
    return { outcome: "rejected", reason: "evidence not found" };
  }
  if (evidence.expiresAt <= now) {
    return { outcome: "rejected", reason: "evidence expired" };
  }
  if (evidence.repositoryId !== request.repositoryId) {
    return { outcome: "rejected", reason: "repository mismatch" };
  }
  if (evidence.worktreeId !== request.worktreeId) {
    return { outcome: "rejected", reason: "worktree mismatch" };
  }
  if (evidence.sessionId !== request.sessionId) {
    return { outcome: "rejected", reason: "session mismatch" };
  }

  const evidencePath = normalizeRelativePath(evidence.path);
  const requestPath = normalizeRelativePath(request.path);
  if (evidencePath === null || requestPath === null) {
    return { outcome: "rejected", reason: "path traversal detected" };
  }
  if (evidencePath !== requestPath) {
    return { outcome: "rejected", reason: "path mismatch" };
  }

  if (request.worktreeRoot.length === 0) {
    return { outcome: "rejected", reason: "worktree root required" };
  }
  const escapeReason = detectSymlinkEscape(request.worktreeRoot, requestPath);
  if (escapeReason !== null) {
    return { outcome: "rejected", reason: escapeReason };
  }

  if (!isValidLineRange(request.startLine, request.endLine)) {
    return { outcome: "rejected", reason: "invalid line range" };
  }

  if (request.startLine >= evidence.startLine && request.endLine <= evidence.endLine) {
    return { outcome: "allow", reason: "within authorized range", evidence };
  }

  return {
    outcome: "rewrite",
    reason: "requested range exceeds authorized range; rewritten to evidence bounds",
    rewrittenRange: { startLine: evidence.startLine, endLine: evidence.endLine },
    evidence,
  };
}

/** 正の整数かつ startLine <= endLine のときだけ true。逆転・負数・小数を弾く。 */
function isValidLineRange(startLine: number, endLine: number): boolean {
  return Number.isInteger(startLine) && Number.isInteger(endLine)
    && startLine >= 1 && endLine >= 1 && startLine <= endLine;
}

/** ".." 脱出・絶対パス・null byte を弾く。安全なら正規化済み相対パスを返す。 */
function normalizeRelativePath(input: string): string | null {
  if (input.length === 0 || input.includes("\0")) return null;
  const posix = input.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  const normalized = path.posix.normalize(posix);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

/** resolveInside（src/local-tools.ts）と同じ二段 realpath 検査で symlink 脱出を検出する。 */
function detectSymlinkEscape(root: string, relativePath: string): string | null {
  try {
    const rootReal = fs.realpathSync(root);
    const candidate = path.resolve(rootReal, relativePath);
    if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) {
      return "path traversal detected";
    }
    const resolved = fs.realpathSync(candidate);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
      return "symlink escape detected";
    }
    return null;
  } catch {
    return "path could not be resolved";
  }
}
