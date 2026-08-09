import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { collectWorkflowDoctorReport } from "./doctor.js";
import type { ReconciliationReport } from "./reconcile.js";

function cleanReport(): ReconciliationReport {
  return {
    schemaVersion: 1,
    mode: "read-only",
    observedAt: 1,
    ok: true,
    repository: undefined,
    managedWorktreeRoot: undefined,
    divergences: [],
    repairPlan: [],
    diagnostics: [],
    auditRecords: [],
  };
}

test("workflow doctor is a separate injectable read-only report contract", async (t) => {
  const store = createWorkflowStore(t);
  let called = false;
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      reconcile: async () => {
        called = true;
        return cleanReport();
      },
    },
  });
  assert.equal(called, true);
  assert.equal(report.mode, "read-only");
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
});

test("workflow doctor reports task/PR instance mismatches instead of observing foreign metadata", async (t) => {
  const store = createWorkflowStore(t);
  const instanceId = "doctor-instance" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "doctor-digest" as RootCommitDigest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
    observedAt: 0,
  });
  store.recordPullRequest({
    instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 1,
    url: "https://github.com/org/repository/pull/1",
    headSha: "head",
    lifecycleState: "open",
  });
  let providerObserved = false;
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    reconciliation: {
      pathExists: () => false,
      gitSnapshot: async () => ({
        ok: true,
        snapshot: {
          repositoryRoot: "/repo",
          gitCommonDir: "/repo/.git",
          branch: "main",
          head: "head",
          worktrees: [{ path: "/repo", branch: "main", head: "head", detached: false, prunable: false }],
        },
      }),
      pullRequestObserver: async () => {
        providerObserved = true;
        return { ok: true, lifecycleState: "open", headSha: "head" };
      },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(
    report.problems.some((problem) => problem.code === "pull-request-task-mismatch"),
    true,
  );
  assert.equal(providerObserved, false);
});
