import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "../../retrieve.js";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import type { ManagedCheckContext } from "./governor.js";
import { assessManagedCheck, assessManagedChecks, buildValidationReceipt, runManagedCheck } from "./governor.js";
import type { ManagedCheckDefinition } from "./registry.js";

const instanceId = "inst-1" as RepositoryInstanceId;

function context(t: TestContext, root: string): ManagedCheckContext {
  const store = createWorkflowStore(t);
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as RootCommitDigest,
    instanceId,
    gitCommonDir: path.join(root, ".git"),
    canonicalWorktreePath: root,
  });
  return {
    workspaceRoot: root,
    store,
    artifactStore: new InMemoryArtifactStore(),
    instanceId,
    worktreeId: "wt-1",
  };
}

function nodeCheck(overrides: Partial<ManagedCheckDefinition> = {}): ManagedCheckDefinition {
  return {
    id: "test",
    label: "fast tests",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    required: true,
    ...overrides,
  };
}

function failingCheck(overrides: Partial<ManagedCheckDefinition> = {}): ManagedCheckDefinition {
  return nodeCheck({
    // `process.exitCode = 1` (not `process.exit(1)`) lets Node drain pending stdio writes
    // before exiting, so the diagnostic text is not truncated by a forced early exit.
    args: ["-e", "console.error('boom: something broke'); process.exitCode = 1;"],
    ...overrides,
  });
}

function mutateTrackedFileScript(root: string): string {
  const file = JSON.stringify(path.join(root, "file.txt"));
  return `require("fs").writeFileSync(${file}, ${JSON.stringify("changed during check\n")})`;
}

function commitTrackedFileScript(root: string): string {
  const repo = JSON.stringify(root);
  return [
    mutateTrackedFileScript(root),
    `require("child_process").execFileSync("git", ["add", "file.txt"], { cwd: ${repo} })`,
    `require("child_process").execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "during check"], { cwd: ${repo} })`,
  ].join(";");
}

test("a check with no prior evidence executes and records a passing run", async (t) => {
  const root = createTempGitRepo(t);
  const receipt = await runManagedCheck(context(t, root), nodeCheck());
  assert.equal(receipt.execution, "executed");
  assert.equal(receipt.state, "executed-pass");
  assert.equal(receipt.status, "passed");
  assert.notEqual(receipt.runId, undefined);
  assert.notEqual(receipt.fingerprint, undefined);
});

test("an unchanged repository state reuses the prior passing run without a new runId", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck();
  const first = await runManagedCheck(ctx, check);
  const second = await runManagedCheck(ctx, check);
  assert.equal(second.execution, "reused");
  assert.equal(second.state, "reused-pass");
  assert.equal(second.status, "passed");
  assert.equal(second.runId, first.runId);
  assert.equal(second.reusedFromRunId, first.runId);
});

test("editing a tracked file invalidates reuse and forces real execution", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck();
  const first = await runManagedCheck(ctx, check);
  fs.writeFileSync(path.join(root, "file.txt"), "changed\n");
  const second = await runManagedCheck(ctx, check);
  assert.equal(second.execution, "executed");
  assert.equal(second.state, "executed-pass");
  assert.notEqual(second.runId, first.runId);
});

test("tracked content changed during execution is not persisted under the pre-run fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const changed = await runManagedCheck(ctx, nodeCheck({ args: ["-e", mutateTrackedFileScript(root)] }));

  assert.equal(changed.status, "passed");
  assert.equal(changed.runId, undefined);
  assert.equal(changed.fingerprint, undefined);
  assert.equal(changed.provenance.reasonCode, "fingerprint-unstable");

  const afterMutation = await runManagedCheck(ctx, nodeCheck());
  assert.equal(afterMutation.execution, "executed");
  assert.notEqual(afterMutation.runId, undefined);
});

test("a clean post-run state with a different HEAD is not reusable under the pre-run fingerprint", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const committed = await runManagedCheck(ctx, nodeCheck({ args: ["-e", commitTrackedFileScript(root)] }));

  assert.equal(committed.status, "passed");
  assert.equal(committed.runId, undefined);
  assert.equal(committed.fingerprint, undefined);
  assert.equal(committed.provenance.reasonCode, "fingerprint-unstable");

  const afterCommit = await runManagedCheck(ctx, nodeCheck());
  assert.equal(afterCommit.execution, "executed");
  assert.notEqual(afterCommit.runId, undefined);
});

test("a different command for the same check id invalidates reuse (config identity changed)", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const first = await runManagedCheck(ctx, nodeCheck({ args: ["-e", "process.exit(0)"] }));
  const second = await runManagedCheck(ctx, nodeCheck({ args: ["-e", "process.exit(0) // different"] }));
  assert.equal(second.execution, "executed");
  assert.notEqual(second.runId, first.runId);
});

test("force bypasses reuse even when the state is unchanged", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck();
  const first = await runManagedCheck(ctx, check);
  const second = await runManagedCheck(ctx, check, { force: true });
  assert.equal(second.execution, "executed");
  assert.notEqual(second.runId, first.runId);
});

test("evidence is isolated per worktree: another worktree with identical state does not reuse", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck();
  await runManagedCheck(ctx, check);
  const otherWorktree: ManagedCheckContext = { ...ctx, worktreeId: "wt-2" };
  const receipt = await runManagedCheck(otherWorktree, check);
  assert.equal(receipt.execution, "executed");
});

test("a failing check returns bounded diagnostics and is never silently reused as passing", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = failingCheck();
  const first = await runManagedCheck(ctx, check);
  assert.equal(first.execution, "executed");
  assert.equal(first.state, "executed-fail");
  assert.equal(first.status, "failed");
  assert.ok(first.diagnostics !== undefined && first.diagnostics.length > 0);
  assert.ok(first.diagnostics!.some((line) => line.includes("boom")));

  // Unchanged state, but the prior run failed — must execute again, not reuse a stale failure as evidence.
  const second = await runManagedCheck(ctx, check);
  assert.equal(second.execution, "executed");
  assert.equal(second.state, "executed-fail");
});

test("successful checks do not carry diagnostics in the receipt (compact by default)", async (t) => {
  const root = createTempGitRepo(t);
  const receipt = await runManagedCheck(context(t, root), nodeCheck());
  assert.equal(receipt.diagnostics, undefined);
  assert.notEqual(receipt.artifactRef, undefined);
});

test("a non-git workspace (fingerprint unavailable) always executes and never persists reusable evidence", async (t) => {
  const root = createTempDir(t, "mottainai-not-a-repo-");
  const store = createWorkflowStore(t);
  const ctx: ManagedCheckContext = {
    workspaceRoot: root,
    store,
    artifactStore: new InMemoryArtifactStore(),
    instanceId,
    worktreeId: "wt-1",
  };
  const first = await runManagedCheck(ctx, nodeCheck());
  const second = await runManagedCheck(ctx, nodeCheck());
  assert.equal(first.execution, "executed");
  assert.equal(second.execution, "executed");
  assert.equal(first.runId, undefined);
  assert.equal(first.fingerprint, undefined);
});

test("assessManagedCheck never spawns a process and reports stale for a required check with no evidence", async (t) => {
  const root = createTempGitRepo(t);
  const receipt = await assessManagedCheck(context(t, root), nodeCheck());
  assert.equal(receipt.execution, "not-run");
  assert.equal(receipt.state, "stale");
});

test("assessManagedCheck reports not-required for an optional check with no evidence", async (t) => {
  const root = createTempGitRepo(t);
  const receipt = await assessManagedCheck(context(t, root), nodeCheck({ required: false }));
  assert.equal(receipt.state, "not-required");
});

test("assessManagedCheck reports reused-pass after a real run, without spawning a process", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck();
  await runManagedCheck(ctx, check);
  const assessed = await assessManagedCheck(ctx, check);
  // "reused" here means the receipt cites prior evidence, not that a process ran — assessManagedCheck
  // never calls runProgram; see the fingerprint match happening purely against store.findReusableCheckRun.
  assert.equal(assessed.execution, "reused");
  assert.equal(assessed.state, "reused-pass");
});

test("buildValidationReceipt/assessManagedChecks: satisfied becomes true once the required check has evidence", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const required = nodeCheck({ id: "test", required: true });
  const optional = nodeCheck({ id: "build", required: false, args: ["-e", "process.exit(0) // build"] });

  const before = await assessManagedChecks(ctx, [required, optional]);
  assert.equal(before.satisfied, false);
  assert.deepEqual(before.requiredPending, ["test"]);

  await runManagedCheck(ctx, required);
  const after = await assessManagedChecks(ctx, [required, optional]);
  assert.equal(after.satisfied, true);
  assert.deepEqual(after.requiredPending, []);
});

test("buildValidationReceipt is a pure aggregation over already-computed receipts", async (t) => {
  const root = createTempGitRepo(t);
  const receipt = await runManagedCheck(context(t, root), nodeCheck());
  const aggregate = buildValidationReceipt([receipt]);
  assert.equal(aggregate.satisfied, true);
  assert.equal(aggregate.checks.length, 1);
});

test("a clean passing run bridges into the existing validation_evidence push-gate table", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const check = nodeCheck({ evidenceName: "test" });
  const receipt = await runManagedCheck(ctx, check);
  assert.equal(receipt.fingerprint !== undefined, true);
  const headResult = runGit(["rev-parse", "HEAD"], root);
  const evidence = ctx.store.listValidationEvidence(instanceId, headResult);
  assert.equal(evidence.some((item) => item.name === "test" && item.status === "passed"), true);
});

test("evidence is not bridged into validation_evidence when the worktree is dirty outside the check's scope", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  fs.writeFileSync(path.join(root, "unrelated.txt"), "dirty\n");
  const check = nodeCheck({ evidenceName: "test", scope: ["src/**"] });
  await runManagedCheck(ctx, check);
  const headResult = runGit(["rev-parse", "HEAD"], root);
  const evidence = ctx.store.listValidationEvidence(instanceId, headResult);
  assert.equal(evidence.length, 0);
});

test("evidence is not bridged when the check itself leaves the worktree dirty as a side effect (regression: cleanliness must be re-checked after execution, not before)", async (t) => {
  const root = createTempGitRepo(t);
  const ctx = context(t, root);
  const targetPath = path.join(root, "file.txt").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const check = nodeCheck({
    evidenceName: "test",
    // The repository starts clean, so `overallClean` measured *before* execution is true.
    // This script then mutates a tracked file as a side effect before exiting successfully,
    // leaving the worktree dirty by the time the check finishes.
    args: ["-e", `require('fs').writeFileSync('${targetPath}', 'mutated by check\\n')`],
  });
  const receipt = await runManagedCheck(ctx, check);
  assert.equal(receipt.status, "passed");
  const headResult = runGit(["rev-parse", "HEAD"], root);
  const evidence = ctx.store.listValidationEvidence(instanceId, headResult);
  assert.equal(evidence.length, 0);
});
