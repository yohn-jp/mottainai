import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { RepositoryInstanceId } from "../domain/identity.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { buildWorktreeNaming, createWorktree, decideBootstrap, detectWorktreeCollisions, runBootstrap } from "./worktree.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t: TestContext): string {
  const root = tmpDir(t, "mottainai-worktree-test-");
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
  git(["add", "file.txt"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

test("buildWorktreeNaming without issueRef uses task/<slug>", () => {
  const naming = buildWorktreeNaming("my-task", undefined, ".worktrees");
  assert.equal(naming.branchName, "task/my-task");
  assert.equal(naming.relativePath, path.join(".worktrees", "task-my-task"));
});

test("buildWorktreeNaming with issueRef uses issue-<n>/<slug>", () => {
  const naming = buildWorktreeNaming("my-task", "33", ".worktrees");
  assert.equal(naming.branchName, "issue-33/my-task");
  assert.equal(naming.relativePath, path.join(".worktrees", "issue-33-my-task"));
});

test("createWorktree succeeds against a real repository and records the base commit", async (t) => {
  const root = initRepo(t);
  const naming = buildWorktreeNaming("my-task", undefined, ".worktrees");
  const result = await createWorktree({ workspaceRoot: root, naming, baseBranch: "main" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(fs.existsSync(result.canonicalPath));
  const expectedHead = git(["rev-parse", "HEAD"], root);
  assert.equal(result.baseCommit, expectedHead);
});

test("createWorktree returns a structured failure when the branch already exists", async (t) => {
  const root = initRepo(t);
  git(["branch", "task/dup"], root);
  const naming = buildWorktreeNaming("dup", undefined, ".worktrees");
  const result = await createWorktree({ workspaceRoot: root, naming, baseBranch: "main" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "git-worktree-add-failed");
  assert.ok(result.detail.length > 0);
});

test("decideBootstrap: off never executes even if a lockfile is present", (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("off", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: suggest returns the command but does not execute it", (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("suggest", root);
  assert.equal(decision.shouldExecute, false);
  assert.ok(decision.command !== undefined);
});

test("decideBootstrap: automatic executes when a lockfile is present", (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, true);
});

test("decideBootstrap: no lockfile means nothing to bootstrap regardless of mode", (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-test-");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: conditional executes only when the digest matches", (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-test-");
  const contents = "lockfileVersion: 9\n";
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), contents);
  const digest = crypto.createHash("sha256").update(contents).digest("hex");

  const matched = decideBootstrap("conditional", root, digest);
  assert.equal(matched.shouldExecute, true);

  const mismatched = decideBootstrap("conditional", root, "wrong-digest");
  assert.equal(mismatched.shouldExecute, false);

  const undeclared = decideBootstrap("conditional", root);
  assert.equal(undeclared.shouldExecute, false);
});

test("runBootstrap does not leak process.env secrets not in the allowlist", async (t) => {
  const root = tmpDir(t, "mottainai-bootstrap-run-test-");
  process.env.MOTTAINAI_TEST_CANARY_SECRET = "super-secret-value";
  t.after(() => {
    delete process.env.MOTTAINAI_TEST_CANARY_SECRET;
  });
  const scriptPath = path.join(root, "print-canary.js");
  fs.writeFileSync(scriptPath, "console.log(process.env.MOTTAINAI_TEST_CANARY_SECRET === undefined ? 'absent' : 'leaked')\n");
  const result = await runBootstrap(root, `node ${scriptPath}`);
  assert.equal(result.ran, true);
  assert.match(result.stdout, /absent/);
});

test("detectWorktreeCollisions reports branch/path collisions against active worktrees", (t) => {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const instanceId = "inst-1" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as never,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });

  const existingDir = tmpDir(t, "mottainai-collision-existing-");
  const taskResult = store.reserveTask({
    instanceId, taskSlug: "existing", issueRef: undefined, baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(taskResult.ok, true);
  if (!taskResult.ok) return;
  const worktreeResult = store.reserveWorktree({
    taskId: taskResult.task.taskId, instanceId, branchName: "task/existing", canonicalPath: existingDir,
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(worktreeResult.ok, true);
  if (!worktreeResult.ok) return;
  store.activateWorktree(worktreeResult.worktree.worktreeId);

  const branchCollision = detectWorktreeCollisions(store, instanceId, "task/existing", "/repo/.worktrees/new-path");
  assert.equal(branchCollision.branchCollision, true);
  assert.equal(branchCollision.pathCollision, false);

  const pathCollision = detectWorktreeCollisions(store, instanceId, "task/new", existingDir);
  assert.equal(pathCollision.pathCollision, true);
});

test("detectWorktreeCollisions reports stale metadata for active rows whose path no longer exists", (t) => {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  const instanceId = "inst-1" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as never,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const taskResult = store.reserveTask({
    instanceId, taskSlug: "gone", issueRef: undefined, baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(taskResult.ok, true);
  if (!taskResult.ok) return;
  const worktreeResult = store.reserveWorktree({
    taskId: taskResult.task.taskId, instanceId, branchName: "task/gone", canonicalPath: "/nonexistent/path/for/test",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(worktreeResult.ok, true);
  if (!worktreeResult.ok) return;
  store.activateWorktree(worktreeResult.worktree.worktreeId);

  const result = detectWorktreeCollisions(store, instanceId, "task/other", "/repo/.worktrees/other");
  assert.equal(result.staleMetadata.length, 1);
  assert.equal(result.staleMetadata[0]?.branchName, "task/gone");
});
