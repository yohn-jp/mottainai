import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startNawabariTask } from "./nawabari-task.js";
import { closeNawabariExecution, reconcileNawabariClosures } from "./nawabari-close.js";
import { fakeNawabari } from "../../test-support/nawabari-fixture.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { NawabariSessionId } from "../state/store.js";
import type { PullRequestObserver } from "../providers/reconciliation.js";

async function mergedFixture(
  t: TestContext,
  beforeSessionClose?: () => void,
  options: { mergeRevision?: string | undefined; prNumber?: number } = {},
) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls, beforeSessionClose });
  const prNumber = options.prNumber ?? 378;
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "close-reconciliation",
    branchType: "fix",
    issueRef: String(prNumber),
    idempotencyKey: `close-reconciliation-${prNumber}`,
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("fixture setup failed");
  store.recordPullRequest({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber,
    url: `https://github.com/org/repository/pull/${prNumber}`,
    headSha: "head-sha",
    ...("mergeRevision" in options ? { mergeRevision: options.mergeRevision } : { mergeRevision: "integrated-sha" }),
    lifecycleState: "merged",
  });
  store.updateTaskLifecycleState(started.task.taskId, "merged");
  return { root, store, nawabari, sessions, calls, task: store.getTask(started.task.taskId)! };
}

test("close uses inspected task identity and forwards the authoritative merge revision", async (t) => {
  const fixture = await mergedFixture(t);
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const result = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const inspectIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "inspect");
  const closeIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "close");
  assert.ok(inspectIndex >= 0);
  assert.ok(closeIndex > inspectIndex);
  assert.deepEqual(fixture.calls[closeIndex], [
    "session",
    "close",
    "--session",
    fixture.task.nawabariSessionId,
    "--integrated-revision",
    "integrated-sha",
    "--json",
  ]);
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");
});

test("a close blocker durably keeps the task merged and the same identity retries", async (t) => {
  let attempts = 0;
  const fixture = await mergedFixture(t, () => {
    attempts += 1;
    if (attempts === 1) throw new Error("DIRTY_WORKTREE: review changes remain");
  });
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const first = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.reason, "cleanup-blocked");
  assert.equal(fixture.store.getTask(fixture.task.taskId)?.lifecycleState, "merged");
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "blocked");

  const second = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.store.getTask(fixture.task.taskId)!,
    providerRecord: fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");
  assert.equal(attempts, 2);
});

test("a non-active, non-closed inspect state (closing/stale) stays blocked and retryable, not closed", async (t) => {
  const fixture = await mergedFixture(t);
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const session = fixture.sessions.get(fixture.task.nawabariSessionId!)!;
  session.state = "closing";

  const result = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "cleanup-blocked");
    // The physical close-readiness evidence stays visible in the bounded diagnostic.
    assert.match(result.detail, /close_readiness/);
    assert.match(result.detail, /blockers/);
  }
  assert.equal(fixture.store.getTask(fixture.task.taskId)?.lifecycleState, "merged");
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "blocked");
  const closeIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "close");
  assert.equal(closeIndex, -1, "a closing/stale session must never receive a close request");
});

test("a merged provider record without a merge revision closes without --integrated-revision", async (t) => {
  const fixture = await mergedFixture(t, undefined, { mergeRevision: undefined });
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  assert.equal(record.mergeRevision, undefined);

  const result = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const closeIndex = fixture.calls.findIndex((args) => args[0] === "session" && args[1] === "close");
  assert.ok(closeIndex >= 0);
  assert.deepEqual(fixture.calls[closeIndex], [
    "session",
    "close",
    "--session",
    fixture.task.nawabariSessionId,
    "--json",
  ]);
});

test("reconcileNawabariClosures reports a never-attempted task as a non-blocking diagnostic, not a start blocker", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(root, { sessions });
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "never-attempted",
    branchType: "fix",
    issueRef: "1",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("fixture setup failed");
  // pull-request-open with zero provider records: e.g. pr_records.task_id's
  // ON DELETE SET NULL detached the record. No close was ever attempted.
  store.updateTaskLifecycleState(started.task.taskId, "pull-request-open");

  const result = await reconcileNawabariClosures({ workspaceRoot: root, store, client: nawabari });
  assert.equal(result.blocked.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]!.detail, /close identity is ambiguous/);
});

test("reconciliation never promotes or closes on a mismatched observed head, and leaves an unrelated session untouched", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls });

  const target = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "mismatched-head",
    branchType: "fix",
    issueRef: "2",
    nawabari,
  });
  assert.equal(target.ok, true, JSON.stringify(target));
  if (!target.ok) throw new Error("fixture setup failed");
  store.recordPullRequest({
    taskId: target.task.taskId,
    instanceId: target.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 2,
    url: "https://github.com/org/repository/pull/2",
    headSha: "recorded-head-sha",
    lifecycleState: "open",
  });
  store.updateTaskLifecycleState(target.task.taskId, "pull-request-open");

  // An unrelated, unmanaged session in the same repository must never be touched
  // by reconciliation, whatever the outcome for the target task.
  const unrelatedSessionId = "manual-unrelated-session";
  sessions.set(unrelatedSessionId, {
    ok: true,
    command: "session show",
    session_id: unrelatedSessionId,
    repository: sessions.get(target.task.nawabariSessionId!)!.repository,
    worktree: "/tmp/unrelated-worktree",
    branch: "manual/unrelated",
    state: "active",
  });

  const result = await reconcileNawabariClosures({
    workspaceRoot: root,
    store,
    client: nawabari,
    providerObserver: async () => ({ ok: true, lifecycleState: "merged", headSha: "different-head-sha" }),
  });
  assert.equal(result.promoted, 0);
  assert.equal(result.closed, 0);
  assert.equal(store.getTask(target.task.taskId)?.lifecycleState, "pull-request-open");
  assert.equal(sessions.get(target.task.nawabariSessionId!)?.state, "active");
  assert.equal(sessions.get(unrelatedSessionId)?.state, "active");
  assert.equal(
    calls.some((args) => args[0] === "session" && args[1] === "close"),
    false,
    "a head mismatch must never trigger a close request",
  );
});

test("durable closed reconciliation state is terminal: a later race never regresses it to blocked", async (t) => {
  const fixture = await mergedFixture(t);
  const record = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!;
  const first = await closeNawabariExecution({
    workspaceRoot: fixture.root,
    store: fixture.store,
    client: fixture.nawabari,
    task: fixture.task,
    providerRecord: record,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");

  // Simulate a second, concurrent close attempt that observed the reconciliation
  // row before it was marked closed and later loses a race, reporting a failure.
  const raced = fixture.store.markNawabariCloseReconciliation(
    fixture.task.taskId,
    "blocked",
    "simulated concurrent close failure",
  );
  assert.equal(raced.state, "closed", "a durable closed result must never regress to blocked");
  assert.equal(fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.state, "closed");
});

test("golden path: authoritative merge observation drives Nawabari close, and the next task start needs no manual session close", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls });

  // Reproduces the #373 -> PR #376 -> #377 sequence: a prior task's execution
  // merges, but its Nawabari session/claims would otherwise remain active and
  // block the very next managed task start with RESOURCE_CLAIM_CONFLICT.
  const priorTask = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "issue-373",
    branchType: "fix",
    issueRef: "373",
    nawabari,
  });
  assert.equal(priorTask.ok, true, JSON.stringify(priorTask));
  if (!priorTask.ok) throw new Error("fixture setup failed");
  const priorSessionId = priorTask.task.nawabariSessionId!;
  store.recordPullRequest({
    taskId: priorTask.task.taskId,
    instanceId: priorTask.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 376,
    url: "https://github.com/org/repository/pull/376",
    headSha: "pr-376-head-sha",
    lifecycleState: "open",
  });
  store.updateTaskLifecycleState(priorTask.task.taskId, "pull-request-open");

  // Mottainai obtains authoritative integration evidence (exact task/head
  // identity) through the owning governance/provider observer and requests
  // Nawabari's normal safe close — it never edits Nawabari registry state.
  const observer: PullRequestObserver = async () => ({
    ok: true,
    lifecycleState: "merged",
    headSha: "pr-376-head-sha",
    mergeRevision: "merge-commit-for-376",
  });
  const first = await reconcileNawabariClosures({
    workspaceRoot: root,
    store,
    client: nawabari,
    providerObserver: observer,
  });
  assert.equal(first.promoted, 1);
  assert.equal(first.closed, 1);
  assert.equal(first.blocked.length, 0);
  assert.equal(store.getTask(priorTask.task.taskId)?.lifecycleState, "merged");
  assert.equal(sessions.get(priorSessionId)?.state, "closed");
  assert.equal(store.getNawabariCloseReconciliation(priorTask.task.taskId)?.state, "closed");

  // Crash/retry idempotency: reconciling again after the fact (simulating a
  // process restart before the caller observed the first result) must not
  // fail, must not re-request a close, and must not lose the closed record.
  calls.length = 0;
  const second = await reconcileNawabariClosures({
    workspaceRoot: root,
    store,
    client: nawabari,
    providerObserver: observer,
  });
  assert.equal(second.blocked.length, 0);
  assert.equal(
    calls.some((args) => args[0] === "session" && (args[1] === "close" || args[1] === "inspect")),
    false,
    "a task already durably closed must not re-invoke Nawabari",
  );
  assert.equal(store.getNawabariCloseReconciliation(priorTask.task.taskId)?.state, "closed");

  // The next managed task start (the reproduced #377) must succeed without any
  // manual `nawabari session close` — the bounded interactive reconciliation
  // already released the prior execution's session.
  const nextTask = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "issue-377",
    branchType: "fix",
    issueRef: "377",
    nawabari,
  });
  assert.equal(nextTask.ok, true, JSON.stringify(nextTask));
});

test("beginNawabariCloseReconciliation rejects an identity mismatch against an already-durable row", async (t) => {
  const fixture = await mergedFixture(t);
  fixture.store.beginNawabariCloseReconciliation({
    taskId: fixture.task.taskId,
    instanceId: fixture.task.instanceId,
    nawabariSessionId: fixture.task.nawabariSessionId!,
    providerRecordId: fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!.recordId,
  });
  assert.throws(
    () =>
      fixture.store.beginNawabariCloseReconciliation({
        taskId: fixture.task.taskId,
        instanceId: fixture.task.instanceId,
        // A different session identity for the same task is a corrupted/foreign
        // record, not a retry: never silently adopt it as the retry boundary.
        nawabariSessionId: "unrelated-session-id" as NawabariSessionId,
        providerRecordId: fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!.recordId,
      }),
    /identity mismatch/,
  );
});

test("beginNawabariCloseReconciliation backfills a missing integrated revision onto an existing pending row", async (t) => {
  const fixture = await mergedFixture(t, undefined, { mergeRevision: undefined });
  const recordId = fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!.recordId;
  const begun = fixture.store.beginNawabariCloseReconciliation({
    taskId: fixture.task.taskId,
    instanceId: fixture.task.instanceId,
    nawabariSessionId: fixture.task.nawabariSessionId!,
    providerRecordId: recordId,
  });
  assert.equal(begun.integratedRevision, undefined);
  assert.equal(begun.state, "pending");

  const backfilled = fixture.store.beginNawabariCloseReconciliation({
    taskId: fixture.task.taskId,
    instanceId: fixture.task.instanceId,
    nawabariSessionId: fixture.task.nawabariSessionId!,
    providerRecordId: recordId,
    integratedRevision: "late-observed-merge-revision",
  });
  assert.equal(backfilled.integratedRevision, "late-observed-merge-revision");
  assert.equal(backfilled.state, "pending");
  assert.equal(
    fixture.store.getNawabariCloseReconciliation(fixture.task.taskId)?.integratedRevision,
    "late-observed-merge-revision",
  );
});

test("getNawabariCloseReconciliation reports undefined for a task with no reconciliation row", async (t) => {
  const fixture = await mergedFixture(t);
  assert.equal(fixture.store.getNawabariCloseReconciliation("no-such-task" as typeof fixture.task.taskId), undefined);
});

test("listNawabariCloseReconciliations lists globally and scoped to a repository instance", async (t) => {
  const fixture = await mergedFixture(t);
  fixture.store.beginNawabariCloseReconciliation({
    taskId: fixture.task.taskId,
    instanceId: fixture.task.instanceId,
    nawabariSessionId: fixture.task.nawabariSessionId!,
    providerRecordId: fixture.store.listPullRequestRecordsForTask(fixture.task.taskId)[0]!.recordId,
    createdAt: Date.now(),
  });
  const all = fixture.store.listNawabariCloseReconciliations();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.taskId, fixture.task.taskId);
  const scoped = fixture.store.listNawabariCloseReconciliations(fixture.task.instanceId);
  assert.equal(scoped.length, 1);
  const otherInstanceScoped = fixture.store.listNawabariCloseReconciliations(
    "unrelated-instance" as typeof fixture.task.instanceId,
  );
  assert.equal(otherInstanceScoped.length, 0);
});
