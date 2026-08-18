import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "../../retrieve.js";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { getPreset } from "../policy/presets.js";
import { startTask } from "../domain/task.js";
import { NawabariExecutionError, type NawabariExecutionClient } from "../nawabari.js";
import type { NawabariSessionId } from "../state/store.js";
import { startNawabariManagedTask } from "../../test-support/nawabari-fixture.js";
import { computeStateFingerprint } from "../validation/fingerprint.js";
import { getWorkflowValidationReceipt, runWorkflowCheck } from "./check.js";

// Nawabari is the sole physical authority for managed worktrees (#203); a task must have an
// attached session before its worktree can be resolved for a managed check. Reuse the shared
// startNawabariTask()-backed fixture instead of bolting a session onto the legacy startTask().
async function taskFixture(t: TestContext) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = getPreset("standard");
  const fixture = await startNawabariManagedTask(t, {
    root,
    store,
    policy,
    taskSlug: `check-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    branchType: "fix",
    issueRef: "1",
  });
  return { root, store, task: fixture.task, worktree: fixture.worktree, nawabari: fixture.nawabari };
}

const checks = [
  { id: "test", label: "fast tests", command: process.execPath, args: ["-e", "process.exit(0)"], required: true },
];

function cloneCheckout(t: TestContext, source: string, prefix: string): string {
  const checkout = createTempDir(t, prefix);
  runGit(["clone", "--quiet", source, checkout], source);
  return checkout;
}

async function attachNawabariTask(
  root: string,
  store: ReturnType<typeof createWorkflowStore>,
  issueRef: string,
  sessionId: string,
) {
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: getPreset("minimal"),
    taskSlug: `nawabari-check-${issueRef}`,
    branchType: "fix",
    issueRef,
    skipWorktree: true,
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("test fixture task did not start");
  return store.attachNawabariSession(started.task.taskId, sessionId as NawabariSessionId);
}

function fakeNawabari(
  sessions: ReadonlyMap<string, string>,
  calls: Array<{ cwd: string; sessionId: string }>,
): NawabariExecutionClient {
  return {
    currentSessionId: async () => {
      throw new NawabariExecutionError(
        "nawabari-command-failed",
        "no current test session",
        "NO_CURRENT_SESSION",
      );
    },
    showSession: async ({ cwd, sessionId }: { cwd: string; sessionId: string }) => {
      calls.push({ cwd, sessionId });
      const worktree = sessions.get(sessionId);
      if (worktree === undefined) throw new Error(`unknown test session: ${sessionId}`);
      return {
        sessionId,
        repository: "test-repository",
        worktree,
        branch: `fix/${sessionId}`,
        state: "active",
        raw: { ok: true, command: "session show" },
      };
    },
  } as unknown as NawabariExecutionClient;
}

test("runWorkflowCheck executes a registered managed check for the active task", async (t) => {
  const { store, task, worktree, nawabari } = await taskFixture(t);
  const result = await runWorkflowCheck(
    { workspaceRoot: worktree.canonicalPath, store, taskId: task.taskId, nawabari, checkId: "test" },
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
  const { store, task, worktree, nawabari } = await taskFixture(t);
  const result = await getWorkflowValidationReceipt(
    { workspaceRoot: worktree.canonicalPath, store, taskId: task.taskId, nawabari },
    { artifactStore: new InMemoryArtifactStore(), checks },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.satisfied, false);
  assert.deepEqual(result.receipt.requiredPending, ["test"]);
});

test("runWorkflowCheck fingerprints and executes in the selected task's worktree, not an unrelated caller workspaceRoot (regression)", async (t) => {
  const { root, store, task, worktree, nawabari } = await taskFixture(t);
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
    { workspaceRoot: root, store, taskId: task.taskId, nawabari, checkId: "test" },
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

test("runWorkflowCheck uses an explicit Nawabari task's execution worktree for execution, receipts, and reuse identity", async (t) => {
  const root = createTempGitRepo(t);
  const checkoutB = cloneCheckout(t, root, "mottainai-nawabari-checkout-b-");
  const checkoutC = cloneCheckout(t, root, "mottainai-nawabari-checkout-c-");
  const store = createWorkflowStore(t);
  const taskB = await attachNawabariTask(root, store, "197-b", "session-b");
  const taskC = await attachNawabariTask(root, store, "197-c", "session-c");
  assert.equal(taskB.instanceId, taskC.instanceId);

  // The caller's primary checkout has a different state; both managed session checkouts stay identical.
  fs.writeFileSync(path.join(root, "primary-only.txt"), "must not be fingerprinted for task B\n");
  const expectedPrimary = await computeStateFingerprint({ workspaceRoot: root });
  const expectedB = await computeStateFingerprint({ workspaceRoot: checkoutB });
  assert.equal(expectedPrimary.ok, true);
  assert.equal(expectedB.ok, true);
  if (!expectedPrimary.ok || !expectedB.ok) return;
  assert.notEqual(expectedPrimary.fingerprint, expectedB.fingerprint);

  const showCalls: Array<{ cwd: string; sessionId: string }> = [];
  const nawabari = fakeNawabari(
    new Map([
      ["session-b", checkoutB],
      ["session-c", checkoutC],
    ]),
    showCalls,
  );
  const artifactStore = new InMemoryArtifactStore();
  const cwdEchoingChecks = [
    { id: "cwd", label: "cwd", command: process.execPath, args: ["-e", "console.log(process.cwd())"], required: true },
  ];
  const dependencies = { artifactStore, checks: cwdEchoingChecks };

  const resultB = await runWorkflowCheck(
    { workspaceRoot: root, store, taskId: taskB.taskId, nawabari, checkId: "cwd" },
    dependencies,
  );
  assert.equal(resultB.ok, true);
  if (!resultB.ok) return;
  assert.equal(resultB.receipt.execution, "executed");
  assert.equal(resultB.receipt.fingerprint, expectedB.fingerprint);
  assert.notEqual(resultB.receipt.fingerprint, expectedPrimary.fingerprint);
  const artifactB = artifactStore.retrieve(resultB.receipt.artifactRef!);
  assert.equal(artifactB?.text.trim(), fs.realpathSync(checkoutB));

  const assessedB = await getWorkflowValidationReceipt(
    { workspaceRoot: root, store, taskId: taskB.taskId, nawabari },
    dependencies,
  );
  assert.equal(assessedB.ok, true);
  if (!assessedB.ok) return;
  assert.equal(assessedB.receipt.checks[0]?.state, "reused-pass");
  assert.equal(assessedB.receipt.checks[0]?.fingerprint, expectedB.fingerprint);
  assert.equal(
    artifactStore.retrieve(assessedB.receipt.checks[0]?.artifactRef ?? "")?.text.trim(),
    fs.realpathSync(checkoutB),
  );

  // The second session has the same repository state but a distinct execution boundary.
  const resultC = await runWorkflowCheck(
    { workspaceRoot: root, store, taskId: taskC.taskId, nawabari, checkId: "cwd" },
    dependencies,
  );
  assert.equal(resultC.ok, true);
  if (!resultC.ok) return;
  assert.equal(resultC.receipt.execution, "executed");
  const artifactC = artifactStore.retrieve(resultC.receipt.artifactRef!);
  assert.equal(artifactC?.text.trim(), fs.realpathSync(checkoutC));

  const bRuns = store.listCheckRuns({ instanceId: taskB.instanceId, worktreeId: "nawabari:session-b" });
  const cRuns = store.listCheckRuns({ instanceId: taskC.instanceId, worktreeId: "nawabari:session-c" });
  assert.equal(bRuns.length, 1);
  assert.equal(cRuns.length, 1);
  assert.notEqual(bRuns[0]?.worktreeId, cRuns[0]?.worktreeId);
  assert.equal(store.listCheckRuns({ instanceId: taskB.instanceId, worktreeId: "" }).length, 0);
  assert.deepEqual(showCalls, [
    { cwd: root, sessionId: "session-b" },
    { cwd: root, sessionId: "session-b" },
    { cwd: root, sessionId: "session-c" },
  ]);
});

test("a second runWorkflowCheck call for the same task reuses the prior passing execution", async (t) => {
  const { store, task, worktree, nawabari } = await taskFixture(t);
  const dependencies = { artifactStore: new InMemoryArtifactStore(), checks };
  const first = await runWorkflowCheck(
    { workspaceRoot: worktree.canonicalPath, store, taskId: task.taskId, nawabari, checkId: "test" },
    dependencies,
  );
  const second = await runWorkflowCheck(
    { workspaceRoot: worktree.canonicalPath, store, taskId: task.taskId, nawabari, checkId: "test" },
    dependencies,
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.receipt.execution, "reused");
  assert.equal(second.receipt.runId, first.receipt.runId);
});
