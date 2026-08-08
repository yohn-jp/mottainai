import path from "node:path";
import { runProgram } from "../../subprocess.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type { WorkflowStateStore, TaskId, TaskRecord, WorktreeRecord } from "../state/store.js";
import { buildWorktreeNaming, createWorktree, decideBootstrap, detectWorktreeCollisions, runBootstrap } from "../git/worktree.js";
import type { BootstrapDecision, RunBootstrapResult } from "../git/worktree.js";
import { resolveRepositoryIdentity } from "./identity.js";
import type { RepositoryInstanceId } from "./identity.js";
import { resolveRepoState } from "./repo-state.js";
import type { RepoStateKind } from "./repo-state.js";
import { validateTransition, allowedNextTransitions } from "./lifecycle.js";
import type { LifecycleState, TransitionBlockedInfo } from "./lifecycle.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

interface GitOutcome {
  /** コマンドが完走し exit code 0 だった。 */
  ok: boolean;
  stdout: string;
  /** コマンドが完走した（spawn 失敗・timeout・output-limit のいずれでもない）。false の場合、
   * `ok: false` は「exit code が非 0」を意味しない — 呼び出し側は状態を確定させてはならない。
   * `src/workflow/domain/repo-state.ts` の同名パターンと同じ理由（timeout を「非0」と混同しない）。 */
  usable: boolean;
}

async function git(args: string[], cwd: string): Promise<GitOutcome> {
  const result = await runProgram("git", args, cwd, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  const usable = result.spawnError === undefined && !result.timedOut && !result.outputLimit && result.exitCode !== null;
  return { ok: usable && result.exitCode === 0, stdout: result.stdout.trim(), usable };
}

/** baseBranch の現在の tip commit を解決する。予約時点の base_commit を確定するために
 * 使う（`createWorktree` 成功後の実際の worktree HEAD とは別に、予約時点の意図を記録する）。 */
async function resolveBaseCommit(workspaceRoot: string, baseBranch: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--verify", "-q", baseBranch], workspaceRoot);
  if (!result.usable || !result.ok || result.stdout.length === 0) return undefined;
  return result.stdout;
}

export type StaleBaseBranchCheck =
  | { kind: "fresh" }
  | { kind: "stale"; remoteCommit: string }
  /** origin tracking ref が存在しない（origin に同名ブランチがない、detached HEAD 等）。
   * 判定対象外 — stale とは異なり、そもそも比較材料がない。 */
  | { kind: "unavailable"; reason: string }
  /** git 呼び出しが完走しなかった（spawn 失敗・timeout・output-limit）ため stale かどうか
   * 判定できなかった。呼び出し側は enforce では fail-closed（block）、advisory では
   * fail-open ＋ diagnostic とすること。 */
  | { kind: "unknown"; reason: string };

/** baseBranch のローカル tip が `origin/<baseBranch>` の tip より古くないか検証する。
 * fetch は行わない（副作用を避けるため） — 呼び出し側が事前に fetch している前提で、
 * ローカルの認識している origin tracking ref とだけ比較する。 */
export async function checkStaleBaseBranch(workspaceRoot: string, baseBranch: string, baseCommit: string): Promise<StaleBaseBranchCheck> {
  const remoteRef = `origin/${baseBranch}`;
  const remoteRefResult = await git(["rev-parse", "--verify", "-q", remoteRef], workspaceRoot);
  if (!remoteRefResult.usable) return { kind: "unknown", reason: `git rev-parse --verify ${remoteRef} did not complete` };
  if (!remoteRefResult.ok || remoteRefResult.stdout.length === 0) {
    return { kind: "unavailable", reason: `no tracking ref ${remoteRef}` };
  }
  const remoteCommit = remoteRefResult.stdout;
  if (remoteCommit === baseCommit) return { kind: "fresh" };

  const ancestryResult = await git(["merge-base", "--is-ancestor", baseCommit, remoteCommit], workspaceRoot);
  if (!ancestryResult.usable) return { kind: "unknown", reason: "git merge-base --is-ancestor did not complete" };
  // baseCommit が remoteCommit の祖先なら、ローカルは origin より単純に遅れている（stale）。
  // 祖先でなければ（分岐 or ローカルが進んでいる）判定対象外とし、誤検知を避ける。
  if (!ancestryResult.ok) return { kind: "fresh" };
  return { kind: "stale", remoteCommit };
}

/**
 * task start/status domain service（Issue #28 Child 4）。MCP/CLI 配線は
 * この Issue の対象外（Child 4.5/9a）— ここは純粋な domain 層で、
 * `src/envelope.ts` の output() 形式には依存しない。
 */

const DEFAULT_WORKTREE_DIR_RELATIVE = ".worktrees";

export interface StartTaskInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  policy: WorkflowPolicyDocument;
  taskSlug: string;
  issueRef?: string;
  /** worktree.required が off の場合のみ、呼び出し側が worktree 不要と明示できる。 */
  skipWorktree?: boolean;
  expectedLockfileDigest?: string;
  worktreeDirRelative?: string;
}

export type StartTaskFailureReason =
  | "unsupported-repo-state"
  | "policy-denied"
  | "issue-required"
  | "issue-already-claimed"
  | "branch-collision"
  | "path-collision"
  | "active-task-in-workspace"
  | "git-worktree-add-failed";

export interface StartTaskWarning {
  code: "stale-base-branch" | "stale-base-branch-check-unavailable";
  detail: string;
}

export type StartTaskResult =
  | {
      ok: true;
      task: TaskRecord;
      worktree: WorktreeRecord | undefined;
      bootstrap: BootstrapDecision | undefined;
      /** bootstrap.shouldExecute が true だった場合の実行結果。実行しなかった場合は undefined。 */
      bootstrapRun: RunBootstrapResult | undefined;
      /** policy.worktree.staleBaseBranch=advisory がブロックせず記録した guardrail 警告。
       * block しなかった場合は常に undefined を含む空配列ではなく undefined そのもの。 */
      warnings: StartTaskWarning[];
    }
  | { ok: false; reason: StartTaskFailureReason; detail: string };

function allowsMultipleActiveTasksPerIssue(policy: WorkflowPolicyDocument): boolean {
  const mode = policy.worktree.multipleActiveTasksPerIssue;
  return mode === "off" || mode === "advisory";
}

/**
 * task を開始する。流れ: repository identity/state 解決 → issueRequired 判定 →
 * （worktree を作らない経路のみ）protected-branch の sourceWrite 判定 → 命名決定 →
 * 事前衝突チェック → task 予約 → worktree 予約 → `git worktree add` → activate →
 * lifecycle を active へ遷移 → bootstrap 判定/実行。
 *
 * 予約（DB トランザクション）と外部 git 呼び出しは分離されているため
 * （SQLite トランザクションは外部プロセス呼び出しをまたげない）、git 呼び出し失敗時は
 * 予約した行を補償削除する。二重の補償（worktree だけ、または worktree+task の両方）を
 * 呼び出し順の逆順で行うことで、途中失敗でも DB に reserved のまま取り残さない。
 */
/** instanceId+canonicalWorktreePath に一致する active worktree とその task を探す。
 * 「今いる物理 worktree はすでに別 task が使っているか」を判定する唯一の入口 —
 * `startTask` の重複開始拒否と `getTaskStatusForWorkspace` の現在地解決で共有する。 */
function findActiveTaskAtWorktreePath(
  store: WorkflowStateStore,
  instanceId: RepositoryInstanceId,
  canonicalWorktreePath: string,
): { task: TaskRecord | undefined; worktree: WorktreeRecord } | undefined {
  const worktree = store
    .listWorktreesForInstance(instanceId)
    .find((candidate) => candidate.status === "active" && candidate.canonicalPath === canonicalWorktreePath);
  if (worktree === undefined) return undefined;
  // task が undefined でもここでは握りつぶさず返す — worktrees→tasks の FK 制約上
  // 起きないはずの状態だが、呼び出し元（startTask / getTaskStatusForWorkspace）に
  // 「見えない」ままにすると fail-closed の意図が死ぬ。
  return { task: store.getTask(worktree.taskId), worktree };
}

export async function startTask(input: StartTaskInput): Promise<StartTaskResult> {
  const { workspaceRoot, store, policy, taskSlug, issueRef } = input;

  const identityResult = resolveRepositoryIdentity(workspaceRoot);
  if (!identityResult.ok) {
    return { ok: false, reason: "unsupported-repo-state", detail: identityResult.reason };
  }
  const repoStateResult = await resolveRepoState(workspaceRoot);
  if (!repoStateResult.ok) {
    return { ok: false, reason: "unsupported-repo-state", detail: repoStateResult.reason };
  }
  if (!repoStateResult.state.supported) {
    return { ok: false, reason: "unsupported-repo-state", detail: repoStateResult.state.reason };
  }

  // 呼び出し元の cwd がそれ自体すでに別 task の active worktree である場合、ここで
  // 新規 task を予約すると同じ物理 worktree に矛盾する2つの active task が
  // 存在しうる（ネストした worktree を作る、または no-worktree task を重ねる）。
  // policy 判定より前に、無条件で fail-closed に拒否する。
  const conflicting = findActiveTaskAtWorktreePath(store, identityResult.identity.instanceId, identityResult.identity.worktreePath);
  if (conflicting !== undefined) {
    const taskDescription = conflicting.task !== undefined
      ? `taskId=${conflicting.task.taskId}`
      : `worktreeId=${conflicting.worktree.worktreeId} references a task missing from the store`;
    return {
      ok: false,
      reason: "active-task-in-workspace",
      detail: `this worktree already has an active task (${taskDescription}); finish or abandon it before starting another task here`,
    };
  }

  if ((policy.worktree.issueRequired === "enforce" || policy.worktree.issueRequired === "confirm") && issueRef === undefined) {
    return { ok: false, reason: "issue-required", detail: `policy.worktree.issueRequired=${policy.worktree.issueRequired} but no issueRef was provided` };
  }

  const wantsWorktree = policy.worktree.required !== "off" || input.skipWorktree !== true;

  if (!wantsWorktree) {
    const decision = decideProtectedBranchOperation({
      policy,
      branch: repoStateResult.state.branch,
      operation: "sourceWrite",
      repository: { isPrimaryCheckout: repoStateResult.state.isPrimaryCheckout },
    });
    if (!decision.allowed) {
      return { ok: false, reason: "policy-denied", detail: `sourceWrite denied on branch ${repoStateResult.state.branch ?? "(detached)"}: ${decision.reason}` };
    }
  } else {
    // worktree management は control-plane role に関わらず常に許可される操作。
    // ここでの呼び出しは判定記録を残す目的であり、結果は常に allowed=true になる
    // （decideProtectedBranchOperation の control-plane-management-allowed 経路）。
    decideProtectedBranchOperation({
      policy,
      branch: repoStateResult.state.branch,
      operation: "worktreeManagement",
      repository: { isPrimaryCheckout: repoStateResult.state.isPrimaryCheckout },
    });
  }

  // tasks/worktrees の instance_id は repository_instances への FK 制約を持つため、
  // 予約前に必ず observeRepositoryInstance で instance 行を確立しておく
  // （初回呼び出しの repository ではまだ行が存在しない）。
  store.observeRepositoryInstance({
    rootCommitDigest: identityResult.identity.rootCommitDigest,
    instanceId: identityResult.identity.instanceId,
    gitCommonDir: identityResult.identity.gitCommonDir,
    canonicalWorktreePath: identityResult.identity.worktreePath,
  });

  const instanceId = identityResult.identity.instanceId;
  const baseBranch = repoStateResult.state.branch ?? "HEAD";
  const baseCommit = await resolveBaseCommit(workspaceRoot, baseBranch);
  if (baseCommit === undefined) {
    return { ok: false, reason: "unsupported-repo-state", detail: `cannot resolve tip commit of ${baseBranch}` };
  }

  const warnings: StartTaskWarning[] = [];
  if (policy.worktree.staleBaseBranch === "enforce" || policy.worktree.staleBaseBranch === "advisory") {
    const staleness = await checkStaleBaseBranch(workspaceRoot, baseBranch, baseCommit);
    // enforce は判定不能（unknown）を fail-closed で block する — 「判定に失敗した」を
    // 「stale ではない」とみなさない（timeout/spawn 失敗を fresh と誤認しない）。
    // advisory は unknown/stale いずれも block せず、guardrail warning として記録するのみ。
    if (staleness.kind === "stale") {
      const detail = `local ${baseBranch} (${baseCommit}) is behind origin/${baseBranch} (${staleness.remoteCommit}); fetch and update before starting a task`;
      if (policy.worktree.staleBaseBranch === "enforce") {
        return { ok: false, reason: "unsupported-repo-state", detail };
      }
      warnings.push({ code: "stale-base-branch", detail });
    } else if (staleness.kind === "unknown") {
      const detail = `could not determine whether ${baseBranch} is behind origin/${baseBranch}: ${staleness.reason}`;
      if (policy.worktree.staleBaseBranch === "enforce") {
        return { ok: false, reason: "unsupported-repo-state", detail };
      }
      warnings.push({ code: "stale-base-branch-check-unavailable", detail });
    }
  }

  if (!wantsWorktree) {
    const reserveResult = store.reserveTask({
      instanceId,
      taskSlug,
      issueRef,
      baseBranch,
      baseCommit,
      allowMultipleActiveTasksPerIssue: allowsMultipleActiveTasksPerIssue(policy),
    });
    if (!reserveResult.ok) {
      return { ok: false, reason: "issue-already-claimed", detail: `issue ${issueRef} is already claimed by task ${reserveResult.existingTask.taskId}` };
    }
    const activated = store.updateTaskLifecycleState(reserveResult.task.taskId, "active");
    return { ok: true, task: activated, worktree: undefined, bootstrap: undefined, bootstrapRun: undefined, warnings };
  }

  const worktreeDirRelative = input.worktreeDirRelative ?? DEFAULT_WORKTREE_DIR_RELATIVE;
  const naming = buildWorktreeNaming(taskSlug, issueRef, worktreeDirRelative);

  // identity.worktreePath は resolveRepositoryIdentity 側で fs.realpathSync.native 済みの
  // canonicalized path。createWorktree が成功時に返す canonicalPath（同じく realpathSync.native）
  // と食い違わないよう、予約時点の候補パスもここから計算する（workspaceRoot の生入力ではなく）。
  const candidateCanonicalPath = path.resolve(identityResult.identity.worktreePath, naming.relativePath);
  const collisions = detectWorktreeCollisions(store, instanceId, naming.branchName, candidateCanonicalPath);
  if (collisions.branchCollision) {
    return { ok: false, reason: "branch-collision", detail: `branch ${naming.branchName} is already claimed by an active worktree` };
  }
  if (collisions.pathCollision) {
    return { ok: false, reason: "path-collision", detail: `path ${naming.relativePath} is already claimed by an active worktree` };
  }

  const reserveTaskResult = store.reserveTask({
    instanceId,
    taskSlug,
    issueRef,
    baseBranch,
    baseCommit,
    allowMultipleActiveTasksPerIssue: allowsMultipleActiveTasksPerIssue(policy),
  });
  if (!reserveTaskResult.ok) {
    return { ok: false, reason: "issue-already-claimed", detail: `issue ${issueRef} is already claimed by task ${reserveTaskResult.existingTask.taskId}` };
  }
  const task = reserveTaskResult.task;

  const reserveWorktreeResult = store.reserveWorktree({
    taskId: task.taskId,
    instanceId,
    branchName: naming.branchName,
    canonicalPath: candidateCanonicalPath,
    baseBranch,
    baseCommit,
  });
  if (!reserveWorktreeResult.ok) {
    store.deleteReservedTask(task.taskId);
    return {
      ok: false,
      reason: reserveWorktreeResult.reason === "branch-collision" ? "branch-collision" : "path-collision",
      detail: `${reserveWorktreeResult.reason} against worktree ${reserveWorktreeResult.existingWorktree.worktreeId}`,
    };
  }
  const reservedWorktree = reserveWorktreeResult.worktree;

  const createResult = await createWorktree({ workspaceRoot, naming, baseBranch });
  if (!createResult.ok) {
    store.deleteReservedWorktree(reservedWorktree.worktreeId);
    store.deleteReservedTask(task.taskId);
    return { ok: false, reason: "git-worktree-add-failed", detail: createResult.detail };
  }

  const activeWorktree = store.activateWorktree(reservedWorktree.worktreeId);
  const activeTask = store.updateTaskLifecycleState(task.taskId, "active");

  const bootstrap = decideBootstrap(policy.worktree.bootstrapMode, createResult.canonicalPath, input.expectedLockfileDigest);
  let bootstrapRun: RunBootstrapResult | undefined;
  if (bootstrap.shouldExecute && bootstrap.command !== undefined) {
    // bootstrap 失敗は worktree/task のロールバック対象にしない — worktree 自体は
    // 正当に作成済みであり、bootstrap は利便性のための追加ステップに過ぎない。
    // 実行結果は bootstrapRun として呼び出し側に返し、再実行の要否を判断できるようにする。
    bootstrapRun = await runBootstrap(createResult.canonicalPath, bootstrap.command);
  }

  return { ok: true, task: activeTask, worktree: activeWorktree, bootstrap, bootstrapRun, warnings };
}

export interface TaskStatusResult {
  task: TaskRecord;
  worktrees: WorktreeRecord[];
  allowedNextTransitions: LifecycleState[];
}

export function getTaskStatus(store: WorkflowStateStore, taskId: TaskId): TaskStatusResult | undefined {
  const task = store.getTask(taskId);
  if (task === undefined) return undefined;
  return {
    task,
    worktrees: store.listWorktreesForTask(taskId),
    allowedNextTransitions: allowedNextTransitions(task.lifecycleState),
  };
}

export type TransitionTaskResult = { ok: true; task: TaskRecord } | { ok: false; blocked: TransitionBlockedInfo };

export function transitionTask(store: WorkflowStateStore, taskId: TaskId, to: LifecycleState): TransitionTaskResult {
  const task = store.getTask(taskId);
  if (task === undefined) throw new Error(`task not found: ${taskId}`);
  const validation = validateTransition(task.lifecycleState, to);
  if (!validation.allowed) return { ok: false, blocked: validation.blocked };
  return { ok: true, task: store.updateTaskLifecycleState(taskId, to) };
}

export interface WorkspaceGuardrailWarning {
  code: string;
  detail: string;
}

/** `getTaskStatusForWorkspace` の cwd 解決結果。task の有無に関わらず常に埋まる、
 * 「今どこにいるか」の基本情報（MCP/CLI 側が task id を知らなくても呼べるための土台）。 */
interface WorkspaceLocation {
  instanceId: RepositoryInstanceId;
  worktreePath: string;
  branch: string | undefined;
  repoStateKind: RepoStateKind;
  warnings: WorkspaceGuardrailWarning[];
}

export type WorkspaceTaskStatusResult =
  | ({ ok: true; active: true; status: TaskStatusResult } & WorkspaceLocation)
  | ({ ok: true; active: false } & WorkspaceLocation)
  | { ok: false; reason: string };

/**
 * taskId を持たない呼び出し側（MCP/CLI）のための入口。cwd から repository
 * identity・repo state・「この物理 worktree に active task があるか」を副作用なく
 * 解決する（`observeRepositoryInstance` は呼ばない — instance/path の観測記録は
 * `startTask` の責務であり、`status` は読み取り専用のまま保つ）。
 *
 * git/repository の検出自体が失敗した場合（非 git ディレクトリ、git 呼び出しが
 * 完走しない等）は `ok: false` で fail-closed にする — 「たぶんこの repository」で
 * 推測して続行しない。detached HEAD 等の未サポート状態は `ok: true` のまま
 * `warnings` に記録する（task が無いこと自体は正常系のため）。
 */
export async function getTaskStatusForWorkspace(workspaceRoot: string, store: WorkflowStateStore): Promise<WorkspaceTaskStatusResult> {
  const identityResult = resolveRepositoryIdentity(workspaceRoot);
  if (!identityResult.ok) return { ok: false, reason: identityResult.reason };

  const repoStateResult = await resolveRepoState(workspaceRoot);
  if (!repoStateResult.ok) return { ok: false, reason: repoStateResult.reason };

  const warnings: WorkspaceGuardrailWarning[] = [];
  if (!repoStateResult.state.supported) {
    warnings.push({ code: `unsupported-repo-state:${repoStateResult.state.kind}`, detail: repoStateResult.state.reason });
  }

  const location: WorkspaceLocation = {
    instanceId: identityResult.identity.instanceId,
    worktreePath: identityResult.identity.worktreePath,
    branch: repoStateResult.state.branch,
    repoStateKind: repoStateResult.state.kind,
    warnings,
  };

  const found = findActiveTaskAtWorktreePath(store, identityResult.identity.instanceId, identityResult.identity.worktreePath);
  if (found === undefined) {
    return { ok: true, active: false, ...location };
  }
  if (found.task === undefined) {
    return { ok: false, reason: `active worktree ${found.worktree.worktreeId} references task ${found.worktree.taskId}, which is missing from the store` };
  }

  // found.task は既に store.getTask() 済みなので、getTaskStatus() で同じ id を
  // 再取得する必要はない（その場合の「missing from the store」は既に上で判定済み）。
  const status: TaskStatusResult = {
    task: found.task,
    worktrees: store.listWorktreesForTask(found.task.taskId),
    allowedNextTransitions: allowedNextTransitions(found.task.lifecycleState),
  };
  return { ok: true, active: true, status, ...location };
}
