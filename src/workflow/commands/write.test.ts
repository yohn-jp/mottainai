import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  abandonWorkflowTask,
  cleanupWorkflowTask,
  commitWorkflowTask,
  finishWorkflowTask,
  pushWorkflowTask,
} from "./write.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startTask } from "../domain/task.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { GithubAdapter, type RunProgramFunction } from "../providers/github.js";
import type { RunResult } from "../../subprocess.js";
import { startNawabariTask } from "../domain/nawabari-task.js";
import { NawabariExecutionClient } from "../nawabari.js";

function providerResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

function pullRequestViewJson(input: {
  state: "OPEN" | "CLOSED";
  mergedAt: string | null;
  url: string;
  headName: string;
  headSha: string;
  baseCommit: string;
}): string {
  return JSON.stringify({
    id: "PR_node_40",
    number: 40,
    state: input.state,
    isDraft: false,
    mergedAt: input.mergedAt,
    url: input.url,
    headRefName: input.headName,
    headRefOid: input.headSha,
    baseRefName: "main",
    baseRefOid: input.baseCommit,
    repository: { name: "repository", nameWithOwner: "org/repository" },
  });
}

function githubAdapter(workspaceRoot: string, result: RunResult, calls: string[][] = []): GithubAdapter {
  const execute: RunProgramFunction = async (_program, args) => {
    calls.push(args);
    return result;
  };
  return new GithubAdapter({ workspaceRoot, runProgram: execute, sleep: async () => undefined });
}

async function finishFixture(t: TestContext) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "finish-provider-state",
    branchType: "fix",
    issueRef: "40",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) throw new Error("task fixture setup failed");
  const worktree = started.worktree;
  const headSha = runGit(["rev-parse", "HEAD"], worktree.canonicalPath);
  const url = "https://github.com/org/repository/pull/40";
  store.recordPullRequest({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 40,
    url,
    headSha,
    lifecycleState: "open",
  });
  store.updateTaskLifecycleState(started.task.taskId, "pull-request-open");
  return { root, store, taskId: started.task.taskId, worktree, headSha, url, baseCommit: started.task.baseCommit };
}

test("commit dry-run returns the domain verification plan without changing Git or lifecycle state", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "write-dry-run",
    branchType: "fix",
    issueRef: "40",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) return;
  fs.appendFileSync(path.join(started.worktree.canonicalPath, "file.txt"), "planned\n");
  const before = runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath);
  const result = await commitWorkflowTask({
    workspaceRoot: started.worktree.canonicalPath,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "planned workflow commit" },
    dryRun: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.dryRun, true);
    assert.equal((result.plan as { operation: string }).operation, "commit");
  }
  assert.equal(runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath), before);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "active");
});

test("managed commit delegates the only Git mutation to Nawabari", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "nawabari-commit",
    branchType: "fix",
    issueRef: "41",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "delegated\n");

  const result = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "delegated workflow commit" },
    nawabari,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "committed");
  if (result.ok)
    assert.equal(
      (result.commit as { commitId?: string }).commitId,
      runGit(["rev-parse", "HEAD"], started.execution.worktree),
      "the mutation identity must come from Nawabari's governed commit result",
    );
  assert.equal(
    store.getHookCheckpoint(started.task.instanceId, started.execution.branch)?.lastCheckedCommit,
    runGit(["rev-parse", "HEAD"], started.execution.worktree),
    "Git-observable Nawabari checkpoint evidence must reconcile into Mottainai state",
  );
  assert.notEqual(runGit(["rev-parse", "HEAD"], started.execution.worktree), runGit(["rev-parse", "HEAD"], root));
});

test("legacy task rows cannot fall back to the retired Mottainai commit executor", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "legacy-no-fallback",
    branchType: "fix",
    issueRef: "42",
  });
  assert.equal(started.ok, true);
  if (!started.ok || started.worktree === undefined) return;
  fs.appendFileSync(path.join(started.worktree.canonicalPath, "file.txt"), "must not mutate\n");
  const before = runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath);
  const result = await commitWorkflowTask({
    workspaceRoot: started.worktree.canonicalPath,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "legacy fallback" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "legacy-task-adoption-required");
  assert.equal(runGit(["rev-parse", "HEAD"], started.worktree.canonicalPath), before);
});

test("managed push delegates target and divergence safety to Nawabari", async (t) => {
  const root = createTempGitRepo(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-nawabari-remote-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  runGit(["init", "--bare", "--quiet"], remote);
  runGit(["remote", "add", "origin", remote], root);

  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "nawabari-push",
    branchType: "fix",
    issueRef: "43",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );
  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "pushed\n");
  const committed = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "delegated workflow push" },
    nawabari,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = await pushWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    remote: "origin",
    createUpstream: true,
    nawabari,
  });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(
    runGit(["--git-dir", remote, "rev-parse", "refs/heads/fix/43-nawabari-push"], root),
    runGit(["rev-parse", "HEAD"], started.execution.worktree),
  );
});

test("Nawabari task start idempotency reuses the exact task and external session", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const input = {
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "retryable-start",
    branchType: "fix",
    issueRef: "40",
    idempotencyKey: "start-write-test",
    nawabari,
  } as const;
  const first = await startNawabariTask(input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const repeated = await startNawabariTask(input);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  if (repeated.ok) {
    assert.equal(repeated.reused, true);
    assert.equal(repeated.task.taskId, first.task.taskId);
    assert.equal(repeated.execution.sessionId, first.execution.sessionId);
    assert.equal(repeated.execution.worktree, first.execution.worktree);
  }
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listWorktrees().length, 0, "Mottainai must not reserve an external worktree locally");
});

test("cleanup idempotency key reuses the same cleanup operation without a second deletion", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS["strict-worktree"],
    taskSlug: "write-cleanup",
    branchType: "fix",
    issueRef: "40",
    nawabari,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const worktreePath = started.execution.worktree;
  store.updateTaskLifecycleState(started.task.taskId, "abandoned");
  const preview = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    nawabari,
    dryRun: true,
    idempotencyKey: "cleanup-write-preview",
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  if (preview.ok) assert.equal(preview.dryRun, true);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "abandoned");
  assert.equal(fs.existsSync(worktreePath), true);

  const first = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    nawabari,
    idempotencyKey: "cleanup-write-test",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "cleaned");
  assert.equal(fs.existsSync(worktreePath), false);

  const repeated = await cleanupWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS["strict-worktree"],
    nawabari,
    idempotencyKey: "cleanup-write-test",
  });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  if (repeated.ok) assert.equal(repeated.execution?.status, "already-completed");
});

test("finish refuses an open provider pull request", async (t) => {
  const fixture = await finishFixture(t);
  const result = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult(
          pullRequestViewJson({
            state: "OPEN",
            mergedAt: null,
            url: fixture.url,
            headName: fixture.worktree.branchName,
            headSha: fixture.headSha,
            baseCommit: fixture.baseCommit,
          }),
        ),
      ),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider-not-merged");
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pull-request-open");
  assert.equal(fixture.store.listPullRequestRecordsForTask(fixture.taskId)[0]?.lifecycleState, "open");
});

test("finish refuses a closed-but-unmerged provider pull request", async (t) => {
  const fixture = await finishFixture(t);
  const result = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult(
          pullRequestViewJson({
            state: "CLOSED",
            mergedAt: null,
            url: fixture.url,
            headName: fixture.worktree.branchName,
            headSha: fixture.headSha,
            baseCommit: fixture.baseCommit,
          }),
        ),
      ),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider-not-merged");
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pull-request-open");
});

test("finish marks the task merged only after an identity- and head-matching merged observation", async (t) => {
  const fixture = await finishFixture(t);
  const result = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult(
          pullRequestViewJson({
            state: "CLOSED",
            mergedAt: "2026-08-10T12:00:00Z",
            url: fixture.url,
            headName: fixture.worktree.branchName,
            headSha: fixture.headSha,
            baseCommit: fixture.baseCommit,
          }),
        ),
      ),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "merged");
  assert.equal(fixture.store.listPullRequestRecordsForTask(fixture.taskId)[0]?.lifecycleState, "merged");
});

test("finish fails closed when the provider is unavailable", async (t) => {
  const fixture = await finishFixture(t);
  const result = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult("", "authentication failed", { exitCode: 1 }),
      ),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider-state-unavailable");
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pull-request-open");
});

test("finish fails closed when the observed provider head does not match the persisted PR record", async (t) => {
  const fixture = await finishFixture(t);
  const result = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult(
          pullRequestViewJson({
            state: "CLOSED",
            mergedAt: "2026-08-10T12:00:00Z",
            url: fixture.url,
            headName: fixture.worktree.branchName,
            headSha: "different-head",
            baseCommit: fixture.baseCommit,
          }),
        ),
      ),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider-state-mismatch");
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pull-request-open");
});

test("finish retry returns the persisted merged state without re-observing the provider", async (t) => {
  const fixture = await finishFixture(t);
  const first = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    {
      githubAdapter: githubAdapter(
        fixture.worktree.canonicalPath,
        providerResult(
          pullRequestViewJson({
            state: "CLOSED",
            mergedAt: "2026-08-10T12:00:00Z",
            url: fixture.url,
            headName: fixture.worktree.branchName,
            headSha: fixture.headSha,
            baseCommit: fixture.baseCommit,
          }),
        ),
      ),
    },
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  const calls: string[][] = [];
  const repeated = await finishWorkflowTask(
    {
      workspaceRoot: fixture.worktree.canonicalPath,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
    },
    { githubAdapter: githubAdapter(fixture.worktree.canonicalPath, providerResult("unexpected"), calls) },
  );
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(calls.length, 0);
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "merged");
});

test("abandon retry returns the persisted abandoned state", async (t) => {
  const fixture = await finishFixture(t);
  const input = {
    workspaceRoot: fixture.worktree.canonicalPath,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
  };
  const first = await abandonWorkflowTask(input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const repeated = await abandonWorkflowTask(input);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "abandoned");
});
