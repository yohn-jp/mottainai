import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runProgram } from "../../subprocess.js";
import type { RunResult } from "../../subprocess.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type { WorktreeRule } from "../policy/schema.js";
import type { WorkflowStateStore, WorktreeRecord } from "../state/store.js";

/** `subprocess.ts` の `runProgram` と同一の呼び出し形。fault-injection テストが
 * `git worktree add` 成功直後の検証失敗を決定論的に再現できるよう、
 * `createWorktree`/`compensatePhysicalWorktree` は既定でこの実装を使いつつ、
 * 呼び出し側から差し替え可能にしておく（本番動作は変えない）。 */
export type GitRunner = (
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env?: NodeJS.ProcessEnv,
) => Promise<RunResult>;

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

export class WorktreeNamingError extends Error {
  readonly code = "duplicated-issue-identity";

  constructor(message: string) {
    super(message);
    this.name = "WorktreeNamingError";
  }
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
 *
 * 複数プロセスが同時に同じ segment を初回作成しうる（task workflow の並行 start）ため、
 * mkdirSync が EEXIST で失敗しても異常とはせず、他プロセスが作った実体を同じ symlink
 * 検証にかけてから続行する。
 */
function ensureCanonicalDirectorySegment(parentCanonical: string, segmentName: string): ManagedWorktreeRootResult {
  const target = path.join(parentCanonical, segmentName);
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        fs.mkdirSync(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    } else if (stat.isSymbolicLink()) {
      return { ok: false, detail: `managed worktree root resolves outside its canonical path: ${target}` };
    } else if (!stat.isDirectory()) {
      return { ok: false, detail: `managed worktree path segment is not a directory: ${target}` };
    }

    // mkdir 直後に他プロセスが symlink へ差し替えている可能性もゼロではないため、
    // mkdir 成功/EEXIST いずれの経路でも symlink チェックを lstat からやり直す。
    const postStat = fs.lstatSync(target);
    if (postStat.isSymbolicLink()) {
      return { ok: false, detail: `managed worktree root resolves outside its canonical path: ${target}` };
    }
    if (!postStat.isDirectory()) {
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
 * `<type>/<issue>-<slug>` 候補へ射影する。同じIssue identityをslugの先頭に
 * 重複させた候補だけは、意味が変わるため投影前に拒否する。 */
export function buildWorktreeNaming(input: WorktreeNamingInput): WorktreeNaming {
  if (input.taskSlug === input.issueRef || input.taskSlug.startsWith(`${input.issueRef}-`)) {
    throw new WorktreeNamingError(
      `task slug "${input.taskSlug}" repeats issue identity "${input.issueRef}"; use a descriptive slug without the issue prefix`,
    );
  }
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
  /** Canonical Git common-dir captured from the repository identity before creation. */
  expectedGitCommonDir: string;
  /** テスト専用のfault-injectionフック。省略時は実際の `runProgram` を使う。 */
  runProgram?: GitRunner;
}

export type CreateWorktreeResult =
  | { ok: true; canonicalPath: string; baseCommit: string }
  | {
      ok: false;
      reason: "git-worktree-add-failed";
      detail: string;
      compensation?: CompensatePhysicalWorktreeResult;
    };

function firstLine(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : trimmed.split("\n")[0];
}

export interface CompensatePhysicalWorktreeResult {
  /** true なら `git worktree remove` と `git branch -D` の両方が成功した — 物理的な
   * 残留は無い。false の場合、呼び出し側は detail を診断/reconciliation に伝えること。 */
  compensated: boolean;
  detail?: string;
}

export interface CompensatePhysicalWorktreeInput {
  /** Canonical repository root captured from the repository identity authority. */
  canonicalRepositoryRoot: string;
  /** Canonical Git common-dir captured before the physical object was created. */
  expectedGitCommonDir: string;
  /** Canonical worktree path captured immediately after creation. */
  worktreePath: string;
  /** Branch created by the failed operation. */
  branchName: string;
  /** HEAD/base commit recorded immediately after creation. */
  expectedHead: string;
}

interface RegisteredWorktree {
  path: string;
  head: string;
  branch: string | undefined;
}

function commandFailure(label: string, result: RunResult): string {
  return `${label} failed: ${firstLine(result.stderr || result.stdout || result.spawnError || "") ?? "unknown error"}`;
}

async function runGitCommand(run: GitRunner, args: string[], cwd: string): Promise<RunResult> {
  try {
    return await run("git", args, cwd, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message, exitCode: null, signal: null, timedOut: false, outputLimit: false, spawnError: message };
  }
}

function canonicalGitPath(cwd: string, value: string): string | undefined {
  try {
    return fs.realpathSync.native(path.resolve(cwd, value.trim()));
  } catch {
    return undefined;
  }
}

function sameGitObject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current);
      current = { path: line.slice("worktree ".length), head: "", branch: undefined };
    } else if (current !== undefined && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== undefined && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

async function verifyPhysicalWorktreeIdentity(
  input: CompensatePhysicalWorktreeInput,
  run: GitRunner,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const expectedRoot = canonicalGitPath(input.canonicalRepositoryRoot, input.canonicalRepositoryRoot);
  const expectedCommonDir = canonicalGitPath(input.canonicalRepositoryRoot, input.expectedGitCommonDir);
  if (expectedRoot === undefined || expectedCommonDir === undefined) {
    return {
      ok: false,
      detail: `refusing compensation: expected repository identity is not canonical or no longer exists (root=${input.canonicalRepositoryRoot} common-dir=${input.expectedGitCommonDir})`,
    };
  }

  const registrationResult = await runGitCommand(run, ["worktree", "list", "--porcelain"], input.canonicalRepositoryRoot);
  if (registrationResult.exitCode !== 0) {
    return { ok: false, detail: `refusing compensation: cannot verify Git worktree registration (${commandFailure("git worktree list", registrationResult)})` };
  }
  const expectedPath = canonicalGitPath(input.canonicalRepositoryRoot, input.worktreePath);
  if (expectedPath === undefined) {
    return {
      ok: false,
      detail: `refusing compensation: expected worktree path is not canonical or no longer exists at ${input.worktreePath}; physical object left intact`,
    };
  }
  const registration = parseRegisteredWorktrees(registrationResult.stdout).find(
    (entry) => canonicalGitPath(input.canonicalRepositoryRoot, entry.path) === expectedPath,
  );
  if (registration === undefined) {
    return {
      ok: false,
      detail: `refusing compensation: expected worktree is not registered at canonical path ${input.worktreePath}; physical object left intact`,
    };
  }
  const expectedBranch = `refs/heads/${input.branchName}`;
  if (registration.branch !== expectedBranch) {
    return {
      ok: false,
      detail: `refusing compensation: registered branch at ${input.worktreePath} is ${registration.branch ?? "detached"}, expected ${expectedBranch}; physical object left intact`,
    };
  }
  if (!sameGitObject(registration.head, input.expectedHead)) {
    return {
      ok: false,
      detail: `refusing compensation: registered HEAD at ${input.worktreePath} is ${registration.head || "unknown"}, expected ${input.expectedHead}; physical object left intact`,
    };
  }

  const repositoryCommonDirResult = await runGitCommand(
    run,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    input.canonicalRepositoryRoot,
  );
  if (repositoryCommonDirResult.exitCode !== 0) {
    return { ok: false, detail: `refusing compensation: cannot verify repository identity (${commandFailure("git rev-parse --git-common-dir", repositoryCommonDirResult)})` };
  }
  const repositoryCommonDir = canonicalGitPath(input.canonicalRepositoryRoot, repositoryCommonDirResult.stdout);
  if (repositoryCommonDir !== expectedCommonDir) {
    return {
      ok: false,
      detail: `refusing compensation: repository common-dir changed from ${expectedCommonDir} to ${repositoryCommonDir ?? "unknown"}; physical object left intact`,
    };
  }

  const worktreeCommonDirResult = await runGitCommand(
    run,
    ["-C", input.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    input.canonicalRepositoryRoot,
  );
  if (worktreeCommonDirResult.exitCode !== 0) {
    return { ok: false, detail: `refusing compensation: cannot verify target repository identity (${commandFailure("target git rev-parse --git-common-dir", worktreeCommonDirResult)}); physical object left intact` };
  }
  const worktreeCommonDir = canonicalGitPath(input.worktreePath, worktreeCommonDirResult.stdout);
  if (worktreeCommonDir !== expectedCommonDir) {
    return {
      ok: false,
      detail: `refusing compensation: target worktree belongs to Git common-dir ${worktreeCommonDir ?? "unknown"}, expected ${expectedCommonDir}; physical object left intact`,
    };
  }

  const worktreeRootResult = await runGitCommand(
    run,
    ["-C", input.worktreePath, "rev-parse", "--path-format=absolute", "--show-toplevel"],
    input.canonicalRepositoryRoot,
  );
  if (worktreeRootResult.exitCode !== 0) {
    return { ok: false, detail: `refusing compensation: cannot verify target repository root (${commandFailure("target git rev-parse --show-toplevel", worktreeRootResult)}); physical object left intact` };
  }
  const worktreeRoot = canonicalGitPath(input.worktreePath, worktreeRootResult.stdout);
  if (worktreeRoot !== expectedRoot && worktreeRoot !== expectedPath) {
    return {
      ok: false,
      detail: `refusing compensation: target worktree root is ${worktreeRoot ?? "unknown"}, expected ${expectedRoot}; physical object left intact`,
    };
  }

  const checkedOutBranchResult = await runGitCommand(
    run,
    ["-C", input.worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
    input.canonicalRepositoryRoot,
  );
  if (checkedOutBranchResult.exitCode !== 0 || checkedOutBranchResult.stdout.trim() !== input.branchName) {
    return {
      ok: false,
      detail: `refusing compensation: checked-out branch is ${checkedOutBranchResult.stdout.trim() || "detached/unavailable"}, expected ${input.branchName}; physical object left intact`,
    };
  }

  const targetHeadResult = await runGitCommand(
    run,
    ["-C", input.worktreePath, "rev-parse", "HEAD"],
    input.canonicalRepositoryRoot,
  );
  if (targetHeadResult.exitCode !== 0 || !sameGitObject(targetHeadResult.stdout, input.expectedHead)) {
    return {
      ok: false,
      detail: `refusing compensation: target HEAD is ${targetHeadResult.stdout.trim() || "unknown"}, expected ${input.expectedHead}; physical object left intact`,
    };
  }

  const branchHeadResult = await runGitCommand(
    run,
    ["rev-parse", "--verify", `refs/heads/${input.branchName}`],
    input.canonicalRepositoryRoot,
  );
  if (branchHeadResult.exitCode !== 0 || !sameGitObject(branchHeadResult.stdout, input.expectedHead)) {
    return {
      ok: false,
      detail: `refusing compensation: branch ${input.branchName} points to ${branchHeadResult.stdout.trim() || "unknown"}, expected ${input.expectedHead}; physical object left intact`,
    };
  }

  const statusResult = await runGitCommand(
    run,
    ["-C", input.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"],
    input.canonicalRepositoryRoot,
  );
  if (statusResult.exitCode !== 0) {
    return { ok: false, detail: `refusing compensation: cannot verify target worktree cleanliness (${commandFailure("target git status", statusResult)}); physical object left intact` };
  }
  if (statusResult.stdout.trim().length > 0) {
    return { ok: false, detail: `refusing compensation: target worktree has uncommitted or untracked changes; physical object left intact` };
  }
  return { ok: true };
}

/**
 * `git worktree add` が物理的に成功した後、何らかの理由（HEAD 解決失敗、後段の DB
 * finalization 例外等）で処理を継続できなくなった場合の補償。作成済みの worktree
 * ディレクトリと、それに紐づく branch を取り除く（Issue #877 — `git worktree add` は
 * 呼び出した時点でディスク上に worktree/branch を作成済みであり、以降の検証/確定が
 * 失敗しても自動では取り消されない）。
 *
 * ベストエフォート: 失敗しても例外は投げず、呼び出し側が detail を診断や
 * reconciliation（`src/workflow/commands/reconcile.ts`）に渡せるよう構造化結果を返す。
 * `git worktree remove` を branch 削除より先に行う — branch が worktree に checkout
 * されたままだと `git branch -D` は拒否されるため。
 */
export async function compensatePhysicalWorktree(
  input: CompensatePhysicalWorktreeInput,
  run: GitRunner = runProgram,
): Promise<CompensatePhysicalWorktreeResult> {
  const identity = await verifyPhysicalWorktreeIdentity(input, run);
  if (!identity.ok) return { compensated: false, detail: identity.detail };

  const removeResult = await runGitCommand(
    run,
    ["worktree", "remove", "--force", input.worktreePath],
    input.canonicalRepositoryRoot,
  );
  if (removeResult.exitCode !== 0) {
    return {
      compensated: false,
      detail: `physical worktree was left intact; ${commandFailure("git worktree remove", removeResult)}`,
    };
  }

  // Re-check the branch ref after unregistering the worktree. A concurrent actor may have
  // reused or moved the branch while removal was in flight; never force-delete that branch.
  const branchHeadResult = await runGitCommand(
    run,
    ["rev-parse", "--verify", `refs/heads/${input.branchName}`],
    input.canonicalRepositoryRoot,
  );
  if (branchHeadResult.exitCode !== 0 || !sameGitObject(branchHeadResult.stdout, input.expectedHead)) {
    return {
      compensated: false,
      detail: `worktree was removed, but refusing branch deletion because ${input.branchName} now points to ${branchHeadResult.stdout.trim() || "unknown"} instead of ${input.expectedHead}; manual cleanup required`,
    };
  }

  const branchResult = await runGitCommand(
    run,
    ["branch", "-D", "--", input.branchName],
    input.canonicalRepositoryRoot,
  );
  if (branchResult.exitCode !== 0)
    return {
      compensated: false,
      detail: `worktree was removed but branch ${input.branchName} remains; ${commandFailure("git branch -D", branchResult)}; manual cleanup required`,
    };
  return { compensated: true };
}

/** `git worktree add` を実行する。失敗は throw せず構造化結果で返す（呼び出し元の
 * task.ts は branch/path を store.reserveTask/reserveWorktree で atomic に確保済みの
 * 前提で呼ぶが、DB に追跡されていない残留ディレクトリ等は依然ありうるため、
 * ここでも失敗経路を正常系として扱う）。
 *
 * `git worktree add` 自体が成功した後の検証失敗（realpath 解決／HEAD 解決）は、
 * ディスク上に worktree/branch を作成済みのまま `ok:false` を返すと呼び出し元にも
 * 補償手段が無い孤児状態になる（Issue #877）。ここで `compensatePhysicalWorktree` に
 * よる後始末まで行ってから失敗を返す。 */
export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const { canonicalRepositoryRoot, naming, baseCommit } = input;
  const run = input.runProgram ?? runProgram;
  const managedRoot = ensureCanonicalManagedWorktreeRoot(canonicalRepositoryRoot);
  if (!managedRoot.ok) return { ok: false, reason: "git-worktree-add-failed", detail: managedRoot.detail };
  const absolutePath = resolveCanonicalWorktreePath(canonicalRepositoryRoot, naming);
  const addResult = await run(
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
    const compensation = await compensatePhysicalWorktree(
      {
        canonicalRepositoryRoot,
        expectedGitCommonDir: input.expectedGitCommonDir,
        worktreePath: absolutePath,
        branchName: naming.branchName,
        expectedHead: baseCommit,
      },
      run,
    );
    const detail = `cannot resolve created worktree path: ${(err as Error).message}`;
    return {
      ok: false,
      reason: "git-worktree-add-failed",
      detail: compensation.compensated
        ? `${detail} (orphaned worktree/branch removed)`
        : `${detail}; COMPENSATION FAILED, manual cleanup required for worktree=${absolutePath} branch=${naming.branchName} (${compensation.detail})`,
      compensation,
    };
  }

  const headResult = await run("git", ["-C", canonicalPath, "rev-parse", "HEAD"], canonicalRepositoryRoot, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  if (headResult.exitCode !== 0 || headResult.stdout.trim().length === 0) {
    const compensation = await compensatePhysicalWorktree(
      {
        canonicalRepositoryRoot,
        expectedGitCommonDir: input.expectedGitCommonDir,
        worktreePath: canonicalPath,
        branchName: naming.branchName,
        expectedHead: baseCommit,
      },
      run,
    );
    const detail = "worktree created but HEAD could not be resolved";
    return {
      ok: false,
      reason: "git-worktree-add-failed",
      detail: compensation.compensated
        ? `${detail} (orphaned worktree/branch removed)`
        : `${detail}; COMPENSATION FAILED, manual cleanup required for worktree=${canonicalPath} branch=${naming.branchName} (${compensation.detail})`,
      compensation,
    };
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
