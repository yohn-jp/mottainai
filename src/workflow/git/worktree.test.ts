import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import type { RepositoryInstanceId } from "../domain/identity.js";
import type { RunResult } from "../../subprocess.js";
import { runProgram } from "../../subprocess.js";
import {
  buildWorktreeNaming,
  compensatePhysicalWorktree,
  createWorktree,
  decideBootstrap,
  detectWorktreeCollisions,
  ensureCanonicalManagedWorktreeRoot,
  resolveCanonicalWorktreePath,
  runBootstrap,
  WorktreeNamingError,
  type GitRunner,
} from "./worktree.js";

function failResult(stderr: string): RunResult {
  return { stdout: "", stderr, exitCode: 1, signal: null, timedOut: false, outputLimit: false };
}

function isHeadRevParse(args: string[]): boolean {
  return args.includes("rev-parse") && args.includes("HEAD") && args[0] === "-C";
}

function gitCommonDir(root: string): string {
  return runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
}

function removeTestWorktree(root: string, worktreePath: string, branchName: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], root);
  } catch {
    // Best-effort cleanup keeps later assertions focused on the compensation under test.
  }
  try {
    runGit(["branch", "-D", "--", branchName], root);
  } catch {
    // The branch may already have been removed by the code under test.
  }
}

test("ensureCanonicalManagedWorktreeRoot rejects a symlink escape at the .mottainai segment before creating anything outside the root", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const outsideTarget = createTempDir(t, "mottainai-managed-root-outside-");
  fs.symlinkSync(outsideTarget, path.join(root, ".mottainai"));

  const result = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /resolves outside its canonical path/);
  assert.equal(fs.existsSync(path.join(outsideTarget, "worktrees")), false);
});

test("ensureCanonicalManagedWorktreeRoot rejects a symlink escape at the worktrees segment", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const outsideTarget = createTempDir(t, "mottainai-managed-root-outside-");
  fs.mkdirSync(path.join(root, ".mottainai"));
  fs.symlinkSync(outsideTarget, path.join(root, ".mottainai", "worktrees"));

  const result = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /resolves outside its canonical path/);
});

test("ensureCanonicalManagedWorktreeRoot succeeds and is idempotent when segments already exist as real directories", (t) => {
  const root = createTempDir(t, "mottainai-managed-root-test-");
  const first = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(first.ok, true);
  const second = ensureCanonicalManagedWorktreeRoot(root);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.path, second.path);
  assert.equal(first.path, fs.realpathSync.native(path.join(root, ".mottainai", "worktrees")));
});

test("buildWorktreeNaming projects explicit structured input into the governance candidate and canonical root", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "my-task" });
  assert.equal(naming.branchName, "fix/33-my-task");
  assert.equal(naming.relativePath, path.join(".mottainai", "worktrees", "fix-33-my-task"));
});

test("buildWorktreeNaming rejects a task slug that repeats the issue identity prefix", () => {
  assert.throws(
    () => buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "378-nawabari-integration-close" }),
    (error: unknown) => {
      assert.ok(error instanceof WorktreeNamingError);
      assert.equal(error.code, "duplicated-issue-identity");
      assert.match(error.message, /repeats issue identity/);
      return true;
    },
  );
});

test("buildWorktreeNaming preserves unrelated numeric content in a descriptive slug", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "manager-510-unrelated" });
  assert.equal(naming.branchName, "fix/378-manager-510-unrelated");
  const leadingNumber = buildWorktreeNaming({ branchType: "fix", issueRef: "378", taskSlug: "510-unrelated" });
  assert.equal(leadingNumber.branchName, "fix/378-510-unrelated");
});

test("buildWorktreeNaming keeps an unlinked task slug distinct from the synthetic identity", () => {
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "unlinked", taskSlug: "maintenance" });
  assert.equal(naming.branchName, "fix/unlinked-maintenance");
});

test("createWorktree succeeds against a real repository and records the base commit", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "my-task" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const expectedGitCommonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  const result = await createWorktree({ canonicalRepositoryRoot: root, naming, baseCommit, expectedGitCommonDir });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(fs.existsSync(result.canonicalPath));
  const expectedHead = runGit(["rev-parse", "HEAD"], root);
  assert.equal(result.baseCommit, expectedHead);
});

test("createWorktree returns a structured failure when the branch already exists", async (t) => {
  const root = createTempGitRepo(t);
  runGit(["branch", "fix/33-dup"], root);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "33", taskSlug: "dup" });
  const result = await createWorktree({
    canonicalRepositoryRoot: root,
    naming,
    baseCommit: runGit(["rev-parse", "HEAD"], root),
    expectedGitCommonDir: runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "git-worktree-add-failed");
  assert.ok(result.detail.length > 0);
});

test("createWorktree compensates a physical worktree/branch when HEAD verification fails after `git worktree add` succeeds (Issue #877)", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "head-verify-fault" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const expectedGitCommonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  let injectedHeadFailure = true;

  const faultyRun: GitRunner = async (program, args, cwd, timeoutMs, maxOutputBytes, env) => {
    if (isHeadRevParse(args) && injectedHeadFailure) {
      injectedHeadFailure = false;
      return failResult("injected HEAD resolution failure");
    }
    return runProgram(program, args, cwd, timeoutMs, maxOutputBytes, env);
  };

  const result = await createWorktree({
    canonicalRepositoryRoot: root,
    naming,
    baseCommit,
    expectedGitCommonDir,
    runProgram: faultyRun,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "git-worktree-add-failed");
  assert.match(result.detail, /HEAD could not be resolved/);
  assert.match(result.detail, /orphaned worktree\/branch removed/);

  // The physical side effect `git worktree add` already committed to disk must not survive.
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  assert.equal(fs.existsSync(worktreePath), false);
  const remainingBranches = runGit(["branch", "--list", naming.branchName], root);
  assert.equal(remainingBranches, "");
  const worktreeList = runGit(["worktree", "list", "--porcelain"], root);
  assert.equal(worktreeList.includes(naming.branchName), false);
});

test("createWorktree surfaces a manual-cleanup diagnostic when compensation itself cannot remove the orphan", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "compensation-fault" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const expectedGitCommonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  let injectedHeadFailure = true;

  const faultyRun: GitRunner = async (program, args, cwd, timeoutMs, maxOutputBytes, env) => {
    if (isHeadRevParse(args) && injectedHeadFailure) {
      injectedHeadFailure = false;
      return failResult("injected HEAD resolution failure");
    }
    if (args[0] === "worktree" && args[1] === "remove") return failResult("injected worktree remove failure");
    return runProgram(program, args, cwd, timeoutMs, maxOutputBytes, env);
  };

  const result = await createWorktree({
    canonicalRepositoryRoot: root,
    naming,
    baseCommit,
    expectedGitCommonDir,
    runProgram: faultyRun,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /COMPENSATION FAILED/);
  assert.match(result.detail, /manual cleanup required/);
  assert.match(result.detail, /injected worktree remove failure/);

  // The physical worktree genuinely survives here — the diagnostic is the durable
  // record a human/reconciliation pass needs to find and clear it.
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(runGit(["branch", "--list", naming.branchName], root).includes(naming.branchName), true);
  t.after(() => {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], root);
    } catch {
      /* best-effort test cleanup */
    }
  });
});

test("compensatePhysicalWorktree removes a worktree and its branch created by a prior git worktree add", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "direct-compensation" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(["worktree", "add", "-b", naming.branchName, worktreePath, baseCommit], root);
  assert.ok(fs.existsSync(worktreePath));

  const result = await compensatePhysicalWorktree({
    canonicalRepositoryRoot: root,
    expectedGitCommonDir: runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
    worktreePath,
    branchName: naming.branchName,
    expectedHead: baseCommit,
  });
  assert.equal(result.compensated, true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(runGit(["branch", "--list", naming.branchName], root), "");
});

test("compensation refuses a canonical path that has been reused by a different registered branch", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "path-reused" });
  const foreignBranch = "fix/877-foreign-path";
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(["worktree", "add", "-b", naming.branchName, worktreePath, baseCommit], root);
  runGit(["worktree", "remove", "--force", worktreePath], root);
  runGit(["branch", "-D", "--", naming.branchName], root);
  runGit(["worktree", "add", "-b", foreignBranch, worktreePath, baseCommit], root);
  t.after(() => removeTestWorktree(root, worktreePath, foreignBranch));

  let removeCalls = 0;
  const observingRun: GitRunner = async (program, args, cwd, timeoutMs, maxOutputBytes, env) => {
    if (program === "git" && args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
    return runProgram(program, args, cwd, timeoutMs, maxOutputBytes, env);
  };
  const result = await compensatePhysicalWorktree(
    {
      canonicalRepositoryRoot: root,
      expectedGitCommonDir: gitCommonDir(root),
      worktreePath,
      branchName: naming.branchName,
      expectedHead: baseCommit,
    },
    observingRun,
  );
  assert.equal(result.compensated, false);
  assert.match(result.detail ?? "", /registered branch/);
  assert.equal(removeCalls, 0);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(runGit(["-C", worktreePath, "branch", "--show-current"], root), foreignBranch);
});

test("compensation refuses when the expected branch was recreated at a different registered path", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "branch-reused" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const expectedPath = resolveCanonicalWorktreePath(root, naming);
  const foreignPath = path.join(root, "foreign-worktree");
  fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
  runGit(["worktree", "add", "-b", naming.branchName, expectedPath, baseCommit], root);
  runGit(["worktree", "remove", "--force", expectedPath], root);
  runGit(["worktree", "add", foreignPath, naming.branchName], root);
  t.after(() => removeTestWorktree(root, foreignPath, naming.branchName));

  const result = await compensatePhysicalWorktree({
    canonicalRepositoryRoot: root,
    expectedGitCommonDir: gitCommonDir(root),
    worktreePath: expectedPath,
    branchName: naming.branchName,
    expectedHead: baseCommit,
  });
  assert.equal(result.compensated, false);
  assert.match(result.detail ?? "", /refusing compensation/);
  assert.equal(fs.existsSync(foreignPath), true);
  assert.equal(runGit(["-C", foreignPath, "branch", "--show-current"], root), naming.branchName);
  assert.equal(runGit(["branch", "--list", naming.branchName], root).includes(naming.branchName), true);
});

test("compensation refuses a registered worktree whose HEAD no longer matches the failed operation", async (t) => {
  const root = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "head-reused" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(["worktree", "add", "-b", naming.branchName, worktreePath, baseCommit], root);
  fs.writeFileSync(path.join(worktreePath, "file.txt"), "changed by a later owner\n");
  runGit(["add", "file.txt"], worktreePath);
  runGit(["commit", "--quiet", "-m", "later owner change"], worktreePath);
  t.after(() => removeTestWorktree(root, worktreePath, naming.branchName));

  let removeCalls = 0;
  const observingRun: GitRunner = async (program, args, cwd, timeoutMs, maxOutputBytes, env) => {
    if (program === "git" && args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
    return runProgram(program, args, cwd, timeoutMs, maxOutputBytes, env);
  };
  const result = await compensatePhysicalWorktree(
    {
      canonicalRepositoryRoot: root,
      expectedGitCommonDir: gitCommonDir(root),
      worktreePath,
      branchName: naming.branchName,
      expectedHead: baseCommit,
    },
    observingRun,
  );
  assert.equal(result.compensated, false);
  assert.match(result.detail ?? "", /registered HEAD/);
  assert.equal(removeCalls, 0);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.notEqual(runGit(["rev-parse", "HEAD"], worktreePath), baseCommit);
});

test("compensation refuses a target whose Git common-dir is not the original repository", async (t) => {
  const root = createTempGitRepo(t);
  const otherRepository = createTempGitRepo(t);
  const naming = buildWorktreeNaming({ branchType: "fix", issueRef: "877", taskSlug: "repository-reused" });
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  const worktreePath = resolveCanonicalWorktreePath(root, naming);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(["worktree", "add", "-b", naming.branchName, worktreePath, baseCommit], root);
  t.after(() => removeTestWorktree(root, worktreePath, naming.branchName));

  const result = await compensatePhysicalWorktree({
    canonicalRepositoryRoot: root,
    expectedGitCommonDir: gitCommonDir(otherRepository),
    worktreePath,
    branchName: naming.branchName,
    expectedHead: baseCommit,
  });
  assert.equal(result.compensated, false);
  assert.match(result.detail ?? "", /repository common-dir changed/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(runGit(["branch", "--list", naming.branchName], root).includes(naming.branchName), true);
});

test("decideBootstrap: off never executes even if a lockfile is present", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("off", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: suggest returns the command but does not execute it", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("suggest", root);
  assert.equal(decision.shouldExecute, false);
  assert.ok(decision.command !== undefined);
});

test("decideBootstrap: automatic executes when a lockfile is present", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, true);
});

test("decideBootstrap: no lockfile means nothing to bootstrap regardless of mode", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  const decision = decideBootstrap("automatic", root);
  assert.equal(decision.shouldExecute, false);
});

test("decideBootstrap: conditional executes only when the digest matches", (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-test-");
  const contents = "lockfileVersion: 9\n";
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), contents);
  const digest = crypto.createHash("sha256").update(contents).digest("hex");

  const matched = decideBootstrap("conditional", root, digest);
  assert.equal(matched.shouldExecute, true);

  const mismatched = decideBootstrap("conditional", root, "wrong-digest");
  assert.equal(mismatched.shouldExecute, false);

  const undeclared = decideBootstrap("conditional", root);
  assert.equal(undeclared.shouldExecute, false);
});

test("runBootstrap does not leak process.env secrets not in the allowlist", async (t) => {
  const root = createTempDir(t, "mottainai-bootstrap-run-test-");
  process.env.MOTTAINAI_TEST_CANARY_SECRET = "super-secret-value";
  t.after(() => {
    delete process.env.MOTTAINAI_TEST_CANARY_SECRET;
  });
  const scriptPath = path.join(root, "print-canary.js");
  fs.writeFileSync(scriptPath, "console.log(process.env.MOTTAINAI_TEST_CANARY_SECRET === undefined ? 'absent' : 'leaked')\n");
  const result = await runBootstrap(root, `node ${scriptPath}`);
  assert.equal(result.ran, true);
  assert.match(result.stdout, /absent/);
});

test("detectWorktreeCollisions reports branch/path collisions against active worktrees", (t) => {
  const store = createWorkflowStore(t);
  const instanceId = "inst-1" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as never,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });

  const existingDir = createTempDir(t, "mottainai-collision-existing-");
  const taskResult = store.reserveTask({
    instanceId, taskSlug: "existing", issueRef: undefined, baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(taskResult.ok, true);
  if (!taskResult.ok) return;
  const worktreeResult = store.reserveWorktree({
    taskId: taskResult.task.taskId, instanceId, branchName: "task/existing", canonicalPath: existingDir,
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(worktreeResult.ok, true);
  if (!worktreeResult.ok) return;
  store.activateWorktree(worktreeResult.worktree.worktreeId);

  const branchCollision = detectWorktreeCollisions(store, instanceId, "task/existing", "/repo/.mottainai/worktrees/new-path");
  assert.equal(branchCollision.branchCollision, true);
  assert.equal(branchCollision.pathCollision, false);

  const pathCollision = detectWorktreeCollisions(store, instanceId, "task/new", existingDir);
  assert.equal(pathCollision.pathCollision, true);
});

test("detectWorktreeCollisions reports stale metadata for active rows whose path no longer exists", (t) => {
  const store = createWorkflowStore(t);
  const instanceId = "inst-1" as RepositoryInstanceId;
  store.observeRepositoryInstance({
    rootCommitDigest: "digest-1" as never,
    instanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const taskResult = store.reserveTask({
    instanceId, taskSlug: "gone", issueRef: undefined, baseBranch: "main", baseCommit: "deadbeef",
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(taskResult.ok, true);
  if (!taskResult.ok) return;
  const worktreeResult = store.reserveWorktree({
    taskId: taskResult.task.taskId, instanceId, branchName: "task/gone", canonicalPath: "/nonexistent/path/for/test",
    baseBranch: "main", baseCommit: "deadbeef",
  });
  assert.equal(worktreeResult.ok, true);
  if (!worktreeResult.ok) return;
  store.activateWorktree(worktreeResult.worktree.worktreeId);

  const result = detectWorktreeCollisions(store, instanceId, "task/other", "/repo/.mottainai/worktrees/other");
  assert.equal(result.staleMetadata.length, 1);
  assert.equal(result.staleMetadata[0]?.branchName, "task/gone");
});
