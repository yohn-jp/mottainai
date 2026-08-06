import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

function openStore(): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  return store;
}

const digest = "digest-1" as RootCommitDigest;
const instanceId = "inst-1" as RepositoryInstanceId;

test("observing a new instance creates source and instance records, issuing a fresh source id", () => {
  const store = openStore();
  const result = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  assert.equal(result.source.rootCommitDigest, digest);
  assert.equal(result.instance.instanceId, instanceId);
  assert.equal(result.instance.sourceId, result.source.sourceId);
  assert.equal(result.moved, false);
  assert.equal(result.previousCurrentPath, undefined);

  assert.deepEqual(store.getRepositorySource(result.source.sourceId)?.rootCommitDigest, digest);
  assert.deepEqual(store.getRepositorySourceByDigest(digest)?.sourceId, result.source.sourceId);
  assert.deepEqual(store.getRepositoryInstance(instanceId)?.gitCommonDir, "/repo/.git");
  assert.deepEqual(store.getRepositoryInstanceByCommonDir("/repo/.git")?.instanceId, instanceId);

  const paths = store.listRepositoryPaths(instanceId);
  assert.equal(paths.length, 1);
  assert.equal(paths[0]?.canonicalPath, "/repo");
  assert.equal(paths[0]?.isCurrent, true);
  store.close();
});

test("observing the same digest twice reuses the same source id (does not mint a duplicate)", () => {
  const store = openStore();
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const otherInstanceId = "inst-2" as RepositoryInstanceId;
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId: otherInstanceId,
    gitCommonDir: "/other/.git",
    canonicalWorktreePath: "/other",
  });
  assert.equal(first.source.sourceId, second.source.sourceId);
  store.close();
});

test("observing two different digests yields two different source ids (no collision even if digest were to repeat elsewhere)", () => {
  const store = openStore();
  const digestB = "digest-2" as RootCommitDigest;
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo-a/.git",
    canonicalWorktreePath: "/repo-a",
  });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digestB,
    instanceId: "inst-2" as RepositoryInstanceId,
    gitCommonDir: "/repo-b/.git",
    canonicalWorktreePath: "/repo-b",
  });
  assert.notEqual(first.source.sourceId, second.source.sourceId);
  store.close();
});

test("re-observing the same path does not create a duplicate path row or flag a move", () => {
  const store = openStore();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/repo" });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  assert.equal(second.moved, false);
  assert.equal(store.listRepositoryPaths(instanceId).length, 1);
  store.close();
});

test("observing a new canonical path for a known instance is detected as a move", () => {
  const store = openStore();
  store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/old/repo",
  });
  const moved = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/new/repo",
  });

  assert.equal(moved.moved, true);
  assert.equal(moved.previousCurrentPath, "/old/repo");

  const paths = store.listRepositoryPaths(instanceId).sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  assert.equal(paths.length, 2);
  const oldPath = paths.find((row) => row.canonicalPath === "/old/repo");
  const newPath = paths.find((row) => row.canonicalPath === "/new/repo");
  assert.equal(oldPath?.isCurrent, false);
  assert.equal(newPath?.isCurrent, true);
  store.close();
});

test("moving back to a previously observed path flips is_current back without erroring", () => {
  const store = openStore();
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/path/a" });
  store.observeRepositoryInstance({ rootCommitDigest: digest, instanceId, gitCommonDir: "/repo/.git", canonicalWorktreePath: "/path/b" });
  const backToA = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/path/a",
  });

  assert.equal(backToA.moved, true);
  const paths = store.listRepositoryPaths(instanceId);
  assert.equal(paths.length, 2);
  const pathA = paths.find((row) => row.canonicalPath === "/path/a");
  const pathB = paths.find((row) => row.canonicalPath === "/path/b");
  assert.equal(pathA?.isCurrent, true);
  assert.equal(pathB?.isCurrent, false);
  store.close();
});

test("two instances under the same source are both tracked independently", () => {
  const store = openStore();
  const otherInstanceId = "inst-2" as RepositoryInstanceId;
  const first = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId,
    gitCommonDir: "/repo-a/.git",
    canonicalWorktreePath: "/repo-a",
  });
  const second = store.observeRepositoryInstance({
    rootCommitDigest: digest,
    instanceId: otherInstanceId,
    gitCommonDir: "/repo-b/.git",
    canonicalWorktreePath: "/repo-b",
  });

  assert.equal(store.getRepositoryInstance(instanceId)?.sourceId, first.source.sourceId);
  assert.equal(store.getRepositoryInstance(otherInstanceId)?.sourceId, second.source.sourceId);
  assert.notEqual(store.getRepositoryInstance(instanceId)?.instanceId, store.getRepositoryInstance(otherInstanceId)?.instanceId);
  store.close();
});

test("init() is idempotent and lookups before any observation return undefined", () => {
  const store = openStore();
  store.init();
  assert.equal(store.getRepositorySourceByDigest(digest), undefined);
  assert.equal(store.getRepositoryInstance(instanceId), undefined);
  assert.equal(store.getRepositoryInstanceByCommonDir("/nope"), undefined);
  assert.deepEqual(store.listRepositoryPaths(instanceId), []);
  store.close();
});
