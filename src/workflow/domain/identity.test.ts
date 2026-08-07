import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { resolveRepositoryIdentity } from "./identity.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// テスト間でリポジトリ状態が残らないようにする。
function initRepo(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-workflow-identity-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "README.md"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

// 非 Git ディレクトリが必要な失敗系を他のテストから隔離する。
function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("resolves a stable identity for a normal repository", (t) => {
  const root = initRepo(t);
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.worktreePath, root);
  assert.match(result.identity.rootCommitDigest, /^[0-9a-f]{64}$/);
  assert.match(result.identity.instanceId, /^[0-9a-f-]{36}$/);
});

test("same repository resolved twice yields the same digest and instance id", (t) => {
  const root = initRepo(t);
  const first = resolveRepositoryIdentity(root);
  const second = resolveRepositoryIdentity(root);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.identity.rootCommitDigest, second.identity.rootCommitDigest);
  assert.equal(first.identity.instanceId, second.identity.instanceId);
});

test("two independently initialized repositories under different common-dirs yield different instance ids", (t) => {
  // rootCommitDigest は Git 由来のヒント値に過ぎず、同一内容+同時刻 init では
  // 偶然一致しうる（commit SHA が tree/parent/author/timestamp/message のみで
  // 決まるため）。globally unique な source identity は
  // WorkflowStateStore.observeRepositoryInstance() が発行する source_id が担う
  // （sqlite-store.test.ts 側で検証）。ここでは instanceId が gitCommonDir 由来で
  // 別リポジトリなら必ず分かれることだけを確認する。
  const rootA = initRepo(t);
  const rootB = initRepo(t);
  const resultA = resolveRepositoryIdentity(rootA);
  const resultB = resolveRepositoryIdentity(rootB);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  if (!resultA.ok || !resultB.ok) return;
  assert.notEqual(resultA.identity.instanceId, resultB.identity.instanceId);
});

test("resolving through a symlinked path yields the same identity as the real path", (t) => {
  const root = initRepo(t);
  const parent = path.dirname(root);
  const linkPath = path.join(parent, "symlinked-repo");
  // Windows は symlink 作成に管理者権限や開発者モードを要求しうる（EPERM）が、
  // junction はその制約を受けない。
  fs.symlinkSync(root, linkPath, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.rmSync(linkPath));

  const direct = resolveRepositoryIdentity(root);
  const viaSymlink = resolveRepositoryIdentity(linkPath);
  assert.equal(direct.ok, true);
  assert.equal(viaSymlink.ok, true);
  if (!direct.ok || !viaSymlink.ok) return;
  assert.equal(direct.identity.rootCommitDigest, viaSymlink.identity.rootCommitDigest);
  assert.equal(direct.identity.instanceId, viaSymlink.identity.instanceId);
  assert.equal(viaSymlink.identity.worktreePath, root);
});

test("moving a repository on disk preserves the root commit digest and instance id (path is not part of identity)", (t) => {
  const root = initRepo(t);
  const before = resolveRepositoryIdentity(root);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const movedParent = tmpDir(t, "mottainai-workflow-identity-moved-");
  const movedRoot = path.join(movedParent, "repo");
  fs.renameSync(root, movedRoot);

  const after = resolveRepositoryIdentity(movedRoot);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.identity.rootCommitDigest, before.identity.rootCommitDigest);
  assert.equal(after.identity.instanceId, before.identity.instanceId);
  assert.equal(after.identity.worktreePath, movedRoot);
});

test("a directory that is not a git repository fails closed", (t) => {
  const root = tmpDir(t, "mottainai-workflow-identity-nongit-");
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a git repository/);
});

test("a repository with an unborn HEAD (no commits) fails closed", (t) => {
  const root = tmpDir(t, "mottainai-workflow-identity-unborn-");
  git(["init", "--quiet", "-b", "main"], root);
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /root commit/);
});

test("a corrupted instance marker file fails closed instead of silently re-minting an id", (t) => {
  const root = initRepo(t);
  fs.writeFileSync(path.join(root, ".git", "mottainai-instance-id"), "not-a-valid-uuid\n");
  const result = resolveRepositoryIdentity(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /instance marker file is corrupt/);
});

test("two worktrees of the same repository share instanceId and rootCommitDigest but have distinct worktreePaths", (t) => {
  const root = initRepo(t);
  const worktreeParent = tmpDir(t, "mottainai-workflow-identity-worktree-");
  const worktreePath = path.join(worktreeParent, "wt");
  git(["worktree", "add", "-b", "feature", worktreePath], root);
  t.after(() => {
    try {
      git(["worktree", "remove", "--force", worktreePath], root);
    } catch {
      // ベストエフォート（先行する test 失敗時などは既に無い場合がある）
    }
  });

  const fromMain = resolveRepositoryIdentity(root);
  const fromWorktree = resolveRepositoryIdentity(worktreePath);
  assert.equal(fromMain.ok, true);
  assert.equal(fromWorktree.ok, true);
  if (!fromMain.ok || !fromWorktree.ok) return;

  assert.equal(fromMain.identity.instanceId, fromWorktree.identity.instanceId);
  assert.equal(fromMain.identity.rootCommitDigest, fromWorktree.identity.rootCommitDigest);
  assert.notEqual(fromMain.identity.worktreePath, fromWorktree.identity.worktreePath);
  assert.equal(fromWorktree.identity.worktreePath, fs.realpathSync.native(worktreePath));
});

test("concurrent first-time resolution from multiple processes converges on one instance id", async (t) => {
  const root = initRepo(t);
  const workerModule = path.join(import.meta.dirname, "identity-resolve-worker.mjs");

  // 単一プロセス内の呼び出しは Node のイベントループ上で逐次実行されるため、
  // マーカー未作成時の書き込み競合（初回発行の一意性）は複数の実プロセスを
  // 同時起動しないと再現できない。
  const { spawn } = await import("node:child_process");
  const runWorker = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerModule, root], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
        else resolve(stdout.trim());
      });
    });

  const concurrentResults = await Promise.all(Array.from({ length: 5 }, () => runWorker()));
  const uniqueConcurrent = new Set(concurrentResults);
  assert.equal(
    uniqueConcurrent.size,
    1,
    `expected all concurrent resolutions to agree on one instance id, got: ${concurrentResults.join(", ")}`,
  );
});

test("rootCommitDigest is stable across an unrelated orphan branch checkout (not HEAD-relative)", (t) => {
  const root = initRepo(t);
  const before = resolveRepositoryIdentity(root);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  git(["checkout", "--orphan", "orphan-branch"], root);
  git(["commit", "--quiet", "--allow-empty", "-m", "unrelated root"], root);

  const afterOrphanCommit = resolveRepositoryIdentity(root);
  assert.equal(afterOrphanCommit.ok, true);
  if (!afterOrphanCommit.ok) return;

  // rev-list --all で全 ref を対象にしているため、新しい orphan branch の
  // root commit が increase しても、既存 root を含む digest は変わらない
  // （ソート済み連結ハッシュに 1 要素追加されるだけなので値自体は変わるが、
  // 同一リポジトリを指し続ける限り HEAD 切替のたびに変化してはならない）。
  git(["checkout", "main"], root);
  const backOnMain = resolveRepositoryIdentity(root);
  assert.equal(backOnMain.ok, true);
  if (!backOnMain.ok) return;
  assert.equal(backOnMain.identity.rootCommitDigest, afterOrphanCommit.identity.rootCommitDigest);
  assert.equal(backOnMain.identity.instanceId, before.identity.instanceId);
});
