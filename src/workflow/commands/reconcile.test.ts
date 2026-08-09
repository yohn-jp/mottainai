import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { GitReconciliationSnapshot, ReconcileWorkflowInput } from "./reconcile.js";
import { executeReconciliationRepairs, reconcileWorkflow } from "./reconcile.js";
import type { TaskId, WorktreeId, WorkflowStateStore } from "../state/store.js";

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

function seedInstance(store: WorkflowStateStore): void {
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-38" as RootCommitDigest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
    observedAt: 0,
  });
}

function seedTask(
  store: WorkflowStateStore,
  slug = "task-38",
  issueRef = "38",
): { taskId: TaskId; worktreeId: WorktreeId } {
  const reserved = store.reserveTask({
    instanceId,
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
    instanceId,
    branchName: `feat/${issueRef}-${slug}`,
    canonicalPath: `/repo/.mottainai/worktrees/feat-${issueRef}-${slug}`,
    baseBranch: "main",
    baseCommit: "base-sha",
    reservedAt: 0,
  });
  assert.equal(worktree.ok, true);
  store.activateWorktree(worktree.worktree.worktreeId, 1);
  return { taskId: task.taskId, worktreeId: worktree.worktree.worktreeId };
}

function fresh(t: TestContext): WorkflowStateStore {
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
  assert.equal(store.listWorktrees()[0]?.status, "active");
  assert.equal(seeded.worktreeId.length > 0, true);
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

test("repair execution requires explicit confirmation and never deletes a path", async (t) => {
  const store = fresh(t);
  seedInstance(store);
  seedTask(store);
  const report = await reconcileWorkflow(input(store, snapshot(), []));
  const actionId = report.repairPlan[0]!.actionId;
  const refused = executeReconciliationRepairs({ store, report, actionIds: [actionId] });
  assert.equal(refused.reason, "confirmation-required");
  assert.equal(store.listWorktrees()[0]?.status, "active");
  const applied = executeReconciliationRepairs({ store, report, confirm: true, actionIds: [actionId] });
  assert.deepEqual(applied.applied, [actionId]);
  assert.equal(store.listWorktrees()[0]?.status, "removed");
});
