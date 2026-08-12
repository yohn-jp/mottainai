import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "../../retrieve.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { getPreset } from "../policy/presets.js";
import { startTask } from "../domain/task.js";
import { computeStateFingerprint } from "../validation/fingerprint.js";
import { getWorkflowValidationReceipt, runWorkflowCheck } from "./check.js";

async function taskFixture(t: TestContext) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = getPreset("standard");
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy,
    taskSlug: `check-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    branchType: "fix",
    issueRef: "1",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) throw new Error("test fixture task did not create a worktree");
  return { root, store, task: started.task, worktree: started.worktree };
}

const checks = [
  { id: "test", label: "fast tests", command: process.execPath, args: ["-e", "process.exit(0)"], required: true },
];

test("runWorkflowCheck executes a registered managed check for the active task", async (t) => {
  const { store, worktree } = await taskFixture(t);
  const result = await runWorkflowCheck(
    { workspaceRoot: worktree.canonicalPath, store, checkId: "test" },
    { artifactStore: new InMemoryArtifactStore(), checks },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.state, "executed-pass");
});

test("runWorkflowCheck rejects an unknown checkId", async (t) => {
  const { store, worktree } = await taskFixture(t);
  const result = await runWorkflowCheck(
    { workspaceRoot: worktree.canonicalPath, store, checkId: "does-not-exist" },
    { artifactStore: new InMemoryArtifactStore(), checks },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unknown-check");
});

test("getWorkflowValidationReceipt reports pending required checks without executing them", async (t) => {
  const { store, worktree } = await taskFixture(t);
  const result = await getWorkflowValidationReceipt(
    { workspaceRoot: worktree.canonicalPath, store },
    { artifactStore: new InMemoryArtifactStore(), checks },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.satisfied, false);
  assert.deepEqual(result.receipt.requiredPending, ["test"]);
});

test("runWorkflowCheck fingerprints and executes in the selected task's worktree, not an unrelated caller workspaceRoot (regression)", async (t) => {
  const { root, store, task, worktree } = await taskFixture(t);
  // Dirty the primary checkout (root) only — the task's dedicated worktree stays clean.
  fs.writeFileSync(path.join(root, "unrelated-in-root.txt"), "dirty root, not the task worktree\n");

  const expected = await computeStateFingerprint({ workspaceRoot: worktree.canonicalPath });
  assert.equal(expected.ok, true);
  if (!expected.ok) return;

  const artifactStore = new InMemoryArtifactStore();
  const cwdEchoingChecks = [
    { id: "test", label: "fast tests", command: process.execPath, args: ["-e", "console.log(process.cwd())"], required: true },
  ];
  const result = await runWorkflowCheck(
    { workspaceRoot: root, store, taskId: task.taskId, checkId: "test" },
    { artifactStore, checks: cwdEchoingChecks },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The fingerprint proves the worktree's repository state was used...
  assert.equal(result.receipt.fingerprint, expected.fingerprint);
  // ...and this proves the check process itself actually ran there, not at `root`.
  assert.notEqual(result.receipt.artifactRef, undefined);
  const artifact = artifactStore.retrieve(result.receipt.artifactRef!);
  assert.equal(artifact?.text.trim(), fs.realpathSync(worktree.canonicalPath));
});

test("a second runWorkflowCheck call for the same task reuses the prior passing execution", async (t) => {
  const { store, worktree } = await taskFixture(t);
  const dependencies = { artifactStore: new InMemoryArtifactStore(), checks };
  const first = await runWorkflowCheck({ workspaceRoot: worktree.canonicalPath, store, checkId: "test" }, dependencies);
  const second = await runWorkflowCheck({ workspaceRoot: worktree.canonicalPath, store, checkId: "test" }, dependencies);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.receipt.execution, "reused");
  assert.equal(second.receipt.runId, first.receipt.runId);
});
