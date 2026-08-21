import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWorkflowDoctorReport } from "../commands/doctor.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { FAKE_NAWABARI_CAPABILITIES, fakeNawabari } from "../../test-support/nawabari-fixture.js";
import { startNawabariTask } from "./nawabari-task.js";
import { closeNawabariExecution, reconcileNawabariClosures } from "./nawabari-close.js";
import { NawabariExecutionClient, NawabariExecutionError } from "../nawabari.js";
import type { RunResult } from "../../subprocess.js";

function runResult(stdout: string, overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

async function startManaged(
  root: string,
  store: ReturnType<typeof createWorkflowStore>,
  nawabari: NawabariExecutionClient,
  issueRef: string,
  taskSlug: string,
) {
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug,
    branchType: "fix",
    issueRef,
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("managed task fixture setup failed");
  return started;
}

test("workflow doctor default observation cannot persist authoritative provider merge state", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(root, { sessions });
  const started = await startManaged(root, store, nawabari, "378", "doctor-read-only-provider");

  store.recordPullRequest({
    taskId: started.task.taskId,
    instanceId: started.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 381,
    url: "https://github.com/org/repository/pull/381",
    headSha: "owned-head-sha",
    lifecycleState: "open",
  });
  store.updateTaskLifecycleState(started.task.taskId, "pull-request-open");

  await collectWorkflowDoctorReport({
    workspaceRoot: root,
    store,
    dependencies: {
      inspectNawabari: async () => ({ ok: true, command: "doctor" }),
    },
    reconciliation: {
      pullRequestObserver: async (record) => ({
        ok: true,
        lifecycleState: "merged",
        headSha: record.headSha,
        mergeRevision: "authoritative-merge-sha",
      }),
    },
  });

  const providerRecord = store.listPullRequestRecordsForTask(started.task.taskId)[0]!;
  assert.equal(providerRecord.lifecycleState, "open");
  assert.equal(providerRecord.mergeRevision, undefined);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "pull-request-open");
  assert.equal(store.getNawabariCloseReconciliation(started.task.taskId), undefined);
  assert.equal(sessions.get(started.execution.sessionId)?.state, "active");
});

test("interactive maxTasks=1 skips older durable-closed history and closes the newest retained claimant", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const nawabari = fakeNawabari(root, { sessions, calls });

  const older = await startManaged(root, store, nawabari, "101", "older-closed");
  store.recordPullRequest({
    taskId: older.task.taskId,
    instanceId: older.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 101,
    url: "https://github.com/org/repository/pull/101",
    headSha: "older-head",
    lifecycleState: "merged",
  });
  store.updateTaskLifecycleState(older.task.taskId, "merged");
  const olderClosed = await closeNawabariExecution({
    workspaceRoot: root,
    store,
    client: nawabari,
    task: store.getTask(older.task.taskId)!,
    providerRecord: store.listPullRequestRecordsForTask(older.task.taskId)[0]!,
  });
  assert.equal(olderClosed.ok, true, JSON.stringify(olderClosed));
  assert.equal(store.getNawabariCloseReconciliation(older.task.taskId)?.state, "closed");

  const blocker = await startManaged(root, store, nawabari, "102", "newest-blocker");
  store.recordPullRequest({
    taskId: blocker.task.taskId,
    instanceId: blocker.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 102,
    url: "https://github.com/org/repository/pull/102",
    headSha: "blocker-head",
    lifecycleState: "merged",
  });
  store.updateTaskLifecycleState(blocker.task.taskId, "merged");
  assert.equal(sessions.get(blocker.execution.sessionId)?.state, "active");

  calls.length = 0;
  const reconciled = await reconcileNawabariClosures({
    workspaceRoot: root,
    store,
    client: nawabari,
    instanceId: blocker.task.instanceId,
    maxTasks: 1,
    providerObserver: async () => {
      throw new Error("provider observation must not be needed for an already-merged record");
    },
  });

  assert.equal(reconciled.attempted, 1);
  assert.equal(reconciled.closed, 1);
  assert.equal(reconciled.blocked.length, 0);
  assert.equal(sessions.get(blocker.execution.sessionId)?.state, "closed");
  assert.equal(
    calls.filter((args) => args[0] === "session" && args[1] === "close").length,
    1,
    "one interactive close budget must perform exactly one physical close request",
  );
});

test("bounded crash recovery promotes provider-observed integration and closes in one attempt", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(root, { sessions });
  const prior = await startManaged(root, store, nawabari, "373", "crash-before-merge-persist");

  store.recordPullRequest({
    taskId: prior.task.taskId,
    instanceId: prior.task.instanceId,
    provider: "github",
    repositoryId: "org/repository",
    prNumber: 376,
    url: "https://github.com/org/repository/pull/376",
    headSha: "pr-376-head",
    lifecycleState: "open",
  });
  store.updateTaskLifecycleState(prior.task.taskId, "pull-request-open");

  let observations = 0;
  const reconciled = await reconcileNawabariClosures({
    workspaceRoot: root,
    store,
    client: nawabari,
    instanceId: prior.task.instanceId,
    maxTasks: 1,
    providerObserver: async (record) => {
      observations += 1;
      return {
        ok: true,
        lifecycleState: "merged",
        headSha: record.headSha,
        mergeRevision: "merge-376",
      };
    },
  });

  assert.equal(observations, 1);
  assert.equal(reconciled.promoted, 1);
  assert.equal(reconciled.attempted, 1);
  assert.equal(reconciled.closed, 1);
  assert.equal(reconciled.blocked.length, 0);
  assert.equal(store.getTask(prior.task.taskId)?.lifecycleState, "merged");
  assert.equal(store.listPullRequestRecordsForTask(prior.task.taskId)[0]?.mergeRevision, "merge-376");
  assert.equal(sessions.get(prior.execution.sessionId)?.state, "closed");
});

test("session close success envelope is rejected unless the returned session proves state=closed", async () => {
  const sessionId = "session-not-closed";
  const client = new NawabariExecutionClient({
    runner: {
      async run(_command, args) {
        if (args[0] === "capabilities")
          return runResult(
            JSON.stringify({
              ok: true,
              command: "capabilities",
              schema_version: 1,
              contract_id: "nawabari.standalone-execution.v1",
              package_version: "0.5.0",
              capabilities: FAKE_NAWABARI_CAPABILITIES,
            }),
          );
        if (args[0] === "session" && args[1] === "close")
          return runResult(
            JSON.stringify({
              ok: true,
              command: "session close",
              session: {
                schema_version: 1,
                session_id: sessionId,
                repository: "/repo/.git",
                worktree: "/repo/worktree",
                branch: "fix/378-close-contract",
                state: "closing",
                created_at: "2026-08-21T00:00:00Z",
                updated_at: "2026-08-21T00:00:01Z",
              },
              worktree_removed: false,
              branch_removed: false,
              idempotent: false,
            }),
          );
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    },
  });

  await assert.rejects(
    () => client.closeSession({ cwd: "/repo", sessionId }),
    (error: unknown) => {
      assert.ok(error instanceof NawabariExecutionError);
      assert.equal(error.code, "nawabari-contract-invalid");
      assert.match(error.message, /did not prove physical closure/);
      return true;
    },
  );
});
