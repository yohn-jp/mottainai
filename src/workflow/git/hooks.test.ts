import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, isolatedGitEnv, runGit } from "../../test-support/tmp-git-repo.js";
import { detectHookBypass, generatePreCommitHookScript, generatePrePushHookScript, isMottainaiGeneratedHook } from "./hooks.js";

function writePolicy(root: string, overrides: Record<string, unknown> = {}): void {
  const policy = {
    schemaVersion: 1,
    protectedBranches: ["main", "release/*"],
    protectedBranchRule: {
      sourceWrite: "enforce",
      stage: "enforce",
      commit: "enforce",
      directPush: "enforce",
      forcePush: "enforce",
      destructiveBranchOp: "enforce",
    },
    controlPlaneRole: "primary-checkout",
    worktree: { required: "off", bootstrapMode: "off", multipleActiveTasksPerIssue: "off", multipleWorktreesPerTask: "off" },
    stagingMode: "explicit",
    cleanup: { worktreeRemoval: "off", localBranchDeletion: "off", remoteBranchDeletion: "off", worktreePrune: "off", forceCleanup: "off" },
    ...overrides,
  };
  fs.mkdirSync(path.join(root, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mottainai", "workflow.json"), JSON.stringify(policy, null, 2));
}

function installHook(root: string, name: "pre-commit" | "pre-push", script: string): void {
  const hookPath = path.join(root, ".git", "hooks", name);
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
}

test("isMottainaiGeneratedHook: detects generated scripts and rejects unrelated content", () => {
  assert.equal(isMottainaiGeneratedHook(generatePreCommitHookScript()), true);
  assert.equal(isMottainaiGeneratedHook(generatePrePushHookScript()), true);
  assert.equal(isMottainaiGeneratedHook("#!/bin/sh\necho hi\n"), false);
});

test("generated pre-commit hook blocks commits on a protected branch", (t) => {
  const root = createTempGitRepo(t);
  writePolicy(root);
  installHook(root, "pre-commit", generatePreCommitHookScript());
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["add", "file.txt"], root);
  assert.throws(() => runGit(["commit", "-m", "blocked"], root));
});

test("generated pre-commit hook allows commits on a non-protected branch", (t) => {
  const root = createTempGitRepo(t);
  writePolicy(root);
  installHook(root, "pre-commit", generatePreCommitHookScript());
  runGit(["checkout", "--quiet", "-b", "feature/allowed"], root);
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["add", "file.txt"], root);
  assert.doesNotThrow(() => runGit(["commit", "-m", "allowed"], root));
});

test("generated pre-commit hook respects glob-matched protected branches (release/*)", (t) => {
  const root = createTempGitRepo(t);
  writePolicy(root);
  installHook(root, "pre-commit", generatePreCommitHookScript());
  runGit(["checkout", "--quiet", "-b", "release/1.0"], root);
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["add", "file.txt"], root);
  assert.throws(() => runGit(["commit", "-m", "blocked-glob"], root));
});

test("generated pre-commit hook allows commit when protectedBranchRule.commit is advisory", (t) => {
  const root = createTempGitRepo(t);
  writePolicy(root, {
    protectedBranchRule: {
      sourceWrite: "advisory", stage: "advisory", commit: "advisory",
      directPush: "enforce", forcePush: "enforce", destructiveBranchOp: "enforce",
    },
  });
  installHook(root, "pre-commit", generatePreCommitHookScript());
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["add", "file.txt"], root);
  assert.doesNotThrow(() => runGit(["commit", "-m", "advisory-allowed"], root));
});

function initRepoWithRemote(t: TestContext): { root: string; remote: string } {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-workflow-hooks-remote-");
  runGit(["init", "--quiet", "--bare"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["-c", "protocol.file.allow=always", "push", "--quiet", "origin", "main:main"], root);
  return { root, remote };
}

test("generated pre-push hook blocks direct push to a protected branch", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root);
  installHook(root, "pre-push", generatePrePushHookScript());
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["commit", "-am", "extra"], root);
  assert.throws(() => runGit(["-c", "protocol.file.allow=always", "push", "origin", "main:main"], root));
});

test("generated pre-push hook allows push to a non-protected branch", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root);
  installHook(root, "pre-push", generatePrePushHookScript());
  runGit(["checkout", "--quiet", "-b", "feature/pushable"], root);
  assert.doesNotThrow(() => runGit(["-c", "protocol.file.allow=always", "push", "origin", "feature/pushable:feature/pushable"], root));
});

test("generated pre-push hook blocks force-push to a protected branch even when directPush is off", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root, {
    protectedBranchRule: {
      sourceWrite: "off", stage: "off", commit: "off",
      directPush: "off", forcePush: "enforce", destructiveBranchOp: "off",
    },
  });
  installHook(root, "pre-push", generatePrePushHookScript());
  runGit(["commit", "--quiet", "--amend", "-m", "amended"], root);
  assert.throws(() => runGit(["-c", "protocol.file.allow=always", "push", "--force", "origin", "main:main"], root));
});

test("generated pre-push hook allows a plain fast-forward push when directPush is off", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root, {
    protectedBranchRule: {
      sourceWrite: "off", stage: "off", commit: "off",
      directPush: "off", forcePush: "enforce", destructiveBranchOp: "off",
    },
  });
  installHook(root, "pre-push", generatePrePushHookScript());
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["commit", "-am", "extra"], root);
  assert.doesNotThrow(() => runGit(["-c", "protocol.file.allow=always", "push", "origin", "main:main"], root));
});

test("detectHookBypass: no checkpoint recorded is not treated as diverged", async (t) => {
  const root = createTempGitRepo(t);
  const result = await detectHookBypass(root, "main", undefined);
  assert.equal(result.diverged, false);
  assert.equal(result.reason, "no-checkpoint");
});

test("detectHookBypass: checkpoint equal to HEAD is clean", async (t) => {
  const root = createTempGitRepo(t);
  const head = runGit(["rev-parse", "HEAD"], root);
  const result = await detectHookBypass(root, "main", head);
  assert.equal(result.diverged, false);
  assert.equal(result.reason, "clean");
});

test("detectHookBypass: checkpoint that is an ancestor of HEAD is clean (hook-mediated commit happened after checkpoint)", async (t) => {
  const root = createTempGitRepo(t);
  const checkpoint = runGit(["rev-parse", "HEAD"], root);
  fs.appendFileSync(path.join(root, "file.txt"), "more\n");
  runGit(["commit", "-am", "second"], root);
  const result = await detectHookBypass(root, "main", checkpoint);
  assert.equal(result.diverged, false);
  assert.equal(result.reason, "clean");
});

test("detectHookBypass: checkpoint that is not an ancestor of HEAD indicates a bypass (e.g. --no-verify amend/rebase)", async (t) => {
  const root = createTempGitRepo(t);
  const checkpoint = runGit(["rev-parse", "HEAD"], root);
  runGit(["commit", "--quiet", "--amend", "--allow-empty", "-m", "rewritten", "--no-verify"], root);
  const result = await detectHookBypass(root, "main", checkpoint);
  assert.equal(result.diverged, true);
  assert.equal(result.reason, "checkpoint-not-ancestor");
});

test("detectHookBypass: resolves the requested branch's tip, not HEAD, when the checkout is on a different branch", async (t) => {
  const root = createTempGitRepo(t);
  const mainCheckpoint = runGit(["rev-parse", "HEAD"], root);
  runGit(["checkout", "--quiet", "-b", "feature/older"], root);
  // main advances after the feature branch forked; HEAD (feature/older) never moves.
  runGit(["checkout", "--quiet", "main"], root);
  fs.appendFileSync(path.join(root, "file.txt"), "main-advanced\n");
  runGit(["commit", "-am", "main advances"], root);
  runGit(["checkout", "--quiet", "feature/older"], root);

  const result = await detectHookBypass(root, "main", mainCheckpoint);
  assert.equal(result.diverged, false, "checking 'main' from a feature checkout must resolve main's own tip, not HEAD");
  assert.equal(result.reason, "clean");
});

test("detectHookBypass: throws when the requested branch does not exist", async (t) => {
  const root = createTempGitRepo(t);
  await assert.rejects(() => detectHookBypass(root, "no-such-branch", undefined));
});

test("generated pre-push hook blocks deleting a protected remote branch via destructiveBranchOp, independent of forcePush", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root, {
    protectedBranches: ["release/1.0"],
    protectedBranchRule: {
      sourceWrite: "off", stage: "off", commit: "off",
      directPush: "off", forcePush: "off", destructiveBranchOp: "enforce",
    },
  });
  runGit(["checkout", "--quiet", "-b", "release/1.0"], root);
  runGit(["-c", "protocol.file.allow=always", "push", "--quiet", "origin", "release/1.0:release/1.0"], root);
  installHook(root, "pre-push", generatePrePushHookScript());
  assert.throws(() => runGit(["-c", "protocol.file.allow=always", "push", "origin", "--delete", "release/1.0"], root));
});

test("generated pre-push hook allows deleting a protected remote branch when destructiveBranchOp is off, even if forcePush is enforce", (t) => {
  const { root } = initRepoWithRemote(t);
  writePolicy(root, {
    protectedBranches: ["release/1.0"],
    protectedBranchRule: {
      sourceWrite: "off", stage: "off", commit: "off",
      directPush: "off", forcePush: "enforce", destructiveBranchOp: "off",
    },
  });
  runGit(["checkout", "--quiet", "-b", "release/1.0"], root);
  runGit(["-c", "protocol.file.allow=always", "push", "--quiet", "origin", "release/1.0:release/1.0"], root);
  installHook(root, "pre-push", generatePrePushHookScript());
  assert.doesNotThrow(() => runGit(["-c", "protocol.file.allow=always", "push", "origin", "--delete", "release/1.0"], root));
});

test("generated hook fails closed (blocks the operation) when node is not on PATH", (t) => {
  const root = createTempGitRepo(t);
  writePolicy(root);
  installHook(root, "pre-commit", generatePreCommitHookScript());
  fs.appendFileSync(path.join(root, "file.txt"), "change\n");
  runGit(["add", "file.txt"], root);
  const pathWithoutNode = process.env.PATH?.split(path.delimiter)
    .filter((entry) => !fs.existsSync(path.join(entry, "node")) && !fs.existsSync(path.join(entry, "node.exe")))
    .join(path.delimiter);
  assert.throws(() => runGit(["commit", "-m", "blocked-no-node"], root, isolatedGitEnv({ PATH: pathWithoutNode })));
});
