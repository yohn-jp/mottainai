import assert from "node:assert/strict";
import { test } from "node:test";
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
