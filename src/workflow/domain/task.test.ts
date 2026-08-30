import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { fakeNawabari, startNawabariManagedTask } from "../../test-support/nawabari-fixture.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { validateBranchNameAgainstGovernance } from "../governance/branch.js";
import { resolveRepositoryIdentity } from "./identity.js";
import {
  checkStaleBaseBranch,
  getTaskStatus,
  getTaskStatusById,
  getTaskStatusForWorkspace,
  listTaskDiscoverySnapshot,
  startTask,
  transitionTask,
} from "./task.js";

function standardPolicy(overrides: Partial<WorkflowPolicyDocument["worktree"]> = {}): WorkflowPolicyDocument {
  return { ...BUILTIN_PRESETS.standard, worktree: { ...BUILTIN_PRESETS.standard.worktree, ...overrides } };
}

test("startTask happy path creates an active task with an active worktree (issue-bound)", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const result = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "my-task", branchType: "fix", issueRef: "33" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.lifecycleState, "active");
  assert.equal(result.task.issueRef, "33");
  assert.ok(result.worktree !== undefined);
  assert.equal(result.worktree?.status, "active");
  assert.equal(result.worktree?.branchName, "fix/33-my-task");
  // standard preset の bootstrapMode は "suggest" のため実行しない。
  assert.equal(result.bootstrapRun, undefined);
});

test("startTask uses one canonical managed root from primary and linked worktrees", async (t) => {
  const root = createTempGitRepo(t);
  const linkedParent = createTempDir(t, "mottainai-task-linked-caller-");
  const linkedRoot = path.join(linkedParent, "linked");
  runGit(["worktree", "add", "--quiet", "-b", "caller-branch", linkedRoot], root);
  t.after(() => {
    try {
      runGit(["worktree", "remove", "--force", linkedRoot], root);
    } catch {
      // best effort cleanup after an assertion failure
    }
  });

  const store = createWorkflowStore(t);
  const primary = await startTask({
    workspaceRoot: root,
    store,
    policy: standardPolicy(),
    taskSlug: "from-primary",
    branchType: "fix",
    issueRef: "102",
  });
  const linked = await startTask({
    workspaceRoot: linkedRoot,
    store,
    policy: standardPolicy(),
    taskSlug: "from-linked",
    branchType: "docs",
    issueRef: "103",
  });
  assert.equal(primary.ok, true);
  assert.equal(linked.ok, true);
  if (!primary.ok || !linked.ok) return;

  const expectedRoot = path.join(root, ".mottainai", "worktrees");
  assert.equal(path.dirname(primary.worktree!.canonicalPath), expectedRoot);
  assert.equal(path.dirname(linked.worktree!.canonicalPath), expectedRoot);
  assert.equal(primary.worktree?.canonicalPath, path.join(expectedRoot, "fix-102-from-primary"));
  assert.equal(linked.worktree?.canonicalPath, path.join(expectedRoot, "docs-103-from-linked"));
  assert.deepEqual(await validateBranchNameAgainstGovernance(primary.worktree!.branchName, root), { ok: true });
  assert.deepEqual(await validateBranchNameAgainstGovernance(linked.worktree!.branchName, root), { ok: true });
  assert.equal(runGit(["-C", linked.worktree!.canonicalPath, "branch", "--show-current"], root), "docs/103-from-linked");
  assert.equal(fs.existsSync(path.join(linkedRoot, ".mottainai")), false);
  assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
});

test("startTask rejects a governance-invalid generated branch before Git or SQLite reservation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const result = await startTask({
    workspaceRoot: root,
    store,
    policy: standardPolicy(),
    taskSlug: "invalid-type",
    branchType: "feature",
    issueRef: "104",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid-branch-name");
  assert.match(result.detail, /rejected before Git mutation/);
  assert.equal(fs.existsSync(path.join(root, ".mottainai", "worktrees")), false);
  assert.equal(runGit(["branch", "--list", "feature/104-invalid-type"], root), "");
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  assert.equal(store.getActiveTaskByIssueRef(identity.identity.instanceId, "104"), undefined);
  assert.deepEqual(store.listWorktreesForInstance(identity.identity.instanceId), []);
});

test("startTask rejects a duplicated Issue identity before Git or SQLite reservation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const result = await startTask({
    workspaceRoot: root,
    store,
    policy: standardPolicy(),
    taskSlug: "378-nawabari-integration-close",
    branchType: "fix",
    issueRef: "378",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid-branch-name");
  assert.match(result.detail, /repeats issue identity/);
  assert.deepEqual(store.listTasks(), []);
  assert.equal(runGit(["branch", "--list", "fix/378-378-nawabari-integration-close"], root), "");
  assert.equal(fs.existsSync(path.join(root, ".mottainai", "worktrees")), false);
});

test("startTask with bootstrapMode=automatic returns the bootstrap execution outcome (not just the decision)", async (t) => {
  const root = createTempGitRepo(t);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  runGit(["add", "pnpm-lock.yaml"], root);
  runGit(["commit", "--quiet", "-m", "add lockfile"], root);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ bootstrapMode: "automatic" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "bootstrap-check", branchType: "fix", issueRef: "34" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bootstrap?.shouldExecute, true);
  assert.ok(result.bootstrapRun !== undefined, "expected bootstrapRun to be populated when bootstrap actually executes");
  assert.equal(result.bootstrapRun?.ran, true);
});

test("startTask rejects a worktree task without an issueRef before state reservation", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const result = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "no-issue", branchType: "fix" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "issue-required");
  const status = await getTaskStatusForWorkspace(root, store);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.active, false);
});

test("startTask rejects when staleBaseBranch=enforce and local base branch is behind origin", async (t) => {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-task-test-remote-");
  runGit(["init", "--quiet", "--bare", "-b", "main"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["push", "--quiet", "origin", "main"], root);

  // origin に新しいコミットを積むが、ローカル main の tracking ref (`origin/main`) は
  // 明示 fetch するまで更新されない — clone を経由して origin 側だけ進める。
  const otherClone = createTempDir(t, "mottainai-task-test-clone-");
  runGit(["clone", "--quiet", remote, otherClone], path.dirname(otherClone));
  fs.writeFileSync(path.join(otherClone, "file2.txt"), "more\n");
  runGit(["add", "file2.txt"], otherClone);
  runGit(["config", "user.email", "test@example.com"], otherClone);
  runGit(["config", "user.name", "Test"], otherClone);
  runGit(["commit", "--quiet", "-m", "second"], otherClone);
  runGit(["push", "--quiet", "origin", "main"], otherClone);
  runGit(["fetch", "--quiet", "origin"], root);

  const store = createWorkflowStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "stale-check", branchType: "fix", issueRef: "35" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unsupported-repo-state");
  assert.match(result.detail, /behind origin\/main/);
});

test("startTask succeeds when staleBaseBranch=enforce and local base branch matches origin", async (t) => {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-task-test-remote-");
  runGit(["init", "--quiet", "--bare", "-b", "main"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["push", "--quiet", "origin", "main"], root);

  const store = createWorkflowStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "fresh-check", branchType: "fix", issueRef: "36" });
  assert.equal(result.ok, true);
});

test("startTask ignores staleBaseBranch when no origin tracking ref exists", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ staleBaseBranch: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "no-origin-check", branchType: "fix", issueRef: "37" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
});

test("startTask allows but records a warning when staleBaseBranch=advisory and local base branch is behind origin", async (t) => {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-task-test-remote-");
  runGit(["init", "--quiet", "--bare", "-b", "main"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["push", "--quiet", "origin", "main"], root);

  const otherClone = createTempDir(t, "mottainai-task-test-clone-");
  runGit(["clone", "--quiet", remote, otherClone], path.dirname(otherClone));
  fs.writeFileSync(path.join(otherClone, "file2.txt"), "more\n");
  runGit(["add", "file2.txt"], otherClone);
  runGit(["config", "user.email", "test@example.com"], otherClone);
  runGit(["config", "user.name", "Test"], otherClone);
  runGit(["commit", "--quiet", "-m", "second"], otherClone);
  runGit(["push", "--quiet", "origin", "main"], otherClone);
  runGit(["fetch", "--quiet", "origin"], root);

  const store = createWorkflowStore(t);
  const policy = standardPolicy({ staleBaseBranch: "advisory" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "stale-advisory-check", branchType: "fix", issueRef: "38" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "stale-base-branch");
  assert.match(result.warnings[0].detail, /behind origin\/main/);
});

test("checkStaleBaseBranch reports unknown (not fresh) when a git call does not complete", async (t) => {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-task-test-remote-");
  runGit(["init", "--quiet", "--bare", "-b", "main"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["push", "--quiet", "origin", "main"], root);
  const baseCommit = runGit(["rev-parse", "HEAD"], root);

  // PATH を壊し `git` 自体を spawn 不能にすることで、"非0 exit" ではなく
  // "コマンドが完走しなかった" 状態（usable=false）を再現する。
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const result = await checkStaleBaseBranch(root, "main", baseCommit);
  assert.equal(result.kind, "unknown");
});

test("startTask rejects when issueRequired=enforce and no issueRef is provided", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ issueRequired: "enforce" });
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "needs-issue", branchType: "fix" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "issue-required");
});

test("startTask denies a no-worktree task start when protected-branch sourceWrite is enforced on the primary checkout", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy: WorkflowPolicyDocument = {
    ...BUILTIN_PRESETS["strict-worktree"],
    worktree: { ...BUILTIN_PRESETS["strict-worktree"].worktree, required: "off" },
  };
  const result = await startTask({ workspaceRoot: root, store, policy, taskSlug: "direct-edit", branchType: "fix", skipWorktree: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "policy-denied");
});

test("startTask reports branch-collision when the branch is already claimed by an active worktree", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy();
  const first = await startTask({ workspaceRoot: root, store, policy, taskSlug: "dup", branchType: "fix", issueRef: "39" });
  assert.equal(first.ok, true);

  const second = await startTask({ workspaceRoot: root, store, policy, taskSlug: "dup", branchType: "fix", issueRef: "39" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "branch-collision");
});

test("startTask rejects a second active task for the same issue when multipleActiveTasksPerIssue is disallowed", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "enforce" });
  const first = await startTask({ workspaceRoot: root, store, policy, taskSlug: "task-a", branchType: "fix", issueRef: "7" });
  assert.equal(first.ok, true);

  const second = await startTask({ workspaceRoot: root, store, policy, taskSlug: "task-b", branchType: "fix", issueRef: "7" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "issue-already-claimed");
});

test("getTaskStatus reflects lifecycle state and allowed next transitions", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "status-check", branchType: "fix", issueRef: "40" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const status = getTaskStatus(store, started.task.taskId);
  assert.ok(status !== undefined);
  assert.equal(status?.task.lifecycleState, "active");
  assert.deepEqual(status?.allowedNextTransitions.sort(), ["abandoned", "committed", "orphaned"].sort());
  assert.equal(status?.worktrees.length, 1);
});

test("getTaskStatus returns undefined for an unknown task id", (t) => {
  const store = createWorkflowStore(t);
  assert.equal(getTaskStatus(store, "does-not-exist" as never), undefined);
});

test("startTask rejects starting a second task from inside an already-active task worktree", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy();
  const outer = await startTask({ workspaceRoot: root, store, policy, taskSlug: "outer", branchType: "fix", issueRef: "41" });
  assert.equal(outer.ok, true);
  if (!outer.ok) return;
  assert.ok(outer.worktree !== undefined);

  const inner = await startTask({ workspaceRoot: outer.worktree!.canonicalPath, store, policy, taskSlug: "inner", branchType: "fix", issueRef: "42" });
  assert.equal(inner.ok, false);
  if (inner.ok) return;
  assert.equal(inner.reason, "active-task-in-workspace");
  assert.ok(inner.detail.includes(outer.task.taskId));
});

test("getTaskStatusForWorkspace reports no active task for a plain repository", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const status = await getTaskStatusForWorkspace(root, store);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.active, false);
  assert.equal(status.branch, "main");
  assert.deepEqual(status.warnings, []);
});

test("getTaskStatusForWorkspace reports the active task from inside its own worktree", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "status-ws", branchType: "fix", issueRef: "43" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const status = await getTaskStatusForWorkspace(started.worktree!.canonicalPath, store);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.active, true);
  if (!status.active) return;
  assert.equal(status.status.task.taskId, started.task.taskId);
  assert.equal(status.branch, started.worktree?.branchName);
});

test("getTaskStatusForWorkspace surfaces detached HEAD as a warning instead of failing (no active task is a normal outcome)", async (t) => {
  const root = createTempGitRepo(t);
  const headCommit = runGit(["rev-parse", "HEAD"], root);
  runGit(["checkout", "--quiet", headCommit], root);
  const store = createWorkflowStore(t);
  const status = await getTaskStatusForWorkspace(root, store);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.active, false);
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0].code, /detached-head/);
});

test("getTaskStatusForWorkspace fails closed for a non-git directory", async (t) => {
  const dir = createTempDir(t, "mottainai-task-test-nongit-");
  const store = createWorkflowStore(t);
  const status = await getTaskStatusForWorkspace(dir, store);
  assert.equal(status.ok, false);
});

test("getTaskStatusForWorkspace keeps two repositories' active tasks separate in a shared store", async (t) => {
  const rootA = createTempGitRepo(t);
  const rootB = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const startedA = await startTask({ workspaceRoot: rootA, store, policy: standardPolicy(), taskSlug: "repo-a-task", branchType: "fix", issueRef: "44" });
  assert.equal(startedA.ok, true);
  if (!startedA.ok) return;

  const statusB = await getTaskStatusForWorkspace(rootB, store);
  assert.equal(statusB.ok, true);
  if (!statusB.ok) return;
  assert.equal(statusB.active, false);

  const statusA = await getTaskStatusForWorkspace(startedA.worktree!.canonicalPath, store);
  assert.equal(statusA.ok, true);
  if (!statusA.ok) return;
  assert.equal(statusA.active, true);
});

test("separate repository instances never share the canonical managed worktree root", async (t) => {
  const rootA = createTempGitRepo(t);
  const rootB = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const [startedA, startedB] = await Promise.all([
    startTask({ workspaceRoot: rootA, store, policy: standardPolicy(), taskSlug: "same-task", branchType: "fix", issueRef: "105" }),
    startTask({ workspaceRoot: rootB, store, policy: standardPolicy(), taskSlug: "same-task", branchType: "fix", issueRef: "105" }),
  ]);
  assert.equal(startedA.ok, true);
  assert.equal(startedB.ok, true);
  if (!startedA.ok || !startedB.ok) return;
  assert.notEqual(startedA.worktree?.canonicalPath, startedB.worktree?.canonicalPath);
  assert.equal(path.dirname(startedA.worktree!.canonicalPath), path.join(rootA, ".mottainai", "worktrees"));
  assert.equal(path.dirname(startedB.worktree!.canonicalPath), path.join(rootB, ".mottainai", "worktrees"));
});

test("getTaskStatusForWorkspace distinguishes between two active worktrees of the same repository", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "advisory" });
  const first = await startTask({ workspaceRoot: root, store, policy, taskSlug: "multi-a", branchType: "fix", issueRef: "45" });
  const second = await startTask({ workspaceRoot: root, store, policy, taskSlug: "multi-b", branchType: "fix", issueRef: "45" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  const statusFirst = await getTaskStatusForWorkspace(first.worktree!.canonicalPath, store);
  const statusSecond = await getTaskStatusForWorkspace(second.worktree!.canonicalPath, store);
  assert.equal(statusFirst.ok, true);
  assert.equal(statusSecond.ok, true);
  if (!statusFirst.ok || !statusSecond.ok || !statusFirst.active || !statusSecond.active) return;
  assert.equal(statusFirst.status.task.taskId, first.task.taskId);
  assert.equal(statusSecond.status.task.taskId, second.task.taskId);
  assert.notEqual(statusFirst.status.task.taskId, statusSecond.status.task.taskId);
});

test("getTaskStatusForWorkspace survives a store restart against a file-backed database", async (t) => {
  const root = createTempGitRepo(t);
  const dbDir = createTempDir(t, "mottainai-task-test-db-");
  const dbPath = path.join(dbDir, "state.sqlite3");
  const store1 = new WorkflowSqliteStateStore({ dbPath });
  store1.init();
  t.after(() => store1.close());
  const started = await startTask({ workspaceRoot: root, store: store1, policy: standardPolicy(), taskSlug: "restart-check", branchType: "fix", issueRef: "46" });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  store1.close();

  const store2 = new WorkflowSqliteStateStore({ dbPath });
  store2.init();
  t.after(() => store2.close());
  const status = await getTaskStatusForWorkspace(started.worktree!.canonicalPath, store2);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.active, true);
  if (!status.active) return;
  assert.equal(status.status.task.taskId, started.task.taskId);
});

test("transitionTask applies a valid transition and rejects an invalid one with structured blocker info", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "transition-check", branchType: "fix", issueRef: "47" });
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

// --- Issue #539: cross-workspace task/session discovery -------------------

test("listTaskDiscoverySnapshot enumerates active tasks across two repositories and two concurrent sessions without a workspace hint", async (t) => {
  const rootA = createTempGitRepo(t);
  const rootB = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "advisory" });

  const a1 = await startTask({ workspaceRoot: rootA, store, policy, taskSlug: "repo-a-one", branchType: "fix", issueRef: "201" });
  const a2 = await startTask({ workspaceRoot: rootA, store, policy, taskSlug: "repo-a-two", branchType: "fix", issueRef: "202" });
  const b1 = await startTask({ workspaceRoot: rootB, store, policy, taskSlug: "repo-b-one", branchType: "fix", issueRef: "301" });
  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);
  assert.equal(b1.ok, true);
  if (!a1.ok || !a2.ok || !b1.ok) return;

  const before = Date.now();
  const result = listTaskDiscoverySnapshot(store);
  assert.equal(result.schemaVersion, 1);
  // generatedAt makes the snapshot's point-in-time nature explicit and checkable,
  // not just documented in prose — see the module-level discovery-snapshot contract.
  assert.ok(result.generatedAt >= before && result.generatedAt <= Date.now());
  const taskIds = result.tasks.map((task) => task.taskId);
  assert.ok(taskIds.includes(a1.task.taskId));
  assert.ok(taskIds.includes(a2.task.taskId));
  assert.ok(taskIds.includes(b1.task.taskId));

  const entryA1 = result.tasks.find((task) => task.taskId === a1.task.taskId)!;
  const entryA2 = result.tasks.find((task) => task.taskId === a2.task.taskId)!;
  const entryB1 = result.tasks.find((task) => task.taskId === b1.task.taskId)!;
  // Two concurrent sessions in the same repository share repository identity...
  assert.equal(entryA1.repository.instanceId, entryA2.repository.instanceId);
  // ...while the second repository has a distinct, opaque identity.
  assert.notEqual(entryA1.repository.instanceId, entryB1.repository.instanceId);
  assert.equal(entryA1.branchName, a1.worktree?.branchName);
  assert.equal(entryB1.branchName, b1.worktree?.branchName);
});

test("listTaskDiscoverySnapshot never includes an absolute filesystem path or other private registry state", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "no-path-leak", branchType: "fix", issueRef: "401" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const result = listTaskDiscoverySnapshot(store);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /"worktreePath"/);
  assert.doesNotMatch(serialized, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(serialized, new RegExp(started.worktree!.canonicalPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  const entry = result.tasks.find((task) => task.taskId === started.task.taskId)!;
  assert.deepEqual(Object.keys(entry.repository), ["instanceId"]);
});

test("listTaskDiscoverySnapshot excludes closed/abandoned/finished tasks from the default view while unrelated tasks remain listed", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "advisory" });
  const stillActive = await startTask({ workspaceRoot: root, store, policy, taskSlug: "stays-listed", branchType: "fix", issueRef: "501" });
  const willAbandon = await startTask({ workspaceRoot: root, store, policy, taskSlug: "gets-abandoned", branchType: "fix", issueRef: "502" });
  assert.equal(stillActive.ok, true);
  assert.equal(willAbandon.ok, true);
  if (!stillActive.ok || !willAbandon.ok) return;

  const beforeAbandon = listTaskDiscoverySnapshot(store);
  assert.ok(beforeAbandon.tasks.some((task) => task.taskId === willAbandon.task.taskId));

  const abandoned = transitionTask(store, willAbandon.task.taskId, "abandoned");
  assert.equal(abandoned.ok, true);

  const afterAbandon = listTaskDiscoverySnapshot(store);
  assert.ok(afterAbandon.tasks.some((task) => task.taskId === stillActive.task.taskId));
  assert.ok(!afterAbandon.tasks.some((task) => task.taskId === willAbandon.task.taskId));
});

test("listTaskDiscoverySnapshot excludes every terminal/ownership-unresolved lifecycle state: merged, cleaned, and orphaned", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "advisory" });

  const willFinish = await startTask({ workspaceRoot: root, store, policy, taskSlug: "gets-finished", branchType: "fix", issueRef: "511" });
  const willOrphan = await startTask({ workspaceRoot: root, store, policy, taskSlug: "gets-orphaned", branchType: "fix", issueRef: "512" });
  assert.equal(willFinish.ok, true);
  assert.equal(willOrphan.ok, true);
  if (!willFinish.ok || !willOrphan.ok) return;

  assert.equal(transitionTask(store, willFinish.task.taskId, "committed").ok, true);
  assert.equal(transitionTask(store, willFinish.task.taskId, "pushed").ok, true);
  assert.equal(transitionTask(store, willFinish.task.taskId, "pull-request-open").ok, true);
  assert.equal(transitionTask(store, willFinish.task.taskId, "merged").ok, true);
  const mergedListed = listTaskDiscoverySnapshot(store);
  assert.ok(!mergedListed.tasks.some((task) => task.taskId === willFinish.task.taskId));

  assert.equal(transitionTask(store, willFinish.task.taskId, "cleaned").ok, true);
  const cleanedListed = listTaskDiscoverySnapshot(store);
  assert.ok(!cleanedListed.tasks.some((task) => task.taskId === willFinish.task.taskId));

  assert.equal(transitionTask(store, willOrphan.task.taskId, "orphaned").ok, true);
  const orphanedListed = listTaskDiscoverySnapshot(store);
  assert.ok(!orphanedListed.tasks.some((task) => task.taskId === willOrphan.task.taskId));
});

test("listTaskDiscoverySnapshot task ids are unique and stable across the returned snapshot", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = standardPolicy({ multipleActiveTasksPerIssue: "advisory" });
  await startTask({ workspaceRoot: root, store, policy, taskSlug: "unique-a", branchType: "fix", issueRef: "601" });
  await startTask({ workspaceRoot: root, store, policy, taskSlug: "unique-b", branchType: "fix", issueRef: "602" });
  await startTask({ workspaceRoot: root, store, policy, taskSlug: "unique-c", branchType: "fix", issueRef: "603" });

  const result = listTaskDiscoverySnapshot(store);
  const ids = result.tasks.map((task) => task.taskId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/u);
});

test("getTaskStatusById resolves a legacy task's current canonical worktree path fresh, keyed only by taskId", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "keyed-legacy", branchType: "fix", issueRef: "701" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const nawabari = fakeNawabari(root);
  const result = await getTaskStatusById(store, started.task.taskId, nawabari);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktreePath, started.worktree!.canonicalPath);
  assert.equal(result.branch, started.worktree!.branchName);
  assert.equal(result.task.taskId, started.task.taskId);
});

test("getTaskStatusById resolves a Nawabari-managed task's current worktree path without any --workspace hint", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const fixture = await startNawabariManagedTask(t, {
    root,
    store,
    policy: standardPolicy(),
    taskSlug: "keyed-nawabari",
    branchType: "fix",
    issueRef: "801",
  });

  const result = await getTaskStatusById(store, fixture.task.taskId, fixture.nawabari);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktreePath, fixture.worktree.canonicalPath);
  assert.equal(result.branch, fixture.worktree.branchName);
});

test("getTaskStatusById fails closed with no fallback when the task id is unknown", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = fakeNawabari(root);
  const result = await getTaskStatusById(store, "not-a-real-task-id" as never, nawabari);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "task-not-found");
});

test("getTaskStatusById fails closed once a task has closed, never resolving to another task or the caller's cwd", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({ workspaceRoot: root, store, policy: standardPolicy(), taskSlug: "keyed-closes", branchType: "fix", issueRef: "901" });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const abandoned = transitionTask(store, started.task.taskId, "abandoned");
  assert.equal(abandoned.ok, true);

  const nawabari = fakeNawabari(root);
  const result = await getTaskStatusById(store, started.task.taskId, nawabari);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "task-unavailable:abandoned");
});

test("discovery-snapshot contract: a task present in listTaskDiscoverySnapshot can still fail closed in getTaskStatusById (normal race, not a bug)", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const nawabariForStart = fakeNawabari(root, { sessions });
  const started = await import("./nawabari-task.js").then(({ startNawabariTask }) =>
    startNawabariTask({
      workspaceRoot: root,
      store,
      policy: standardPolicy(),
      taskSlug: "keyed-disappears",
      branchType: "fix",
      issueRef: "902",
      nawabari: nawabariForStart,
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;

  // Listing still reflects the snapshot taken before the session disappeared.
  const listed = listTaskDiscoverySnapshot(store);
  assert.ok(listed.tasks.some((task) => task.taskId === started.task.taskId));

  // Simulate the session becoming unknown to Nawabari (closed + purged) between
  // the list snapshot and the keyed resolve.
  sessions.delete(started.execution.sessionId);
  const nawabariForResolve = fakeNawabari(root, { sessions });
  const result = await getTaskStatusById(store, started.task.taskId, nawabariForResolve);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "session-unavailable");
});
