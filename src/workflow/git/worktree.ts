import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runProgram } from "../../subprocess.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type { WorktreeRule } from "../policy/schema.js";
import type { WorkflowStateStore, WorktreeRecord } from "../state/store.js";

/**
 * policy 駆動 worktree 作成（Issue #28 Child 4）。task workflow の worktree は
 * repository identity が解決した canonical root 配下だけを使用する。bootstrap
 * コマンドは従来どおり `pnpm-lock.yaml` 存在時のみ実行する。
 */

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface WorktreeNaming {
  branchName: string;
  relativePath: string;
}

export interface WorktreeNamingInput {
  branchType: string;
  issueRef: string;
  taskSlug: string;
}

export const MANAGED_WORKTREE_DIR_RELATIVE = path.join(".mottainai", "worktrees");

export type ManagedWorktreeRootResult =
  | { ok: true; path: string }
  | { ok: false; detail: string };

/**
 * 1 segment ずつ lstat で symlink でないことを確認してから mkdir する。
 * mkdirSync(..., {recursive:true}) を先に実行して事後に realpath 比較する方式だと、
 * 中間 segment（例: `.mottainai` 自体）が repository 外への symlink だった場合、
 * 失敗を報告する前に repository 外へディレクトリを作ってしまう。ここでは各
 * segment を作る *前* に、既存なら symlink でないことを検証してから進むことで、
 * mutation 前に escape を検出する（fail-closed）。
 */
function ensureCanonicalDirectorySegment(parentCanonical: string, segmentName: string): ManagedWorktreeRootResult {
  const target = path.join(parentCanonical, segmentName);
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat === undefined) {
      fs.mkdirSync(target);
    } else if (stat.isSymbolicLink()) {
      return { ok: false, detail: `managed worktree root resolves outside its canonical path: ${target}` };
    } else if (!stat.isDirectory()) {
      return { ok: false, detail: `managed worktree path segment is not a directory: ${target}` };
    }
    const actual = fs.realpathSync.native(target);
    if (actual !== target) {
      return { ok: false, detail: `managed worktree root resolves outside its canonical path: ${target}` };
    }
    return { ok: true, path: actual };
  } catch (err) {
    return { ok: false, detail: `cannot prepare managed worktree path segment ${target}: ${(err as Error).message}` };
  }
}

/** Ensure the managed directory itself is not a symlink escape from the canonical root. */
export function ensureCanonicalManagedWorktreeRoot(canonicalRepositoryRoot: string): ManagedWorktreeRootResult {
  let current = canonicalRepositoryRoot;
  for (const segmentName of MANAGED_WORKTREE_DIR_RELATIVE.split(path.sep)) {
    const result = ensureCanonicalDirectorySegment(current, segmentName);
    if (!result.ok) return result;
    current = result.path;
  }
  return { ok: true, path: current };
}

/** branch rule は governance authority 側で検証する。ここでは structured input を
 * そのまま `<type>/<issue>-<slug>` 候補へ射影し、rule の複製や推測を行わない。 */
export function buildWorktreeNaming(input: WorktreeNamingInput): WorktreeNaming {
  const branchName = `${input.branchType}/${input.issueRef}-${input.taskSlug}`;
  const relativePath = path.join(MANAGED_WORKTREE_DIR_RELATIVE, branchName.replace(/\//g, "-"));
  return { branchName, relativePath };
}

/** collision check と `git worktree add` が同一の canonical target を使うための唯一の path 解決。 */
export function resolveCanonicalWorktreePath(canonicalRepositoryRoot: string, naming: WorktreeNaming): string {
  return path.resolve(canonicalRepositoryRoot, naming.relativePath);
}

export interface CreateWorktreeInput {
  canonicalRepositoryRoot: string;
  naming: WorktreeNaming;
  baseCommit: string;
}

export type CreateWorktreeResult =
  | { ok: true; canonicalPath: string; baseCommit: string }
  | { ok: false; reason: "git-worktree-add-failed"; detail: string };

/** `git worktree add` を実行する。失敗は throw せず構造化結果で返す（衝突は呼び出し前に detectWorktreeCollisions で弾く想定だが、
 * TOCTOU で外部から先に取られる可能性は残るため、ここでも失敗経路を正常系として扱う）。 */
export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const { canonicalRepositoryRoot, naming, baseCommit } = input;
  const managedRoot = ensureCanonicalManagedWorktreeRoot(canonicalRepositoryRoot);
  if (!managedRoot.ok) return { ok: false, reason: "git-worktree-add-failed", detail: managedRoot.detail };
  const absolutePath = resolveCanonicalWorktreePath(canonicalRepositoryRoot, naming);
  const addResult = await runProgram(
    "git",
    ["worktree", "add", "-b", naming.branchName, absolutePath, baseCommit],
    canonicalRepositoryRoot,
    GIT_TIMEOUT_MS,
    GIT_MAX_OUTPUT_BYTES,
  );
  if (addResult.exitCode !== 0) {
    const detail = (addResult.stderr || addResult.stdout || "git worktree add failed").trim().split("\n")[0] ?? "git worktree add failed";
    return { ok: false, reason: "git-worktree-add-failed", detail };
  }

  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(absolutePath);
  } catch (err) {
    return { ok: false, reason: "git-worktree-add-failed", detail: `cannot resolve created worktree path: ${(err as Error).message}` };
  }

  const headResult = await runProgram("git", ["-C", canonicalPath, "rev-parse", "HEAD"], canonicalRepositoryRoot, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  if (headResult.exitCode !== 0 || headResult.stdout.trim().length === 0) {
    return { ok: false, reason: "git-worktree-add-failed", detail: "worktree created but HEAD could not be resolved" };
  }

  return { ok: true, canonicalPath, baseCommit: headResult.stdout.trim() };
}

export interface BootstrapDecision {
  mode: WorktreeRule["bootstrapMode"];
  command: string | undefined;
  shouldExecute: boolean;
  reason: string;
}

const LOCKFILE_NAME = "pnpm-lock.yaml";
const BOOTSTRAP_COMMAND = "pnpm install --frozen-lockfile";

function computeLockfileDigest(worktreePath: string): string | undefined {
  try {
    const contents = fs.readFileSync(path.join(worktreePath, LOCKFILE_NAME));
    return crypto.createHash("sha256").update(contents).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * bootstrapMode に応じて bootstrap コマンドの実行可否を決定する。`conditional` は
 * 呼び出し側が宣言した `expectedInputDigest`（例: 事前に承認されたロックファイルの
 * sha256）と実際のロックファイル内容が一致する場合のみ実行を許可する — これにより
 * 「呼び出し側が想定していないロックファイル内容では自動実行しない」制約を、
 * policy schema を拡張せず呼び出し時点の入力として表現する。
 */
export function decideBootstrap(mode: WorktreeRule["bootstrapMode"], worktreePath: string, expectedInputDigest?: string): BootstrapDecision {
  const digest = computeLockfileDigest(worktreePath);
  if (digest === undefined) {
    return { mode, command: undefined, shouldExecute: false, reason: `${LOCKFILE_NAME} not found; nothing to bootstrap` };
  }

  if (mode === "off") {
    return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: false, reason: "bootstrapMode is off" };
  }
  if (mode === "suggest") {
    return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: false, reason: "bootstrapMode is suggest; caller must run the command explicitly" };
  }
  if (mode === "automatic") {
    return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: true, reason: "bootstrapMode is automatic" };
  }

  // conditional
  if (expectedInputDigest === undefined) {
    return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: false, reason: "bootstrapMode is conditional but no expectedInputDigest was declared" };
  }
  if (expectedInputDigest !== digest) {
    return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: false, reason: "lockfile digest does not match the declared expectedInputDigest" };
  }
  return { mode, command: BOOTSTRAP_COMMAND, shouldExecute: true, reason: "lockfile digest matches the declared expectedInputDigest" };
}

export interface RunBootstrapResult {
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const BOOTSTRAP_TIMEOUT_MS = 120_000;
const BOOTSTRAP_MAX_OUTPUT_BYTES = 256 * 1024;
const BOOTSTRAP_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TMPDIR", "NODE_ENV"] as const;

function buildBootstrapEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BOOTSTRAP_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** bootstrap command を allowlist のみの環境変数で実行する。secrets の無断継承を防ぐため、
 * `process.env` をそのまま渡さず必要最小限のキーだけ明示的にコピーする。 */
export async function runBootstrap(worktreePath: string, command: string): Promise<RunBootstrapResult> {
  const [program, ...args] = command.split(" ");
  const result = await runProgram(program, args, worktreePath, BOOTSTRAP_TIMEOUT_MS, BOOTSTRAP_MAX_OUTPUT_BYTES, buildBootstrapEnv());
  return { ran: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export interface WorktreeCollisionCheck {
  pathCollision: boolean;
  branchCollision: boolean;
  staleMetadata: WorktreeRecord[];
}

/**
 * git worktree add を実行する前の事前チェック。branch/path 衝突は UNIQUE index
 * （store.reserveWorktree）が最終的な保証だが、ここで先に読み取り専用チェックする
 * ことで、無駄な git 呼び出しを避けられる。staleMetadata（status='active' だが
 * 実体が無い worktree）は advisory 情報として返すのみでブロックしない — 自動修復は
 * Child Issue 7/8 の範囲であり、ここで手を出すと reconciliation の責務と重複する。
 */
export function detectWorktreeCollisions(
  store: WorkflowStateStore,
  instanceId: RepositoryInstanceId,
  branchName: string,
  canonicalPathCandidate: string,
): WorktreeCollisionCheck {
  const staleMetadata: WorktreeRecord[] = [];
  let pathCollision = false;
  let branchCollision = false;

  for (const worktree of store.listWorktreesForInstance(instanceId)) {
    if (worktree.status !== "active") continue;
    if (!fs.existsSync(worktree.canonicalPath)) {
      staleMetadata.push(worktree);
      continue;
    }
    if (worktree.branchName === branchName) branchCollision = true;
    if (worktree.canonicalPath === canonicalPathCandidate) pathCollision = true;
  }

  return { pathCollision, branchCollision, staleMetadata };
}
