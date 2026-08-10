import fs from "node:fs";
import path from "node:path";
import { runProgram, type RunResult } from "../../subprocess.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type {
  TaskId,
  WorktreeId,
  WorkflowStateStore,
  TaskRecord,
  WorktreeRecord,
  RepositoryInstanceRecord,
} from "../state/store.js";
import type { LifecycleState } from "../domain/lifecycle.js";

export const GIT_OPERATION_TIMEOUT_MS = 10_000;
export const GIT_OPERATION_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_PATH_REPORT_LIMIT = 32;

export type GitCommandErrorCode = "git-spawn-failed" | "git-timeout" | "git-output-limit" | "git-command-failed";

export interface GitCommandFailure {
  code: GitCommandErrorCode;
  operation: string;
  detail: string;
}

export interface GitCommandObservation {
  result: RunResult;
  usable: boolean;
}

export async function runGitCommand(cwd: string, args: string[]): Promise<GitCommandObservation> {
  const result = await runProgram("git", args, cwd, GIT_OPERATION_TIMEOUT_MS, GIT_OPERATION_MAX_OUTPUT_BYTES);
  return {
    result,
    usable: result.spawnError === undefined && !result.timedOut && !result.outputLimit && result.exitCode !== null,
  };
}

export function gitCommandFailure(operation: string, observation: GitCommandObservation): GitCommandFailure {
  const { result, usable } = observation;
  if (result.spawnError !== undefined)
    return { code: "git-spawn-failed", operation, detail: "git process could not be started" };
  if (result.timedOut) return { code: "git-timeout", operation, detail: "git command exceeded its bounded timeout" };
  if (result.outputLimit)
    return { code: "git-output-limit", operation, detail: "git output exceeded its bounded capture limit" };
  if (!usable || result.exitCode === null)
    return { code: "git-command-failed", operation, detail: "git command did not complete" };
  return { code: "git-command-failed", operation, detail: `git command exited with code ${result.exitCode}` };
}

export interface BoundedPathList {
  paths: string[];
  truncated: boolean;
}

export function boundPaths(paths: readonly string[], limit = DEFAULT_PATH_REPORT_LIMIT): BoundedPathList {
  const uniquePaths = [...new Set(paths)].sort();
  return { paths: uniquePaths.slice(0, limit), truncated: uniquePaths.length > limit };
}

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  /** Present only for rename/copy entries; the path git renamed or copied from. */
  originalPath?: string;
}

export interface GitStatusSnapshot {
  entries: GitStatusEntry[];
  changedPaths: BoundedPathList;
  stagedPaths: BoundedPathList;
  unstagedPaths: BoundedPathList;
  untrackedPaths: BoundedPathList;
}

function parseStatusEntries(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const records = output.split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    // For rename/copy (R/C), porcelain -z emits the current (destination) path in this
    // record and the original (source) path as the following NUL-separated record.
    const currentPath = record.slice(3);
    let originalPath: string | undefined;
    if (
      (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") &&
      index + 1 < records.length
    ) {
      originalPath = records[index + 1]!;
      index += 1;
    }
    entries.push({
      path: currentPath,
      indexStatus,
      worktreeStatus,
      ...(originalPath !== undefined ? { originalPath } : {}),
    });
  }
  return entries;
}

export async function readGitStatus(
  cwd: string,
): Promise<{ ok: true; status: GitStatusSnapshot } | { ok: false; failure: GitCommandFailure }> {
  const observation = await runGitCommand(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!observation.usable || observation.result.exitCode !== 0) {
    return { ok: false, failure: gitCommandFailure("status", observation) };
  }

  const entries = parseStatusEntries(observation.result.stdout);
  const stagedPaths = entries
    .filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?")
    .map((entry) => entry.path);
  const unstagedPaths = entries
    .filter((entry) => entry.worktreeStatus !== " " && entry.worktreeStatus !== "?")
    .map((entry) => entry.path);
  const untrackedPaths = entries
    .filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?")
    .map((entry) => entry.path);
  return {
    ok: true,
    status: {
      entries,
      changedPaths: boundPaths(entries.map((entry) => entry.path)),
      stagedPaths: boundPaths(stagedPaths),
      unstagedPaths: boundPaths(unstagedPaths),
      untrackedPaths: boundPaths(untrackedPaths),
    },
  };
}

export type WorkflowContextFailureCode =
  | "task-not-found"
  | "repository-instance-not-found"
  | "task-repository-mismatch"
  | "worktree-not-found"
  | "worktree-not-active"
  | "worktree-task-mismatch"
  | "worktree-repository-mismatch"
  | "workspace-path-mismatch"
  | "repository-path-mismatch"
  | "branch-mismatch"
  | "detached-head"
  | "task-not-active"
  | GitCommandErrorCode;

export interface WorkflowContextFailure {
  ok: false;
  code: WorkflowContextFailureCode;
  detail: string;
}

export interface WorkflowContextInput {
  workspaceRoot: string;
  store: WorkflowStateStore;
  taskId: TaskId;
  /** Canonical spelling for new callers. `instanceId` is retained as a short compatibility alias. */
  repositoryInstanceId?: RepositoryInstanceId;
  instanceId?: RepositoryInstanceId;
  worktreeId?: WorktreeId;
  /** Expected current branch. Required for a task without a managed worktree. */
  expectedBranch?: string;
  /** Lifecycle states accepted by this operation. Defaults to the active state. */
  allowedLifecycleStates?: readonly LifecycleState[];
}

export interface VerifiedWorkflowContext {
  ok: true;
  task: TaskRecord;
  repository: RepositoryInstanceRecord;
  worktree: WorktreeRecord | undefined;
  workspaceRoot: string;
  branch: string;
  isPrimaryCheckout: boolean;
  headCommit: string;
}

export type WorkflowContextResult = VerifiedWorkflowContext | WorkflowContextFailure;

function canonicalPath(targetPath: string): string | undefined {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return undefined;
  }
}

function resolveGitPath(cwd: string, reportedPath: string): string | undefined {
  const absolutePath = path.resolve(cwd, reportedPath);
  return canonicalPath(absolutePath) ?? absolutePath;
}

function failureFromObservation(operation: string, observation: GitCommandObservation): WorkflowContextFailure {
  const failure = gitCommandFailure(operation, observation);
  return { ok: false, code: failure.code, detail: failure.detail };
}

export async function verifyWorkflowContext(input: WorkflowContextInput): Promise<WorkflowContextResult> {
  const repositoryInstanceId = input.repositoryInstanceId ?? input.instanceId;
  if (repositoryInstanceId === undefined) {
    return { ok: false, code: "repository-instance-not-found", detail: "repository instance id was not provided" };
  }

  const task = input.store.getTask(input.taskId);
  if (task === undefined) return { ok: false, code: "task-not-found", detail: "task was not found in workflow state" };
  const allowedLifecycleStates = input.allowedLifecycleStates ?? ["active"];
  if (!allowedLifecycleStates.includes(task.lifecycleState))
    return {
      ok: false,
      code: "task-not-active",
      detail: `task lifecycle is ${task.lifecycleState}, expected ${allowedLifecycleStates.join(" or ")}`,
    };
  if (task.instanceId !== repositoryInstanceId) {
    return {
      ok: false,
      code: "task-repository-mismatch",
      detail: "task does not belong to the requested repository instance",
    };
  }

  const repository = input.store.getRepositoryInstance(repositoryInstanceId);
  if (repository === undefined) {
    return {
      ok: false,
      code: "repository-instance-not-found",
      detail: "repository instance was not found in workflow state",
    };
  }

  const workspaceCanonicalPath = canonicalPath(input.workspaceRoot);
  if (workspaceCanonicalPath === undefined) {
    return { ok: false, code: "workspace-path-mismatch", detail: "workspace path could not be canonicalized" };
  }

  const [topLevel, commonDirectory, gitDirectory, symbolicRef, headCommitResult] = await Promise.all([
    runGitCommand(input.workspaceRoot, ["rev-parse", "--show-toplevel"]),
    runGitCommand(input.workspaceRoot, ["rev-parse", "--git-common-dir"]),
    runGitCommand(input.workspaceRoot, ["rev-parse", "--git-dir"]),
    runGitCommand(input.workspaceRoot, ["symbolic-ref", "-q", "--short", "HEAD"]),
    runGitCommand(input.workspaceRoot, ["rev-parse", "--verify", "HEAD"]),
  ]);
  if (!topLevel.usable || topLevel.result.exitCode !== 0)
    return failureFromObservation("resolve-worktree-root", topLevel);
  if (!commonDirectory.usable || commonDirectory.result.exitCode !== 0)
    return failureFromObservation("resolve-git-common-dir", commonDirectory);
  if (!gitDirectory.usable || gitDirectory.result.exitCode !== 0)
    return failureFromObservation("resolve-git-dir", gitDirectory);
  if (
    !headCommitResult.usable ||
    headCommitResult.result.exitCode !== 0 ||
    headCommitResult.result.stdout.trim().length === 0
  )
    return failureFromObservation("resolve-head-commit", headCommitResult);
  const headCommit = headCommitResult.result.stdout.trim();

  const reportedTopLevel = canonicalPath(topLevel.result.stdout.trim());
  if (reportedTopLevel !== workspaceCanonicalPath) {
    return { ok: false, code: "workspace-path-mismatch", detail: "workspace is not the Git worktree recorded by Git" };
  }

  const commonDirectoryPath = resolveGitPath(input.workspaceRoot, commonDirectory.result.stdout.trim());
  const recordedCommonDirectory = canonicalPath(repository.gitCommonDir) ?? path.resolve(repository.gitCommonDir);
  if (commonDirectoryPath !== recordedCommonDirectory) {
    return {
      ok: false,
      code: "repository-path-mismatch",
      detail: "Git common directory does not match repository identity",
    };
  }

  if (!symbolicRef.usable) return failureFromObservation("resolve-current-branch", symbolicRef);
  if (symbolicRef.result.exitCode !== 0 || symbolicRef.result.stdout.trim().length === 0) {
    return { ok: false, code: "detached-head", detail: "current HEAD is not attached to a branch" };
  }
  const branch = symbolicRef.result.stdout.trim();
  const expectedBranch = input.expectedBranch;
  if (expectedBranch !== undefined && branch !== expectedBranch) {
    return {
      ok: false,
      code: "branch-mismatch",
      detail: `current branch ${branch} does not match expected branch ${expectedBranch}`,
    };
  }

  const gitDirectoryPath = resolveGitPath(input.workspaceRoot, gitDirectory.result.stdout.trim());
  const isPrimaryCheckout = gitDirectoryPath === commonDirectoryPath;

  const taskWorktrees = input.store.listWorktreesForTask(input.taskId);
  let worktree: WorktreeRecord | undefined;
  if (input.worktreeId !== undefined) {
    worktree = taskWorktrees.find((candidate) => candidate.worktreeId === input.worktreeId);
    if (worktree === undefined)
      return { ok: false, code: "worktree-not-found", detail: "requested worktree is not attached to the task" };
  } else {
    const activeAtPath = taskWorktrees.filter(
      (candidate) => candidate.status === "active" && candidate.canonicalPath === workspaceCanonicalPath,
    );
    if (activeAtPath.length > 1)
      return {
        ok: false,
        code: "worktree-task-mismatch",
        detail: "multiple active worktrees match the workspace path",
      };
    worktree = activeAtPath[0];
    if (worktree === undefined && taskWorktrees.some((candidate) => candidate.status === "active")) {
      return {
        ok: false,
        code: "workspace-path-mismatch",
        detail: "workspace path does not match the task's active worktree",
      };
    }
  }

  if (worktree !== undefined) {
    if (worktree.status !== "active")
      return {
        ok: false,
        code: "worktree-not-active",
        detail: `worktree status is ${worktree.status}, expected active`,
      };
    if (worktree.taskId !== task.taskId)
      return { ok: false, code: "worktree-task-mismatch", detail: "worktree does not belong to the requested task" };
    if (worktree.instanceId !== repositoryInstanceId)
      return {
        ok: false,
        code: "worktree-repository-mismatch",
        detail: "worktree does not belong to the requested repository instance",
      };
    if (worktree.canonicalPath !== workspaceCanonicalPath)
      return { ok: false, code: "workspace-path-mismatch", detail: "workspace path does not match the task worktree" };
    if (worktree.branchName !== branch)
      return {
        ok: false,
        code: "branch-mismatch",
        detail: `current branch ${branch} does not match worktree branch ${worktree.branchName}`,
      };
  } else if (expectedBranch === undefined) {
    return { ok: false, code: "branch-mismatch", detail: "a task without a managed worktree requires expectedBranch" };
  }

  return {
    ok: true,
    task,
    repository,
    worktree,
    workspaceRoot: workspaceCanonicalPath,
    branch,
    isPrimaryCheckout,
    headCommit,
  };
}

export function isPathInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  if (candidatePath.length === 0 || path.isAbsolute(candidatePath)) return false;
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCandidate = path.resolve(workspaceRoot, candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}
