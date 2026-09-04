import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    assert.ok(second.principal.internalUsername.length <= 32);
    assert.equal(first.principal.instanceId, repositoryA);
  } finally {
    store.close();
  }
});

test("path and remote spelling changes retain the principal, while a forked instance does not inherit it", () => {
  const store = openStore();
  try {
    observe(store, repositoryA);
    const first = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_010,
      allocatedAt: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // The identity authority deliberately does not use mutable path/remote spelling.
    store.observeRepositoryInstance({
      rootCommitDigest: "digest-repository-a" as RootCommitDigest,
      instanceId: repositoryA,
      gitCommonDir: "/relocated/repository-a.git",
      canonicalWorktreePath: "/relocated/repository-a",
    });
    const afterRelocation = store.allocateRepositoryPrincipal({
      instanceId: repositoryA,
      minId: 10_000,
      maxId: 10_010,
    });
    assert.equal(afterRelocation.ok, true);
    if (!afterRelocation.ok) return;
    assert.equal(afterRelocation.principal.allocationId, first.principal.allocationId);
    assert.equal(afterRelocation.principal.uid, first.principal.uid);
    assert.equal(afterRelocation.principal.gid, first.principal.gid);

    // Same source/root hint and similar mutable metadata still cannot grant the fork
    // the original instance's principal: instanceId is the canonical allocation key.
    store.observeRepositoryInstance({
      rootCommitDigest: "digest-repository-a" as RootCommitDigest,
      instanceId: repositoryB,
      gitCommonDir: "/fork/repository-a.git",
      canonicalWorktreePath: "/fork/repository-a",
    });
    const fork = store.allocateRepositoryPrincipal({ instanceId: repositoryB, minId: 10_000, maxId: 10_010 });
    assert.equal(fork.ok, true);
    if (!fork.ok) return;
    assert.notEqual(fork.principal.allocationId, first.principal.allocationId);
    assert.notEqual(fork.principal.uid, first.principal.uid);
    assert.notEqual(fork.principal.gid, first.principal.gid);
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
    const retired = store.getRepositoryPrincipal(repositoryA);
    assert.equal(retired?.lifecycleState, "retired");
    assert.equal(retired?.reassignedToAllocationId, reused.principal.allocationId);
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

test("release and cleanup-proof persistence failures retry without half-state", () => {
  let failedOperation: "write" | "commit" | undefined;
  const boundaries: BoundaryOperations = {
    file: (_operation, action) => action(),
    process: (_operation, action) => action(),
    storage: (operation, action) => {
      if (failedOperation === "write" && operation === "sqlite.repository-principal.write") {
        failedOperation = undefined;
        throw new Error("injected lifecycle persistence failure");
      }
      if (failedOperation === "commit" && operation === "sqlite.repository-principal.commit") {
        failedOperation = undefined;
        action();
        throw new Error("injected commit acknowledgement failure");
      }
      return action();
    },
  };
  const store = openStore(":memory:", boundaries);
  try {
    observe(store, repositoryA);
    observe(store, repositoryB);
    observe(store, repositoryC);
    const allocated = store.allocateRepositoryPrincipal({ instanceId: repositoryA, minId: 10_000, maxId: 10_010 });
    assert.equal(allocated.ok, true);
    if (!allocated.ok) return;

    failedOperation = "write";
    assert.throws(() => store.releaseRepositoryPrincipal({ instanceId: repositoryA, releasedAt: 200 }));
    assert.equal(store.getRepositoryPrincipal(repositoryA)?.lifecycleState, "active");
    assert.equal(
      store.releaseRepositoryPrincipal({ instanceId: repositoryA, releasedAt: 201 }).lifecycleState,
      "quarantined",
    );

    failedOperation = "write";
    assert.throws(() => store.proveRepositoryPrincipalCleanup({ instanceId: repositoryA, provenAt: 300 }));
    assert.equal(store.getRepositoryPrincipal(repositoryA)?.lifecycleState, "quarantined");
    assert.equal(
      store.proveRepositoryPrincipalCleanup({ instanceId: repositoryA, provenAt: 301 }).lifecycleState,
      "available",
    );

    failedOperation = "commit";
    assert.throws(() => store.allocateRepositoryPrincipal({ instanceId: repositoryB, minId: 10_000, maxId: 10_010 }));
    const recovered = store.allocateRepositoryPrincipal({ instanceId: repositoryB, minId: 10_000, maxId: 10_010 });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(store.listRepositoryPrincipals({ lifecycleStates: ["active"] }).length, 1);
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

test("corrupt and ambiguous persisted principal rows fail closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-principal-corruption-test-"));
  const dbPath = path.join(directory, "state.sqlite3");
  try {
    const store = openStore(dbPath);
    observe(store, repositoryA);
    store.allocateRepositoryPrincipal({ instanceId: repositoryA });
    store.close();

    const corrupt = new DatabaseSync(dbPath);
    corrupt
      .prepare("UPDATE repository_principals SET internal_username = ? WHERE instance_id = ?")
      .run("not valid", repositoryA);
    corrupt.close();
    const corruptedStore = openStore(dbPath);
    assert.throws(() => corruptedStore.getRepositoryPrincipal(repositoryA), /corrupt|unsupported/u);
    corruptedStore.close();

    // Restore a valid row, then create the impossible active+available overlap
    // directly to prove readers reject ambiguous persisted ownership.
    const repair = new DatabaseSync(dbPath);
    repair
      .prepare("UPDATE repository_principals SET internal_username = ? WHERE instance_id = ?")
      .run("mottainai-repo-1234567890abcdef", repositoryA);
    repair.close();

    const clean = openStore(dbPath);
    observe(clean, repositoryB);
    clean.releaseRepositoryPrincipal({ instanceId: repositoryA, releasedAt: 10 });
    clean.proveRepositoryPrincipalCleanup({ instanceId: repositoryA, provenAt: 11 });
    const allocated = clean.allocateRepositoryPrincipal({ instanceId: repositoryB });
    assert.equal(allocated.ok, true);
    if (!allocated.ok) return;
    clean.close();
    const inject = new DatabaseSync(dbPath);
    inject
      .prepare(
        `UPDATE repository_principals
       SET uid = ?, gid = ?, lifecycle_state = 'available', reassigned_at = NULL, reassigned_to_allocation_id = NULL
       WHERE instance_id = ?`,
      )
      .run(allocated.principal.uid, allocated.principal.gid, repositoryA);
    inject.close();
    const ambiguous = openStore(dbPath);
    assert.throws(() => ambiguous.listRepositoryPrincipals(), /ambiguous/u);
    assert.throws(() => ambiguous.getRepositoryPrincipal(repositoryB), /ambiguous/u);
    ambiguous.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
