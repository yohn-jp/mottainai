import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { collectWorkflowDoctorReport } from "./doctor.js";
import { RECONCILIATION_SCHEMA_VERSION, type ReconciliationReport } from "./reconcile.js";

function cleanReport(): ReconciliationReport {
  return {
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    mode: "read-only",
    observedAt: 1,
    ok: true,
    repository: undefined,
    managedWorktreeRoot: undefined,
    legacyPhysical: { authority: "nawabari", worktreeRows: 0, cleanupLeaseRows: 0 },
    divergences: [],
    repairPlan: [],
    diagnostics: [],
    auditRecords: [],
  };
}

async function cleanNawabari() {
  return { ok: true, command: "doctor" } as const;
}

test("workflow doctor is a separate injectable read-only report contract", async (t) => {
  const store = createWorkflowStore(t);
  let called = false;
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      inspectNawabari: cleanNawabari,
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
  assert.deepEqual(
    report.checks.map((check) => ({ name: check.name, status: check.status })),
    [
      { name: "nawabari-execution-authority", status: "pass" },
      { name: "legacy-execution-state", status: "pass" },
      { name: "reconciliation", status: "pass" },
      { name: "repair-mode", status: "pass" },
      { name: "provider-observation", status: "pass" },
    ],
  );
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
    dependencies: { inspectNawabari: cleanNawabari },
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

test("workflow doctor reports a reconciliation failure even without divergences", async (t) => {
  const store = createWorkflowStore(t);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      inspectNawabari: cleanNawabari,
      reconcile: async () => ({
        ...cleanReport(),
        ok: false,
        diagnostics: [{ code: "git-command-failed", severity: "error", detail: "Git observation failed" }],
      }),
    },
  });
  const reconciliationCheck = report.checks.find((check) => check.name === "reconciliation");
  assert.equal(reconciliationCheck?.status, "error");
  assert.equal(reconciliationCheck?.message, "workflow reconciliation failed during observation");
  assert.equal(report.ok, false);
});

test("workflow doctor maps divergence and diagnostic severity into report metrics", async (t) => {
  const store = createWorkflowStore(t);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      inspectNawabari: cleanNawabari,
      reconcile: async () => ({
        ...cleanReport(),
        ok: false,
        divergences: [
          {
            divergenceId: "divergence:missing-managed-worktree:0",
            kind: "missing-managed-worktree",
            severity: "error",
            detail: "managed worktree is missing",
            evidence: {},
          },
        ],
        diagnostics: [
          { code: "provider-observation-unavailable", severity: "warning", detail: "provider unavailable" },
        ],
      }),
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors, 1);
  assert.equal(report.warnings, 1);
  assert.equal(report.checked, 5);
  assert.equal(report.checks.find((check) => check.name === "reconciliation")?.status, "error");
  assert.deepEqual(
    report.problems.map((problem) => ({ code: problem.code, severity: problem.severity })),
    [
      { code: "missing-managed-worktree", severity: "error" },
      { code: "provider-observation-unavailable", severity: "warning" },
    ],
  );
});

test("workflow doctor marks provider observation warnings without treating them as errors", async (t) => {
  const store = createWorkflowStore(t);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      inspectNawabari: cleanNawabari,
      reconcile: async () => ({
        ...cleanReport(),
        diagnostics: [
          { code: "provider-observation-unavailable", severity: "warning", detail: "provider unavailable" },
        ],
      }),
    },
  });
  const providerCheck = report.checks.find((check) => check.name === "provider-observation");
  assert.equal(providerCheck?.status, "warning");
  assert.equal(report.ok, true);
  assert.equal(report.warnings, 1);
});

test("workflow doctor reports a missing Nawabari companion without falling back to legacy execution", async (t) => {
  const store = createWorkflowStore(t);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    dependencies: {
      reconcile: async () => cleanReport(),
      inspectNawabari: async () => {
        throw new Error("spawn nawabari ENOENT");
      },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "nawabari-execution-authority")?.status, "error");
  assert.equal(report.problems.some((problem) => problem.code === "nawabari-command-failed"), true);
});

test("workflow doctor blocks unresolved pre-cutover task rows without claiming legacy ownership", async (t) => {
  const store = createWorkflowStore(t);
  const instanceId = "legacy-instance" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "legacy-digest" as RootCommitDigest,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const reserved = store.reserveTask({
    instanceId,
    taskSlug: "legacy-task",
    issueRef: "181",
    baseBranch: "main",
    baseCommit: "head",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true);
  const report = await collectWorkflowDoctorReport({
    workspaceRoot: "/repo",
    store,
    repositoryInstanceId: instanceId,
    dependencies: { reconcile: async () => cleanReport(), inspectNawabari: cleanNawabari },
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "legacy-execution-state")?.status, "error");
  assert.equal(report.problems.some((problem) => problem.code === "legacy-task-resolution-required"), true);
});
