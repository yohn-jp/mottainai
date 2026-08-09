import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitCommand } from "../git/context.js";
import type { CleanupRule, RuleMode, WorkflowPolicyDocument } from "../policy/schema.js";
import type {
  PullRequestRecord,
  TaskId,
  TaskRecord,
  WorktreeId,
  WorktreeRecord,
  WorkflowStateStore,
} from "../state/store.js";
import { resolveRepositoryIdentity } from "./identity.js";
import type { RepositoryInstanceId } from "./identity.js";
import type { LifecycleState } from "./lifecycle.js";

export const CLEANUP_PLAN_SCHEMA_VERSION = 1;
export const DEFAULT_CLEANUP_PLAN_TTL_MS = 5 * 60 * 1_000;
const MAX_REPORTED_PATHS = 64;

export type CleanupDisposition = "merged" | "abandoned" | "orphaned" | "cleaned";
export type CleanupPlanStatus = "ready" | "blocked" | "noop";

export type CleanupPullRequestState = "absent" | "open" | "merged" | "closed-unmerged" | "unknown";

export interface CleanupPullRequestObservation {
  state: CleanupPullRequestState;
  headSha?: string;
  detail?: string;
}

export type CleanupPullRequestObserver = (
  record: PullRequestRecord,
) => CleanupPullRequestObservation | Promise<CleanupPullRequestObservation>;

export type CleanupActivityState = "inactive" | "active" | "unknown";

export interface CleanupActivityObservation {
  state: CleanupActivityState;
  processIds?: number[];
  detail?: string;
}

export interface CleanupActivityInput {
  canonicalWorktreePath: string;
  taskId: TaskId;
  worktreeId: WorktreeId;
}

export type CleanupActivityProbe = (
  input: CleanupActivityInput,
) => CleanupActivityObservation | Promise<CleanupActivityObservation>;

export interface CleanupPlanInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId: TaskId;
  policy: CleanupRule | Pick<WorkflowPolicyDocument, "cleanup">;
  now?: () => number;
  planTtlMs?: number;
  pullRequestObserver?: CleanupPullRequestObserver;
  activityProbe?: CleanupActivityProbe;
}

export interface CleanupRepositorySnapshot {
  instanceId: RepositoryInstanceId;
  rootCommitDigest: string;
  gitCommonDir: string;
  canonicalRepositoryRoot: string;
  workspaceRoot: string;
}

export interface CleanupTaskSnapshot {
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  taskSlug: string;
  lifecycleState: LifecycleState | "unknown";
  version: number | undefined;
  baseBranch: string | undefined;
  baseCommit: string | undefined;
}

export interface CleanupWorktreeSnapshot {
  worktreeId: WorktreeId;
  taskId: TaskId;
  instanceId: RepositoryInstanceId;
  branchName: string;
  canonicalPath: string;
  status: WorktreeRecord["status"] | "unknown";
  baseBranch: string;
  baseCommit: string;
}

export interface CleanupFileSnapshot {
  trackedPaths: string[];
  untrackedPaths: string[];
  ignoredPaths: string[];
  nestedRepositoryPaths: string[];
}

export interface CleanupGitSnapshot extends CleanupFileSnapshot {
  branchHead: string | undefined;
  baseBranchHead: string | undefined;
  upstream: string | undefined;
  remoteBranchHead: string | undefined;
  unpushedCommitCount: number | undefined;
  unmergedCommitCount: number | undefined;
  branchMergedIntoBase: boolean | undefined;
  stashCount: number | undefined;
  worktreeRegistered: boolean;
  worktreePathExists: boolean;
  pruneCandidates: string[];
}

export interface CleanupSafetySnapshot {
  observedAt: number;
  git: CleanupGitSnapshot;
  pullRequest: CleanupPullRequestObservation;
  activity: CleanupActivityObservation;
}

export type CleanupAction =
  | { id: "remove-worktree"; kind: "remove-worktree"; worktreeId: WorktreeId; canonicalPath: string }
  | { id: "delete-local-branch"; kind: "delete-local-branch"; branchName: string }
  | { id: "delete-remote-branch"; kind: "delete-remote-branch"; remoteName: string; branchName: string }
  | { id: "prune-worktrees"; kind: "prune-worktrees"; candidates: string[] }
  | { id: "mark-worktree-removed"; kind: "mark-worktree-removed"; worktreeId: WorktreeId }
  | { id: "mark-task-cleaned"; kind: "mark-task-cleaned"; taskId: TaskId };

export interface CleanupBlocker {
  code: string;
  detail: string;
  recoveryOptions: string[];
}

export interface CleanupPlan {
  schemaVersion: typeof CLEANUP_PLAN_SCHEMA_VERSION;
  planId: string;
  planDigest: string;
  createdAt: number;
  expiresAt: number;
  status: CleanupPlanStatus;
  disposition: CleanupDisposition | "unknown";
  policy: CleanupRule;
  repository: CleanupRepositorySnapshot | undefined;
  task: CleanupTaskSnapshot;
  worktree: CleanupWorktreeSnapshot | undefined;
  safety: CleanupSafetySnapshot | undefined;
  actions: CleanupAction[];
  blockers: CleanupBlocker[];
  warnings: string[];
}

export interface CleanupPlanResult {
  ok: boolean;
  plan: CleanupPlan;
}

interface GitCommandValue {
  ok: boolean;
  usable: boolean;
  exitCode: number | null;
  stdout: string;
  detail: string;
}

interface WorktreeGitRecord {
  canonicalPath: string;
  head: string | undefined;
  branch: string | undefined;
}

function policyRule(input: CleanupPlanInput["policy"]): CleanupRule {
  return "cleanup" in input ? input.cleanup : input;
}

function sortedLimited(values: Iterable<string>): string[] {
  return [...new Set(values)].sort().slice(0, MAX_REPORTED_PATHS);
}

function blocker(code: string, detail: string, ...recoveryOptions: string[]): CleanupBlocker {
  return { code, detail, recoveryOptions };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digestPlan(plan: Omit<CleanupPlan, "planDigest">): string {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function computeCleanupPlanDigest(plan: CleanupPlan): string {
  const { planDigest: _ignored, ...withoutDigest } = plan;
  return digestPlan(withoutDigest);
}

function finalizePlan(plan: Omit<CleanupPlan, "planDigest"> | CleanupPlan): CleanupPlan {
  const { planDigest: _ignored, ...withoutDigest } = plan as CleanupPlan;
  return { ...withoutDigest, planDigest: digestPlan(withoutDigest) };
}

function emptyGitSnapshot(): CleanupGitSnapshot {
  return {
    trackedPaths: [],
    untrackedPaths: [],
    ignoredPaths: [],
    nestedRepositoryPaths: [],
    branchHead: undefined,
    baseBranchHead: undefined,
    upstream: undefined,
    remoteBranchHead: undefined,
    unpushedCommitCount: undefined,
    unmergedCommitCount: undefined,
    branchMergedIntoBase: undefined,
    stashCount: undefined,
    worktreeRegistered: false,
    worktreePathExists: false,
    pruneCandidates: [],
  };
}

function emptyPlan(input: CleanupPlanInput, now: number, rule: CleanupRule, task: TaskRecord | undefined): CleanupPlan {
  const taskSnapshot: CleanupTaskSnapshot =
    task === undefined
      ? {
          taskId: input.taskId,
          instanceId: "unknown" as RepositoryInstanceId,
          taskSlug: "unknown",
          lifecycleState: "unknown",
          version: undefined,
          baseBranch: undefined,
          baseCommit: undefined,
        }
      : {
          taskId: task.taskId,
          instanceId: task.instanceId,
          taskSlug: task.taskSlug,
          lifecycleState: task.lifecycleState,
          version: task.version,
          baseBranch: task.baseBranch,
          baseCommit: task.baseCommit,
        };
  return finalizePlan({
    schemaVersion: CLEANUP_PLAN_SCHEMA_VERSION,
    planId: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + DEFAULT_CLEANUP_PLAN_TTL_MS,
    status: "blocked",
    disposition: "unknown",
    policy: rule,
    repository: undefined,
    task: taskSnapshot,
    worktree: undefined,
    safety: undefined,
    actions: [],
    blockers: [],
    warnings: [],
  });
}

async function gitValue(cwd: string, args: string[], operation: string): Promise<GitCommandValue> {
  const observation = await runGitCommand(cwd, args);
  const result = observation.result;
  return {
    ok: observation.usable && result.exitCode === 0,
    usable: observation.usable,
    exitCode: result.exitCode,
    stdout: result.stdout,
    detail: observation.usable
      ? `${operation} exited with code ${result.exitCode ?? "unknown"}`
      : `${operation} did not complete safely`,
  };
}

function parseStatus(output: string): CleanupFileSnapshot {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const ignored: string[] = [];
  const records = output.split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const currentPath = record.slice(3);
    if (
      (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") &&
      index + 1 < records.length
    ) {
      index += 1;
    }
    if (indexStatus === "?" && worktreeStatus === "?") untracked.push(currentPath);
    else if (indexStatus === "!" && worktreeStatus === "!") ignored.push(currentPath);
    else if (indexStatus !== " " || worktreeStatus !== " ") tracked.push(currentPath);
  }
  return {
    trackedPaths: sortedLimited(tracked),
    untrackedPaths: sortedLimited(untracked),
    ignoredPaths: sortedLimited(ignored),
    nestedRepositoryPaths: [],
  };
}

function canonicalOrAbsolute(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function isSafeManagedWorktreePath(repositoryRoot: string, candidate: string): boolean {
  const managedRoot = path.resolve(repositoryRoot, ".mottainai", "worktrees");
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathWithin(managedRoot, resolvedCandidate)) return false;

  let current = repositoryRoot;
  const relative = path.relative(repositoryRoot, resolvedCandidate);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      return false;
    }
  }
  try {
    if (fs.existsSync(resolvedCandidate) && canonicalOrAbsolute(resolvedCandidate) !== resolvedCandidate) return false;
  } catch {
    return false;
  }
  return true;
}

function discoverNestedRepositories(worktreePath: string): string[] {
  if (!fs.existsSync(worktreePath)) return [];
  const nested: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === ".git") {
        if (directory !== worktreePath) nested.push(path.relative(worktreePath, directory));
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      visit(absolute);
    }
  };
  visit(worktreePath);
  return sortedLimited(nested);
}

function parseWorktreeList(output: string): WorktreeGitRecord[] {
  const records: WorktreeGitRecord[] = [];
  let current: WorktreeGitRecord | undefined;
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      if (current !== undefined) records.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = {
        canonicalPath: canonicalOrAbsolute(line.slice("worktree ".length)),
        head: undefined,
        branch: undefined,
      };
    } else if (current !== undefined && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current !== undefined && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

function parseCount(output: string): number | undefined {
  const value = Number.parseInt(output.trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isUnknownMode(mode: RuleMode): boolean {
  return mode === "confirm";
}

function addPolicyWarningOrBlock(
  mode: RuleMode,
  operation: string,
  blockers: CleanupBlocker[],
  warnings: string[],
): void {
  if (mode === "confirm")
    blockers.push(
      blocker(
        "human-confirmation-required",
        `${operation} requires a trusted human approval channel`,
        "use a trusted human workflow; do not pass a caller boolean",
      ),
    );
  else if (mode === "advisory") warnings.push(`${operation} is advisory and will not mutate state automatically`);
}

function defaultActivityProbe(input: CleanupActivityInput): CleanupActivityObservation {
  if (os.platform() !== "linux")
    return { state: "unknown", detail: "managed process probing is unavailable on this platform" };
  try {
    const processIds: number[] = [];
    const target = canonicalOrAbsolute(input.canonicalWorktreePath);
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number.parseInt(entry, 10);
      if (pid === process.pid) continue;
      try {
        const cwd = canonicalOrAbsolute(`/proc/${entry}/cwd`);
        if (cwd === target || isPathWithin(target, cwd)) processIds.push(pid);
      } catch {
        // A process can exit while its /proc entry is being inspected.
      }
    }
    return processIds.length === 0
      ? { state: "inactive" }
      : { state: "active", processIds: processIds.sort((a, b) => a - b) };
  } catch (err) {
    return { state: "unknown", detail: `cannot inspect managed processes: ${safeError(err)}` };
  }
}

async function observePullRequest(
  records: PullRequestRecord[],
  observer: CleanupPullRequestObserver | undefined,
): Promise<CleanupPullRequestObservation> {
  const record = records[0];
  if (record === undefined) return { state: "absent" };
  if (observer === undefined)
    return { state: "unknown", detail: "a fresh pull-request observer is required; local metadata is not merge proof" };
  try {
    const observation = await observer(record);
    if (!["absent", "open", "merged", "closed-unmerged", "unknown"].includes(observation.state)) {
      return { state: "unknown", detail: "pull-request observer returned an unsupported state" };
    }
    return {
      state: observation.state,
      ...(observation.headSha === undefined ? {} : { headSha: observation.headSha }),
      ...(observation.detail === undefined ? {} : { detail: observation.detail }),
    };
  } catch (err) {
    return { state: "unknown", detail: `pull-request observation failed: ${safeError(err)}` };
  }
}

async function readGitSnapshot(
  repositoryRoot: string,
  worktree: WorktreeRecord,
  task: TaskRecord,
  options: { allowMissingWorktree?: boolean; allowMissingBranch?: boolean } = {},
): Promise<{ snapshot: CleanupGitSnapshot; blockers: CleanupBlocker[] }> {
  const blockers: CleanupBlocker[] = [];
  const targetExists = fs.existsSync(worktree.canonicalPath);
  const worktreeList = await gitValue(repositoryRoot, ["worktree", "list", "--porcelain"], "git worktree list");
  const records = worktreeList.ok ? parseWorktreeList(worktreeList.stdout) : [];
  if (!worktreeList.ok)
    blockers.push(blocker("worktree-state-unavailable", worktreeList.detail, "retry after Git is responsive"));

  const registered = records.find((record) => record.canonicalPath === worktree.canonicalPath);
  if (
    worktree.status === "active" &&
    (!targetExists || registered === undefined) &&
    options.allowMissingWorktree !== true
  ) {
    blockers.push(
      blocker(
        "worktree-missing",
        "the active worktree path is absent or no longer registered by Git",
        "recover the worktree explicitly or mark the task orphaned through reconciliation",
      ),
    );
  }
  if (worktree.status === "removed" && targetExists) {
    blockers.push(
      blocker(
        "unrelated-path-at-worktree",
        "a path exists where removed worktree metadata expects no path",
        "inspect the path and remove it only through an independently authorized operation",
      ),
    );
  }
  if (
    registered !== undefined &&
    (registered.branch !== worktree.branchName ||
      (registered.head !== undefined && worktree.status === "active" && registered.head.length === 0))
  ) {
    blockers.push(
      blocker(
        "worktree-registration-mismatch",
        "Git worktree registration does not match the stored branch association",
        "repair state through reconciliation before cleanup",
      ),
    );
  }

  const snapshot = emptyGitSnapshot();
  snapshot.worktreeRegistered = registered !== undefined;
  snapshot.worktreePathExists = targetExists;
  snapshot.pruneCandidates = [];

  const branchHeadResult = await gitValue(
    repositoryRoot,
    ["rev-parse", "--verify", `refs/heads/${worktree.branchName}`],
    "resolve task branch",
  );
  if (!branchHeadResult.ok && options.allowMissingBranch !== true)
    blockers.push(blocker("branch-state-unavailable", branchHeadResult.detail, "retry after Git is responsive"));
  else snapshot.branchHead = branchHeadResult.stdout.trim();

  const baseHeadResult = await gitValue(
    repositoryRoot,
    ["rev-parse", "--verify", `refs/heads/${task.baseBranch}`],
    "resolve base branch",
  );
  if (!baseHeadResult.ok)
    blockers.push(
      blocker("base-branch-state-unavailable", baseHeadResult.detail, "restore or explicitly verify the base branch"),
    );
  else snapshot.baseBranchHead = baseHeadResult.stdout.trim();

  const statusResult = targetExists
    ? await gitValue(
        worktree.canonicalPath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
        "read worktree status",
      )
    : { ok: false, usable: false, exitCode: null, stdout: "", detail: "worktree path is absent" };
  if (!statusResult.ok) {
    if (worktree.status === "active" && options.allowMissingWorktree !== true)
      blockers.push(blocker("tracked-state-unavailable", statusResult.detail, "restore the worktree and retry"));
  } else {
    Object.assign(snapshot, parseStatus(statusResult.stdout));
  }

  snapshot.nestedRepositoryPaths = targetExists ? discoverNestedRepositories(worktree.canonicalPath) : [];

  if (snapshot.branchHead !== undefined && snapshot.baseBranchHead !== undefined) {
    const mergedResult = await gitValue(
      repositoryRoot,
      ["merge-base", "--is-ancestor", `refs/heads/${worktree.branchName}`, `refs/heads/${task.baseBranch}`],
      "check branch merge state",
    );
    if (mergedResult.usable) snapshot.branchMergedIntoBase = mergedResult.exitCode === 0;
    else blockers.push(blocker("merge-state-unavailable", mergedResult.detail, "retry after Git is responsive"));

    const unmergedResult = await gitValue(
      repositoryRoot,
      ["rev-list", "--count", `refs/heads/${worktree.branchName}`, "--not", `refs/heads/${task.baseBranch}`],
      "count unmerged commits",
    );
    if (unmergedResult.ok) snapshot.unmergedCommitCount = parseCount(unmergedResult.stdout);
    else blockers.push(blocker("commit-state-unavailable", unmergedResult.detail, "retry after Git is responsive"));
  }

  const upstreamResult = await gitValue(
    repositoryRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `refs/heads/${worktree.branchName}@{upstream}`],
    "resolve branch upstream",
  );
  if (upstreamResult.usable && upstreamResult.exitCode === 0 && upstreamResult.stdout.trim().length > 0) {
    snapshot.upstream = upstreamResult.stdout.trim();
    const separator = snapshot.upstream.indexOf("/");
    if (separator > 0 && separator < snapshot.upstream.length - 1) {
      const remoteName = snapshot.upstream.slice(0, separator);
      const branchName = snapshot.upstream.slice(separator + 1);
      const remoteHeadResult = await gitValue(
        repositoryRoot,
        ["ls-remote", "--heads", remoteName, `refs/heads/${branchName}`],
        "resolve remote branch",
      );
      if (remoteHeadResult.ok)
        snapshot.remoteBranchHead = remoteHeadResult.stdout.trim().split(/\s+/, 1)[0] || undefined;
    }
  }
  if (snapshot.branchHead !== undefined) {
    const unpushedArgs =
      snapshot.upstream === undefined
        ? ["rev-list", "--count", `refs/heads/${worktree.branchName}`, "--not", `refs/heads/${task.baseBranch}`]
        : ["rev-list", "--count", `refs/heads/${worktree.branchName}`, "--not", snapshot.upstream];
    const unpushedResult = await gitValue(repositoryRoot, unpushedArgs, "count unpushed commits");
    if (unpushedResult.ok) snapshot.unpushedCommitCount = parseCount(unpushedResult.stdout);
    else blockers.push(blocker("push-state-unavailable", unpushedResult.detail, "retry after Git is responsive"));
  }

  const stashResult = await gitValue(repositoryRoot, ["stash", "list", "--format=%H"], "read stash state");
  if (stashResult.ok)
    snapshot.stashCount = stashResult.stdout.trim().length === 0 ? 0 : stashResult.stdout.trim().split("\n").length;
  else blockers.push(blocker("stash-state-unavailable", stashResult.detail, "retry after Git is responsive"));

  const pruneResult = await gitValue(
    repositoryRoot,
    ["worktree", "prune", "--dry-run", "--verbose"],
    "preview worktree prune",
  );
  if (pruneResult.ok)
    snapshot.pruneCandidates = sortedLimited(
      pruneResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  else blockers.push(blocker("prune-state-unavailable", pruneResult.detail, "retry after Git is responsive"));

  return { snapshot, blockers };
}

function validateCommonSafety(
  task: TaskRecord,
  worktree: WorktreeRecord,
  snapshot: CleanupGitSnapshot,
  disposition: CleanupDisposition,
  blockers: CleanupBlocker[],
  options: { allowMissingBranch?: boolean } = {},
): void {
  if (snapshot.trackedPaths.length > 0)
    blockers.push(
      blocker(
        "tracked-changes",
        "tracked changes are present in the worktree",
        "commit or discard the tracked changes explicitly",
      ),
    );
  if (snapshot.untrackedPaths.length > 0)
    blockers.push(
      blocker(
        "untracked-files",
        "untracked files are present in the worktree",
        "move or remove untracked files explicitly",
      ),
    );
  if (snapshot.ignoredPaths.length > 0)
    blockers.push(
      blocker(
        "ignored-files",
        "ignored files are present in the worktree",
        "remove generated/ignored files explicitly before cleanup",
      ),
    );
  if (snapshot.nestedRepositoryPaths.length > 0)
    blockers.push(
      blocker(
        "nested-repository",
        "a nested repository was found below the worktree",
        "detach or inspect the nested repository before cleanup",
      ),
    );
  if (snapshot.stashCount !== undefined && snapshot.stashCount > 0)
    blockers.push(
      blocker(
        "stash-present",
        "the repository has stash entries that cleanup must not discard",
        "apply, export, or explicitly remove the stash",
      ),
    );
  if (snapshot.unpushedCommitCount !== undefined && snapshot.unpushedCommitCount > 0)
    blockers.push(
      blocker(
        "unpushed-commits",
        "commits unique to the task branch are not safely accounted for",
        "push or merge the commits before cleanup",
      ),
    );
  if (
    (snapshot.branchHead === undefined && options.allowMissingBranch !== true) ||
    snapshot.baseBranchHead === undefined ||
    (snapshot.branchMergedIntoBase === undefined && options.allowMissingBranch !== true)
  ) {
    blockers.push(blocker("branch-state-unknown", "branch merge state is not known", "retry with complete Git state"));
  }
  if (disposition === "merged" && snapshot.branchMergedIntoBase !== true && options.allowMissingBranch !== true) {
    blockers.push(
      blocker(
        "branch-not-merged",
        `task branch ${worktree.branchName} is not merged into ${task.baseBranch}`,
        "update the base branch or keep the worktree",
      ),
    );
  }
}

function addAction(actions: CleanupAction[], action: CleanupAction): void {
  if (!actions.some((existing) => existing.id === action.id)) actions.push(action);
}

function actionModeFor(action: CleanupAction["kind"], rule: CleanupRule): RuleMode {
  if (action === "remove-worktree") return rule.worktreeRemoval;
  if (action === "delete-local-branch") return rule.localBranchDeletion;
  if (action === "delete-remote-branch") return rule.remoteBranchDeletion;
  if (action === "prune-worktrees") return rule.worktreePrune;
  return "enforce";
}

function policyActions(
  rule: CleanupRule,
  disposition: CleanupDisposition,
  task: TaskRecord,
  worktree: WorktreeRecord,
  snapshot: CleanupGitSnapshot,
  blockers: CleanupBlocker[],
  warnings: string[],
): CleanupAction[] {
  const actions: CleanupAction[] = [];
  const worktreeCanBeRemoved = worktree.status === "removed" || rule.worktreeRemoval === "enforce";
  if (worktree.status === "active") {
    if (rule.worktreeRemoval === "enforce")
      addAction(actions, {
        id: "remove-worktree",
        kind: "remove-worktree",
        worktreeId: worktree.worktreeId,
        canonicalPath: worktree.canonicalPath,
      });
    else {
      addPolicyWarningOrBlock(rule.worktreeRemoval, "worktree removal", blockers, warnings);
      if (rule.worktreeRemoval !== "advisory")
        blockers.push(
          blocker(
            "worktree-removal-disabled",
            "worktree removal is not enabled for this cleanup",
            "enable worktreeRemoval=enforce in an authorized policy",
          ),
        );
    }
  }
  if (worktree.status === "active" && rule.worktreeRemoval !== "enforce") {
    blockers.push(
      blocker(
        "worktree-removal-required-before-other-cleanup",
        "the active worktree must be removed before branch or task state cleanup",
        "enable worktreeRemoval=enforce or leave the task intact",
      ),
    );
    return [];
  }

  if (rule.localBranchDeletion === "enforce") {
    if (snapshot.branchMergedIntoBase === true)
      addAction(actions, { id: "delete-local-branch", kind: "delete-local-branch", branchName: worktree.branchName });
    else
      blockers.push(
        blocker(
          "local-branch-not-merged",
          `local branch ${worktree.branchName} cannot be deleted without a verified merge`,
          "merge the branch or leave local branch deletion disabled",
        ),
      );
  } else addPolicyWarningOrBlock(rule.localBranchDeletion, "local branch deletion", blockers, warnings);

  if (rule.remoteBranchDeletion === "enforce") {
    if (
      snapshot.upstream === undefined ||
      !snapshot.upstream.includes("/") ||
      snapshot.remoteBranchHead === undefined
    ) {
      blockers.push(
        blocker(
          "remote-branch-unknown",
          "remote branch identity is not known; refusing remote deletion",
          "configure an explicit remote branch and re-plan",
        ),
      );
    } else {
      const separator = snapshot.upstream.indexOf("/");
      addAction(actions, {
        id: "delete-remote-branch",
        kind: "delete-remote-branch",
        remoteName: snapshot.upstream.slice(0, separator),
        branchName: snapshot.upstream.slice(separator + 1),
      });
    }
  } else addPolicyWarningOrBlock(rule.remoteBranchDeletion, "remote branch deletion", blockers, warnings);

  if (rule.worktreePrune === "enforce")
    addAction(actions, { id: "prune-worktrees", kind: "prune-worktrees", candidates: snapshot.pruneCandidates });
  else addPolicyWarningOrBlock(rule.worktreePrune, "worktree prune", blockers, warnings);

  if (rule.forceCleanup === "enforce")
    blockers.push(
      blocker(
        "force-cleanup-disabled-for-agent",
        "force cleanup is disabled for the agent execution path",
        "use a separately authorized human workflow; no caller boolean is accepted",
      ),
    );
  else if (isUnknownMode(rule.forceCleanup))
    blockers.push(
      blocker(
        "human-confirmation-required",
        "force cleanup requires a trusted human approval channel",
        "use a trusted human workflow; do not pass a caller boolean",
      ),
    );

  if (
    worktreeCanBeRemoved &&
    (actions.some((action) => action.id === "remove-worktree") || worktree.status === "removed")
  ) {
    if (worktree.status === "active")
      addAction(actions, {
        id: "mark-worktree-removed",
        kind: "mark-worktree-removed",
        worktreeId: worktree.worktreeId,
      });
    if (disposition !== "orphaned" || worktree.status === "removed")
      addAction(actions, { id: "mark-task-cleaned", kind: "mark-task-cleaned", taskId: task.taskId });
  }
  return actions;
}

async function buildPlan(input: CleanupPlanInput, now: number, rule: CleanupRule): Promise<CleanupPlan> {
  let plan = emptyPlan(input, now, rule, input.store.getTask(input.taskId));
  plan = { ...plan, expiresAt: now + (input.planTtlMs ?? DEFAULT_CLEANUP_PLAN_TTL_MS) };
  const blockers = plan.blockers;
  const warnings = plan.warnings;
  const task = input.store.getTask(input.taskId);
  if (task === undefined) {
    blockers.push(
      blocker(
        "task-not-found",
        `task was not found: ${input.taskId}`,
        "use the persisted task id from the workflow store",
      ),
    );
    return finalizePlan({ ...plan, status: "blocked", blockers, warnings });
  }

  const identityResult = resolveRepositoryIdentity(input.workspaceRoot);
  if (!identityResult.ok) {
    blockers.push(
      blocker("repository-identity-unavailable", identityResult.reason, "run cleanup from a valid repository checkout"),
    );
    return finalizePlan({
      ...plan,
      task: { ...plan.task, version: task.version, lifecycleState: task.lifecycleState },
      blockers,
      warnings,
    });
  }
  const identity = identityResult.identity;
  const repository: CleanupRepositorySnapshot = {
    instanceId: identity.instanceId,
    rootCommitDigest: identity.rootCommitDigest,
    gitCommonDir: identity.gitCommonDir,
    canonicalRepositoryRoot: identity.canonicalRepositoryRoot,
    workspaceRoot: canonicalOrAbsolute(input.workspaceRoot),
  };
  plan = {
    ...plan,
    repository,
    task: {
      taskId: task.taskId,
      instanceId: task.instanceId,
      taskSlug: task.taskSlug,
      lifecycleState: task.lifecycleState,
      version: task.version,
      baseBranch: task.baseBranch,
      baseCommit: task.baseCommit,
    },
  };
  if (task.instanceId !== identity.instanceId)
    blockers.push(
      blocker(
        "repository-identity-mismatch",
        "task instance does not match the repository identity resolved at the workspace",
        "use the task's owning repository checkout",
      ),
    );
  const repositoryRecord = input.store.getRepositoryInstance(identity.instanceId);
  if (repositoryRecord === undefined)
    blockers.push(
      blocker(
        "repository-state-missing",
        "repository identity is not recorded in workflow state",
        "observe the repository through the workflow start path before cleanup",
      ),
    );
  else if (repositoryRecord.gitCommonDir !== identity.gitCommonDir)
    blockers.push(
      blocker(
        "repository-common-dir-mismatch",
        "Git common directory differs from the recorded repository instance",
        "reconcile repository identity before cleanup",
      ),
    );

  const disposition: CleanupDisposition | "unknown" =
    task.lifecycleState === "merged" ||
    task.lifecycleState === "abandoned" ||
    task.lifecycleState === "orphaned" ||
    task.lifecycleState === "cleaned"
      ? task.lifecycleState
      : "unknown";
  plan.disposition = disposition;
  if (task.lifecycleState === "cleaned")
    return finalizePlan({ ...plan, status: "noop", blockers, warnings, actions: [] });
  if (disposition === "unknown")
    blockers.push(
      blocker(
        "lifecycle-not-cleanable",
        `task lifecycle ${task.lifecycleState} is not a cleanup disposition`,
        "transition the task through the workflow lifecycle first",
      ),
    );

  const taskWorktrees = input.store.listWorktreesForTask(task.taskId);
  const activeWorktrees = taskWorktrees.filter((candidate) => candidate.status === "active");
  if (activeWorktrees.length > 1)
    blockers.push(
      blocker(
        "multiple-active-worktrees",
        "more than one active worktree is associated with the task",
        "resolve the association through reconciliation before cleanup",
      ),
    );
  const worktree = activeWorktrees[0] ?? taskWorktrees.find((candidate) => candidate.status === "removed");
  if (worktree === undefined)
    blockers.push(
      blocker(
        "worktree-association-missing",
        "task has no persisted worktree association",
        "recover or reconcile the task before cleanup",
      ),
    );
  else {
    plan.worktree = {
      worktreeId: worktree.worktreeId,
      taskId: worktree.taskId,
      instanceId: worktree.instanceId,
      branchName: worktree.branchName,
      canonicalPath: worktree.canonicalPath,
      status: worktree.status,
      baseBranch: worktree.baseBranch,
      baseCommit: worktree.baseCommit,
    };
    if (worktree.taskId !== task.taskId || worktree.instanceId !== task.instanceId)
      blockers.push(
        blocker(
          "worktree-association-mismatch",
          "worktree does not belong to the requested task and repository instance",
          "repair state through reconciliation before cleanup",
        ),
      );
    if (!isSafeManagedWorktreePath(identity.canonicalRepositoryRoot, worktree.canonicalPath))
      blockers.push(
        blocker(
          "unsafe-worktree-path",
          "persisted worktree path is outside the canonical managed worktree root or uses a symlink",
          "do not delete the path; repair metadata manually",
        ),
      );
  }

  const records = input.store.listPullRequestRecordsForTask(task.taskId);
  const pullRequest = await observePullRequest(records, input.pullRequestObserver);
  if (disposition === "merged") {
    if (records.length === 0)
      blockers.push(
        blocker(
          "merged-pr-record-missing",
          "merged task has no pull-request record",
          "verify the pull request through the provider and record it before cleanup",
        ),
      );
    if (pullRequest.state !== "merged")
      blockers.push(
        blocker(
          pullRequest.state === "closed-unmerged" ? "pull-request-closed-unmerged" : "pull-request-merge-unverified",
          pullRequest.detail ?? "pull request is not freshly verified as merged",
          "re-query the provider; never treat closed-unmerged as merged",
        ),
      );
  } else if (disposition === "abandoned") {
    if (pullRequest.state === "open")
      blockers.push(
        blocker(
          "pull-request-open",
          "an open pull request is attached to an abandoned task",
          "close or otherwise resolve the pull request before cleanup",
        ),
      );
    if (pullRequest.state === "unknown")
      blockers.push(
        blocker(
          "pull-request-state-unknown",
          pullRequest.detail ?? "pull request state is unavailable",
          "re-query the provider before cleanup",
        ),
      );
    if (pullRequest.state === "merged")
      blockers.push(
        blocker(
          "abandoned-pr-merged-mismatch",
          "an abandoned task has a pull request freshly observed as merged",
          "repair the task lifecycle instead of cleaning it as abandoned",
        ),
      );
  } else if (disposition === "orphaned" && pullRequest.state === "open") {
    blockers.push(
      blocker(
        "orphaned-open-pr",
        "an orphaned task still has an open pull request",
        "resolve the pull request before orphan recovery",
      ),
    );
  }
  if (worktree === undefined)
    return finalizePlan({
      ...plan,
      safety: {
        observedAt: now,
        git: emptyGitSnapshot(),
        pullRequest,
        activity: { state: "unknown", detail: "worktree association is missing" },
      },
      status: "blocked",
      blockers,
      warnings,
      actions: [],
    });

  const activeLease = input.store.getActiveCleanupLease(task.instanceId, task.taskId, worktree.worktreeId, now);
  if (activeLease !== undefined)
    blockers.push(
      blocker(
        "active-lease",
        `cleanup operation ${activeLease.operationId} already holds an active lease`,
        "wait for the lease to expire or resume the exact operation",
      ),
    );

  const gitRead = await readGitSnapshot(identity.canonicalRepositoryRoot, worktree, task);
  const activityProbe = input.activityProbe ?? defaultActivityProbe;
  let activity: CleanupActivityObservation;
  try {
    activity = await activityProbe({
      canonicalWorktreePath: worktree.canonicalPath,
      taskId: task.taskId,
      worktreeId: worktree.worktreeId,
    });
  } catch (err) {
    activity = { state: "unknown", detail: `managed activity probe failed: ${safeError(err)}` };
  }
  if (activity.state === "active")
    blockers.push(
      blocker(
        "active-managed-process",
        activity.detail ?? "a managed process has the task worktree active",
        "stop the managed process and re-plan",
      ),
    );
  if (activity.state === "unknown")
    blockers.push(
      blocker(
        "managed-process-state-unknown",
        activity.detail ?? "managed process state is unavailable",
        "retry with a trusted activity probe",
      ),
    );
  if (gitRead.snapshot.stashCount !== undefined)
    validateCommonSafety(
      task,
      worktree,
      gitRead.snapshot,
      disposition === "unknown" ? "abandoned" : disposition,
      blockers,
    );
  if (
    disposition === "merged" &&
    pullRequest.state === "merged" &&
    pullRequest.headSha !== undefined &&
    gitRead.snapshot.branchHead !== pullRequest.headSha
  ) {
    blockers.push(
      blocker(
        "pull-request-head-mismatch",
        "fresh merged pull-request head does not match the task branch",
        "discard the plan and reconcile the branch/PR identity",
      ),
    );
  }
  plan.safety = { observedAt: now, git: gitRead.snapshot, pullRequest, activity };
  blockers.push(...gitRead.blockers);

  if (disposition === "orphaned" && worktree.status === "active" && !gitRead.snapshot.worktreePathExists) {
    blockers.push(
      blocker(
        "orphaned-active-metadata",
        "orphaned task still has active worktree metadata without a verified path",
        "recover the metadata through reconciliation before cleanup",
      ),
    );
  }
  const actions =
    blockers.length === 0
      ? policyActions(
          rule,
          disposition === "unknown" ? "abandoned" : disposition,
          task,
          worktree,
          gitRead.snapshot,
          blockers,
          warnings,
        )
      : [];
  if (actions.length === 0 && blockers.length === 0)
    blockers.push(
      blocker(
        "no-cleanup-action",
        "policy does not authorize a safe cleanup mutation",
        "enable an explicit cleanup operation in policy or leave the task intact",
      ),
    );
  const status: CleanupPlanStatus = blockers.length > 0 ? "blocked" : "ready";
  return finalizePlan({ ...plan, status, blockers, warnings, actions });
}

export async function createCleanupPlan(input: CleanupPlanInput): Promise<CleanupPlanResult> {
  const now = input.now?.() ?? Date.now();
  const ttlMs = input.planTtlMs ?? DEFAULT_CLEANUP_PLAN_TTL_MS;
  const rule = policyRule(input.policy);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("cleanup plan ttl must be a positive safe integer");
  const plan = await buildPlan({ ...input, planTtlMs: ttlMs }, now, rule);
  return { ok: plan.status !== "blocked", plan };
}

export const planCleanup = createCleanupPlan;

export interface CleanupRevalidationInput {
  plan: CleanupPlan;
  store: WorkflowStateStore;
  now?: number;
  pullRequestObserver?: CleanupPullRequestObserver;
  activityProbe?: CleanupActivityProbe;
  allowPostMutationState?: boolean;
  expectedCompletedActionIds?: readonly string[];
}

export interface CleanupRevalidationResult {
  ok: boolean;
  blockers: CleanupBlocker[];
  safety: CleanupSafetySnapshot | undefined;
  completedActionIds: string[];
}

/** Re-read the same plan's safety facts. It intentionally never changes the action list. */
export async function revalidateCleanupPlan(input: CleanupRevalidationInput): Promise<CleanupRevalidationResult> {
  const blockers: CleanupBlocker[] = [];
  const plan = input.plan;
  const now = input.now ?? Date.now();
  const completedActionIds: string[] = [];
  if (now > plan.expiresAt)
    blockers.push(blocker("plan-expired", "cleanup plan has expired", "create a new plan from current state"));
  if (plan.repository === undefined || plan.task.version === undefined || plan.worktree === undefined) {
    blockers.push(
      blocker(
        "plan-incomplete",
        "cleanup plan lacks the identity required for revalidation",
        "create a new complete cleanup plan",
      ),
    );
    return { ok: false, blockers, safety: undefined, completedActionIds };
  }
  const identityResult = resolveRepositoryIdentity(plan.repository.workspaceRoot);
  if (!identityResult.ok)
    blockers.push(
      blocker(
        "repository-identity-unavailable",
        identityResult.reason,
        "run execute from the original repository checkout",
      ),
    );
  else {
    const identity = identityResult.identity;
    if (
      identity.instanceId !== plan.repository.instanceId ||
      identity.gitCommonDir !== plan.repository.gitCommonDir ||
      identity.canonicalRepositoryRoot !== plan.repository.canonicalRepositoryRoot
    ) {
      blockers.push(
        blocker(
          "repository-identity-mismatch",
          "repository identity changed after planning",
          "discard the plan and create a new one for this repository",
        ),
      );
    }
    if (identity.instanceId !== plan.task.instanceId)
      blockers.push(
        blocker(
          "task-repository-mismatch",
          "the execute workspace does not own the planned task",
          "execute only from the task's recorded repository",
        ),
      );
  }
  const task = input.store.getTask(plan.task.taskId);
  if (task === undefined)
    blockers.push(
      blocker("task-not-found", "task disappeared from workflow state", "recover the task state before cleanup"),
    );
  else {
    if (
      task.instanceId !== plan.task.instanceId ||
      task.taskId !== plan.task.taskId ||
      task.version !== plan.task.version
    )
      blockers.push(
        blocker(
          "task-version-changed",
          "task identity or version changed after planning",
          "discard the plan and re-plan",
        ),
      );
    if (task.lifecycleState !== plan.task.lifecycleState)
      blockers.push(
        blocker("task-lifecycle-changed", "task lifecycle changed after planning", "discard the plan and re-plan"),
      );
  }
  const worktree = input.store
    .listWorktreesForTask(plan.task.taskId)
    .find((candidate) => candidate.worktreeId === plan.worktree!.worktreeId);
  if (worktree === undefined)
    blockers.push(
      blocker(
        "worktree-association-missing",
        "planned worktree disappeared from workflow state",
        "recover the worktree state before cleanup",
      ),
    );
  else {
    if (
      worktree.taskId !== plan.task.taskId ||
      worktree.instanceId !== plan.task.instanceId ||
      worktree.branchName !== plan.worktree.branchName ||
      worktree.canonicalPath !== plan.worktree.canonicalPath
    )
      blockers.push(
        blocker(
          "worktree-association-mismatch",
          "worktree identity or path changed after planning",
          "discard the plan and reconcile state",
        ),
      );
    if (
      worktree.status !== plan.worktree.status &&
      !(input.allowPostMutationState === true && worktree.status === "removed")
    )
      blockers.push(
        blocker("worktree-state-changed", "worktree lifecycle changed after planning", "discard the plan and re-plan"),
      );
  }
  const activityProbe = input.activityProbe ?? defaultActivityProbe;
  let activity: CleanupActivityObservation;
  try {
    activity = await activityProbe({
      canonicalWorktreePath: plan.worktree.canonicalPath,
      taskId: plan.task.taskId,
      worktreeId: plan.worktree.worktreeId,
    });
  } catch (err) {
    activity = { state: "unknown", detail: `managed activity probe failed: ${safeError(err)}` };
  }
  if (activity.state === "active")
    blockers.push(
      blocker("active-managed-process", activity.detail ?? "a managed process is active", "stop the process and retry"),
    );
  if (activity.state === "unknown")
    blockers.push(
      blocker(
        "managed-process-state-unknown",
        activity.detail ?? "managed process state is unknown",
        "retry with a trusted activity probe",
      ),
    );

  const expectedCompleted = new Set(input.expectedCompletedActionIds ?? []);
  const taskForGit =
    task ??
    ({
      taskId: plan.task.taskId,
      instanceId: plan.task.instanceId,
      taskSlug: plan.task.taskSlug,
      issueRef: undefined,
      lifecycleState: plan.task.lifecycleState as LifecycleState,
      version: plan.task.version,
      baseBranch: plan.task.baseBranch!,
      baseCommit: plan.task.baseCommit!,
      createdAt: 0,
      updatedAt: 0,
    } satisfies TaskRecord);
  const worktreeForGit =
    worktree ??
    ({
      worktreeId: plan.worktree.worktreeId,
      taskId: plan.worktree.taskId,
      instanceId: plan.worktree.instanceId,
      branchName: plan.worktree.branchName,
      canonicalPath: plan.worktree.canonicalPath,
      status: plan.worktree.status === "unknown" ? "active" : plan.worktree.status,
      baseBranch: plan.worktree.baseBranch,
      baseCommit: plan.worktree.baseCommit,
      createdAt: 0,
      updatedAt: 0,
    } satisfies WorktreeRecord);
  const repositoryRoot = plan.repository.canonicalRepositoryRoot;
  const gitRead = await readGitSnapshot(repositoryRoot, worktreeForGit, taskForGit, {
    allowMissingWorktree: expectedCompleted.has("remove-worktree") || input.allowPostMutationState === true,
    allowMissingBranch: expectedCompleted.has("delete-local-branch") || input.allowPostMutationState === true,
  });
  blockers.push(...gitRead.blockers);
  validateCommonSafety(
    taskForGit,
    worktreeForGit,
    gitRead.snapshot,
    plan.disposition === "unknown" ? "abandoned" : plan.disposition,
    blockers,
    {
      allowMissingBranch: expectedCompleted.has("delete-local-branch") || input.allowPostMutationState === true,
    },
  );
  if (plan.safety !== undefined) {
    if (!expectedCompleted.has("delete-local-branch") && gitRead.snapshot.branchHead !== plan.safety.git.branchHead)
      blockers.push(
        blocker("branch-head-changed", "task branch HEAD changed after planning", "discard the plan and re-plan"),
      );
    if (!expectedCompleted.has("delete-local-branch") && gitRead.snapshot.upstream !== plan.safety.git.upstream)
      blockers.push(
        blocker("upstream-changed", "task branch upstream changed after planning", "discard the plan and re-plan"),
      );
    if (
      !expectedCompleted.has("delete-remote-branch") &&
      !expectedCompleted.has("delete-local-branch") &&
      gitRead.snapshot.remoteBranchHead !== plan.safety.git.remoteBranchHead &&
      plan.actions.some((action) => action.id === "delete-remote-branch")
    )
      blockers.push(
        blocker("remote-branch-changed", "remote branch state changed after planning", "discard the plan and re-plan"),
      );
    if (gitRead.snapshot.stashCount !== plan.safety.git.stashCount)
      blockers.push(
        blocker("stash-state-changed", "stash state changed after planning", "discard the plan and re-plan"),
      );
    if (
      !expectedCompleted.has("delete-local-branch") &&
      gitRead.snapshot.branchMergedIntoBase !== plan.safety.git.branchMergedIntoBase &&
      plan.disposition === "merged"
    )
      blockers.push(
        blocker("merge-state-changed", "branch merge state changed after planning", "discard the plan and re-plan"),
      );
  }
  const remoteDeleteAction = plan.actions.find((action) => action.id === "delete-remote-branch");
  if (
    remoteDeleteAction?.id === "delete-remote-branch" &&
    expectedCompleted.has("delete-local-branch") &&
    !expectedCompleted.has("delete-remote-branch") &&
    plan.safety !== undefined
  ) {
    const remoteHeadResult = await gitValue(
      repositoryRoot,
      ["ls-remote", "--heads", remoteDeleteAction.remoteName, `refs/heads/${remoteDeleteAction.branchName}`],
      "revalidate remote branch",
    );
    const remoteHead = remoteHeadResult.ok ? remoteHeadResult.stdout.trim().split(/\s+/, 1)[0] || undefined : undefined;
    if (!remoteHeadResult.ok)
      blockers.push(
        blocker(
          "remote-branch-state-unavailable",
          remoteHeadResult.detail,
          "retry the exact plan after remote state is available",
        ),
      );
    else if (remoteHead !== plan.safety.git.remoteBranchHead)
      blockers.push(
        blocker("remote-branch-changed", "remote branch state changed after planning", "discard the plan and re-plan"),
      );
  }
  if (
    !expectedCompleted.has("prune-worktrees") &&
    plan.actions.some((action) => action.id === "prune-worktrees") &&
    plan.safety !== undefined &&
    JSON.stringify(gitRead.snapshot.pruneCandidates) !== JSON.stringify(plan.safety.git.pruneCandidates)
  ) {
    blockers.push(
      blocker(
        "prune-candidates-changed",
        "worktree prune candidates changed after planning",
        "discard the plan and re-plan",
      ),
    );
  }
  const records = input.store.listPullRequestRecordsForTask(plan.task.taskId);
  const pullRequest = await observePullRequest(records, input.pullRequestObserver);
  if (plan.disposition === "merged" && pullRequest.state !== "merged")
    blockers.push(
      blocker(
        pullRequest.state === "closed-unmerged" ? "pull-request-closed-unmerged" : "pull-request-merge-unverified",
        pullRequest.detail ?? "pull request is no longer freshly verified as merged",
        "re-query the provider and create a new plan",
      ),
    );
  if (
    plan.disposition === "abandoned" &&
    (pullRequest.state === "open" || pullRequest.state === "unknown" || pullRequest.state === "merged")
  )
    blockers.push(
      blocker(
        pullRequest.state === "open" ? "pull-request-open" : "pull-request-state-changed",
        pullRequest.detail ?? "pull request state is unsafe for abandoned cleanup",
        "resolve the pull request and create a new plan",
      ),
    );
  if (plan.safety?.pullRequest.state !== undefined && pullRequest.state !== plan.safety.pullRequest.state)
    blockers.push(
      blocker(
        "pull-request-state-changed",
        "pull request state changed after planning",
        "discard the plan and re-plan",
      ),
    );
  if (
    plan.disposition === "merged" &&
    pullRequest.state === "merged" &&
    pullRequest.headSha !== undefined &&
    gitRead.snapshot.branchHead !== pullRequest.headSha
  )
    blockers.push(
      blocker(
        "pull-request-head-mismatch",
        "fresh merged pull-request head does not match the task branch",
        "discard the plan and reconcile the branch/PR identity",
      ),
    );

  for (const action of plan.actions) {
    if (action.id === "remove-worktree" && !gitRead.snapshot.worktreeRegistered && !gitRead.snapshot.worktreePathExists)
      completedActionIds.push(action.id);
    if (action.id === "delete-local-branch" && gitRead.snapshot.branchHead === undefined)
      completedActionIds.push(action.id);
    if (action.id === "delete-remote-branch" && gitRead.snapshot.upstream === undefined)
      completedActionIds.push(action.id);
    if (
      action.id === "prune-worktrees" &&
      gitRead.snapshot.pruneCandidates.length === 0 &&
      action.candidates.length === 0
    )
      completedActionIds.push(action.id);
    if (action.id === "mark-worktree-removed" && worktree?.status === "removed") completedActionIds.push(action.id);
    if (action.id === "mark-task-cleaned" && task?.lifecycleState === "cleaned") completedActionIds.push(action.id);
  }
  const safety: CleanupSafetySnapshot = { observedAt: now, git: gitRead.snapshot, pullRequest, activity };
  return { ok: blockers.length === 0, blockers, safety, completedActionIds: [...new Set(completedActionIds)] };
}
