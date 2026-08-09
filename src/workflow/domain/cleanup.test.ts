import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { executeCleanup } from "./cleanup-execute.js";
import { createCleanupPlan, computeCleanupPlanDigest, type CleanupPlanInput } from "./cleanup-plan.js";
import { markLease, reserveLease } from "./lease.js";
import { startTask } from "./task.js";

function cleanupPolicy(overrides: Partial<WorkflowPolicyDocument["cleanup"]> = {}): WorkflowPolicyDocument {
  const preset = BUILTIN_PRESETS["strict-worktree"];
  return { ...preset, cleanup: { ...preset.cleanup, ...overrides } };
}

interface Fixture {
  root: string;
  store: ReturnType<typeof createWorkflowStore>;
  taskId: string & { readonly __brand: "TaskId" };
  worktree: string;
  branch: string;
  branchHead: string;
  policy: WorkflowPolicyDocument;
}

async function fixture(
  t: Parameters<typeof createTempGitRepo>[0],
  options: { ignoredBase?: boolean } = {},
): Promise<Fixture> {
  const root = createTempGitRepo(t);
  if (options.ignoredBase) {
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
    runGit(["add", ".gitignore"], root);
    runGit(["commit", "--quiet", "-m", "add ignore rule"], root);
  }
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: cleanupPolicy(),
    taskSlug: "cleanup-test",
    branchType: "fix",
    issueRef: String(Math.floor(Math.random() * 1_000_000)),
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) throw new Error("cleanup fixture task did not start");
  return {
    root,
    store,
    taskId: started.task.taskId,
    worktree: started.worktree.canonicalPath,
    branch: started.worktree.branchName,
    branchHead: runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath),
    policy: cleanupPolicy(),
  };
}

function setLifecycle(fixtureValue: Fixture, state: "merged" | "abandoned" | "orphaned"): void {
  fixtureValue.store.updateTaskLifecycleState(fixtureValue.taskId, state);
}

function observerFor(fixtureValue: Fixture): NonNullable<CleanupPlanInput["pullRequestObserver"]> {
  return (record) => {
    if (record.lifecycleState === "merged") return { state: "merged", headSha: record.headSha };
    if (record.lifecycleState === "open" || record.lifecycleState === "draft")
      return { state: "open", headSha: record.headSha };
    if (record.lifecycleState === "closed") return { state: "closed-unmerged", headSha: record.headSha };
    return { state: "unknown", detail: `unsupported fixture state for ${fixtureValue.taskId}` };
  };
}

function planInput(fixtureValue: Fixture, overrides: Partial<CleanupPlanInput> = {}): CleanupPlanInput {
  return {
    workspaceRoot: fixtureValue.root,
    store: fixtureValue.store,
    taskId: fixtureValue.taskId,
    policy: fixtureValue.policy,
    activityProbe: () => ({ state: "inactive" }),
    pullRequestObserver: observerFor(fixtureValue),
    ...overrides,
  };
}

function makeAbandoned(fixtureValue: Fixture): void {
  setLifecycle(fixtureValue, "abandoned");
}

function makeMerged(fixtureValue: Fixture): void {
  fs.appendFileSync(path.join(fixtureValue.worktree, "file.txt"), "merged\n");
  runGit(["add", "file.txt"], fixtureValue.worktree);
  runGit(["commit", "--quiet", "-m", "task commit"], fixtureValue.worktree);
  fixtureValue.branchHead = runGit(["rev-parse", "HEAD"], fixtureValue.worktree);
  runGit(["merge", "--quiet", "--no-ff", "--no-edit", fixtureValue.branch], fixtureValue.root);
  fixtureValue.store.recordPullRequest({
    taskId: fixtureValue.taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 37,
    url: "https://github.com/org/repository/pull/37",
    headSha: fixtureValue.branchHead,
    lifecycleState: "merged",
  });
  setLifecycle(fixtureValue, "merged");
}

test("clean merged task produces an exact serializable plan and executes idempotently", async (t) => {
  const value = await fixture(t);
  makeMerged(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.status, "ready");
  assert.equal(planned.plan.disposition, "merged");
  assert.deepEqual(
    planned.plan.actions.map((action) => action.id),
    ["remove-worktree", "mark-worktree-removed", "mark-task-cleaned"],
  );
  assert.doesNotThrow(() => JSON.stringify(planned.plan));
  assert.equal(computeCleanupPlanDigest(planned.plan), planned.plan.planDigest);

  const executed = await executeCleanup({ ...planInput(value), plan: planned.plan });
  assert.equal(executed.status, "completed", JSON.stringify(executed));
  assert.equal(value.store.getTask(value.taskId)?.lifecycleState, "cleaned");
  assert.equal(fs.existsSync(value.worktree), false);
  assert.equal(value.store.listWorktreesForTask(value.taskId)[0]?.status, "removed");

  const repeated = await executeCleanup({ ...planInput(value), plan: planned.plan });
  assert.equal(repeated.status, "already-completed");
  assert.equal(value.store.listWorktreesForTask(value.taskId).length, 1);
});

const safetyCases: ReadonlyArray<{
  name: string;
  setup: (value: Fixture) => void;
  expected: string;
  options?: { ignoredBase?: boolean };
}> = [
  {
    name: "dirty tracked",
    setup: (value) => fs.appendFileSync(path.join(value.worktree, "file.txt"), "dirty\n"),
    expected: "tracked-changes",
  },
  {
    name: "untracked",
    setup: (value) => fs.writeFileSync(path.join(value.worktree, "untracked.txt"), "untracked\n"),
    expected: "untracked-files",
  },
  {
    name: "ignored relevant file",
    setup: (value) => fs.writeFileSync(path.join(value.worktree, "ignored.txt"), "ignored\n"),
    expected: "ignored-files",
    options: { ignoredBase: true },
  },
  {
    name: "unpushed commit",
    setup: (value) => {
      fs.appendFileSync(path.join(value.worktree, "file.txt"), "unpushed\n");
      runGit(["add", "file.txt"], value.worktree);
      runGit(["commit", "--quiet", "-m", "unpushed"], value.worktree);
      makeAbandoned(value);
    },
    expected: "unpushed-commits",
  },
  {
    name: "stash",
    setup: (value) => {
      fs.appendFileSync(path.join(value.worktree, "file.txt"), "stashed\n");
      runGit(["stash", "push", "--quiet", "-m", "cleanup-test"], value.worktree);
      makeAbandoned(value);
    },
    expected: "stash-present",
  },
  {
    name: "nested repository",
    setup: (value) => {
      const nested = path.join(value.worktree, "nested");
      fs.mkdirSync(nested);
      runGit(["init", "--quiet", "-b", "main"], nested);
      makeAbandoned(value);
    },
    expected: "nested-repository",
  },
];

for (const safetyCase of safetyCases) {
  test(`cleanup blocks ${safetyCase.name}`, async (t) => {
    const value = await fixture(t, safetyCase.options);
    safetyCase.setup(value);
    if (value.store.getTask(value.taskId)?.lifecycleState === "active") makeAbandoned(value);
    const planned = await createCleanupPlan(planInput(value));
    assert.equal(planned.ok, false);
    assert.ok(
      planned.plan.blockers.some((item) => item.code === safetyCase.expected),
      JSON.stringify(planned.plan.blockers),
    );
    assert.equal(fs.existsSync(value.worktree), true);
  });
}

test("open and closed-unmerged PRs never become a merged cleanup", async (t) => {
  const open = await fixture(t);
  open.store.recordPullRequest({
    taskId: open.taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 101,
    url: "https://example.test/101",
    headSha: open.branchHead,
    lifecycleState: "open",
  });
  makeAbandoned(open);
  const openPlan = await createCleanupPlan(planInput(open));
  assert.ok(openPlan.plan.blockers.some((item) => item.code === "pull-request-open"));

  const closed = await fixture(t);
  closed.store.recordPullRequest({
    taskId: closed.taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 102,
    url: "https://example.test/102",
    headSha: closed.branchHead,
    lifecycleState: "closed",
  });
  setLifecycle(closed, "merged");
  const closedPlan = await createCleanupPlan(planInput(closed));
  assert.ok(closedPlan.plan.blockers.some((item) => item.code === "pull-request-closed-unmerged"));
});

test("abandonment has a distinct cleanable disposition", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.disposition, "abandoned");
  assert.notEqual(planned.plan.disposition, "merged");
});

test("active leases block new plans and stale leases are recoverable", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value, { now: () => 1_000 }));
  assert.equal(planned.ok, true);
  const worktree = value.store.listWorktreesForTask(value.taskId)[0]!;
  const active = reserveLease(value.store, {
    operationId: "other-operation",
    planDigest: "other-digest",
    instanceId: worktree.instanceId,
    taskId: value.taskId,
    worktreeId: worktree.worktreeId,
    owner: "other",
    now: 1_000,
    ttlMs: 10_000,
  });
  assert.equal(active.ok, true);
  const blocked = await createCleanupPlan(planInput(value, { now: () => 2_000 }));
  assert.ok(blocked.plan.blockers.some((item) => item.code === "active-lease"));

  const stale = await fixture(t);
  makeAbandoned(stale);
  const stalePlan = await createCleanupPlan(planInput(stale, { now: () => 1_000 }));
  const staleWorktree = stale.store.listWorktreesForTask(stale.taskId)[0]!;
  reserveLease(stale.store, {
    operationId: "stale-operation",
    planDigest: "stale-digest",
    instanceId: staleWorktree.instanceId,
    taskId: stale.taskId,
    worktreeId: staleWorktree.worktreeId,
    owner: "stale",
    now: 1_000,
    ttlMs: 10,
  });
  const recovered = await executeCleanup({ ...planInput(stale), plan: stalePlan.plan, now: () => 2_000 });
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
});

test("repository identity and task version changes block execute without deleting the path", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  value.store.updateTaskLifecycleState(value.taskId, "orphaned");
  const changed = await executeCleanup({ ...planInput(value), plan: planned.plan });
  assert.equal(changed.status, "blocked");
  assert.ok(
    changed.blockers.some((item) => item.code === "task-version-changed" || item.code === "task-lifecycle-changed"),
  );
  assert.equal(fs.existsSync(value.worktree), true);
});

test("execute rejects a plan whose repository identity is from another repository", async (t) => {
  const value = await fixture(t);
  const other = await fixture(t);
  makeAbandoned(value);
  makeAbandoned(other);
  const planned = await createCleanupPlan(planInput(value));
  const otherPlan = await createCleanupPlan(planInput(other));
  assert.equal(planned.ok, true);
  assert.equal(otherPlan.ok, true);
  const mismatched = { ...planned.plan, repository: otherPlan.plan.repository };
  mismatched.planDigest = computeCleanupPlanDigest(mismatched);
  const result = await executeCleanup({ ...planInput(value), plan: mismatched });
  assert.equal(result.status, "blocked");
  assert.ok(
    result.blockers.some(
      (item) => item.code === "task-repository-mismatch" || item.code === "repository-identity-mismatch",
    ),
  );
  assert.equal(fs.existsSync(value.worktree), true);
});

test("unknown or active managed activity blocks cleanup", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const active = await createCleanupPlan(
    planInput(value, { activityProbe: () => ({ state: "active", processIds: [999] }) }),
  );
  assert.ok(active.plan.blockers.some((item) => item.code === "active-managed-process"));
  const unknown = await createCleanupPlan(
    planInput(value, { activityProbe: () => ({ state: "unknown", detail: "probe unavailable" }) }),
  );
  assert.ok(unknown.plan.blockers.some((item) => item.code === "managed-process-state-unknown"));
});

test("TOCTOU tracked mutation after the last preflight blocks removal with a barrier", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  let release!: () => void;
  let observed!: () => void;
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutationObserved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const execution = executeCleanup({
    ...planInput(value),
    plan: planned.plan,
    beforeAction: async () => {
      fs.appendFileSync(path.join(value.worktree, "file.txt"), "TOCTOU\n");
      observed();
      await proceed;
    },
  });
  await mutationObserved;
  release();
  const result = await execution;
  assert.notEqual(result.status, "completed");
  assert.ok(
    result.blockers.some((item) => item.code === "tracked-changes" || item.code === "external-mutation-failed"),
  );
  assert.equal(fs.existsSync(value.worktree), true);
});

test("crash after worktree removal is recovered by the exact plan and does not delete an unrelated replacement", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  const record = value.store.listWorktreesForTask(value.taskId)[0]!;
  const leaseResult = reserveLease(value.store, {
    operationId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    instanceId: record.instanceId,
    taskId: record.taskId,
    worktreeId: record.worktreeId,
    owner: "crashed-process",
    now: 1_000,
    ttlMs: 10,
  });
  assert.equal(leaseResult.ok, true);
  if (!leaseResult.ok) return;
  markLease(value.store, { operationId: leaseResult.lease.operationId, state: "mutating", updatedAt: 1_001 });
  runGit(["worktree", "remove", value.worktree], value.root);
  const recovered = await executeCleanup({ ...planInput(value), plan: planned.plan, now: () => 2_000 });
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(value.store.getTask(value.taskId)?.lifecycleState, "cleaned");

  const unrelated = await fixture(t);
  makeAbandoned(unrelated);
  const unrelatedPlan = await createCleanupPlan(planInput(unrelated));
  assert.equal(unrelatedPlan.ok, true);
  const unrelatedRecord = unrelated.store.listWorktreesForTask(unrelated.taskId)[0]!;
  const unrelatedLease = reserveLease(unrelated.store, {
    operationId: unrelatedPlan.plan.planId,
    planDigest: unrelatedPlan.plan.planDigest,
    instanceId: unrelatedRecord.instanceId,
    taskId: unrelated.taskId,
    worktreeId: unrelatedRecord.worktreeId,
    owner: "crashed-process",
    now: 1_000,
    ttlMs: 10,
  });
  assert.equal(unrelatedLease.ok, true);
  if (!unrelatedLease.ok) return;
  markLease(unrelated.store, { operationId: unrelatedLease.lease.operationId, state: "mutating", updatedAt: 1_001 });
  runGit(["worktree", "remove", unrelated.worktree], unrelated.root);
  fs.mkdirSync(unrelated.worktree, { recursive: true });
  fs.writeFileSync(path.join(unrelated.worktree, "do-not-delete.txt"), "unrelated\n");
  const blocked = await executeCleanup({ ...planInput(unrelated), plan: unrelatedPlan.plan, now: () => 2_000 });
  assert.notEqual(blocked.status, "completed");
  assert.equal(fs.existsSync(path.join(unrelated.worktree, "do-not-delete.txt")), true);
});

test("cleanup preserves the original error when a cleanup action also fails", async (t) => {
  const value = await fixture(t);
  makeAbandoned(value);
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, true);
  const result = await executeCleanup({
    ...planInput(value),
    plan: planned.plan,
    originalError: new Error("original workflow failure"),
    beforeAction: () => {
      fs.appendFileSync(path.join(value.worktree, "file.txt"), "cleanup failure\n");
    },
  });
  assert.equal(result.originalError, "original workflow failure");
  assert.notEqual(result.status, "completed");
  assert.ok(result.cleanupError !== undefined);
});

test("orphaned cleanup never claims a merge", async (t) => {
  const value = await fixture(t);
  setLifecycle(value, "orphaned");
  runGit(["worktree", "remove", value.worktree], value.root);
  const worktree = value.store.listWorktreesForTask(value.taskId)[0]!;
  // The active metadata is intentionally left untouched: without reconciliation, cleanup must not infer a safe orphan repair.
  const planned = await createCleanupPlan(planInput(value));
  assert.equal(planned.ok, false);
  assert.equal(planned.plan.disposition, "orphaned");
  assert.ok(
    planned.plan.blockers.some((item) => item.code === "worktree-missing" || item.code === "orphaned-active-metadata"),
  );
  assert.equal(worktree.status, "active");
});
