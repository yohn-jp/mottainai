import path from "node:path";
import { runProgram } from "../../subprocess.js";

/**
 * 曖昧な repository 状態（detached HEAD/unborn branch/bare repo/submodule/
 * linked worktree）を明示的に判定する（Issue #28 Child 3）。silent
 * pass-through にせず、サポート対象かどうかを構造化して返す。
 *
 * `src/workflow/domain/identity.ts` の repository identity 解決とは責務が
 * 異なる（identity は同一性、ここは「今この場所で何ができる状態か」）。
 * git 呼び出しは `runProgram()`（src/subprocess.ts、旧 local-tools.ts から
 * 抽出）を再利用し、新規 subprocess wrapper は作らない。
 */

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export type RepoStateKind = "normal" | "detached-head" | "unborn-branch" | "bare-repository" | "submodule" | "linked-worktree";

export interface RepoState {
  kind: RepoStateKind;
  /** normal/detached-head/unborn-branch で判明していれば branch 名（detached では undefined）。 */
  branch: string | undefined;
  /** この状態で Mottainai の policy-driven 操作をサポートするか。 */
  supported: boolean;
  reason: string;
  /** `--git-dir` と `--git-common-dir` が一致する（linked worktree ではない）checkout か。 */
  isPrimaryCheckout: boolean;
}

export type ResolveRepoStateResult = { ok: true; state: RepoState } | { ok: false; reason: string };

interface GitOutcome {
  /** コマンドが完走し exit code 0 だった。 */
  ok: boolean;
  stdout: string;
  /** コマンドが完走した（spawn 失敗・timeout・output-limit のいずれでもない）。false の場合、
   * `ok: false` は「exit code が非 0」を意味しない — 呼び出し側は状態を確定させてはならない。 */
  usable: boolean;
}

// timeout/spawn 失敗と「exit code 1」を区別しないと、git がハングしただけの状況を
// detached HEAD や unborn branch と誤判定してしまう（呼び出し側はその誤判定を基に
// 正当な操作をブロックしうる）。usable=false の呼び出し元は必ず fail-closed する。
async function git(args: string[], cwd: string): Promise<GitOutcome> {
  const result = await runProgram("git", args, cwd, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  const usable = result.spawnError === undefined && !result.timedOut && !result.outputLimit && result.exitCode !== null;
  return { ok: usable && result.exitCode === 0, stdout: result.stdout.trim(), usable };
}

/**
 * cwd から見た repository の状態を判定する。判定順序（互いに排他ではない
 * 状態もあるため、Mottainai の操作可否にとって最も強い制約を先に返す。
 * コードの実行順序とここの記述は一致させること — ずれると「linked worktree
 * かつ detached HEAD」のような複合状態がどちらの kind で報告されるか
 * ドキュメントと矛盾する）:
 *
 * 1. bare repository — worktree が存在しないため source 操作は不可能。
 * 2. submodule — `git rev-parse --show-superproject-working-tree` が非空
 *    （superproject 配下の worktree）。
 * 3. linked worktree — `--git-common-dir` と `--git-dir` が異なる。
 *    サポート対象（Child Issue 4 で個別 worktree として扱う）。detached HEAD
 *    や unborn branch であっても、linked worktree であることを優先して報告する。
 * 4. unborn branch — HEAD が symbolic-ref で解決できるが対象 commit が無い
 *    （最初の commit 前）。
 * 5. detached HEAD — symbolic-ref が解決できない。
 * 6. normal — 上記のいずれにも当たらない、branch checkout 済みの通常状態。
 */
export async function resolveRepoState(cwd: string): Promise<ResolveRepoStateResult> {
  const isBare = await git(["rev-parse", "--is-bare-repository"], cwd);
  if (!isBare.usable) return { ok: false, reason: "git rev-parse --is-bare-repository did not complete" };
  if (isBare.stdout === "true") {
    return { ok: true, state: { kind: "bare-repository", branch: undefined, supported: false, reason: "bare repository has no worktree; source operations are not applicable", isPrimaryCheckout: false } };
  }

  const [gitDir, commonDir] = await Promise.all([
    git(["rev-parse", "--git-dir"], cwd),
    git(["rev-parse", "--git-common-dir"], cwd),
  ]);
  if (!gitDir.usable || !gitDir.ok || !commonDir.usable || !commonDir.ok) {
    return { ok: false, reason: "cannot resolve git-dir/git-common-dir" };
  }
  const isLinkedWorktree = path.resolve(cwd, gitDir.stdout) !== path.resolve(cwd, commonDir.stdout);
  const isPrimaryCheckout = !isLinkedWorktree;

  const superprojectRoot = await git(["rev-parse", "--show-superproject-working-tree"], cwd);
  if (!superprojectRoot.usable) return { ok: false, reason: "git rev-parse --show-superproject-working-tree did not complete" };
  if (superprojectRoot.ok && superprojectRoot.stdout.length > 0) {
    return { ok: true, state: { kind: "submodule", branch: undefined, supported: false, reason: "path is a submodule working tree; not yet supported", isPrimaryCheckout } };
  }

  const symbolicRef = await git(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
  if (!symbolicRef.usable) return { ok: false, reason: "git symbolic-ref did not complete" };

  if (isLinkedWorktree) {
    return { ok: true, state: { kind: "linked-worktree", branch: symbolicRef.ok ? symbolicRef.stdout : undefined, supported: true, reason: "linked worktree; supported as a managed task worktree", isPrimaryCheckout } };
  }

  if (!symbolicRef.ok) {
    return { ok: true, state: { kind: "detached-head", branch: undefined, supported: false, reason: "HEAD is detached; branch-scoped policy decisions do not apply", isPrimaryCheckout } };
  }

  const headCommit = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd);
  if (!headCommit.usable) return { ok: false, reason: "git rev-parse --verify HEAD did not complete" };
  if (!headCommit.ok) {
    return { ok: true, state: { kind: "unborn-branch", branch: symbolicRef.stdout, supported: false, reason: "branch has no commits yet (unborn HEAD)", isPrimaryCheckout } };
  }

  return { ok: true, state: { kind: "normal", branch: symbolicRef.stdout, supported: true, reason: "ordinary branch checkout", isPrimaryCheckout } };
}
