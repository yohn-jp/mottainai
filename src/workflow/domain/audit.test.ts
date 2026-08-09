import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "./identity.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { aggregateGuardrailMetrics, recordGuardrailDecision } from "./audit.js";
import { createWorkflowStateExport, serializeWorkflowStateExport } from "../state/export.js";

const instanceId = "audit-instance" as RepositoryInstanceId;

test("audit records are redacted and aggregate the guardrail effectiveness metrics", (t) => {
  const store = createWorkflowStore(t);
  store.observeRepositoryInstance({
    rootCommitDigest: "audit-digest" as RootCommitDigest,
    instanceId,
    gitCommonDir: "/private/repository/.git",
    canonicalWorktreePath: "/private/repository",
    observedAt: 0,
  });
  const base = { instanceId, policyProvenance: "standard-default", recordedAt: 1 };
  recordGuardrailDecision(store, {
    ...base,
    operation: "branch-write",
    decision: "deny",
    ruleId: "protected-branch",
    reasonCode: "protected-branch-operation",
    metadata: { safe_count: 1, token: "do-not-export", raw_output: "do-not-export" },
  });
  recordGuardrailDecision(store, {
    ...base,
    operation: "commit",
    decision: "deny",
    ruleId: "commit-policy",
    reasonCode: "invalid-commit",
  });
  recordGuardrailDecision(store, {
    ...base,
    operation: "task-start",
    decision: "deny",
    ruleId: "task-uniqueness",
    reasonCode: "duplicate-task",
  });
  recordGuardrailDecision(store, {
    ...base,
    operation: "worktree-start",
    decision: "deny",
    ruleId: "worktree-uniqueness",
    reasonCode: "path-collision",
  });
  recordGuardrailDecision(store, {
    ...base,
    operation: "cleanup",
    decision: "deny",
    ruleId: "cleanup-safety",
    reasonCode: "cleanup-blocker",
  });
  recordGuardrailDecision(store, {
    ...base,
    operation: "git-hook",
    decision: "deny",
    ruleId: "hook-integrity",
    reasonCode: "bypass-detected",
  });
  const records = store.listGuardrailAuditRecords();
  assert.deepEqual(records.find((record) => record.operation === "branch-write")?.metadata, { safe_count: 1 });
  const metrics = aggregateGuardrailMetrics(records);
  assert.equal(metrics.deniedProtectedBranchOperations, 1);
  assert.equal(metrics.invalidCommitAttempts, 1);
  assert.equal(metrics.duplicateTaskWorktreeAttempts, 2);
  assert.equal(metrics.cleanupBlockers, 1);
  assert.equal(metrics.bypassDetections, 1);
  assert.equal(metrics.policyProvenance["standard-default"], 6);
});

test("workflow state export is versioned and redacts paths, URL credentials, and unsafe audit metadata", (t) => {
  const store = createWorkflowStore(t);
  store.observeRepositoryInstance({
    rootCommitDigest: "export-digest" as RootCommitDigest,
    instanceId,
    gitCommonDir: "/private/repository/.git",
    canonicalWorktreePath: "/private/repository",
    observedAt: 0,
  });
  store.recordPullRequest({
    provider: "github",
    repositoryId: "org/repo",
    prNumber: 38,
    url: "https://user:password@github.com/org/repo/pull/38?token=secret",
    headSha: "head-sha",
    lifecycleState: "open",
    recordedAt: 1,
  });
  recordGuardrailDecision(store, {
    operation: "export",
    decision: "observe",
    ruleId: "export-redaction",
    reasonCode: "backup",
    metadata: { safe_count: 1, secret_token: "secret" },
  });
  const exported = createWorkflowStateExport({ store, workspaceRoot: "/private/repository", now: () => 2 });
  const serialized = serializeWorkflowStateExport(exported);
  assert.equal(exported.format, "mottainai.workflow-state");
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.repositories.instances[0]?.gitCommonDir, "<workspace>/.git");
  assert.equal(exported.pullRequests[0]?.url, "https://github.com/org/repo/pull/38");
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("secret_token"), false);
  assert.equal(serialized.includes("raw SQLite"), false);
});
