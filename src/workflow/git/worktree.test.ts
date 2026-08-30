import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import {
  buildWorktreeNaming,
  createWorktree,
  decideBootstrap,
  detectWorktreeCollisions,
  ensureCanonicalManagedWorktreeRoot,
  runBootstrap,
  WorktreeNamingError,
} from "./worktree.js";

test("ensureCanonicalManagedWorktreeRoot rejects a symlink escape at the .mottainai segment before creating anything outside the root", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const outsideTarget = createTempDir(t, "mottainai-managed-root-outside-");
  fs.symlinkSync(outsideTarget, path.join(root, ".mottainai"));

  const result = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /resolves outside its canonical path/);
  assert.equal(fs.existsSync(path.join(outsideTarget, "worktrees")), false);
});

test("ensureCanonicalManagedWorktreeRoot rejects a symlink escape at the worktrees segment", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const outsideTarget = createTempDir(t, "mottainai-managed-root-outside-");
  fs.mkdirSync(path.join(root, ".mottainai"));
  fs.symlinkSync(outsideTarget, path.join(root, ".mottainai", "worktrees"));

  const result = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /resolves outside its canonical path/);
});

test("ensureCanonicalManagedWorktreeRoot succeeds and is idempotent when segments already exist as real directories", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const first = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(first.ok, true);
  const second = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.path, second.path);
  assert.equal(first.path, fs.realpathSync.native(path.join(root, ".mottainai", "worktrees")));
});

test("buildWorktreeNaming projects explicit structured input into the governance candidate and canonical root", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "my-task" });
  assert.equal(naming.branchName, "fix/33-my-task");
  assert.equal(naming.relativePath, path.join(".mottainai", "worktrees", "fix-33-my-task"));
});

test("buildWorktreeNaming rejects a task slug that repeats the issue identity prefix", () => {
  assert.throws(
    () => buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "378-nawabari-integration-close" }),
    (error: unknown) => {
      assert.ok(error instanceof WorktreeNamingError);
      assert.equal(error.code, "duplicated-issue-identity");
      assert.match(error.message, /repeats issue identity/);
      return true;
    },
  );
});

test("buildWorktreeNaming preserves unrelated numeric content in a descriptive slug", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "manager-510-unrelated" });
  assert.equal(naming.branchName, "fix/378-manager-510-unrelated");
  const leadingNumber = buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "510-unrelated" });
  assert.equal(leadingNumber.branchName, "fix/378-510-unrelated");
});

test("buildWorktreeNaming keeps an unlinked task slug distinct from the synthetic identity", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "unlinked", taskSlug: "maintenance" });
  assert.equal(naming.branchName, "fix/unlinked-maintenance");
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
