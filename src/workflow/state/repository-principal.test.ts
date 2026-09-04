import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BoundaryOperations } from "../../boundary.js";
import { RepositoryPrincipalAllocator } from "../domain/repository-principal.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

const repositoryA = "repository-a" as RepositoryInstanceId;
const repositoryB = "repository-b" as RepositoryInstanceId;
const repositoryC = "repository-c" as RepositoryInstanceId;

function openStore(dbPath = ":memory:", boundaries?: BoundaryOperations): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath, boundaries });
  store.init();
  return store;
}

function observe(store: WorkflowSqliteStateStore, instanceId: RepositoryInstanceId): void {
  store.observeRepositoryInstance({
    rootCommitDigest: `digest-${instanceId}` as RootCommitDigest,
    instanceId,
    gitCommonDir: `/repo/${instanceId}.git`,
    canonicalWorktreePath: `/repo/${instanceId}`,
  });
}

test("allocation is canonical-keyed, stable on retry, and collision-free", () => {
  const store = openStore();
  try {
    observe(store, repositoryA);
    observe(store, repositoryB);
    const first = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_010,
      allocatedAt: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const retry = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_010,
      allocatedAt: 200,
    });
    assert.deepEqual(retry, first);
    const second = store.allocateRepositoryPrincipal({
      instanceId: repositoryB,
      minId: 10_000,
      maxId: 10_010,
      allocatedAt: 300,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.notEqual(second.principal.uid, first.principal.uid);
    assert.notEqual(second.principal.gid, first.principal.gid);
    assert.notEqual(second.principal.internalUsername, first.principal.internalUsername);
    assert.equal(first.principal.instanceId, repositoryA);
  } finally {
    store.close();
  }
});

test("release quarantines IDs and cleanup proof is required before reuse", () => {
  const store = openStore();
  try {
    observe(store, repositoryA);
    observe(store, repositoryB);
    observe(store, repositoryC);
    const first = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_000,
      allocatedAt: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const released = store.releaseRepositoryPrincipal({ instanceId: repositoryA, releasedAt: 200 });
    assert.equal(released.lifecycleState, "quarantined");
    const blocked = store.allocateRepositoryPrincipal({
      instanceId: repositoryB,
      minId: 10_000,
      maxId: 10_000,
      allocatedAt: 300,
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, "no-identities-available");
    const available = store.proveRepositoryPrincipalCleanup({ instanceId: repositoryA, provenAt: 400 });
    assert.equal(available.lifecycleState, "available");
    const reused = store.allocateRepositoryPrincipal({
      instanceId: repositoryB,
      minId: 10_000,
      maxId: 10_000,
      allocatedAt: 500,
    });
    assert.equal(reused.ok, true);
    if (!reused.ok) return;
    assert.equal(reused.principal.uid, first.principal.uid);
    assert.equal(reused.principal.gid, first.principal.gid);
    assert.equal(store.getRepositoryPrincipal(repositoryA)?.lifecycleState, "available");
    assert.equal(store.listRepositoryPrincipals().length, 2);
    const third = store.allocateRepositoryPrincipal({
      instanceId: repositoryC,
      minId: 10_000,
      maxId: 10_002,
      allocatedAt: 600,
    });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.notEqual(third.principal.uid, reused.principal.uid);
    assert.notEqual(third.principal.gid, reused.principal.gid);
  } finally {
    store.close();
  }
});

test("a failed persistence write rolls back and retry has one authoritative assignment", () => {
  let failWrite = true;
  const boundaries: BoundaryOperations = {
    file: (_operation, action) => action(),
    process: (_operation, action) => action(),
    storage: (operation, action) => {
      if (operation === "sqlite.repository-principal.write" && failWrite) {
        failWrite = false;
        throw new Error("injected principal persistence failure");
      }
      return action();
    },
  };
  const store = openStore(":memory:", boundaries);
  try {
    observe(store, repositoryA);
    assert.throws(() => store.allocateRepositoryPrincipal({ instanceId: repositoryA, minId: 10_000, maxId: 10_001 }));
    assert.equal(store.getRepositoryPrincipal(repositoryA), undefined);
    const retry = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_001,
      allocatedAt: 100,
    });
    assert.equal(retry.ok, true);
    assert.equal(store.listRepositoryPrincipals().length, 1);
  } finally {
    store.close();
  }
});

test("allocation survives reopening and status projection is bounded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-principal-test-"));
  const dbPath = path.join(directory, "state.sqlite3");
  try {
    const firstStore = openStore(dbPath);
    observe(firstStore, repositoryA);
    const first = new RepositoryPrincipalAllocator(firstStore).allocate({ instanceId: repositoryA, allocatedAt: 100 });
    assert.equal(first.ok, true);
    firstStore.close();
    const reopened = openStore(dbPath);
    try {
      const allocator = new RepositoryPrincipalAllocator(reopened);
      const status = allocator.status({ limit: 1 });
      assert.equal(status.length, 1);
      assert.equal(status[0]?.repositoryId, repositoryA);
      assert.equal("secret" in (status[0] ?? {}), false);
      assert.equal(allocator.get(repositoryA)?.internalUsername, status[0]?.internalUsername);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
