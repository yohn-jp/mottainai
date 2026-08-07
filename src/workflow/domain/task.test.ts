import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { getTaskStatus, startTask, transitionTask } from "./task.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t: TestContext): string {
  const root = tmpDir(t, "mottainai-task-test-");
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
  git(["add", "file.txt"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

function openStore(t: TestContext): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  return store;
}

function standardPolicy(overrides: Partial<WorkflowPolicyDocument["worktree"]> = {}): WorkflowPolicyDocument {
  return { ...BUILTIN_PRESETS.standard, worktree: { ...BUILTIN_PRESETS.standard.worktree, ...overrides } };
}

test("startTask happy path creates an active task with an active worktree (issue-bound)", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const result = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "my-task", issueRef: "33" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.lifecycleState, "active");
  assert.equal(result.task.issueRef, "33");
  assert.ok(result.worktree !== undefined);
  assert.equal(result.worktree?.status, "active");
  assert.equal(result.worktree?.branchName, "issue-33/my-task");
  // standard preset の bootstrapMode は "suggest" のため実行しない。
  assert.equal(result.bootstrapRun, undefined);
});

test("startTask with bootstrapMode=automatic returns the bootstrap execution outcome (not just the decision)", async (t) => {
  const root = initRepo(t);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  git(["add", "pnpm-lock.yaml"], root);
  git(["commit", "--quiet", "-m", "add lockfile"], root);
  const store = openStore(t);
  const policy = standardPolicy({ bootstrapMode: "automatic" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "bootstrap-check" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bootstrap?.shouldExecute, true);
  assert.ok(result.bootstrapRun !== undefined, "expected bootstrapRun to be populated when bootstrap actually executes");
  assert.equal(result.bootstrapRun?.ran, true);
});

test("startTask happy path without an issueRef", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const result = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "no-issue" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.issueRef, undefined);
  assert.equal(result.worktree?.branchName, "task/no-issue");
});

test("startTask rejects when staleBaseBranch=enforce and local base branch is behind origin", async (t) => {
  const root = initRepo(t);
  const remote = tmpDir(t, "mottainai-task-test-remote-");
  git(["init", "--quiet", "--bare", "-b", "main"], remote);
  git(["remote", "add", "origin", remote], root);
  git(["push", "--quiet", "origin", "main"], root);

  // origin に新しいコミットを積むが、ローカル main の tracking ref (`origin/main`) は
  // 明示 fetch するまで更新されない — clone を経由して origin 側だけ進める。
  const otherClone = tmpDir(t, "mottainai-task-test-clone-");
  git(["clone", "--quiet", remote, otherClone], path.dirname(otherClone));
  fs.writeFileSync(path.join(otherClone, "file2.txt"), "more\n");
  git(["add", "file2.txt"], otherClone);
  git(["config", "user.email", "test@example.com"], otherClone);
  git(["config", "user.name", "Test"], otherClone);
  git(["commit", "--quiet", "-m", "second"], otherClone);
  git(["push", "--quiet", "origin", "main"], otherClone);
  git(["fetch", "--quiet", "origin"], root);

  const store = openStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "stale-check" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unsupported-repo-state");
  assert.match(result.detail, /behind origin\/main/);
});

test("startTask succeeds when staleBaseBranch=enforce and local base branch matches origin", async (t) => {
  const root = initRepo(t);
  const remote = tmpDir(t, "mottainai-task-test-remote-");
  git(["init", "--quiet", "--bare", "-b", "main"], remote);
  git(["remote", "add", "origin", remote], root);
  git(["push", "--quiet", "origin", "main"], root);

  const store = openStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "fresh-check" });
  assert.equal(result.ok, true);
});

test("startTask ignores staleBaseBranch when no origin tracking ref exists", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "no-origin-check" });
  assert.equal(result.ok, true);
});

test("startTask rejects when issueRequired=enforce and no issueRef is provided", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const policy = standardPolicy({ issueRequired: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "needs-issue" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "issue-required");
});

test("startTask denies a no-worktree task start when protected-branch sourceWrite is enforced on the primary checkout", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const policy: WorkflowPolicyDocument = {
    ...BUILTIN_PRESETS["strict-worktree"],
    worktree: { ...BUILTIN_PRESETS["strict-worktree"].worktree, required: "off" },
  };
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "direct-edit", skipWorktree: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "policy-denied");
});

test("startTask reports branch-collision when the branch is already claimed by an active worktree", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const policy = standardPolicy();
  const first = await startTask({ workspaceRoot: root, store, policy, taskSlug: "dup" });
  assert.equal(first.ok, true);

  const second = await startTask({ workspaceRoot: root, store, policy, taskSlug: "dup" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "branch-collision");
});

test("startTask rejects a second active task for the same issue when multipleActiveTasksPerIssue is disallowed", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "enforce" });
  const first = await startTask({ workspaceRoot: root, store, policy, taskSlug: "task-a", issueRef: "7" });
  assert.equal(first.ok, true);

  const second = await startTask({ workspaceRoot: root, store, policy, taskSlug: "task-b", issueRef: "7" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "issue-already-claimed");
});

test("getTaskStatus reflects lifecycle state and allowed next transitions", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "status-check" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const status = getTaskStatus(store, started.task.taskId);
  assert.ok(status !== undefined);
  assert.equal(status?.task.lifecycleState, "active");
  assert.deepEqual(status?.allowedNextTransitions.sort(), ["abandoned", "committed", "orphaned"].sort());
  assert.equal(status?.worktrees.length, 1);
});

test("getTaskStatus returns undefined for an unknown task id", (t) => {
  const store = openStore(t);
  assert.equal(getTaskStatus(store, "does-not-exist" as never), undefined);
});

test("transitionTask applies a valid transition and rejects an invalid one with structured blocker info", async (t) => {
  const root = initRepo(t);
  const store = openStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "transition-check" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const valid = transitionTask(store, started.task.taskId, "committed");
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.task.lifecycleState, "committed");

  const invalid = transitionTask(store, started.task.taskId, "merged");
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.blocked.currentState, "committed");
  assert.equal(invalid.blocked.requestedTransition, "merged");
  assert.ok(invalid.blocked.allowedNextTransitions.includes("pushed"));
});
