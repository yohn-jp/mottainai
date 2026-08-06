import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveRepositoryIdentity } from "./identity.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-identity-test-")));
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "README.md"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

test("resolves a stable identity for a normal repository", () => {
  const root = initRepo();
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.worktreePath, root);
  assert.match(result.identity.rootCommitDigest, /^[0-9a-f]{64}$/);
  assert.match(result.identity.instanceId, /^[0-9a-f-]{36}$/);
});

test("same repository resolved twice yields the same digest and instance id", () => {
  const root = initRepo();
  const first = resolveRepositoryIdentity(root);
  const second = resolveRepositoryIdentity(root);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.identity.rootCommitDigest, second.identity.rootCommitDigest);
  assert.equal(first.identity.instanceId, second.identity.instanceId);
});

test("two independently initialized repositories under different common-dirs yield different instance ids", () => {
  // rootCommitDigest は Git 由来のヒント値に過ぎず、同一内容+同時刻 init では
  // 偶然一致しうる（commit SHA が tree/parent/author/timestamp/message のみで
  // 決まるため）。globally unique な source identity は
  // WorkflowStateStore.observeRepositoryInstance() が発行する source_id が担う
  // （sqlite-store.test.ts 側で検証）。ここでは instanceId が gitCommonDir 由来で
  // 別リポジトリなら必ず分かれることだけを確認する。
  const rootA = initRepo();
  const rootB = initRepo();
  const resultA = resolveRepositoryIdentity(rootA);
  const resultB = resolveRepositoryIdentity(rootB);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  if (!resultA.ok || !resultB.ok) return;
  assert.notEqual(resultA.identity.instanceId, resultB.identity.instanceId);
});

test("resolving through a symlinked path yields the same identity as the real path", () => {
  const root = initRepo();
  const parent = path.dirname(root);
  const linkPath = path.join(parent, "symlinked-repo");
  fs.symlinkSync(root, linkPath, "dir");
  try {
    const direct = resolveRepositoryIdentity(root);
    const viaSymlink = resolveRepositoryIdentity(linkPath);
    assert.equal(direct.ok, true);
    assert.equal(viaSymlink.ok, true);
    if (!direct.ok || !viaSymlink.ok) return;
    assert.equal(direct.identity.rootCommitDigest, viaSymlink.identity.rootCommitDigest);
    assert.equal(direct.identity.instanceId, viaSymlink.identity.instanceId);
    assert.equal(viaSymlink.identity.worktreePath, root);
  } finally {
    fs.rmSync(linkPath);
  }
});

test("moving a repository on disk preserves the root commit digest and instance id (path is not part of identity)", () => {
  const root = initRepo();
  const before = resolveRepositoryIdentity(root);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const movedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-identity-moved-")), "repo");
  fs.renameSync(root, movedRoot);
  try {
    const after = resolveRepositoryIdentity(movedRoot);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.identity.rootCommitDigest, before.identity.rootCommitDigest);
    assert.equal(after.identity.instanceId, before.identity.instanceId);
    assert.equal(after.identity.worktreePath, movedRoot);
  } finally {
    fs.rmSync(path.dirname(movedRoot), { recursive: true, force: true });
  }
});

test("a directory that is not a git repository fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-identity-nongit-"));
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a git repository/);
});

test("a repository with an unborn HEAD (no commits) fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-identity-unborn-"));
  git(["init", "--quiet", "-b", "main"], root);
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /root commit/);
});

test("a corrupted instance marker file fails closed instead of silently re-minting an id", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".git", "mottainai-instance-id"), "not-a-valid-uuid\n");
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /instance marker file is corrupt/);
});
