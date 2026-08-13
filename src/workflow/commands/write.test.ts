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
import { resolveRepositoryIdentity } from "../domain/identity.js";
import { buildWorktreeNaming } from "../git/worktree.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";

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

const FAKE_NAWABARI_COMMANDS = [
  "session create",
  "session id",
  "session show",
  "session list",
  "session claim",
  "session claims",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

function fakeNawabari(
  repositoryRoot: string,
  options: { repository?: string; calls?: string[][]; sessions?: Map<string, Record<string, unknown>> } = {},
): NawabariExecutionClient {
  const calls = options.calls ?? [];
  const sessions = options.sessions ?? new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const claims = new Map<string, Record<string, unknown>[]>();
  return new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities")
          return providerResult(
            JSON.stringify({
              ok: true,
              command: "capabilities",
              schema_version: 1,
              contract_id: "nawabari.standalone-execution.v1",
              package_version: "0.2.0",
              capabilities: [{ commands: FAKE_NAWABARI_COMMANDS }],
            }),
          );
        if (args[0] === "session" && args[1] === "id")
          return providerResult(
            JSON.stringify({ ok: false, command: "session id", code: "NO_SESSION", message: "none" }),
            "",
            {
              exitCode: 3,
            },
          );
        if (args[0] === "session" && args[1] === "create") {
          const sessionId = `fake-session-${++sequence}`;
          const branch = args[args.indexOf("--branch") + 1]!;
          const labelIndex = args.indexOf("--label");
          const label = labelIndex < 0 ? undefined : args[labelIndex + 1];
          const session = {
            ok: true,
            command: "session create",
            session_id: sessionId,
            repository: options.repository ?? path.join(repositoryRoot, ".git"),
            worktree: path.join(repositoryRoot, `.fake-worktree-${sessionId}`),
            branch,
            state: "active",
            ...(label === undefined ? {} : { label }),
          };
          sessions.set(sessionId, session);
          claims.set(sessionId, []);
          return providerResult(JSON.stringify(session));
        }
        if (args[0] === "session" && args[1] === "list")
          return providerResult(
            JSON.stringify({ ok: true, command: "session list", sessions: [...sessions.values()] }),
          );
        if (args[0] === "session" && args[1] === "show") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const session = sessions.get(sessionId);
          if (session === undefined)
            return providerResult(
              JSON.stringify({ ok: false, command: "session show", code: "NOT_FOUND", message: "missing" }),
              "",
              {
                exitCode: 3,
              },
            );
          return providerResult(JSON.stringify(session));
        }
        if (args[0] === "session" && args[1] === "claims") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          return providerResult(
            JSON.stringify({ ok: true, command: "session claims", claims: claims.get(sessionId) ?? [] }),
          );
        }
        if (args[0] === "session" && args[1] === "claim") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const resource = args[args.indexOf("--resource") + 1]!;
          const mode = args[args.indexOf("--mode") + 1]!;
          const claim = { resource, mode };
          claims.get(sessionId)?.push(claim);
          return providerResult(
            JSON.stringify({ ok: true, command: "session claim", session_id: sessionId, ...claim }),
          );
        }
        if (args[0] === "session" && args[1] === "close") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const session = sessions.get(sessionId);
          if (session !== undefined) session.state = "closed";
          return providerResult(
            JSON.stringify({ ok: true, command: "session close", session_id: sessionId, state: "closed" }),
          );
        }
        throw new Error(`unexpected fake Nawabari command: ${args.join(" ")}`);
      },
    },
  });
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
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );
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
  t.after(() =>
    nawabari
      .closeSession({ cwd: first.execution.worktree, sessionId: first.execution.sessionId })
      .catch(() => undefined),
  );
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

for (const point of ["after-session-created", "after-attachment-persistence", "after-lifecycle-activation"] as const) {
  test(`task-start compensation after ${point} never leaves a normal active task`, async (t) => {
    const root = createTempGitRepo(t);
    const store = createWorkflowStore(t);
    const calls: string[][] = [];
    const sessions = new Map<string, Record<string, unknown>>();
    const nawabari = fakeNawabari(root, { calls, sessions });
    const result = await startNawabariTask({
      workspaceRoot: root,
      store,
      policy: BUILTIN_PRESETS.standard,
      taskSlug: `fault-${point.replaceAll("-", "-")}`,
      branchType: "fix",
      issueRef: "193",
      idempotencyKey: `fault-${point}`,
      nawabari,
      faultInjection: (observed) => {
        if (observed === point) throw new Error(`injected ${point}`);
      },
    });
    assert.equal(result.ok, false);
    const task = store.listTasks()[0];
    if (point === "after-lifecycle-activation") {
      assert.notEqual(task, undefined);
      assert.equal(task?.lifecycleState, "abandoned");
      assert.equal(store.getTaskStartReconciliation(task!.taskId)?.state, "abandoned");
    } else {
      assert.equal(task, undefined, "planned task-start reservations are safely rolled back after owned close");
    }
    assert.equal([...sessions.values()].filter((session) => session.state === "active").length, 0);
    assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 1);
    assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 1);
  });
}

test("task-start restart/retry adopts the durably recorded session without creating a duplicate", async (t) => {
  const root = createTempGitRepo(t);
  const dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-task-start-restart-"));
  t.after(() => fs.rmSync(dbDirectory, { recursive: true, force: true }));
  const dbPath = path.join(dbDirectory, "workflow.sqlite");
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  const baseCommit = runGit(["rev-parse", "main"], root);
  const taskSlug = "restart-retry";
  const issueRef = "193-restart";
  const branch = buildWorktreeNaming({ branchType: "fix", issueRef, taskSlug }).branchName;
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "persisted-session-1",
      {
        ok: true,
        command: "session show",
        session_id: "persisted-session-1",
        repository: identity.identity.gitCommonDir,
        worktree: path.join(root, ".fake-restart-worktree"),
        branch,
        state: "active",
        label: "placeholder",
      },
    ],
  ]);
  const firstStore = new WorkflowSqliteStateStore({ dbPath });
  firstStore.init();
  firstStore.observeRepositoryInstance({
    rootCommitDigest: identity.identity.rootCommitDigest,
    instanceId: identity.identity.instanceId,
    gitCommonDir: identity.identity.gitCommonDir,
    canonicalWorktreePath: identity.identity.worktreePath,
  });
  const reserved = firstStore.reserveTask({
    instanceId: identity.identity.instanceId,
    taskSlug,
    issueRef,
    startIdempotencyKey: "restart-retry-key",
    baseBranch: "main",
    baseCommit,
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const taskLabel = `mottainai-task-${reserved.task.taskId}`;
  const reconciliation = firstStore.beginTaskStartReconciliation({
    taskId: reserved.task.taskId,
    instanceId: identity.identity.instanceId,
    taskLabel,
    branchName: branch,
    baseBranch: "main",
    baseCommit,
  });
  sessions.get("persisted-session-1")!.label = taskLabel;
  firstStore.recordTaskStartSession(reserved.task.taskId, "persisted-session-1" as never);
  assert.equal(reconciliation.state, "reserved");
  firstStore.close();

  const calls: string[][] = [];
  const secondStore = new WorkflowSqliteStateStore({ dbPath });
  secondStore.init();
  const retried = await startNawabariTask({
    workspaceRoot: root,
    store: secondStore,
    policy: BUILTIN_PRESETS.standard,
    taskSlug,
    branchType: "fix",
    issueRef,
    idempotencyKey: "restart-retry-key",
    nawabari: fakeNawabari(root, { calls, sessions }),
  });
  t.after(() => secondStore.close());
  assert.equal(retried.ok, true, JSON.stringify(retried));
  if (!retried.ok) return;
  assert.equal(retried.task.taskId, reserved.task.taskId);
  assert.equal(retried.execution.sessionId, "persisted-session-1");
  assert.equal(secondStore.getTask(reserved.task.taskId)?.lifecycleState, "active");
  assert.equal(secondStore.getTaskStartReconciliation(reserved.task.taskId)?.state, "active");
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 0);
});

test("task-start refuses to adopt or close a session whose repository identity is ambiguous", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const calls: string[][] = [];
  const result = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "ownership-mismatch",
    branchType: "fix",
    issueRef: "193-mismatch",
    idempotencyKey: "ownership-mismatch-key",
    nawabari: fakeNawabari(root, { calls, repository: path.join(root, "not-the-repository.git") }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "nawabari-ownership-ambiguous");
  const task = store.listTasks()[0];
  assert.equal(task?.lifecycleState, "orphaned");
  assert.equal(store.getTaskStartReconciliation(task!.taskId)?.state, "orphaned");
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 0);
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
