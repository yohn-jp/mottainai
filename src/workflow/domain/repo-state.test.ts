import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { resolveRepoState } from "./repo-state.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t: TestContext): string {
  const root = tmpDir(t, "mottainai-workflow-repo-state-test-");
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "README.md"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

test("normal branch checkout is supported and reports the branch name", async (t) => {
  const root = initRepo(t);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "normal");
  assert.equal(result.state.branch, "main");
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, true);
});

test("detached HEAD is explicitly reported and unsupported", async (t) => {
  const root = initRepo(t);
  const headSha = git(["rev-parse", "HEAD"], root);
  git(["checkout", "--quiet", headSha], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "detached-head");
  assert.equal(result.state.branch, undefined);
  assert.equal(result.state.supported, false);
});

test("unborn branch (no commits yet) is explicitly reported and unsupported", async (t) => {
  const root = tmpDir(t, "mottainai-workflow-repo-state-unborn-");
  git(["init", "--quiet", "-b", "main"], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "unborn-branch");
  assert.equal(result.state.branch, "main");
  assert.equal(result.state.supported, false);
});

test("bare repository is explicitly reported and unsupported", async (t) => {
  const root = tmpDir(t, "mottainai-workflow-repo-state-bare-");
  git(["init", "--quiet", "--bare"], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "bare-repository");
  assert.equal(result.state.supported, false);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("linked worktree is explicitly reported and supported", async (t) => {
  const root = initRepo(t);
  const worktreeParent = tmpDir(t, "mottainai-workflow-repo-state-worktree-");
  const worktreePath = path.join(worktreeParent, "linked");
  git(["worktree", "add", "--quiet", "-b", "feature/linked", worktreePath, "main"], root);
  const result = await resolveRepoState(worktreePath);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "linked-worktree");
  assert.equal(result.state.branch, "feature/linked");
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("a linked worktree with a detached HEAD is reported as linked-worktree, not detached-head (documented priority order)", async (t) => {
  const root = initRepo(t);
  const worktreeParent = tmpDir(t, "mottainai-workflow-repo-state-worktree-detached-");
  const worktreePath = path.join(worktreeParent, "linked-detached");
  const headSha = git(["rev-parse", "HEAD"], root);
  git(["worktree", "add", "--quiet", "--detach", worktreePath, headSha], root);
  const result = await resolveRepoState(worktreePath);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "linked-worktree");
  assert.equal(result.state.branch, undefined);
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("primary checkout that owns linked worktrees is still reported as isPrimaryCheckout", async (t) => {
  const root = initRepo(t);
  const worktreeParent = tmpDir(t, "mottainai-workflow-repo-state-worktree-primary-");
  const worktreePath = path.join(worktreeParent, "linked");
  git(["worktree", "add", "--quiet", "-b", "feature/linked2", worktreePath, "main"], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "normal");
  assert.equal(result.state.isPrimaryCheckout, true);
});

test("submodule working tree is explicitly reported and unsupported", async (t) => {
  const superRoot = initRepo(t);
  const subRoot = initRepo(t);
  git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", subRoot, "sub"], superRoot);
  const result = await resolveRepoState(path.join(superRoot, "sub"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "submodule");
  assert.equal(result.state.supported, false);
});

test("non-git directory fails closed with a structured reason", async (t) => {
  const dir = tmpDir(t, "mottainai-workflow-repo-state-notgit-");
  const result = await resolveRepoState(dir);
  assert.equal(result.ok, false);
});
