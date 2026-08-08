import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startTask } from "../domain/task.js";
import { getPreset } from "../policy/presets.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type { TaskId, WorktreeId } from "../state/store.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { commitTask, renderCommitMessage, reverifyBeforeMutation, verifyCommit, type CommitOperationInput } from "./commit.js";

async function managedTask(t: TestContext): Promise<{
  root: string;
  worktree: string;
  store: ReturnType<typeof createWorkflowStore>;
  input: Omit<CommitOperationInput, "message">;
}> {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const policy = getPreset("standard");
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy,
    taskSlug: `commit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    branchType: "fix",
    issueRef: "1",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) throw new Error("test fixture task did not create a worktree");
  return {
    root,
    worktree: started.worktree.canonicalPath,
    store,
    input: {
      workspaceRoot: started.worktree.canonicalPath,
      store,
      taskId: started.task.taskId,
      repositoryInstanceId: started.task.instanceId,
      worktreeId: started.worktree.worktreeId,
      policy,
    },
  };
}

function message(subject = "record workflow change"): CommitOperationInput["message"] {
  return { subject };
}

test("structured commit message renders Conventional Commit only when configured", () => {
  const conventional = renderCommitMessage(
    { type: "feat", scope: "workflow", subject: "add policy operation", breaking: true },
    { conventionalCommits: true, allowedTypes: ["feat", "fix"], allowBreaking: true },
  );
  assert.deepEqual(conventional, { ok: true, message: "feat(workflow)!: add policy operation" });

  const freeForm = renderCommitMessage(
    { subject: "Repository policy update", type: undefined },
    { conventionalCommits: false },
  );
  assert.deepEqual(freeForm, { ok: true, message: "Repository policy update" });
});

test("invalid structured commit message is rejected before Git mutation", async (t) => {
  const fixture = await managedTask(t);
  const beforeHead = runGit(["rev-parse", "HEAD"], fixture.worktree);
  const beforeStatus = runGit(["status", "--porcelain"], fixture.worktree);
  const result = await commitTask({ ...fixture.input, message: { subject: " invalid " } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid-message");
  assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), beforeHead);
  assert.equal(runGit(["status", "--porcelain"], fixture.worktree), beforeStatus);
});

test("staging mode explicit requires a bounded include list and stages only it", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "explicit\n");
  const result = await commitTask({
    ...fixture.input,
    message: message("explicit staging"),
    commitPolicy: { stagingMode: "explicit" },
    includePaths: ["file.txt"],
  });
  assert.equal(result.ok, true);
  assert.equal(runGit(["show", "-s", "--format=%s", "HEAD"], fixture.worktree), "explicit staging");
});

test("staging mode already-staged-only never runs an add command", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "already staged\n");
  runGit(["add", "--", "file.txt"], fixture.worktree);
  const result = await commitTask({
    ...fixture.input,
    message: message("already staged"),
    commitPolicy: { stagingMode: "already-staged-only" },
  });
  assert.equal(result.ok, true);
  assert.equal(runGit(["show", "-s", "--format=%s", "HEAD"], fixture.worktree), "already staged");
});

test("staging mode tracked stages tracked changes and excludes untracked files", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "tracked\n");
  fs.writeFileSync(path.join(fixture.worktree, "untracked.txt"), "must remain\n");
  const result = await commitTask({
    ...fixture.input,
    message: message("tracked staging"),
    commitPolicy: { stagingMode: "tracked" },
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(fixture.worktree, "untracked.txt")), true);
  assert.match(runGit(["status", "--porcelain"], fixture.worktree), /\?\? untracked\.txt/);
});

test("staging mode all stages tracked and untracked files only when requested", async (t) => {
  const fixture = await managedTask(t);
  fs.writeFileSync(path.join(fixture.worktree, "all.txt"), "all\n");
  const result = await commitTask({
    ...fixture.input,
    message: message("all staging"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(result.ok, true);
  assert.equal(runGit(["ls-files", "--error-unmatch", "all.txt"], fixture.worktree), "all.txt");
});

test("strict-worktree defaults staging to explicit", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "strict\n");
  const strictPolicy: WorkflowPolicyDocument = { ...getPreset("strict-worktree"), controlPlaneRole: "any" };
  const result = await verifyCommit({
    ...fixture.input,
    policy: strictPolicy,
    message: message("strict default"),
    includePaths: ["file.txt"],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.stagingMode, "explicit");
});

test("explicit include reports unexpected changed and untracked paths without file contents", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "included\n");
  fs.writeFileSync(path.join(fixture.worktree, "unexpected.txt"), "secret-looking body must not be returned\n");
  const before = runGit(["status", "--porcelain"], fixture.worktree);
  const result = await verifyCommit({
    ...fixture.input,
    message: message("unexpected"),
    commitPolicy: { stagingMode: "explicit" },
    includePaths: ["file.txt"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unexpected-changed-paths");
    assert.deepEqual(result.unexpectedPaths?.paths, ["unexpected.txt"]);
    assert.equal(result.detail.includes("secret-looking"), false);
  }
  assert.equal(runGit(["status", "--porcelain"], fixture.worktree), before);
});

test("explicit include of a staged rename is keyed by the destination path, not the source path", async (t) => {
  const fixture = await managedTask(t);
  runGit(["mv", "file.txt", "renamed.txt"], fixture.worktree);
  assert.match(runGit(["status", "--porcelain"], fixture.worktree), /^R\s+file\.txt -> renamed\.txt$/m);

  const result = await commitTask({
    ...fixture.input,
    message: message("rename staged file"),
    commitPolicy: { stagingMode: "explicit" },
    includePaths: ["renamed.txt"],
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(fixture.worktree, "renamed.txt")), true);
});

test("a new untracked file injected after verification is not staged by 'all' mode; operation aborts", async (t) => {
  const fixture = await managedTask(t);
  fs.writeFileSync(path.join(fixture.worktree, "all.txt"), "all\n");
  const verification = await verifyCommit({
    ...fixture.input,
    message: message("all staging"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(verification.ok, true);
  if (!verification.ok) return;

  fs.writeFileSync(path.join(fixture.worktree, "injected-after-verify.txt"), "must not be staged\n");
  const reverified = await reverifyBeforeMutation(verification);
  assert.equal(reverified.ok, false);
  if (!reverified.ok) assert.equal(reverified.code, "staging-failed");
  assert.equal(runGit(["status", "--porcelain"], fixture.worktree).includes("injected-after-verify.txt"), true);
  assert.equal(fs.existsSync(path.join(fixture.worktree, "injected-after-verify.txt")), true);
});

test("a HEAD change after verification aborts the commit instead of mutating on stale context", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "tracked\n");
  const verification = await verifyCommit({
    ...fixture.input,
    message: message("tracked staging"),
    commitPolicy: { stagingMode: "tracked" },
  });
  assert.equal(verification.ok, true);
  if (!verification.ok) return;

  runGit(["commit", "--quiet", "--allow-empty", "-m", "advanced by another process"], fixture.worktree);
  const reverified = await reverifyBeforeMutation(verification);
  assert.equal(reverified.ok, false);
  if (!reverified.ok) assert.equal(reverified.code, "staging-failed");
});

test("empty diff and no staged diff are rejected before mutation", async (t) => {
  const fixture = await managedTask(t);
  const empty = await verifyCommit({
    ...fixture.input,
    message: message("empty"),
    commitPolicy: { stagingMode: "tracked" },
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "empty-diff");
  const stagedOnly = await verifyCommit({
    ...fixture.input,
    message: message("staged empty"),
    commitPolicy: { stagingMode: "already-staged-only" },
  });
  assert.equal(stagedOnly.ok, false);
  if (!stagedOnly.ok) assert.equal(stagedOnly.code, "no-staged-diff");
});

test("wrong task and worktree fail before any Git mutation", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "not committed\n");
  const before = runGit(["status", "--porcelain"], fixture.worktree);
  const wrongTask = await commitTask({
    ...fixture.input,
    taskId: "missing-task" as TaskId,
    message: message("wrong task"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(wrongTask.ok, false);
  if (!wrongTask.ok) assert.equal(wrongTask.code, "task-not-found");
  const wrongWorktree = await commitTask({
    ...fixture.input,
    worktreeId: "missing-worktree" as WorktreeId,
    message: message("wrong worktree"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(wrongWorktree.ok, false);
  if (!wrongWorktree.ok) assert.equal(wrongWorktree.code, "worktree-not-found");
  assert.equal(runGit(["status", "--porcelain"], fixture.worktree), before);
});

test("wrong repository is rejected by repository identity before staging", async (t) => {
  const fixture = await managedTask(t);
  const otherRoot = createTempGitRepo(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "must not stage\n");
  const result = await verifyCommit({
    ...fixture.input,
    workspaceRoot: otherRoot,
    message: message("wrong repository"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "repository-path-mismatch");
});

test("protected branch policy blocks staging and commit before mutation", async (t) => {
  const fixture = await managedTask(t);
  fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "protected\n");
  const base = getPreset("standard");
  const protectedPolicy: WorkflowPolicyDocument = {
    ...base,
    protectedBranches: [runGit(["branch", "--show-current"], fixture.worktree)],
    protectedBranchRule: {
      sourceWrite: "enforce",
      stage: "enforce",
      commit: "enforce",
      directPush: "enforce",
      forcePush: "enforce",
      destructiveBranchOp: "enforce",
    },
    controlPlaneRole: "any",
  };
  const before = runGit(["status", "--porcelain"], fixture.worktree);
  const result = await commitTask({
    ...fixture.input,
    policy: protectedPolicy,
    message: message("protected"),
    commitPolicy: { stagingMode: "all" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "protected-branch");
  assert.equal(runGit(["status", "--porcelain"], fixture.worktree), before);
});
