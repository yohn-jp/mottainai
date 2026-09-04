import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  GhMakamiAwaitRequest,
  GhMakamiAwaitResult,
  GhMakamiJsonObject,
  GhMakamiReconcileRequest,
  GhMakamiReconcileResult,
  GhMakamiResult,
  GhMakamiStatusResult,
  GhMakamiObservationRequest,
} from "../../gh-makami.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import type { PullRequestRecord } from "../state/store.js";
import {
  mapMakamiDeltaToCoarseState,
  reconcileManagedPullRequest,
  type ManagedPullRequestMakamiClient,
} from "./pr-lifecycle.js";

const repository = "acme/example";
const firstHead = "a".repeat(40);
const secondHead = "b".repeat(40);
const thirdHead = "c".repeat(40);

function record(): PullRequestRecord {
  return {
    recordId: "pr-record" as PullRequestRecord["recordId"],
    taskId: undefined,
    instanceId: undefined,
    provider: "github",
    repositoryId: repository,
    prNumber: 12,
    url: "https://github.com/acme/example/pull/12",
    headSha: firstHead,
    mergeRevision: undefined,
    lifecycleState: "open",
    createdAt: 0,
    updatedAt: 0,
  };
}

function status(headSha: string, payload: GhMakamiJsonObject): GhMakamiStatusResult {
  return { generation: { repository, prNumber: 12, headSha }, snapshot: payload };
}

function reconcile(headSha: string, payload: GhMakamiJsonObject): GhMakamiReconcileResult {
  return { generation: { repository, prNumber: 12, headSha }, delta: payload };
}

function fakeClient(
  values: Array<GhMakamiResult<GhMakamiStatusResult | GhMakamiReconcileResult>>,
): ManagedPullRequestMakamiClient & { operations: string[] } {
  let index = 0;
  const operations: string[] = [];
  const next = () => values[Math.min(index++, values.length - 1)]!;
  return {
    operations,
    async status(_request: GhMakamiObservationRequest) {
      operations.push("status");
      return next() as GhMakamiResult<GhMakamiStatusResult>;
    },
    async reconcile(_request: GhMakamiReconcileRequest) {
      operations.push("reconcile");
      return next() as GhMakamiResult<GhMakamiReconcileResult>;
    },
    async await(_request: GhMakamiAwaitRequest) {
      operations.push("await");
      return next() as GhMakamiResult<GhMakamiAwaitResult>;
    },
  };
}

function ok<Value>(value: Value): GhMakamiResult<Value> {
  return { ok: true, value };
}

test("Makami deltas map to bounded coarse states without copying detailed check/review state", () => {
  assert.deepEqual(mapMakamiDeltaToCoarseState({ kind: "unchanged", changed: false }, "awaiting"), {
    state: "awaiting",
    changed: false,
  });
  assert.deepEqual(
    mapMakamiDeltaToCoarseState(
      { kind: "ci-change", changed: true, changes: [{ path: "checks", after: "success" }] },
      "merge-ready",
    ),
    { state: "merge-ready", changed: false },
  );
  assert.deepEqual(
    mapMakamiDeltaToCoarseState(
      { kind: "review-change", changed: true, changes: [{ path: "review.lifecycle", after: "changes-requested" }] },
      "awaiting",
    ),
    { state: "awaiting", changed: false },
  );
  assert.deepEqual(
    mapMakamiDeltaToCoarseState(
      {
        kind: "lifecycle-change",
        changed: true,
        changes: [{ kind: "lifecycle-change", path: "lifecycle", after: "remediation-required" }],
      },
      "awaiting",
    ),
    { state: "remediation-required", changed: true },
  );
  assert.deepEqual(mapMakamiDeltaToCoarseState({ lifecycle: "merge-ready", checks: { many: "details" } }, "awaiting"), {
    state: "merge-ready",
    changed: true,
  });
  assert.deepEqual(mapMakamiDeltaToCoarseState({ lifecycle: "merged", merged: true }, "merge-ready"), {
    state: "merged",
    changed: true,
  });
  assert.deepEqual(
    mapMakamiDeltaToCoarseState({ kind: "new-detail", checks: [{ name: "build", conclusion: "success" }] }, "awaiting"),
    {
      state: "awaiting",
      changed: false,
    },
  );
  assert.deepEqual(mapMakamiDeltaToCoarseState({ review: { status: "approved" } }, "awaiting"), {
    state: "awaiting",
    changed: false,
  });
  assert.deepEqual(mapMakamiDeltaToCoarseState({ lifecycle: "approved", merged: false }, "awaiting"), {
    state: "awaiting",
    changed: false,
  });
});

test("managed PR state persists exact generation and same-generation lifecycle deltas", async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pr-lifecycle-")), "state.sqlite");
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  try {
    const initialClient = fakeClient([ok(status(firstHead, { kind: "pr-snapshot", lifecycle: "awaiting" }))]);
    const initial = await reconcileManagedPullRequest({ store, record: record(), makami: initialClient, now: 10 });
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    assert.equal(initial.event, "initial");
    assert.equal(initial.state.coarseState, "awaiting");
    assert.deepEqual(initial.state.generation, { repository, prNumber: 12, headSha: firstHead });
    assert.equal(initial.state.observationContract, "gh-makami/contracts/v0");
    assert.equal(initial.requiresLiveSession, false);

    const deltaClient = fakeClient([
      ok(
        reconcile(firstHead, {
          kind: "lifecycle-change",
          changed: true,
          changes: [{ kind: "lifecycle-change", path: "lifecycle", after: "merge-ready" }],
        }),
      ),
    ]);
    const delta = await reconcileManagedPullRequest({
      store,
      record: record(),
      makami: deltaClient,
      previousSnapshot: { generation: { repository, prNumber: 12, headSha: firstHead }, lifecycle: "awaiting" },
      now: 20,
    });
    assert.equal(delta.ok, true);
    if (!delta.ok) return;
    assert.equal(delta.event, "same-generation");
    assert.equal(delta.changed, true);
    assert.equal(delta.state.coarseState, "merge-ready");
    assert.deepEqual(deltaClient.operations, ["reconcile"]);
  } finally {
    store.close();
  }
});

test("head rollover updates generation and invalidates older derived/remediation inputs", async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pr-rollover-")), "state.sqlite");
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  try {
    const first = await reconcileManagedPullRequest({
      store,
      record: record(),
      makami: fakeClient([ok(status(firstHead, { lifecycle: "remediation-required" }))]),
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const derived = store.recordManagedPullRequestDerivedInput({
      stateId: first.state.stateId,
      kind: "derived",
      generation: first.state.generation,
      recordedAt: 1,
    });
    const remediation = store.recordManagedPullRequestDerivedInput({
      stateId: first.state.stateId,
      kind: "remediation",
      generation: first.state.generation,
      recordedAt: 2,
    });

    const rollover = await reconcileManagedPullRequest({
      store,
      record: record(),
      makami: fakeClient([ok(status(secondHead, { kind: "new-detail", checks: [{ conclusion: "success" }] }))]),
    });
    assert.equal(rollover.ok, true);
    if (!rollover.ok) return;
    assert.equal(rollover.event, "head-rollover");
    assert.deepEqual(rollover.state.generation, { repository, prNumber: 12, headSha: secondHead });
    assert.equal(
      rollover.state.coarseState,
      "remediation-required",
      "unknown new-head detail inherits prior coarse state",
    );
    assert.deepEqual(new Set(rollover.staleDerivedInputIds), new Set([derived.inputId, remediation.inputId]));
    assert.deepEqual(
      store.listManagedPullRequestDerivedInputs(rollover.state.stateId).map((input) => input.state),
      ["stale", "stale"],
    );
    assert.throws(
      () =>
        store.recordManagedPullRequestDerivedInput({
          stateId: rollover.state.stateId,
          kind: "remediation",
          generation: { repository, prNumber: 12, headSha: firstHead },
        }),
      /stale generation/,
    );

    const current = store.recordManagedPullRequestDerivedInput({
      stateId: rollover.state.stateId,
      kind: "derived",
      generation: rollover.state.generation,
      recordedAt: 3,
    });
    const secondRollover = await reconcileManagedPullRequest({
      store,
      record: record(),
      makami: fakeClient([ok(status(thirdHead, { kind: "detail-only", checks: [{ conclusion: "success" }] }))]),
    });
    assert.equal(secondRollover.ok, true);
    if (!secondRollover.ok) return;
    assert.deepEqual(secondRollover.staleDerivedInputIds, [current.inputId]);
  } finally {
    store.close();
  }
});

test("restart reconciliation re-observes current Makami state and never calls await", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pr-restart-"));
  const dbPath = path.join(directory, "state.sqlite");
  const firstStore = new WorkflowSqliteStateStore({ dbPath });
  firstStore.init();
  const first = await reconcileManagedPullRequest({
    store: firstStore,
    record: record(),
    makami: fakeClient([ok(status(firstHead, { lifecycle: "awaiting" }))]),
  });
  assert.equal(first.ok, true);
  firstStore.close();

  const restartedStore = new WorkflowSqliteStateStore({ dbPath });
  restartedStore.init();
  try {
    const client = fakeClient([ok(status(firstHead, { lifecycle: "merged", merged: true }))]);
    const recovered = await reconcileManagedPullRequest({ store: restartedStore, record: record(), makami: client });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.state.coarseState, "merged");
    assert.deepEqual(client.operations, ["status"]);
    assert.equal(recovered.requiresLiveSession, false);
  } finally {
    restartedStore.close();
  }
});

test("Makami provenance digest is canonical across object insertion order", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pr-digest-"));
  const firstStore = new WorkflowSqliteStateStore({ dbPath: path.join(directory, "first.sqlite") });
  const secondStore = new WorkflowSqliteStateStore({ dbPath: path.join(directory, "second.sqlite") });
  firstStore.init();
  secondStore.init();
  try {
    const firstPayload = { lifecycle: "awaiting", detail: { z: "last", a: "first" } } as GhMakamiJsonObject;
    const secondPayload = { detail: { a: "first", z: "last" }, lifecycle: "awaiting" } as GhMakamiJsonObject;
    const first = await reconcileManagedPullRequest({
      store: firstStore,
      record: record(),
      makami: fakeClient([ok(status(firstHead, firstPayload))]),
    });
    const second = await reconcileManagedPullRequest({
      store: secondStore,
      record: record(),
      makami: fakeClient([ok(status(firstHead, secondPayload))]),
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.state.observationDigest, second.state.observationDigest);
  } finally {
    firstStore.close();
    secondStore.close();
  }
});
