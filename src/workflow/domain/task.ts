import fs from "node:fs";
import { runProgram } from "../../subprocess.js";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type {
  LegacyPhysicalWorkflowStateStore,
  PullRequestRecord,
  WorkflowStateStore,
  TaskId,
  TaskRecord,
  WorktreeRecord,
} from "../state/store.js";
import {
  buildWorktreeNaming,
  createWorktree,
  decideBootstrap,
  ensureCanonicalManagedWorktreeRoot,
  resolveCanonicalWorktreePath,
  runBootstrap,
} from "../git/worktree.js";
import type { BootstrapDecision, RunBootstrapResult, WorktreeNaming } from "../git/worktree.js";
import { validateBranchNameAgainstGovernance } from "../governance/branch.js";
import { resolveRepositoryIdentity } from "./identity.js";
import type { RepositoryInstanceId } from "./identity.js";
import { resolveRepoState } from "./repo-state.js";
import type { RepoStateKind } from "./repo-state.js";
import { lifecycleTransitionStatus, validateTransition } from "./lifecycle.js";
import type { LifecycleState, TransitionBlockedInfo } from "./lifecycle.js";
import { verifyWorkflowContext } from "../git/context.js";
import type { WorkflowContextInput, VerifiedWorkflowContext } from "../git/context.js";
import type { PullRequest } from "../providers/model.js";
import { transitionTask } from "./task-lifecycle.js";
import type { NawabariExecutionClient } from "../nawabari.js";

export { transitionTask } from "./task-lifecycle.js";
export type { TransitionTaskResult } from "./task-lifecycle.js";

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
export async function checkStaleBaseBranch(
  workspaceRoot: string,
  baseBranch: string,
  baseCommit: string,
): Promise<StaleBaseBranchCheck> {
  const remoteRef = `origin/${baseBranch}`;
  const remoteRefResult = await git(["rev-parse", "--verify", "-q", remoteRef], workspaceRoot);
  if (!remoteRefResult.usable)
    return { kind: "unknown", reason: `git rev-parse --verify ${remoteRef} did not complete` };
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

export interface StartTaskInput {
  workspaceRoot: string;
  /** Legacy-only adapter; managed starts use `startNawabariTask`. */
  store: WorkflowStateStore & LegacyPhysicalWorkflowStateStore;
  policy: WorkflowPolicyDocument;
  taskSlug: string;
  /** governance branch candidate に明示的に渡す type。taskSlug から推測しない。 */
  branchType: string;
  issueRef?: string;
  /** worktree.required が off の場合のみ、呼び出し側が worktree 不要と明示できる。 */
  skipWorktree?: boolean;
  expectedLockfileDigest?: string;
  /** 同一task start再試行を既存結果へ束ねる、呼び出し側が保持する自然キー。 */
  idempotencyKey?: string;
}

export type StartTaskFailureReason =
  | "invalid-input"
  | "unsupported-repo-state"
  | "policy-denied"
  | "issue-required"
  | "issue-already-claimed"
  | "invalid-branch-name"
  | "branch-governance-unavailable"
  | "worktree-root-unavailable"
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
      /** 同一の生成branch/pathを再試行したため、既存taskを返した場合 true。 */
      reused?: boolean;
    }
  | { ok: false; reason: StartTaskFailureReason; detail: string };

type StartedTaskSuccess = Extract<StartTaskResult, { ok: true }>;

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

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

/**
 * task start の自然な冪等キー（repository instance + issue + slug + base + generated
 * worktree identity）に一致する、既に完全にactiveな結果だけを再利用する。部分予約や
 * branch/pathだけが一致する別入力は再利用せず、呼び出し側へcollisionを返す。
 */
function reusableStartedTask(
  store: WorkflowStateStore,
  task: TaskRecord,
  input: StartTaskInput,
  baseBranch: string,
  baseCommit: string,
  branchName: string | undefined,
  canonicalPath: string | undefined,
): StartedTaskSuccess | undefined {
  if (input.idempotencyKey === undefined) return undefined;
  if (
    task.lifecycleState !== "active" ||
    task.taskSlug !== input.taskSlug ||
    task.startIdempotencyKey !== input.idempotencyKey ||
    !sameOptional(task.issueRef, input.issueRef) ||
    task.baseBranch !== baseBranch ||
    task.baseCommit !== baseCommit
  )
    return undefined;
  const worktrees = store.listWorktreesForTask(task.taskId).filter((candidate) => candidate.status === "active");
  if (branchName === undefined || canonicalPath === undefined) {
    if (worktrees.length !== 0) return undefined;
    return {
      ok: true,
      task,
      worktree: undefined,
      bootstrap: undefined,
      bootstrapRun: undefined,
      warnings: [],
      reused: true,
    };
  }
  if (
    worktrees.length !== 1 ||
    worktrees[0]?.branchName !== branchName ||
    worktrees[0]?.canonicalPath !== canonicalPath
  )
    return undefined;
  return {
    ok: true,
    task,
    worktree: worktrees[0],
    bootstrap: undefined,
    bootstrapRun: undefined,
    warnings: [],
    reused: true,
  };
}

/**
 * @deprecated Legacy state/worktree reference path retained for migration and
 * regression evidence only. Production task entrypoints use NawabariTaskStart.
 */
export async function startTask(input: StartTaskInput): Promise<StartTaskResult> {
  const { workspaceRoot, store, policy, taskSlug, issueRef } = input;

  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey))
    return { ok: false, reason: "invalid-input", detail: "idempotencyKey must be a bounded branch-safe token" };

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
  const conflicting = findActiveTaskAtWorktreePath(
    store,
    identityResult.identity.instanceId,
    identityResult.identity.worktreePath,
  );
  if (conflicting !== undefined) {
    const taskDescription =
      conflicting.task !== undefined
        ? `taskId=${conflicting.task.taskId}`
        : `worktreeId=${conflicting.worktree.worktreeId} references a task missing from the store`;
    return {
      ok: false,
      reason: "active-task-in-workspace",
      detail: `this worktree already has an active task (${taskDescription}); finish or abandon it before starting another task here`,
    };
  }

  if (
    (policy.worktree.issueRequired === "enforce" || policy.worktree.issueRequired === "confirm") &&
    issueRef === undefined
  ) {
    return {
      ok: false,
      reason: "issue-required",
      detail: `policy.worktree.issueRequired=${policy.worktree.issueRequired} but no issueRef was provided`,
    };
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
      return {
        ok: false,
        reason: "policy-denied",
        detail: `sourceWrite denied on branch ${repoStateResult.state.branch ?? "(detached)"}: ${decision.reason}`,
      };
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

  const instanceId = identityResult.identity.instanceId;
  let naming: WorktreeNaming | undefined;
  let candidateCanonicalPath: string | undefined;

  // Git/DB mutation より先に、structured input から生成した候補を repository の
  // governance authority で検証する。ここで reject された候補は state にも Git にも
  // 到達しない。
  if (wantsWorktree) {
    if (issueRef === undefined) {
      return {
        ok: false,
        reason: "issue-required",
        detail: "task workflow worktree branches require an issueRef for the repository governance pattern",
      };
    }
    naming = buildWorktreeNaming({ branchType: input.branchType, issueRef, taskSlug });
    const branchValidation = await validateBranchNameAgainstGovernance(
      naming.branchName,
      identityResult.identity.canonicalRepositoryRoot,
    );
    if (!branchValidation.ok) {
      return {
        ok: false,
        reason: branchValidation.kind === "invalid" ? "invalid-branch-name" : "branch-governance-unavailable",
        detail: `generated branch ${naming.branchName} was rejected before Git mutation: ${branchValidation.detail}`,
      };
    }

    const managedRoot = ensureCanonicalManagedWorktreeRoot(identityResult.identity.canonicalRepositoryRoot);
    if (!managedRoot.ok) {
      return { ok: false, reason: "worktree-root-unavailable", detail: managedRoot.detail };
    }

    // caller worktree ではなく、identity が common-dir から検証した canonical root を
    // anchor にする。resolveCanonicalWorktreePath は createWorktree とも同じ解決関数を使う。
    //
    // ここでは branch/path の衝突を先読みしない（意図的）。DB 上の衝突チェックは
    // store.reserveTask/reserveWorktree の atomic な UNIQUE 制約違反経路に一本化する
    // — 2 プロセスが同一 branch/path で競合した場合、ロック無しの先読みは相手側の
    // `git worktree add`（ディスクへのディレクトリ作成）と原理的にレースし、
    // 本来 branch-collision であるべき理由を path-collision に誤判定しうる
    // （Issue #106）。fs.existsSync も同じ理由でここでは行わず、reserveWorktree で
    // このプロセスが branch/path を正当に確保した後、createWorktree 直前でのみ行う。
    candidateCanonicalPath = resolveCanonicalWorktreePath(identityResult.identity.canonicalRepositoryRoot, naming);
  }

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

  // tasks/worktrees の instance_id は repository_instances への FK 制約を持つため、
  // 予約前に必ず observeRepositoryInstance で instance 行を確立しておく
  // （初回呼び出しの repository ではまだ行が存在しない）。branch preflight 後に行う。
  store.observeRepositoryInstance({
    rootCommitDigest: identityResult.identity.rootCommitDigest,
    instanceId,
    gitCommonDir: identityResult.identity.gitCommonDir,
    canonicalWorktreePath: identityResult.identity.worktreePath,
  });

  if (!wantsWorktree) {
    const reserveResult = store.reserveTask({
      instanceId,
      taskSlug,
      issueRef,
      startIdempotencyKey: input.idempotencyKey,
      baseBranch,
      baseCommit,
      allowMultipleActiveTasksPerIssue: allowsMultipleActiveTasksPerIssue(policy),
    });
    if (!reserveResult.ok) {
      const reused = reusableStartedTask(
        store,
        reserveResult.existingTask,
        input,
        baseBranch,
        baseCommit,
        undefined,
        undefined,
      );
      if (reused !== undefined) return { ...reused, warnings };
      return {
        ok: false,
        reason: "issue-already-claimed",
        detail: `issue ${issueRef} is already claimed by task ${reserveResult.existingTask.taskId}`,
      };
    }
    const activated = store.updateTaskLifecycleState(reserveResult.task.taskId, "active");
    return { ok: true, task: activated, worktree: undefined, bootstrap: undefined, bootstrapRun: undefined, warnings };
  }

  // wantsWorktree=true の場合、上の preflight が naming/path を確定済み。
  if (naming === undefined || candidateCanonicalPath === undefined) {
    return {
      ok: false,
      reason: "unsupported-repo-state",
      detail: "worktree naming preflight did not produce a canonical target",
    };
  }

  const reserveTaskResult = store.reserveTask({
    instanceId,
    taskSlug,
    issueRef,
    startIdempotencyKey: input.idempotencyKey,
    baseBranch,
    baseCommit,
    allowMultipleActiveTasksPerIssue: allowsMultipleActiveTasksPerIssue(policy),
  });
  if (!reserveTaskResult.ok) {
    const reused = reusableStartedTask(
      store,
      reserveTaskResult.existingTask,
      input,
      baseBranch,
      baseCommit,
      naming.branchName,
      candidateCanonicalPath,
    );
    if (reused !== undefined) return { ...reused, warnings };
    return {
      ok: false,
      reason: "issue-already-claimed",
      detail: `issue ${issueRef} is already claimed by task ${reserveTaskResult.existingTask.taskId}`,
    };
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
    const existingTask = store.getTask(reserveWorktreeResult.existingWorktree.taskId);
    const reused =
      existingTask === undefined
        ? undefined
        : reusableStartedTask(
            store,
            existingTask,
            input,
            baseBranch,
            baseCommit,
            naming.branchName,
            candidateCanonicalPath,
          );
    store.deleteReservedTask(task.taskId);
    if (reused !== undefined) return { ...reused, warnings };
    return {
      ok: false,
      reason: reserveWorktreeResult.reason === "branch-collision" ? "branch-collision" : "path-collision",
      detail: `${reserveWorktreeResult.reason} against worktree ${reserveWorktreeResult.existingWorktree.worktreeId}`,
    };
  }
  const reservedWorktree = reserveWorktreeResult.worktree;

  // branch/path はここまでで atomic に確保済み（他プロセスがこの canonicalPath を
  // 正当に狙うことはもう起きない）。それでも存在する場合は DB に追跡されていない
  // 残留ディレクトリであり、race ではなく本物の path-collision。
  // `git worktree add` に投げて曖昧なエラーにする前にここで検出し、予約行を補償削除する。
  if (fs.existsSync(candidateCanonicalPath)) {
    store.deleteReservedWorktree(reservedWorktree.worktreeId);
    store.deleteReservedTask(task.taskId);
    return {
      ok: false,
      reason: "path-collision",
      detail: `canonical worktree path already exists on disk (untracked): ${candidateCanonicalPath}`,
    };
  }

  const createResult = await createWorktree({
    canonicalRepositoryRoot: identityResult.identity.canonicalRepositoryRoot,
    naming,
    baseCommit,
  });
  if (!createResult.ok) {
    store.deleteReservedWorktree(reservedWorktree.worktreeId);
    store.deleteReservedTask(task.taskId);
    return { ok: false, reason: "git-worktree-add-failed", detail: createResult.detail };
  }

  const activeWorktree = store.activateWorktree(reservedWorktree.worktreeId);
  const activeTask = store.updateTaskLifecycleState(task.taskId, "active");

  const bootstrap = decideBootstrap(
    policy.worktree.bootstrapMode,
    createResult.canonicalPath,
    input.expectedLockfileDigest,
  );
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
  pullRequests: PullRequestRecord[];
  currentState: LifecycleState;
  allowedNextTransitions: LifecycleState[];
  invalidTransitions: TransitionBlockedInfo[];
}

export function getTaskStatus(store: WorkflowStateStore, taskId: TaskId): TaskStatusResult | undefined {
  const task = store.getTask(taskId);
  if (task === undefined) return undefined;
  return {
    task,
    worktrees: store.listWorktreesForTask(taskId),
    pullRequests: store.listPullRequestRecordsForTask(taskId),
    ...lifecycleTransitionStatus(task.lifecycleState),
  };
}

export interface WorkspaceTaskTransitionInput extends WorkflowContextInput {
  policy: WorkflowPolicyDocument;
  to: LifecycleState;
  dryRun?: boolean;
  /** Terminal retries may return the already-persisted successful state. */
  allowIdempotentTerminalState?: boolean;
  /** Provider observation used before a task is marked merged. */
  pullRequestObserver?: WorkflowPullRequestObserver;
}

export type WorkflowPullRequestObservation = { ok: true; pullRequest: PullRequest } | { ok: false; detail: string };

export type WorkflowPullRequestObserver = (record: PullRequestRecord) => Promise<WorkflowPullRequestObservation>;

export type WorkspaceTaskTransitionResult =
  | { ok: true; task: TaskRecord; context: VerifiedWorkflowContext }
  | { ok: false; reason: string; detail: string; blocked?: TransitionBlockedInfo };

type MergedPullRequestVerification =
  | { ok: true; record: PullRequestRecord; pullRequest: PullRequest }
  | { ok: false; reason: string; detail: string };

/** `ancestor` が `descendant` の祖先か（`git merge-base --is-ancestor`）。
 * git 呼び出しが完走しなかった場合は false（呼び出し側は分岐なし＝発散扱いにfall back）。 */
async function isAncestorCommit(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  return result.usable && result.ok;
}

async function verifyMergedPullRequest(
  context: VerifiedWorkflowContext,
  store: WorkflowStateStore,
  observer: WorkflowPullRequestObserver | undefined,
): Promise<MergedPullRequestVerification> {
  const records = store.listPullRequestRecordsForTask(context.task.taskId);
  if (records.length === 0) {
    return {
      ok: false,
      reason: "provider-state-unavailable",
      detail: "a persisted provider pull-request record is required before marking the task merged",
    };
  }
  if (records.length !== 1) {
    return {
      ok: false,
      reason: "provider-state-ambiguous",
      detail: "multiple persisted provider pull-request records are associated with the task",
    };
  }
  if (observer === undefined) {
    return {
      ok: false,
      reason: "provider-state-unavailable",
      detail: "a fresh provider pull-request observation is required before marking the task merged",
    };
  }

  const record = records[0]!;
  let observation: WorkflowPullRequestObservation;
  try {
    observation = await observer(record);
  } catch (error) {
    return {
      ok: false,
      reason: "provider-state-unavailable",
      detail: `provider pull-request observation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!observation.ok) {
    return { ok: false, reason: "provider-state-unavailable", detail: observation.detail };
  }

  const pullRequest = observation.pullRequest;
  const identityMismatches = [
    pullRequest.identity.provider !== record.provider ? "provider" : undefined,
    pullRequest.repository.provider !== record.provider ? "repository provider" : undefined,
    pullRequest.repository.id !== record.repositoryId ? "repository" : undefined,
    pullRequest.number !== record.prNumber ? "pull-request number" : undefined,
    pullRequest.url !== record.url ? "pull-request URL" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (identityMismatches.length > 0) {
    return {
      ok: false,
      reason: "provider-state-mismatch",
      detail: `provider pull-request identity does not match persisted task record (${identityMismatches.join(", ")})`,
    };
  }
  if (pullRequest.lifecycleState !== "merged") {
    return {
      ok: false,
      reason: "provider-not-merged",
      detail: `provider pull-request is ${pullRequest.lifecycleState}; refusing to mark the task merged without an observed merge`,
    };
  }
  const mergedHeadRevision = pullRequest.head.revision;
  if (mergedHeadRevision === undefined) {
    return {
      ok: false,
      reason: "provider-state-unavailable",
      detail: "provider pull-request is merged but reported no head revision to verify against the current HEAD",
    };
  }
  // Live-fact integration proof: the current Nawabari/git HEAD is compared
  // directly against the provider's merged PR head, never against mottainai's
  // own persisted record.headSha (stale by construction — see #478). Ahead and
  // behind are distinguished so remediation guidance differs: extra local
  // commits past the merge need a new task, a HEAD that never reached the
  // merged head needs a push/sync, and neither is safe to auto-resolve here.
  if (context.headCommit !== mergedHeadRevision) {
    const aheadOfMergedHead = await isAncestorCommit(mergedHeadRevision, context.headCommit, context.workspaceRoot);
    const behindMergedHead = await isAncestorCommit(context.headCommit, mergedHeadRevision, context.workspaceRoot);
    if (aheadOfMergedHead) {
      return {
        ok: false,
        reason: "task-head-ahead-of-merge",
        detail: `current HEAD ${context.headCommit} is ahead of the merged pull-request head ${mergedHeadRevision}; the extra commit(s) were never included in the merge and must be moved to a new task or discarded before this task can finish`,
      };
    }
    if (behindMergedHead) {
      return {
        ok: false,
        reason: "task-head-behind-merge",
        detail: `current HEAD ${context.headCommit} is behind the merged pull-request head ${mergedHeadRevision}; push or sync the worktree to the merged head before this task can finish`,
      };
    }
    return {
      ok: false,
      reason: "provider-state-mismatch",
      detail: `current HEAD ${context.headCommit} diverges from the merged pull-request head ${mergedHeadRevision} with no ancestry relationship`,
    };
  }
  let persistedRecord = record;
  if (pullRequest.mergeRevision !== undefined) {
    try {
      persistedRecord = store.recordPullRequestMergeRevision(record.recordId, pullRequest.mergeRevision);
    } catch (error) {
      return {
        ok: false,
        reason: "provider-state-write-failed",
        detail: `authoritative provider merge revision could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, record: persistedRecord, pullRequest };
}

/**
 * State-only task transitions still require the same repository/worktree identity
 * proof as Git mutations.  The adapter supplies the lifecycle states from which
 * this transition is valid; the lifecycle table remains the sole transition
 * authority.
 */
export async function transitionTaskForWorkspace(
  input: WorkspaceTaskTransitionInput,
): Promise<WorkspaceTaskTransitionResult> {
  const context = await verifyWorkflowContext(input);
  if (!context.ok) return { ok: false, reason: context.code, detail: context.detail };

  const decision = decideProtectedBranchOperation({
    policy: input.policy,
    branch: context.branch,
    operation: "worktreeManagement",
    repository: { isPrimaryCheckout: context.isPrimaryCheckout },
  });
  if (!decision.allowed) {
    return {
      ok: false,
      reason: "policy-denied",
      detail: `worktree management denied on branch ${context.branch}: ${decision.reason}`,
    };
  }

  if (input.allowIdempotentTerminalState === true && context.task.lifecycleState === input.to) {
    return { ok: true, task: context.task, context };
  }

  const validation = validateTransition(context.task.lifecycleState, input.to);
  if (!validation.allowed) {
    return {
      ok: false,
      reason: "lifecycle-blocked",
      detail: validation.blocked.blockingRule,
      blocked: validation.blocked,
    };
  }

  let mergedPullRequest: PullRequestRecord | undefined;
  if (input.to === "merged") {
    const verified = await verifyMergedPullRequest(context, input.store, input.pullRequestObserver);
    if (!verified.ok) return verified;
    mergedPullRequest = verified.record;
  }
  if (input.dryRun) return { ok: true, task: context.task, context };

  if (mergedPullRequest !== undefined) {
    try {
      input.store.updatePullRequestLifecycleState(mergedPullRequest.recordId, "merged");
    } catch (error) {
      return {
        ok: false,
        reason: "provider-state-write-failed",
        detail: `persisted provider pull-request state could not be updated: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const transitioned = transitionTask(input.store, input.taskId, input.to);
  if (!transitioned.ok) {
    return {
      ok: false,
      reason: "lifecycle-blocked",
      detail: transitioned.blocked.blockingRule,
      blocked: transitioned.blocked,
    };
  }
  return { ok: true, task: transitioned.task, context };
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
export async function getTaskStatusForWorkspace(
  workspaceRoot: string,
  store: WorkflowStateStore,
): Promise<WorkspaceTaskStatusResult> {
  const identityResult = resolveRepositoryIdentity(workspaceRoot);
  if (!identityResult.ok) return { ok: false, reason: identityResult.reason };

  const repoStateResult = await resolveRepoState(workspaceRoot);
  if (!repoStateResult.ok) return { ok: false, reason: repoStateResult.reason };

  const warnings: WorkspaceGuardrailWarning[] = [];
  if (!repoStateResult.state.supported) {
    warnings.push({
      code: `unsupported-repo-state:${repoStateResult.state.kind}`,
      detail: repoStateResult.state.reason,
    });
  }

  const location: WorkspaceLocation = {
    instanceId: identityResult.identity.instanceId,
    worktreePath: identityResult.identity.worktreePath,
    branch: repoStateResult.state.branch,
    repoStateKind: repoStateResult.state.kind,
    warnings,
  };

  const found = findActiveTaskAtWorktreePath(
    store,
    identityResult.identity.instanceId,
    identityResult.identity.worktreePath,
  );
  if (found === undefined) {
    return { ok: true, active: false, ...location };
  }
  if (found.task === undefined) {
    return {
      ok: false,
      reason: `active worktree ${found.worktree.worktreeId} references task ${found.worktree.taskId}, which is missing from the store`,
    };
  }

  // found.task は既に store.getTask() 済みなので、getTaskStatus() で同じ id を
  // 再取得する必要はない（その場合の「missing from the store」は既に上で判定済み）。
  const status: TaskStatusResult = {
    task: found.task,
    worktrees: store.listWorktreesForTask(found.task.taskId),
    pullRequests: store.listPullRequestRecordsForTask(found.task.taskId),
    ...lifecycleTransitionStatus(found.task.lifecycleState),
  };
  return { ok: true, active: true, status, ...location };
}

/**
 * Cross-workspace task/session discovery（Issue #539）。`task list`/`task status --task-id`
 * が使う read-only 投影。`store.listTasks()`/`listWorktreesForTask()` は既に instance を
 * 横断できる（`instanceId` 省略で全件）ため、ここでは新しい state を持たず、既存の
 * WorkflowStateStore 読み取りだけを安全な形に射影する。
 */
export const TASK_LIST_SCHEMA_VERSION = 1 as const;

/**
 * `task list` の既定（active）ビューから外す lifecycle 状態。issue #539 の文言
 * 「closed/abandoned/finished」に対応させる: cleaned=closed, abandoned=abandoned,
 * merged=finished。`orphaned` も所有権が確定しない状態であり、外部消費者への安全な
 * 選択対象にはならないため同様に除外する。
 */
const TASK_LIST_UNAVAILABLE_STATES: ReadonlySet<LifecycleState> = new Set([
  "merged",
  "abandoned",
  "orphaned",
  "cleaned",
]);

/**
 * 公開安全なリポジトリ識別子。`instanceId` は `resolveRepositoryIdentity` が発行する
 * opaque UUID（`src/workflow/domain/identity.ts` 参照）で、絶対パス・remote URL・
 * ブランチ名のいずれにも依存しない。外部消費者はこれを不透明な安定キーとしてのみ扱う。
 */
export interface PublicRepositoryIdentity {
  instanceId: RepositoryInstanceId;
}

export interface PublicTaskListEntry {
  taskId: TaskId;
  repository: PublicRepositoryIdentity;
  taskSlug: string;
  issueRef: string | undefined;
  /** ベストエフォート。Nawabari 管理 task は task-start reconciliation の記録値、
   * legacy task は現在 active な worktree の記録値から得る — いずれもライブ git/Nawabari
   * 呼び出しを伴わない、既に永続化済みの値。 */
  branchName: string | undefined;
  baseBranch: string;
  baseCommit: string;
  lifecycleState: LifecycleState;
  updatedAt: number;
}

export interface TaskListResult {
  schemaVersion: typeof TASK_LIST_SCHEMA_VERSION;
  tasks: PublicTaskListEntry[];
}

function publicBranchNameForTask(store: WorkflowStateStore, task: TaskRecord): string | undefined {
  if (task.nawabariSessionId !== undefined) {
    return store.getTaskStartReconciliation(task.taskId)?.branchName;
  }
  return store.listWorktreesForTask(task.taskId).find((worktree) => worktree.status === "active")?.branchName;
}

/**
 * 呼び出し側 cwd に一切依存しない、ローカル install が保持する全 repository/task を
 * 横断した read-only 一覧（Issue #539）。副作用なし・bounded・deterministic —
 * git/Nawabari への live 呼び出しは行わない（`listTasks()`/`listWorktreesForTask()`/
 * `getTaskStartReconciliation()` はいずれも永続化済み state の読み取りのみ）。
 *
 * 既定で terminal/所有権不確定な task（`TASK_LIST_UNAVAILABLE_STATES`）を除外する。
 * 絶対 worktree path は一切含めない — fresh な path が要る呼び出し側は
 * `getTaskStatusById` を使うこと。
 */
export function listPublicTasks(store: WorkflowStateStore): TaskListResult {
  const tasks = store.listTasks().filter((task) => !TASK_LIST_UNAVAILABLE_STATES.has(task.lifecycleState));
  return {
    schemaVersion: TASK_LIST_SCHEMA_VERSION,
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      repository: { instanceId: task.instanceId },
      taskSlug: task.taskSlug,
      issueRef: task.issueRef,
      branchName: publicBranchNameForTask(store, task),
      baseBranch: task.baseBranch,
      baseCommit: task.baseCommit,
      lifecycleState: task.lifecycleState,
      updatedAt: task.updatedAt,
    })),
  };
}

export interface TaskStatusByIdSuccess {
  ok: true;
  task: TaskRecord;
  worktreePath: string;
  branch: string | undefined;
  pullRequests: PullRequestRecord[];
  currentState: LifecycleState;
  allowedNextTransitions: LifecycleState[];
  invalidTransitions: TransitionBlockedInfo[];
}

/**
 * `task-not-found` | `task-unavailable:<state>`（`TASK_LIST_UNAVAILABLE_STATES` と同じ
 * 状態集合）| `repository-path-unavailable`（instance の現在パスが未観測）|
 * `session-unavailable`（Nawabari session が消失/読めない）|
 * `worktree-unavailable`（legacy task に active worktree が 0 または複数）のいずれか。
 */
export type TaskStatusByIdResult = TaskStatusByIdSuccess | { ok: false; reason: string };

/**
 * taskId だけを鍵にした、cwd 非依存の fresh 解決（Issue #539 の keyed lookup）。
 * `task list` のスナップショットとは独立に、呼び出し時点の権威ある状態を返す —
 * task が消失/終了/所有権不確定なら必ず `ok: false` で fail-closed になり、
 * 別 task や呼び出し側 cwd へのフォールバックは一切行わない。
 *
 * Nawabari 管理 task は `store.listRepositoryPaths` から得た repository instance の
 * 現在パスを cwd anchor にして `nawabari session show` を呼び、fresh な worktree/branch
 * を返す（anchor は worktree 個別ではなく repository 単位の任意の checkout でよい —
 * `nawabari session show --session <id>` は session id で解決するため）。legacy task は
 * `worktrees` テーブルの active 行を直接返す。
 */
export async function getTaskStatusById(
  store: WorkflowStateStore,
  taskId: TaskId,
  nawabari: NawabariExecutionClient,
): Promise<TaskStatusByIdResult> {
  const task = store.getTask(taskId);
  if (task === undefined) return { ok: false, reason: "task-not-found" };
  if (TASK_LIST_UNAVAILABLE_STATES.has(task.lifecycleState)) {
    return { ok: false, reason: `task-unavailable:${task.lifecycleState}` };
  }

  const status = getTaskStatus(store, taskId);
  const currentState = status?.currentState ?? task.lifecycleState;
  const allowedNextTransitions = status?.allowedNextTransitions ?? [];
  const invalidTransitions = status?.invalidTransitions ?? [];
  const pullRequests = status?.pullRequests ?? [];

  if (task.nawabariSessionId !== undefined) {
    const anchor = store.listRepositoryPaths(task.instanceId).find((candidate) => candidate.isCurrent);
    if (anchor === undefined) return { ok: false, reason: "repository-path-unavailable" };
    try {
      const session = await nawabari.showSession({ cwd: anchor.canonicalPath, sessionId: task.nawabariSessionId });
      return {
        ok: true,
        task,
        worktreePath: session.worktree,
        branch: session.branch,
        pullRequests,
        currentState,
        allowedNextTransitions,
        invalidTransitions,
      };
    } catch {
      // The recorded session no longer resolves (closed/expired/unknown to
      // Nawabari) — never fall back to another task or the caller's cwd.
      return { ok: false, reason: "session-unavailable" };
    }
  }

  const activeWorktrees = store.listWorktreesForTask(taskId).filter((worktree) => worktree.status === "active");
  if (activeWorktrees.length !== 1) return { ok: false, reason: "worktree-unavailable" };
  const worktree = activeWorktrees[0]!;
  return {
    ok: true,
    task,
    worktreePath: worktree.canonicalPath,
    branch: worktree.branchName,
    pullRequests,
    currentState,
    allowedNextTransitions,
    invalidTransitions,
  };
}
