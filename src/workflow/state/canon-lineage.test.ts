import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";
import type { CanonCheckpointFreshnessInputs, CanonCheckpointId } from "./store.js";

const PREFIX_ID = `cp1:${"a".repeat(64)}`;
const ROOT_EXECUTION_STATE_ID = `es1:${"b".repeat(64)}`;
const FORK_EXECUTION_STATE_ID = `es1:${"c".repeat(64)}`;

function freshness(artifactGeneration: string, repository = "repo-1"): CanonCheckpointFreshnessInputs {
  return {
    repository,
    task: "task-1",
    base: "base-1",
    source: "source-1",
    artifactGeneration,
  };
}

function open(dbPath: string): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  return store;
}

test("Canon root and fork checkpoints survive restart and preserve separate execution identities", (t) => {
  const directory = createTempDir(t, "mottainai-canon-lineage-");
  const dbPath = path.join(directory, "state.sqlite3");
  const store = open(dbPath);
  const root = store.recordCanonCheckpoint({
    checkpointId: "canon-root",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness: freshness("artifact-1"),
    execution_state_id: ROOT_EXECUTION_STATE_ID,
    attachmentGeneration: 1,
    agentId: "agent-a",
    modelId: "model-a",
    profile: "codex",
    recordedAt: 100,
  });
  const fork = store.recordCanonCheckpoint({
    checkpointId: "canon-fork",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    parentCheckpointId: root.checkpointId,
    lineageKind: "fork",
    freshness: freshness("artifact-1"),
    execution_state_id: FORK_EXECUTION_STATE_ID,
    attachmentGeneration: 2,
    agentId: "agent-b",
    modelId: "model-b",
    profile: "claude",
    recordedAt: 101,
  });
  assert.equal(root.prefix_id, fork.prefix_id);
  assert.notEqual(root.execution_state_id, fork.execution_state_id);
  assert.deepEqual(
    store.listCanonCheckpointAncestry(fork.checkpointId).map((item) => item.checkpointId),
    [root.checkpointId, fork.checkpointId],
  );
  store.close();

  const reopened = open(dbPath);
  t.after(() => reopened.close());
  const restored = reopened.getCanonCheckpoint(fork.checkpointId);
  assert.equal(restored?.state, "current");
  assert.equal(restored?.agentId, "agent-b");
  assert.equal(reopened.listCanonCheckpoints({ prefix_id: PREFIX_ID }).length, 2);
  assert.deepEqual(
    reopened.listCanonCheckpointAncestry(fork.checkpointId).map((item) => item.checkpointId),
    ["canon-root", "canon-fork"],
  );
});

test("freshness reconciliation marks a parent and descendants stale and rejects stale fork reuse", () => {
  const store = open(":memory:");
  const root = store.recordCanonCheckpoint({
    checkpointId: "canon-root",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness: freshness("artifact-1"),
  });
  const child = store.recordCanonCheckpoint({
    checkpointId: "canon-child",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    parentCheckpointId: root.checkpointId,
    lineageKind: "fork",
    freshness: freshness("artifact-1"),
  });
  const staleRoot = store.reconcileCanonCheckpoint({
    checkpointId: root.checkpointId,
    freshness: freshness("artifact-2"),
    reconciledAt: 200,
  });
  assert.equal(staleRoot.state, "stale");
  assert.equal(store.getCanonCheckpoint(child.checkpointId)?.state, "stale");
  assert.equal(
    store.reconcileCanonCheckpoint({ checkpointId: root.checkpointId, freshness: freshness("artifact-1") }).state,
    "stale",
  );
  assert.throws(
    () =>
      store.recordCanonCheckpoint({
        checkpointId: "canon-rejected-child",
        canonSchemaVersion: 1,
        prefix_id: PREFIX_ID,
        parentCheckpointId: root.checkpointId,
        lineageKind: "fork",
        freshness: freshness("artifact-2"),
      }),
    /parent is stale/u,
  );
  store.close();
});

test("missing or corrupt parent fails boundedly without inventing ancestry", (t) => {
  const directory = createTempDir(t, "mottainai-canon-corrupt-");
  const dbPath = path.join(directory, "state.sqlite3");
  const store = open(dbPath);
  const root = store.recordCanonCheckpoint({
    checkpointId: "canon-root",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness: freshness("artifact-1"),
  });
  const child = store.recordCanonCheckpoint({
    checkpointId: "canon-child",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    parentCheckpointId: root.checkpointId,
    lineageKind: "fork",
    freshness: freshness("artifact-1"),
  });
  store.close();

  const database = new DatabaseSync(dbPath);
  database
    .prepare("UPDATE canon_checkpoints SET freshness_json = ? WHERE checkpoint_id = ?")
    .run("{broken", root.checkpointId);
  database.close();
  const corrupt = open(dbPath);
  assert.throws(() => corrupt.listCanonCheckpointAncestry(child.checkpointId), /corrupt freshness/u);
  corrupt.close();

  const databaseForMissing = new DatabaseSync(dbPath);
  databaseForMissing.exec("PRAGMA foreign_keys = OFF");
  databaseForMissing.prepare("DELETE FROM canon_checkpoints WHERE checkpoint_id = ?").run(root.checkpointId);
  databaseForMissing.close();
  const missing = open(dbPath);
  t.after(() => missing.close());
  assert.throws(() => missing.listCanonCheckpointAncestry(child.checkpointId), /parent not found/u);
});

test("identity and execution metadata are independently persisted", () => {
  const store = open(":memory:");
  const first = store.recordCanonCheckpoint({
    checkpointId: "canon-a",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness: freshness("artifact-1"),
    execution_state_id: ROOT_EXECUTION_STATE_ID,
    agentId: "agent-a",
    modelId: "model-a",
    profile: "codex",
  });
  const second = store.recordCanonCheckpoint({
    checkpointId: "canon-b",
    canonSchemaVersion: 1,
    prefix_id: PREFIX_ID,
    lineageKind: "independent-root",
    freshness: freshness("artifact-1"),
    execution_state_id: FORK_EXECUTION_STATE_ID,
    agentId: "agent-b",
    modelId: "model-b",
    profile: "claude",
  });
  assert.equal(first.prefix_id, second.prefix_id);
  assert.notEqual(first.execution_state_id, second.execution_state_id);
  assert.equal(store.listCanonCheckpoints({ lineageKind: "independent-root" }).length, 2);
  store.close();
});

test("invalid parent lineage and invalid Canon identities are rejected", () => {
  const store = open(":memory:");
  assert.throws(
    () =>
      store.recordCanonCheckpoint({
        checkpointId: "invalid-root",
        canonSchemaVersion: 1,
        prefix_id: PREFIX_ID,
        parentCheckpointId: "parent" as CanonCheckpointId,
        lineageKind: "independent-root",
        freshness: freshness("artifact-1"),
      }),
    /must not have a parent/u,
  );
  assert.throws(
    () =>
      store.recordCanonCheckpoint({
        checkpointId: "invalid-prefix",
        canonSchemaVersion: 1,
        prefix_id: "not-a-prefix",
        lineageKind: "independent-root",
        freshness: freshness("artifact-1"),
      }),
    /prefix_id is invalid/u,
  );
  store.close();
});
