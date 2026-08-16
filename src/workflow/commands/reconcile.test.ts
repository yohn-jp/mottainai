import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { GitReconciliationSnapshot, ReconcileWorkflowInput } from "./reconcile.js";
import { executeReconciliationRepairs, reconcileWorkflow } from "./reconcile.js";
import type { LegacyPhysicalWorkflowStateStore, TaskId, WorktreeId, WorkflowStateStore } from "../state/store.js";

const instanceId = "instance-38" as RepositoryInstanceId;

function snapshot(overrides: Partial<GitReconciliationSnapshot> = {}): GitReconciliationSnapshot {
  return {
    repositoryRoot: "/repo",
    gitCommonDir: "/repo/.git",
    branch: "main",
    head: "base-sha",
    worktrees: [{ path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false }],
    ...overrides,
  };
}

function input(
  store: WorkflowStateStore,
  observed: GitReconciliationSnapshot,
  paths: readonly string[] = [],
): ReconcileWorkflowInput {
  return {
    workspaceRoot: "/repo",
    store,
    dependencies: {
      now: () => 100,
      pathExists: (targetPath) => paths.includes(targetPath),
      gitSnapshot: async () => ({ ok: true, snapshot: observed }),
      pullRequestObserver: async (record) => ({
        ok: true,
        lifecycleState: record.lifecycleState,
        headSha: record.headSha,
      }),
    },
  };
}

function seedInstanceFor(
  store: WorkflowStateStore,
  targetInstanceId: RepositoryInstanceId,
  commonDir = "/repo/.git",
  worktreePath = "/repo",
  digest = "digest-38",
): void {
  store.observeRepositoryInstance({
    rootCommitDigest: digest as RootCommitDigest,
    instanceId: targetInstanceId,
    gitCommonDir: commonDir,
    canonicalWorktreePath: worktreePath,
    observedAt: 0,
  });
}

function seedInstance(store: WorkflowStateStore): void {
  seedInstanceFor(store, instanceId);
}

function seedTask(
  store: WorkflowStateStore & LegacyPhysicalWorkflowStateStore,
  slug = "task-38",
  issueRef = "38",
): { taskId: TaskId; worktreeId: WorktreeId } {
  return seedTaskFor(store, instanceId, slug, issueRef);
}

function seedTaskFor(
  store: WorkflowStateStore & LegacyPhysicalWorkflowStateStore,
  targetInstanceId: RepositoryInstanceId,
  slug: string,
  issueRef: string,
  canonicalPath = `/repo/.mottainai/worktrees/feat-${issueRef}-${slug}`,
): { taskId: TaskId; worktreeId: WorktreeId } {
  const reserved = store.reserveTask({
    instanceId: targetInstanceId,
    taskSlug: slug,
    issueRef,
    baseBranch: "main",
    baseCommit: "base-sha",
    allowMultipleActiveTasksPerIssue: true,
    reservedAt: 0,
  });
  assert.equal(reserved.ok, true);
  const task = reserved.task;
  store.updateTaskLifecycleState(task.taskId, "active", 1);
  const worktree = store.reserveWorktree({
    taskId: task.taskId,
    instanceId: targetInstanceId,
    branchName: `feat/${issueRef}-${slug}`,
    canonicalPath,
    baseBranch: "main",
    baseCommit: "base-sha",
    reservedAt: 0,
  });
  assert.equal(worktree.ok, true);
  store.activateWorktree(worktree.worktree.worktreeId, 1);
  return { taskId: task.taskId, worktreeId: worktree.worktree.worktreeId };
}

function fresh(t: TestContext): WorkflowStateStore & LegacyPhysicalWorkflowStateStore {
  return createWorkflowStore(t);
}

test("reconciliation detects a missing managed worktree", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const seeded = seedTask(store);
  const report = await reconcileWorkflow(input(store, snapshot(), []));
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["missing-managed-worktree"],
  );
  assert.equal(report.repairPlan[0]?.kind, "mark-worktree-removed");
  assert.equal(report.repairPlan[0]?.targetId, seeded.worktreeId);
  assert.equal(store.listWorktrees()[0]?.status, "active");
});

test("reconciliation scopes implicit state to the current repository and never observes another repository PR", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const otherInstance = "instance-other" as RepositoryInstanceId;
  seedInstanceFor(store, otherInstance, "/other/.git", "/other", "digest-other");
  const otherTask = seedTaskFor(store, otherInstance, "other", "99", "/other/.mottainai/worktrees/feat-99-other");
  store.recordPullRequest({
    taskId: otherTask.taskId,
    provider: "github",
    repositoryId: "other/repository",
    prNumber: 99,
    url: "https://github.com/other/repository/pull/99",
    headSha: "other-head",
    lifecycleState: "open",
  });
  const observed: string[] = [];
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow({
    ...baseInput,
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async (record) => {
        observed.push(record.repositoryId);
        return { ok: true, lifecycleState: record.lifecycleState, headSha: record.headSha };
      },
    },
  });
  assert.equal(
    report.divergences.some((divergence) => divergence.taskId === otherTask.taskId),
    false,
  );
  assert.equal(
    report.divergences.some((divergence) => divergence.kind === "moved-repository"),
    false,
  );
  assert.deepEqual(observed, []);
});

test("reconciliation reports an unscoped PR record without sending it to the provider observer", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  store.recordPullRequest({
    instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 77,
    url: "https://github.com/org/repository/pull/77",
    headSha: "head",
    lifecycleState: "open",
  });
  let observed = false;
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow({
    ...baseInput,
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async () => {
        observed = true;
        return { ok: true, lifecycleState: "open", headSha: "head" };
      },
    },
  });
  assert.equal(
    report.divergences.some((divergence) => divergence.kind === "pull-request-task-mismatch"),
    true,
  );
  assert.equal(observed, false);
});

test("reconciliation detects an unregistered worktree below the managed root", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const report = await reconcileWorkflow(
    input(
      store,
      snapshot({
        worktrees: [
          { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
          {
            path: "/repo/.mottainai/worktrees/rogue",
            branch: "feat/rogue",
            head: "rogue-sha",
            detached: false,
            prunable: false,
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["unregistered-managed-root-worktree"],
  );
});

test("reconciliation detects a moved repository", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const report = await reconcileWorkflow(
    input(store, snapshot({ repositoryRoot: "/moved", gitCommonDir: "/moved/.git" })),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["moved-repository"],
  );
});

test("reconciliation detects a branch/task mismatch", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  seedTask(store);
  const report = await reconcileWorkflow(
    input(
      store,
      snapshot({
        worktrees: [
          { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
          {
            path: "/repo/.mottainai/worktrees/feat-38-task-38",
            branch: "feat/other-branch",
            head: "task-sha",
            detached: false,
            prunable: false,
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["branch-task-mismatch"],
  );
});

test("reconciliation detects an expired cleanup lock", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId } = seedTask(store);
  store.reserveCleanupLease({
    operationId: "lease-38",
    planDigest: "digest",
    instanceId,
    taskId,
    owner: "test",
    expiresAt: 10,
    acquiredAt: 0,
  });
  const report = await reconcileWorkflow(
    input(
      store,
      snapshot({
        worktrees: [
          { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
          {
            path: "/repo/.mottainai/worktrees/feat-38-task-38",
            branch: "feat/38-task-38",
            head: "task-sha",
            detached: false,
            prunable: false,
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["stale-lock"],
  );
  assert.equal(report.repairPlan[0]?.kind, "mark-expired-lock-failed");
});

test("confirmed repair marks an expired cleanup lock as failed", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "lease-task",
    issueRef: "lease-task",
    baseBranch: "main",
    baseCommit: "base-sha",
    allowMultipleActiveTasksPerIssue: true,
    reservedAt: 0,
  });
  assert.equal(reserved.ok, true);
  store.updateTaskLifecycleState(reserved.task.taskId, "active", 1);
  store.reserveCleanupLease({
    operationId: "lease-repair",
    planDigest: "digest",
    instanceId,
    taskId: reserved.task.taskId,
    owner: "test",
    expiresAt: 10,
    acquiredAt: 0,
  });
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow(baseInput);
  const actionId = report.repairPlan[0]!.actionId;
  const result = await executeReconciliationRepairs({
    store,
    report,
    confirm: true,
    actionIds: [actionId],
    workspaceRoot: "/repo",
    dependencies: baseInput.dependencies,
  });
  assert.deepEqual(result.applied, []);
  assert.equal(result.reason, "legacy-authority-retired");
  assert.equal(store.getCleanupLease("lease-repair")?.state, "reserved");
});

test("reconciliation detects a merged but uncleaned task", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId } = seedTask(store);
  store.updateTaskLifecycleState(taskId, "merged", 2);
  const report = await reconcileWorkflow(
    input(
      store,
      snapshot({
        worktrees: [
          { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
          {
            path: "/repo/.mottainai/worktrees/feat-38-task-38",
            branch: "feat/38-task-38",
            head: "task-sha",
            detached: false,
            prunable: false,
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["merged-but-uncleaned-task"],
  );
  assert.equal(report.repairPlan.length, 0);
});

test("reconciliation reports provider lifecycle divergence instead of silently trusting stale PR metadata", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId } = seedTask(store);
  store.recordPullRequest({
    provider: "github",
    repositoryId: "org/repo",
    prNumber: 38,
    url: "https://github.com/org/repo/pull/38",
    headSha: "task-sha",
    lifecycleState: "open",
    taskId,
  });
  const baseInput = input(
    store,
    snapshot({
      worktrees: [
        { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
        {
          path: "/repo/.mottainai/worktrees/feat-38-task-38",
          branch: "feat/38-task-38",
          head: "task-sha",
          detached: false,
          prunable: false,
        },
      ],
    }),
  );
  const report = await reconcileWorkflow({
    ...baseInput,
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async () => ({ ok: true, lifecycleState: "merged", headSha: "task-sha" }),
    },
  });
  assert.equal(
    report.divergences.some((item) => item.kind === "provider-state-mismatch"),
    true,
  );
  assert.equal(
    report.divergences.some((item) => item.kind === "merged-but-uncleaned-task"),
    true,
  );
});

test("provider observation unavailability is a warning and does not fail reconciliation", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "provider-unavailable",
    issueRef: "provider-unavailable",
    baseBranch: "main",
    baseCommit: "base-sha",
    allowMultipleActiveTasksPerIssue: true,
    reservedAt: 0,
  });
  assert.equal(reserved.ok, true);
  store.updateTaskLifecycleState(reserved.task.taskId, "active", 1);
  store.recordPullRequest({
    taskId: reserved.task.taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 38,
    url: "https://github.com/org/repository/pull/38",
    headSha: "head-sha",
    lifecycleState: "open",
  });
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow({
    ...baseInput,
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async () => ({ ok: false, lifecycleState: "unknown", detail: "provider unavailable" }),
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.divergences, []);
  assert.deepEqual(report.diagnostics, [
    { code: "provider-observation-unavailable", severity: "warning", detail: "provider unavailable" },
  ]);
});

test("reconciliation detects a cleaned record with a surviving path", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId, worktreeId } = seedTask(store);
  store.markWorktreeRemoved(worktreeId, 2);
  store.updateTaskLifecycleState(taskId, "cleaned", 2);
  const path = "/repo/.mottainai/worktrees/feat-38-task-38";
  const report = await reconcileWorkflow(
    input(
      store,
      snapshot({
        worktrees: [
          { path: "/repo", branch: "main", head: "base-sha", detached: false, prunable: false },
          { path, branch: "feat/38-task-38", head: "task-sha", detached: false, prunable: false },
        ],
      }),
      [path],
    ),
  );
  assert.deepEqual(
    report.divergences.map((item) => item.kind),
    ["cleaned-record-with-surviving-path"],
  );
});

test("confirmed repair marks a verified merged task as cleaned", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId, worktreeId } = seedTask(store);
  store.markWorktreeRemoved(worktreeId, 2);
  store.updateTaskLifecycleState(taskId, "merged", 2);
  store.recordPullRequest({
    taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 38,
    url: "https://github.com/org/repository/pull/38",
    headSha: "task-sha",
    lifecycleState: "merged",
  });
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow(baseInput);
  const actionId = report.repairPlan[0]!.actionId;
  const result = await executeReconciliationRepairs({
    store,
    report,
    confirm: true,
    actionIds: [actionId],
    workspaceRoot: "/repo",
    dependencies: baseInput.dependencies,
  });
  assert.deepEqual(result.applied, []);
  assert.equal(result.reason, "legacy-authority-retired");
  assert.equal(store.getTask(taskId)?.lifecycleState, "merged");
});

test("reconciliation reports a failed Git snapshot without pretending it observed state", async (t) => {
  const store = fresh(t);
  const report = await reconcileWorkflow({
    ...input(store, snapshot(), []),
    dependencies: {
      gitSnapshot: async () => ({
        ok: false,
        failure: {
          code: "git-command-failed",
          operation: "list-worktrees",
          detail: "Git worktree list could not be completed",
        },
      }),
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.repository, undefined);
  assert.deepEqual(report.diagnostics, [
    {
      code: "git-command-failed",
      severity: "error",
      detail: "Git worktree list could not be completed",
    },
  ]);
});

test("repair execution requires explicit confirmation and never deletes a path", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  seedTask(store);
  const report = await reconcileWorkflow(input(store, snapshot(), []));
  const actionId = report.repairPlan[0]!.actionId;
  const refused = await executeReconciliationRepairs({ store, report, actionIds: [actionId] });
  assert.equal(refused.reason, "confirmation-required");
  assert.equal(store.listWorktrees()[0]?.status, "active");
  const applied = await executeReconciliationRepairs({
    store,
    report,
    confirm: true,
    actionIds: [actionId],
    workspaceRoot: "/repo",
    dependencies: {
      now: () => 100,
      pathExists: () => false,
      gitSnapshot: async () => ({ ok: true, snapshot: snapshot() }),
      pullRequestObserver: async (record) => ({
        ok: true,
        lifecycleState: record.lifecycleState,
        headSha: record.headSha,
      }),
    },
  });
  assert.deepEqual(applied.applied, []);
  assert.equal(applied.reason, "legacy-authority-retired");
  assert.equal(store.listWorktrees()[0]?.status, "active");
});

test("confirmed repair rejects an omitted action selection", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  seedTask(store);
  const report = await reconcileWorkflow(input(store, snapshot(), []));
  const result = await executeReconciliationRepairs({ store, report, confirm: true });
  assert.deepEqual(result, { ok: false, reason: "precondition-failed", applied: [], blocked: [] });
  assert.equal(store.listWorktrees()[0]?.status, "active");
});

test("confirmed repair re-checks the live path and blocks a stale report", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  seedTask(store);
  const report = await reconcileWorkflow(input(store, snapshot(), []));
  const actionId = report.repairPlan[0]!.actionId;
  const result = await executeReconciliationRepairs({
    store,
    report,
    confirm: true,
    actionIds: [actionId],
    workspaceRoot: "/repo",
    dependencies: {
      now: () => 100,
      pathExists: () => true,
      gitSnapshot: async () => ({ ok: true, snapshot: snapshot() }),
      pullRequestObserver: async (record) => ({
        ok: true,
        lifecycleState: record.lifecycleState,
        headSha: record.headSha,
      }),
    },
  });
  assert.deepEqual(result.blocked, [actionId]);
  assert.equal(result.reason, "legacy-authority-retired");
  assert.equal(store.listWorktrees()[0]?.status, "active");
});

test("reserved or unmanaged worktree metadata never receives a removal repair", async (t) => {
  const reservedStore = fresh(t);
  seedInstance(reservedStore);
  const reserved = reservedStore.reserveTask({
    instanceId,
    taskSlug: "reserved",
    issueRef: "reserved",
    baseBranch: "main",
    baseCommit: "base-sha",
    allowMultipleActiveTasksPerIssue: true,
    reservedAt: 0,
  });
  assert.equal(reserved.ok, true);
  const reservedWorktree = reservedStore.reserveWorktree({
    taskId: reserved.task.taskId,
    instanceId,
    branchName: "feat/reserved",
    canonicalPath: "/repo/.mottainai/worktrees/feat-reserved",
    baseBranch: "main",
    baseCommit: "base-sha",
    reservedAt: 0,
  });
  assert.equal(reservedWorktree.ok, true);
  const reservedReport = await reconcileWorkflow(input(reservedStore, snapshot(), []));
  assert.equal(reservedReport.repairPlan.length, 0);
  assert.equal(
    reservedReport.divergences.some((divergence) => divergence.kind === "missing-managed-worktree"),
    false,
  );

  const unmanagedStore = fresh(t);
  seedInstance(unmanagedStore);
  seedTaskFor(unmanagedStore, instanceId, "unmanaged", "unmanaged", "/external/feat-unmanaged");
  const unmanagedReport = await reconcileWorkflow(input(unmanagedStore, snapshot(), []));
  assert.equal(unmanagedReport.repairPlan.length, 0);
  assert.equal(unmanagedReport.divergences[0]?.kind, "missing-managed-worktree");
});

test("stale provider state prevents task-cleaned metadata repair", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  const { taskId, worktreeId } = seedTask(store);
  store.markWorktreeRemoved(worktreeId, 2);
  store.updateTaskLifecycleState(taskId, "merged", 2);
  store.recordPullRequest({
    taskId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 38,
    url: "https://github.com/org/repository/pull/38",
    headSha: "task-sha",
    lifecycleState: "merged",
  });
  const baseInput = input(store, snapshot(), []);
  const report = await reconcileWorkflow({
    ...baseInput,
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async () => ({ ok: true, lifecycleState: "merged", headSha: "task-sha" }),
    },
  });
  const actionId = report.repairPlan[0]!.actionId;
  const result = await executeReconciliationRepairs({
    store,
    report,
    confirm: true,
    actionIds: [actionId],
    workspaceRoot: "/repo",
    dependencies: {
      ...baseInput.dependencies,
      pullRequestObserver: async () => ({ ok: true, lifecycleState: "open", headSha: "task-sha" }),
    },
  });
  assert.deepEqual(result.blocked, [actionId]);
  assert.equal(store.getTask(taskId)?.lifecycleState, "merged");
});
