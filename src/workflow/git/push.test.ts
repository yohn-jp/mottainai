import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startTask } from "../domain/task.js";
import { getPreset } from "../policy/presets.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { pushTask, verifyPush, type PushOperationInput } from "./push.js";

interface PushFixture {
  root: string;
  remote: string;
  worktree: string;
  branch: string;
  input: PushOperationInput;
}

async function pushFixture(t: TestContext, upstream: boolean): Promise<PushFixture> {
  const root = createTempGitRepo(t);
  const remote = createTempDir(t, "mottainai-push-remote-");
  runGit(["init", "--quiet", "--bare"], remote);
  runGit(["remote", "add", "origin", remote], root);
  runGit(["-c", "protocol.file.allow=always", "push", "--quiet", "origin", "main:main"], root);

  const store = createWorkflowStore(t);
  const policy = getPreset("standard");
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy,
    taskSlug: `push-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) throw new Error("test fixture task did not create a worktree");
  const worktree = started.worktree.canonicalPath;
  const branch = started.worktree.branchName;
  if (upstream)
    runGit(
      ["-c", "protocol.file.allow=always", "push", "--quiet", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
      worktree,
    );
  return {
    root,
    remote,
    worktree,
    branch,
    input: {
      workspaceRoot: worktree,
      store,
      taskId: started.task.taskId,
      repositoryInstanceId: started.task.instanceId,
      worktreeId: started.worktree.worktreeId,
      policy,
    },
  };
}

function advanceRemote(t: TestContext, fixture: PushFixture, message: string): void {
  const clone = createTempDir(t, "mottainai-push-clone-");
  runGit(["-c", "protocol.file.allow=always", "clone", "--quiet", fixture.remote, clone], fixture.root);
  runGit(["config", "user.email", "push-test@example.com"], clone);
  runGit(["config", "user.name", "Push Test"], clone);
  runGit(["checkout", "--quiet", "-b", fixture.branch, `origin/${fixture.branch}`], clone);
  fs.appendFileSync(path.join(clone, "file.txt"), `${message}\n`);
  runGit(["commit", "--quiet", "-am", message], clone);
  runGit(["-c", "protocol.file.allow=always", "push", "--quiet", "origin", `HEAD:refs/heads/${fixture.branch}`], clone);
  runGit(["-c", "protocol.file.allow=always", "fetch", "origin"], fixture.worktree);
}

test("clean push succeeds with an existing upstream", async (t) => {
  const fixture = await pushFixture(t, true);
  const verified = await verifyPush(fixture.input);
  assert.equal(verified.ok, true);
  if (verified.ok) assert.equal(verified.relation, "up-to-date");
  const result = await pushTask(fixture.input);
  assert.equal(result.ok, true);
});

test("dirty push is denied by default and allowed only by its independent control", async (t) => {
  const fixture = await pushFixture(t, true);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "dirty\n");
  const denied = await verifyPush(fixture.input);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "dirty-worktree");
    assert.deepEqual(denied.dirtyPaths?.paths, ["file.txt"]);
  }

  const allowed = await verifyPush({ ...fixture.input, pushPolicy: { allowDirtyWorktree: true } });
  assert.equal(allowed.ok, true);
});

test("missing upstream requires both an explicit request and upstream-creation policy", async (t) => {
  const fixture = await pushFixture(t, false);
  const missing = await verifyPush(fixture.input);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "upstream-missing");

  const disabled = await verifyPush({ ...fixture.input, createUpstream: true });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.code, "upstream-creation-disabled");

  const result = await pushTask({
    ...fixture.input,
    createUpstream: true,
    pushPolicy: { allowUpstreamCreation: true },
  });
  assert.equal(result.ok, true);
  assert.equal(
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], fixture.worktree),
    `origin/${fixture.branch}`,
  );
});

test("remote behind is independently denied, while explicit allowance does not force push", async (t) => {
  const fixture = await pushFixture(t, true);
  advanceRemote(t, fixture, "remote ahead");
  const denied = await verifyPush(fixture.input);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "remote-behind");

  const allowed = await verifyPush({ ...fixture.input, pushPolicy: { allowRemoteBehind: true } });
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.equal(allowed.relation, "behind");
    assert.equal(allowed.force, false);
  }
});

test("diverged remote requires separate diverged, force, and force-request controls", async (t) => {
  const fixture = await pushFixture(t, true);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local diverged\n");
  runGit(["commit", "--quiet", "-am", "local diverged"], fixture.worktree);
  advanceRemote(t, fixture, "remote diverged");

  const denied = await verifyPush(fixture.input);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "remote-diverged");

  const noForce = await verifyPush({ ...fixture.input, pushPolicy: { allowDiverged: true } });
  assert.equal(noForce.ok, false);
  if (!noForce.ok) assert.equal(noForce.code, "force-required-for-diverged");

  const forceDisabled = await verifyPush({ ...fixture.input, force: true, pushPolicy: { allowDiverged: true } });
  assert.equal(forceDisabled.ok, false);
  if (!forceDisabled.ok) assert.equal(forceDisabled.code, "force-disabled");

  const forced = await pushTask({
    ...fixture.input,
    force: true,
    pushPolicy: { allowDiverged: true, allowForcePush: true },
  });
  assert.equal(forced.ok, true);
  assert.equal(
    runGit(["rev-parse", `refs/remotes/origin/${fixture.branch}`], fixture.worktree),
    runGit(["rev-parse", "HEAD"], fixture.worktree),
  );
});

test("protected branch push is denied without silent target or force fallback", async (t) => {
  const fixture = await pushFixture(t, false);
  const result = await verifyPush({ ...fixture.input, remoteBranch: "main", createUpstream: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "protected-branch");
});

test("required validation evidence is checked before the push subprocess", async (t) => {
  const fixture = await pushFixture(t, true);
  const result = await pushTask({
    ...fixture.input,
    pushPolicy: { requiredValidationEvidence: ["typecheck", "tests"] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "missing-validation-evidence");
    assert.deepEqual(result.missingEvidence, ["typecheck", "tests"]);
  }
});

test("force push remains disabled even when the remote is otherwise safe", async (t) => {
  const fixture = await pushFixture(t, true);
  const result = await verifyPush({ ...fixture.input, force: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "force-disabled");
});

test("push policy remains configurable without forcing Conventional Commit or other message rules", () => {
  const policy: WorkflowPolicyDocument = getPreset("standard");
  assert.equal(policy.protectedBranchRule.directPush, "enforce");
  assert.equal(policy.stagingMode, "tracked");
});
