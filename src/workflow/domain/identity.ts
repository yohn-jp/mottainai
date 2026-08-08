import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Git workflow の repository identity 解決（Issue #28 Child 2）。
 * リモート URL・ファイルシステムパス・ブランチ名は単独では安定した識別子に
 * ならない（移動・ミラー・大文字小文字非区別 FS で変化するため）ので使わない。
 *
 * root commit の SHA 群も、それ単体では *globally unique* な source identity
 * にはならない（同一内容のリポジトリを同時刻に別々に `git init` すると commit
 * SHA が偶然一致しうる — tree/parent/author/timestamp/message が全て同じなら
 * 同じ SHA になる）。そのためここでは root commit 群から決定論的な
 * `RootCommitDigest`（衝突検知・同一性の弱いヒント）だけを算出し、実際の
 * `RepositorySourceId` は初回観測時に state store 側で発行する
 * （src/workflow/state/sqlite-store.ts の repository_sources.source_id）。
 */

export type RootCommitDigest = string & { readonly __brand: "RootCommitDigest" };
export type RepositoryInstanceId = string & { readonly __brand: "RepositoryInstanceId" };

export interface RepositoryIdentity {
  rootCommitDigest: RootCommitDigest;
  instanceId: RepositoryInstanceId;
  /** `git rev-parse --git-common-dir` の canonicalized 絶対パス（worktree 間で共有される値）。 */
  gitCommonDir: string;
  /** git common-dir の実体から検証して導出した primary checkout の root。 */
  canonicalRepositoryRoot: string;
  /** worktree の canonicalized 絶対パス（呼び出し時の cwd に対応する worktree）。 */
  worktreePath: string;
}

const INSTANCE_MARKER_FILE_NAME = "mottainai-instance-id";

export type ResolveRepositoryIdentityResult =
  | { ok: true; identity: RepositoryIdentity }
  | { ok: false; reason: string };

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * シンボリックリンク経由や末尾スラッシュ違いの入力を同一パスとして比較できる
 * よう、実体パス基準に正規化する。大文字小文字の正規化は OS・ファイルシステム
 * 依存（macOS の既定 FS は case-insensitive、Linux は case-sensitive）であり、
 * 全プラットフォームで保証される挙動ではない。
 */
function canonicalizePath(targetPath: string): string {
  return fs.realpathSync.native(targetPath);
}

/**
 * Git common-dir の実体から control-plane repository root を導出する。
 * `.git` 以外を common-dir の root と推測しない — bare repository、submodule、
 * Git の特殊配置はここで fail-closed にする。
 */
function resolveCanonicalRepositoryRoot(gitCommonDir: string): string | undefined {
  if (path.basename(gitCommonDir) !== ".git") return undefined;
  try {
    if (!fs.statSync(gitCommonDir).isDirectory()) return undefined;
    const candidateRoot = canonicalizePath(path.dirname(gitCommonDir));
    const candidateCommonDir = canonicalizePath(path.join(candidateRoot, ".git"));
    return candidateCommonDir === gitCommonDir ? candidateRoot : undefined;
  } catch {
    return undefined;
  }
}

/**
 * root commit（親を持たない commit）の SHA から digest を導出する。shallow
 * clone や複数 root（history 併合）に備え、複数あればソート済みで連結して
 * ハッシュ化する。root commit が 1 つも取れない（unborn HEAD 等）場合は
 * 呼び出し側が fail-closed に扱う。
 */
function deriveRootCommitDigest(rootCommits: string[]): RootCommitDigest | undefined {
  if (rootCommits.length === 0) return undefined;
  const sorted = [...rootCommits].sort();
  const hash = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
  return hash as RootCommitDigest;
}

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * gitCommonDir 配下のマーカーファイルから instanceId を読む。無ければ
 * `crypto.randomUUID()` を新規発行して書き込む。common-dir はパス移動しても
 * 中身ごと一緒に移動する（Git 自身が保証する不変条件）ため、instanceId は
 * リポジトリの移動やリネームに対して安定する。マーカーファイルの内容が
 * 壊れている場合は fail-closed にする（黙って新規発行し直すと、移動検出の
 * 前提である「instanceId は不変」が崩れるため）。
 */
function resolveOrCreateInstanceId(gitCommonDir: string): { ok: true; instanceId: RepositoryInstanceId } | { ok: false; reason: string } {
  const markerPath = path.join(gitCommonDir, INSTANCE_MARKER_FILE_NAME);
  try {
    const existing = fs.readFileSync(markerPath, "utf8").trim();
    if (!INSTANCE_ID_PATTERN.test(existing)) {
      return { ok: false, reason: `instance marker file is corrupt: ${markerPath}` };
    }
    return { ok: true, instanceId: existing as RepositoryInstanceId };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `cannot read instance marker file: ${(err as Error).message}` };
    }
  }

  const generated = crypto.randomUUID() as RepositoryInstanceId;
  // `wx` での直接書き込みは排他生成こそ保証するが、書き込み自体は複数 syscall
  // に分かれるため、他プロセスが空/部分内容を読んだり、書き込み中のクラッシュで
  // 壊れた内容が永続化されたりしうる。一意な一時ファイルに全内容を書いてから
  // `fs.linkSync`（ハードリンク、対象が存在すれば ENOENT ではなく EEXIST で失敗）
  // で公開することで、他プロセスからは「存在しない」か「完全な内容」のいずれか
  // しか観測できないようにする。
  const tmpPath = `${markerPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, `${generated}\n`, { flag: "wx" });
    try {
      fs.linkSync(tmpPath, markerPath);
      return { ok: true, instanceId: generated };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const raceWinner = fs.readFileSync(markerPath, "utf8").trim();
          if (INSTANCE_ID_PATTERN.test(raceWinner)) return { ok: true, instanceId: raceWinner as RepositoryInstanceId };
          return { ok: false, reason: `instance marker file is corrupt: ${markerPath}` };
        } catch {
          // 競合 winner の内容を検証できない場合、新しい id を発行して不変条件を
          // 壊すより fail-closed を優先する。
        }
      }
      return { ok: false, reason: `cannot create instance marker file: ${(err as Error).message}` };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // 公開済み marker の整合性を優先し、一時ファイルの削除失敗で解決全体は失敗させない。
      }
    }
  } catch (err) {
    return { ok: false, reason: `cannot create instance marker temp file: ${(err as Error).message}` };
  }
}

/**
 * cwd が属する Git repository の identity を解決する。detached HEAD や worktree
 * からの呼び出しでも、common-dir が同じであれば同一 instanceId を返す
 * （worktree 個別の識別は Child Issue 4 の worktrees table が担当する）。
 */
export function resolveRepositoryIdentity(cwd: string): ResolveRepositoryIdentityResult {
  let rawCommonDir: string;
  let rawToplevel: string;
  try {
    // 絶対 path を Git 自身に解決させる。caller cwd 基準の相対値を path anchor
    // として再解決すると、linked worktree からの呼び出しで別 root になりうる。
    rawCommonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    rawToplevel = runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch (err) {
    return { ok: false, reason: `not a git repository or git unavailable: ${(err as Error).message}` };
  }

  let gitCommonDir: string;
  let worktreePath: string;
  try {
    gitCommonDir = canonicalizePath(rawCommonDir);
    worktreePath = canonicalizePath(path.resolve(cwd, rawToplevel));
  } catch (err) {
    return { ok: false, reason: `cannot canonicalize repository path: ${(err as Error).message}` };
  }

  const canonicalRepositoryRoot = resolveCanonicalRepositoryRoot(gitCommonDir);
  if (canonicalRepositoryRoot === undefined) {
    return { ok: false, reason: `cannot resolve an unambiguous repository root from git common-dir: ${gitCommonDir}` };
  }

  // HEAD のみを対象にすると、orphan branch への切替や無関係 history の
  // merge で到達可能な root commit 集合が変わり、同一リポジトリの digest が
  // 変化しうる（state store 側で別 source として扱われてしまう）。`--all` で
  // 全 ref から到達可能な root commit を対象にし、branch 追加/切替の影響を
  // 受けないようにする。
  let rootCommits: string[];
  try {
    const output = runGit(["rev-list", "--max-parents=0", "--all"], cwd);
    rootCommits = output.length === 0 ? [] : output.split("\n");
  } catch (err) {
    return { ok: false, reason: `cannot resolve root commit (unborn HEAD?): ${(err as Error).message}` };
  }

  const rootCommitDigest = deriveRootCommitDigest(rootCommits);
  if (rootCommitDigest === undefined) {
    return { ok: false, reason: "repository has no root commit (unborn HEAD)" };
  }

  const instanceIdResult = resolveOrCreateInstanceId(gitCommonDir);
  if (!instanceIdResult.ok) {
    return { ok: false, reason: instanceIdResult.reason };
  }

  return {
    ok: true,
    identity: { rootCommitDigest, instanceId: instanceIdResult.instanceId, gitCommonDir, canonicalRepositoryRoot, worktreePath },
  };
}
