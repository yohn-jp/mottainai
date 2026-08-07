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

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  const result = await runProgram("git", args, cwd, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  return { ok: result.exitCode === 0 && result.spawnError === undefined, stdout: result.stdout.trim() };
}

/**
 * cwd から見た repository の状態を判定する。判定順序（互いに排他ではない
 * 状態もあるため、Mottainai の操作可否にとって最も強い制約を先に返す）:
 *
 * 1. bare repository — worktree が存在しないため source 操作は不可能。
 * 2. linked worktree — `--git-common-dir` と `--git-dir` が異なる。
 *    サポート対象（Child Issue 4 で個別 worktree として扱う）。
 * 3. unborn branch — HEAD が symbolic-ref で解決できるが対象 commit が無い
 *    （最初の commit 前）。
 * 4. detached HEAD — symbolic-ref が解決できない。
 * 5. submodule — `.git` がファイルで `gitdir:` を指す（superproject 配下）。
 * 6. normal — 上記のいずれにも当たらない、branch checkout 済みの通常状態。
 */
export async function resolveRepoState(cwd: string): Promise<ResolveRepoStateResult> {
  const isBare = await git(["rev-parse", "--is-bare-repository"], cwd);
  if (!isBare.ok) return { ok: false, reason: "not a git repository or git unavailable" };
  if (isBare.stdout === "true") {
    return { ok: true, state: { kind: "bare-repository", branch: undefined, supported: false, reason: "bare repository has no worktree; source operations are not applicable", isPrimaryCheckout: false } };
  }

  const [gitDir, commonDir] = await Promise.all([
    git(["rev-parse", "--git-dir"], cwd),
    git(["rev-parse", "--git-common-dir"], cwd),
  ]);
  if (!gitDir.ok || !commonDir.ok) return { ok: false, reason: "cannot resolve git-dir/git-common-dir" };
  const isLinkedWorktree = path.resolve(cwd, gitDir.stdout) !== path.resolve(cwd, commonDir.stdout);
  const isPrimaryCheckout = !isLinkedWorktree;

  const superprojectRoot = await git(["rev-parse", "--show-superproject-working-tree"], cwd);
  if (superprojectRoot.ok && superprojectRoot.stdout.length > 0) {
    return { ok: true, state: { kind: "submodule", branch: undefined, supported: false, reason: "path is a submodule working tree; not yet supported", isPrimaryCheckout } };
  }

  const symbolicRef = await git(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
  if (!symbolicRef.ok) {
    return { ok: true, state: { kind: "detached-head", branch: undefined, supported: false, reason: "HEAD is detached; branch-scoped policy decisions do not apply", isPrimaryCheckout } };
  }

  const headCommit = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd);
  if (!headCommit.ok) {
    return { ok: true, state: { kind: "unborn-branch", branch: symbolicRef.stdout, supported: false, reason: "branch has no commits yet (unborn HEAD)", isPrimaryCheckout } };
  }

  if (isLinkedWorktree) {
    return { ok: true, state: { kind: "linked-worktree", branch: symbolicRef.stdout, supported: true, reason: "linked worktree; supported as a managed task worktree", isPrimaryCheckout } };
  }

  return { ok: true, state: { kind: "normal", branch: symbolicRef.stdout, supported: true, reason: "ordinary branch checkout", isPrimaryCheckout } };
}
