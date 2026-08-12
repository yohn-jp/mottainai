import crypto from "node:crypto";
import { gitCommandFailure, readGitStatus, runGitCommand } from "../git/context.js";
import { matchesScope } from "./scope.js";

/**
 * issue #184 の「conservative v0 invalidation」: 投機的な依存グラフを組まず、
 * repository state（HEAD commit + 変更パスの内容）+ 宣言された check scope から
 * 決定論的な fingerprint を作る。git コマンドが失敗した場合は `ok: false` を返し、
 * 呼び出し側（governor.ts）は必ず実行にフォールバックする —
 * 「不確実なら実行する」を型で強制する。
 */

export interface ChangedEntryFingerprint {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath: string | undefined;
  contentDigest: string;
}

export interface RepositoryStateSnapshot {
  headCommit: string;
  changed: readonly ChangedEntryFingerprint[];
  configFileDigests: Readonly<Record<string, string>>;
  /** true なら scope が宣言されておらず、worktree 全体の変更を対象にした（既定の安全側）。 */
  wholeWorktreeScope: boolean;
  /** true なら `git status` が scope に関わらず完全にクリーン（headCommit と working tree が一致）。 */
  overallClean: boolean;
}

export type StateFingerprintResult =
  | { ok: true; fingerprint: string; headCommit: string; snapshot: RepositoryStateSnapshot }
  | { ok: false; reason: string; detail: string };

export interface StateFingerprintInput {
  workspaceRoot: string;
  /** 宣言された変更許容 scope（glob）。未指定/空は worktree 全体を対象にする最も保守的な既定値。 */
  scope?: readonly string[];
  /** scope に関わらず常に内容を折り込む追加ファイル（例: package.json, tsconfig.json）。 */
  configPaths?: readonly string[];
}

function canonicalChangedEntry(entry: ChangedEntryFingerprint): string {
  return [entry.path, entry.indexStatus, entry.worktreeStatus, entry.originalPath ?? "", entry.contentDigest].join("");
}

/** 存在するファイルだけを対象に `git hash-object` を一括呼び出しし、blob digest を解決する。 */
async function batchHashObjects(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<{ ok: true; digests: Map<string, string> } | { ok: false; reason: string; detail: string }> {
  if (paths.length === 0) return { ok: true, digests: new Map() };
  const observation = await runGitCommand(workspaceRoot, ["hash-object", "--", ...paths]);
  if (!observation.usable || observation.result.exitCode !== 0) {
    const failure = gitCommandFailure("hash-object", observation);
    return { ok: false, reason: failure.code, detail: failure.detail };
  }
  const lines = observation.result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== paths.length) {
    return { ok: false, reason: "hash-object-mismatch", detail: "git hash-object returned an unexpected line count" };
  }
  return { ok: true, digests: new Map(paths.map((path, index) => [path, lines[index]!])) };
}

/** `configPath` は個別に解決する — 存在しないパスを混ぜると `git hash-object` 全体がエラー終了するため。 */
async function resolveConfigFileDigests(
  workspaceRoot: string,
  configPaths: readonly string[],
  knownDigests: ReadonlyMap<string, string>,
): Promise<Record<string, string>> {
  const configFileDigests: Record<string, string> = {};
  for (const configPath of configPaths) {
    const known = knownDigests.get(configPath);
    if (known !== undefined) {
      configFileDigests[configPath] = known;
      continue;
    }
    const single = await batchHashObjects(workspaceRoot, [configPath]);
    configFileDigests[configPath] = single.ok ? (single.digests.get(configPath) ?? "absent") : "absent";
  }
  return configFileDigests;
}

export async function computeStateFingerprint(input: StateFingerprintInput): Promise<StateFingerprintResult> {
  const { workspaceRoot } = input;
  const scope = input.scope ?? [];
  const configPaths = [...new Set(input.configPaths ?? [])].sort();

  const headResult = await runGitCommand(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!headResult.usable || headResult.result.exitCode !== 0 || headResult.result.stdout.trim().length === 0) {
    const failure = gitCommandFailure("resolve-head", headResult);
    return { ok: false, reason: failure.code, detail: failure.detail };
  }
  const headCommit = headResult.result.stdout.trim();

  const statusResult = await readGitStatus(workspaceRoot);
  if (!statusResult.ok) return { ok: false, reason: statusResult.failure.code, detail: statusResult.failure.detail };

  const inScope =
    scope.length === 0
      ? statusResult.status.entries
      : statusResult.status.entries.filter(
          (entry) =>
            matchesScope(entry.path, scope) || (entry.originalPath !== undefined && matchesScope(entry.originalPath, scope)),
        );

  // "D"（worktree で削除）は disk 上に存在しないため hash-object の対象外にする。
  const existingPaths = [...new Set(inScope.filter((entry) => entry.worktreeStatus !== "D").map((entry) => entry.path))];
  const hashed = await batchHashObjects(workspaceRoot, existingPaths);
  if (!hashed.ok) return hashed;

  const configFileDigests = await resolveConfigFileDigests(workspaceRoot, configPaths, hashed.digests);

  const changed: ChangedEntryFingerprint[] = inScope
    .map((entry) => ({
      path: entry.path,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
      originalPath: entry.originalPath,
      contentDigest: hashed.digests.get(entry.path) ?? "deleted",
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const snapshot: RepositoryStateSnapshot = {
    headCommit,
    changed,
    configFileDigests,
    wholeWorktreeScope: scope.length === 0,
    overallClean: statusResult.status.entries.length === 0,
  };

  const payload = [
    `head=${headCommit}`,
    `scope=${scope.length === 0 ? "*" : [...scope].sort().join(",")}`,
    ...changed.map((entry) => canonicalChangedEntry(entry)),
    ...Object.entries(configFileDigests)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([path, contentDigest]) => `config:${path}=${contentDigest}`),
  ].join("\n");
  const fingerprint = `sf_${crypto.createHash("sha256").update("mottainai/state-fingerprint/v1\n").update(payload).digest("hex")}`;

  return { ok: true, fingerprint, headCommit, snapshot };
}
