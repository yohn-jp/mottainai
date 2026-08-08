import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectionBudget, ProjectedResult } from "./types.js";

export const IDENTITY_VERSION = 1 as const;
export const PROJECTION_IDENTITY_VERSION = 1 as const;

export const IDENTITY_ADAPTERS = ["local_file_read_v1", "stored_artifact_v1"] as const;
export type IdentityAdapter = (typeof IDENTITY_ADAPTERS)[number];

export interface ContentIdentity {
  version: typeof IDENTITY_VERSION;
  id: string;
  source: "git-blob" | "content-hash";
}

/** local adapter が result finalizer へ渡す、本文を含まない identity hint。 */
export interface IdentityHint {
  version: typeof IDENTITY_VERSION;
  content_id: string;
  adapter: IdentityAdapter;
  source_key: string;
  projection_key: string;
  if_changed_from?: string;
}

/** file の版を指す identity。read range/mode には依存しない。 */
export interface FileContentIdentity {
  version: typeof IDENTITY_VERSION;
  content_id: string;
  adapter: "local_file_read_v1";
  source_key: string;
}

/** ArtifactStore metadata に保持する identity。projection や本文は保持しない。 */
export interface ArtifactIdentityMetadata extends FileContentIdentity {
  /**
   * 保存した `selected` を生んだ元 read の projection key（range/mode/policy 由来）。
   * content_id はファイル全体の版を指すため、これが無いと同一ファイルの異なる
   * range/mode で保存した artifact が同じ content_id を共有し、stored_artifact_v1
   * 側の result identity が衝突し得る。
   */
  origin_projection_key: string;
}

export interface ResultIdentity {
  version: typeof IDENTITY_VERSION;
  id: string;
  content_id: string;
  projection_id: string;
  changed: boolean;
  previous_id?: string;
}

export interface ProjectionIdentityInput {
  hint: IdentityHint;
  budget: ProjectionBudget;
  projected: ProjectedResult;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A stalled git process (index lock contention, an unresponsive filesystem, a
    // hanging credential helper) must not block the read response indefinitely —
    // the caller's catch already falls back to the content hash.
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024, timeout: 2_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function stableValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("identity input contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => stableValue(entry, seen));
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function stableIdentityString(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value, new Set()));
  if (serialized === undefined) throw new Error("identity input is not serializable");
  return serialized;
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function identityDigest(value: unknown): string {
  return hashContent(stableIdentityString(value));
}

function relativeGitPath(filePath: string, workspaceRoot: string): string | undefined {
  const relative = path.relative(workspaceRoot, filePath);
  if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/**
 * Clean tracked files use the committed Git blob. Dirty and untracked files use the
 * actual bytes scanned by the read adapter. Git failures fall back to the content hash.
 */
export async function resolveFileContentIdentity(
  filePath: string,
  workspaceRoot: string,
  contentHash: string,
): Promise<ContentIdentity | undefined> {
  if (!/^[0-9a-f]{64}$/u.test(contentHash)) return undefined;
  const relative = relativeGitPath(filePath, workspaceRoot);
  if (relative !== undefined) {
    try {
      await runGit(["ls-files", "--error-unmatch", "--", relative], workspaceRoot);
      await runGit(["diff", "--quiet", "HEAD", "--", relative], workspaceRoot);
      const blob = (await runGit(["rev-parse", `HEAD:${relative}`], workspaceRoot)).trim();
      if (/^[0-9a-f]{40,64}$/u.test(blob)) {
        return { version: IDENTITY_VERSION, id: `ci1:git-blob:${blob}`, source: "git-blob" };
      }
    } catch {
      // Dirty, untracked, non-Git, or ambiguous paths use the byte hash below.
    }
  }
  return { version: IDENTITY_VERSION, id: `ci1:sha256:${contentHash}`, source: "content-hash" };
}

export function createIdentityHint(input: {
  content_id: string;
  adapter: IdentityAdapter;
  source_key: string;
  projection_key: string;
  if_changed_from?: string;
}): IdentityHint {
  return {
    version: IDENTITY_VERSION,
    content_id: input.content_id,
    adapter: input.adapter,
    source_key: input.source_key,
    projection_key: input.projection_key,
    ...(input.if_changed_from === undefined ? {} : { if_changed_from: input.if_changed_from }),
  };
}

export function createReadProjectionKey(input: {
  mode: string;
  startLine?: number;
  endLine?: number;
  policy: unknown;
  policyRule: string;
  policyReason: string;
  diagnostics: unknown;
  extractionFailure: boolean;
}): string {
  return `rk1:${identityDigest({ version: "read-projection-v1", ...input })}`;
}

export function createStoredProjectionKey(input: {
  stream: string;
  query?: string;
  startLine?: number;
  maxLines?: number;
  contextLines?: number;
  originProjectionKey: string;
}): string {
  return `sk1:${identityDigest({ version: "stored-artifact-projection-v1", ...input })}`;
}

function projectionShape(projected: ProjectedResult): Record<string, unknown> {
  return {
    status: projected.status,
    isError: projected.isError === true,
    truncated: projected.truncated,
    diagnostics: projected.diagnostics,
    testResults: projected.testResults,
    fields: projected.fields
      .map((field) => ({ key: field.key, priority: field.priority }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    omissions: projected.omissions
      .map((omission) => ({ field: omission.field, reason: omission.reason, retrievalAvailable: omission.retrievalAvailable }))
      .sort((left, right) => left.field.localeCompare(right.field) || left.reason.localeCompare(right.reason)),
  };
}

export function createProjectionIdentity(input: ProjectionIdentityInput): string {
  return `pi1:${identityDigest({
    version: `projection-v${PROJECTION_IDENTITY_VERSION}`,
    projection_key: input.hint.projection_key,
    budget: input.budget,
    shape: projectionShape(input.projected),
  })}`;
}

export function createResultIdentity(contentId: string, projectionId: string): string {
  return `ri1:${identityDigest({ version: "result-v1", content_id: contentId, projection_id: projectionId })}`;
}

export function makeResultIdentity(input: {
  content_id: string;
  projection_id: string;
  changed: boolean;
  previous_id?: string;
}): ResultIdentity {
  const id = createResultIdentity(input.content_id, input.projection_id);
  return {
    version: IDENTITY_VERSION,
    id,
    content_id: input.content_id,
    projection_id: input.projection_id,
    changed: input.changed,
    ...(input.previous_id === undefined ? {} : { previous_id: input.previous_id }),
  };
}

export function isIdentityHint(value: unknown): value is IdentityHint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === IDENTITY_VERSION
    && typeof record.content_id === "string"
    && typeof record.adapter === "string"
    && (IDENTITY_ADAPTERS as readonly string[]).includes(record.adapter)
    && typeof record.source_key === "string"
    && typeof record.projection_key === "string"
    && (record.if_changed_from === undefined || typeof record.if_changed_from === "string");
}

export function isSensitiveReadPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_[^/]+|private[^/]*)(?:\/|$)/iu.test(normalized)
    || /\.(?:pem|key|p12|pfx|jks|kdbx)$/iu.test(normalized);
}

