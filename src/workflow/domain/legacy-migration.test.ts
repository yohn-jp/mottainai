import assert from "node:assert/strict";
import { test } from "node:test";
import type { NawabariExecutionClient, NawabariSession } from "../nawabari.js";
import { createTempDir } from "../../test-support/tmp-dir.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { resolveRepositoryIdentity } from "./identity.js";
import { migrateLegacyWorkflowTask } from "./legacy-migration.js";
import { transitionTask } from "./task.js";
import type { TaskRecord } from "../state/store.js";

function legacyTask(testContext: Parameters<typeof createTempGitRepo>[0], slug: string) {
  const root = createTempGitRepo(testContext);
  const store = createWorkflowStore(testContext);
  const identity = resolveRepositoryIdentity(root);
  if (!identity.ok) throw new Error(identity.reason);
  const baseCommit = runGit(["rev-parse", "HEAD"], root);
  store.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug: slug,
    issueRef: "203",
    baseBranch: "main",
    baseCommit,
    allowMultipleActiveTasksPerIssue: true,
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  return { root, store, identity: identity.identity, task: reserved.task };
}

function terminalTask(store: ReturnType<typeof createWorkflowStore>, task: TaskRecord): TaskRecord {
  const active = transitionTask(store, task.taskId, "active");
  if (!active.ok) throw new Error(active.blocked.blockingRule);
  const abandoned = transitionTask(store, task.taskId, "abandoned");
  if (!abandoned.ok) throw new Error(abandoned.blocked.blockingRule);
  return abandoned.task;
}

function fakeNawabari(session: NawabariSession): NawabariExecutionClient {
  return {
    showSession: async () => session,
  } as unknown as NawabariExecutionClient;
}

test("legacy complete requires terminal lifecycle and independently observed physical absence", async (t) => {
  const fixture = legacyTask(t, "complete");
  const result = await migrateLegacyWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.task.taskId,
    mode: "complete",
  });
  if (result.ok) throw new Error("expected non-terminal legacy task to be rejected");
  assert.equal(result.reason, "legacy-task-not-terminal");

  const terminal = terminalTask(fixture.store, fixture.task);
  const completed = await migrateLegacyWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: terminal.taskId,
    mode: "complete",
    now: () => 203,
  });
  if (!completed.ok) throw new Error(completed.detail);
  assert.equal(completed.task.lifecycleState, "cleaned");
  assert.equal(completed.proof.authority, "nawabari");
  assert.equal(completed.proof.observedAt, 203);
  assert.deepEqual(completed.proof.worktreeRowIds, []);
});

test("legacy complete fails closed when an old physical row or path remains", async (t) => {
  const fixture = legacyTask(t, "physical");
  const terminal = terminalTask(fixture.store, fixture.task);
  const legacyPath = createTempDir(t, "mottainai-legacy-row-");
  const reserved = fixture.store.reserveWorktree({
    taskId: terminal.taskId,
    instanceId: fixture.identity.instanceId,
    branchName: "fix/203-physical",
    canonicalPath: legacyPath,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], fixture.root),
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  fixture.store.activateWorktree(reserved.worktree.worktreeId);
  const before = fixture.store.listWorktreesForTask(terminal.taskId);

  const result = await migrateLegacyWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: terminal.taskId,
    mode: "complete",
  });
  if (result.ok) throw new Error("expected legacy physical state to block completion");
  assert.equal(result.reason, "legacy-physical-state-present");
  assert.deepEqual(result.proof?.activeWorktreeRowIds, [before[0]!.worktreeId]);
  assert.deepEqual(fixture.store.listWorktreesForTask(terminal.taskId), before);
  assert.equal(fixture.store.getTask(terminal.taskId)?.lifecycleState, "abandoned");
});

test("legacy adopt attaches one proven Nawabari session without mutating legacy physical rows", async (t) => {
  const fixture = legacyTask(t, "adopt");
  const legacyPath = createTempDir(t, "mottainai-legacy-adopt-");
  const branch = "fix/203-adopt";
  runGit(["worktree", "add", "--quiet", "-b", branch, legacyPath], fixture.root);
  t.after(() => {
    try {
      runGit(["worktree", "remove", "--force", legacyPath], fixture.root);
    } catch {
      // Best-effort cleanup for a failed assertion.
    }
  });
  const reserved = fixture.store.reserveWorktree({
    taskId: fixture.task.taskId,
    instanceId: fixture.identity.instanceId,
    branchName: branch,
    canonicalPath: legacyPath,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], fixture.root),
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const worktree = fixture.store.activateWorktree(reserved.worktree.worktreeId);
  const session: NawabariSession = {
    sessionId: "nawabari-session-203",
    repository: fixture.identity.canonicalRepositoryRoot,
    worktree: worktree.canonicalPath,
    branch,
    state: "active",
    raw: { ok: true, command: "session show" },
  };
  const before = fixture.store.listWorktreesForTask(fixture.task.taskId);
  const adopted = await migrateLegacyWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.task.taskId,
    mode: "adopt",
    sessionId: session.sessionId,
    nawabari: fakeNawabari(session),
  });
  if (!adopted.ok) throw new Error(adopted.detail);
  assert.equal(adopted.task.nawabariSessionId, session.sessionId);
  assert.equal(adopted.task.lifecycleState, "active");
  assert.equal(adopted.session?.worktree, worktree.canonicalPath);
  assert.deepEqual(fixture.store.listWorktreesForTask(fixture.task.taskId), before);
});

test("legacy adopt rejects a Nawabari identity mismatch and never attaches the session", async (t) => {
  const fixture = legacyTask(t, "mismatch");
  const legacyPath = createTempDir(t, "mottainai-legacy-mismatch-");
  const branch = "fix/203-mismatch";
  const reserved = fixture.store.reserveWorktree({
    taskId: fixture.task.taskId,
    instanceId: fixture.identity.instanceId,
    branchName: branch,
    canonicalPath: legacyPath,
    baseBranch: "main",
    baseCommit: runGit(["rev-parse", "HEAD"], fixture.root),
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const worktree = fixture.store.activateWorktree(reserved.worktree.worktreeId);
  const result = await migrateLegacyWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.task.taskId,
    mode: "adopt",
    sessionId: "nawabari-session-mismatch",
    nawabari: fakeNawabari({
      sessionId: "nawabari-session-mismatch",
      repository: fixture.identity.canonicalRepositoryRoot,
      worktree: worktree.canonicalPath,
      branch: "fix/other-branch",
      state: "active",
      raw: { ok: true, command: "session show" },
    }),
  });
  if (result.ok) throw new Error("expected Nawabari identity mismatch");
  assert.equal(result.reason, "nawabari-identity-mismatch");
  assert.equal(fixture.store.getTask(fixture.task.taskId)?.nawabariSessionId, undefined);
});
