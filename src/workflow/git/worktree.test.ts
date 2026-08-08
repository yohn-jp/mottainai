import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import { buildWorktreeNaming, createWorktree, decideBootstrap, detectWorktreeCollisions, runBootstrap } from "./worktree.js";

test("buildWorktreeNaming projects explicit structured input into the governance candidate and canonical root", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "my-task" });
  assert.equal(naming.branchName, "fix/33-my-task");
  assert.equal(naming.relativePath, path.join(".mottainai", "worktrees", "fix-33-my-task"));
});

test("createWorktree succeeds against a real repository and records the base commit", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "my-task" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const result = await createWorktree({ canonicalRepositoryRoot: root, naming, baseCommit });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(fs.existsSync(result.canonicalPath));
  const expectedHead = runGit(["rev-parse", "HEAD"], root);
  assert.equal(result.baseCommit, expectedHead);
});

test("createWorktree returns a structured failure when the branch already exists", async (t) => {
  const root = createTempGitRepo(t);
  runGit(["branch", "fix/33-dup"], root);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "dup" });
  const result = await createWorktree({ canonicalRepositoryRoot: root, naming, baseCommit: runGit(["rev-parse", "HEAD"], root) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "git-worktree-add-failed");
  assert.ok(result.detail.length > 0);
});

test("decideBootstrap: off never executes even if a lockfile is present", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("off", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: suggest returns the command but does not execute it", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("suggest", root);
  assert.equal(decision.shouldExecute, false);
  assert.ok(decision.command !== undefined);
});

test("decideBootstrap: automatic executes when a lockfile is present", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, true);
});

test("decideBootstrap: no lockfile means nothing to bootstrap regardless of mode", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: conditional executes only when the digest matches", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
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
  const root = createTempDir(t, "mottainai-bootstrap-run-test-");
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
  const store = createWorkflowStore(t);
  const instanceId = "inst-1" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as never,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });

  const existingDir = createTempDir(t, "mottainai-collision-existing-");
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

  const branchCollision = detectWorktreeCollisions(store, instanceId, "task/existing", "/repo/.mottainai/worktrees/new-path");
  assert.equal(branchCollision.branchCollision, true);
  assert.equal(branchCollision.pathCollision, false);

  const pathCollision = detectWorktreeCollisions(store, instanceId, "task/new", existingDir);
  assert.equal(pathCollision.pathCollision, true);
});

test("detectWorktreeCollisions reports stale metadata for active rows whose path no longer exists", (t) => {
  const store = createWorkflowStore(t);
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

  const result = detectWorktreeCollisions(store, instanceId, "task/other", "/repo/.mottainai/worktrees/other");
  assert.equal(result.staleMetadata.length, 1);
  assert.equal(result.staleMetadata[0]?.branchName, "task/gone");
});
