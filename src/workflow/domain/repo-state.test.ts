import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { resolveRepoState } from "./repo-state.js";

test("normal branch checkout is supported and reports the branch name", async (t) => {
  const root = createTempGitRepo(t);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "normal");
  assert.equal(result.state.branch, "main");
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, true);
});

test("detached HEAD is explicitly reported and unsupported", async (t) => {
  const root = createTempGitRepo(t);
  const headSha = runGit(["rev-parse", "HEAD"], root);
  runGit(["checkout", "--quiet", headSha], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "detached-head");
  assert.equal(result.state.branch, undefined);
  assert.equal(result.state.supported, false);
});

test("unborn branch (no commits yet) is explicitly reported and unsupported", async (t) => {
  const root = createTempGitRepo(t, { initialCommit: false });
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "unborn-branch");
  assert.equal(result.state.branch, "main");
  assert.equal(result.state.supported, false);
});

test("bare repository is explicitly reported and unsupported", async (t) => {
  const root = createTempDir(t, "mottainai-workflow-repo-state-bare-");
  runGit(["init", "--quiet", "--bare"], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "bare-repository");
  assert.equal(result.state.supported, false);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("linked worktree is explicitly reported and supported", async (t) => {
  const root = createTempGitRepo(t);
  const worktreeParent = createTempDir(t, "mottainai-workflow-repo-state-worktree-");
  const worktreePath = path.join(worktreeParent, "linked");
  runGit(["worktree", "add", "--quiet", "-b", "feature/linked", worktreePath, "main"], root);
  const result = await resolveRepoState(worktreePath);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "linked-worktree");
  assert.equal(result.state.branch, "feature/linked");
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("a linked worktree with a detached HEAD is reported as linked-worktree, not detached-head (documented priority order)", async (t) => {
  const root = createTempGitRepo(t);
  const worktreeParent = createTempDir(t, "mottainai-workflow-repo-state-worktree-detached-");
  const worktreePath = path.join(worktreeParent, "linked-detached");
  const headSha = runGit(["rev-parse", "HEAD"], root);
  runGit(["worktree", "add", "--quiet", "--detach", worktreePath, headSha], root);
  const result = await resolveRepoState(worktreePath);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "linked-worktree");
  assert.equal(result.state.branch, undefined);
  assert.equal(result.state.supported, true);
  assert.equal(result.state.isPrimaryCheckout, false);
});

test("primary checkout that owns linked worktrees is still reported as isPrimaryCheckout", async (t) => {
  const root = createTempGitRepo(t);
  const worktreeParent = createTempDir(t, "mottainai-workflow-repo-state-worktree-primary-");
  const worktreePath = path.join(worktreeParent, "linked");
  runGit(["worktree", "add", "--quiet", "-b", "feature/linked2", worktreePath, "main"], root);
  const result = await resolveRepoState(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "normal");
  assert.equal(result.state.isPrimaryCheckout, true);
});

test("submodule working tree is explicitly reported and unsupported", async (t) => {
  const superRoot = createTempGitRepo(t);
  const subRoot = createTempGitRepo(t);
  runGit(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", subRoot, "sub"], superRoot);
  const result = await resolveRepoState(path.join(superRoot, "sub"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.kind, "submodule");
  assert.equal(result.state.supported, false);
});

test("non-git directory fails closed with a structured reason", async (t) => {
  const dir = createTempDir(t, "mottainai-workflow-repo-state-notgit-");
  const result = await resolveRepoState(dir);
  assert.equal(result.ok, false);
});
