import path from "node:path";
import { runProgram } from "../../subprocess.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type { WorkflowStateStore, TaskId, TaskRecord, WorktreeRecord } from "../state/store.js";
import { buildWorktreeNaming, createWorktree, decideBootstrap, detectWorktreeCollisions, runBootstrap } from "../git/worktree.js";
import type { BootstrapDecision } from "../git/worktree.js";
import { resolveRepositoryIdentity } from "./identity.js";
import { resolveRepoState } from "./repo-state.js";
import { validateTransition, allowedNextTransitions } from "./lifecycle.js";
import type { LifecycleState, TransitionBlockedInfo } from "./lifecycle.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

/** baseBranch の現在の tip commit を解決する。予約時点の base_commit を確定するために
 * 使う（`createWorktree` 成功後の実際の worktree HEAD とは別に、予約時点の意図を記録する）。 */
async function resolveBaseCommit(workspaceRoot: string, baseBranch: string): Promise<string | undefined> {
  const result = await runProgram("git", ["rev-parse", "--verify", "-q", baseBranch], workspaceRoot, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return undefined;
  return result.stdout.trim();
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
  | "git-worktree-add-failed";

export type StartTaskResult =
  | { ok: true; task: TaskRecord; worktree: WorktreeRecord | undefined; bootstrap: BootstrapDecision | undefined }
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
    return { ok: true, task: activated, worktree: undefined, bootstrap: undefined };
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
  if (bootstrap.shouldExecute && bootstrap.command !== undefined) {
    // bootstrap 失敗は worktree/task のロールバック対象にしない — worktree 自体は
    // 正当に作成済みであり、bootstrap は利便性のための追加ステップに過ぎない。
    // 呼び出し側が結果を見て再実行するかどうかを判断する。
    await runBootstrap(createResult.canonicalPath, bootstrap.command);
  }

  return { ok: true, task: activeTask, worktree: activeWorktree, bootstrap };
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
