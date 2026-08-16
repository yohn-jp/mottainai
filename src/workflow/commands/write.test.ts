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
import { runProgram, type RunResult } from "../../subprocess.js";
import { startNawabariTask } from "../domain/nawabari-task.js";
import { NawabariExecutionClient, type NawabariPushResult } from "../nawabari.js";
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
  "session release",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

function fakeNawabari(
  repositoryRoot: string,
  options: {
    repository?: string;
    calls?: string[][];
    sessions?: Map<string, Record<string, unknown>>;
    currentSessionId?: string;
    failSessionList?: boolean;
    failSessionClaim?: boolean;
    beforeSessionClose?: () => void;
  } = {},
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
          return options.currentSessionId === undefined
            ? providerResult(
                JSON.stringify({ ok: false, command: "session id", code: "NO_SESSION", message: "none" }),
                "",
                {
                  exitCode: 3,
                },
              )
            : providerResult(JSON.stringify({ ok: true, command: "session id", session_id: options.currentSessionId }));
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
        if (args[0] === "session" && args[1] === "list") {
          if (options.failSessionList)
            return providerResult(
              JSON.stringify({ ok: false, command: "session list", code: "TEMPORARY_FAILURE", message: "unavailable" }),
              "",
              { exitCode: 3 },
            );
          return providerResult(
            JSON.stringify({ ok: true, command: "session list", sessions: [...sessions.values()] }),
          );
        }
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
          if (options.failSessionClaim)
            return providerResult(
              JSON.stringify({ ok: false, command: "session claim", code: "CLAIM_FAILED", message: "injected" }),
              "",
              { exitCode: 3 },
            );
          const claim = { resource, mode };
          claims.get(sessionId)?.push(claim);
          return providerResult(
            JSON.stringify({ ok: true, command: "session claim", session_id: sessionId, ...claim }),
          );
        }
        if (args[0] === "session" && args[1] === "close") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          options.beforeSessionClose?.();
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

async function canonicalNawabariFixture(t: TestContext) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-226-worktree-"));
  const worktree = path.join(worktreeParent, "canonical");
  const branch = "fix/226-canonical-worktree-task-resolution";
  runGit(["worktree", "add", "--quiet", "-b", branch, worktree, "HEAD"], root);
  t.after(() => {
    if (fs.existsSync(root)) runGit(["worktree", "remove", "--force", worktree], root);
    fs.rmSync(worktreeParent, { recursive: true, force: true });
  });

  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(root, { sessions, currentSessionId: "fake-session-1" });
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "canonical-worktree-task-resolution",
    branchType: "fix",
    issueRef: "226",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("canonical worktree fixture setup failed");
  const session = sessions.get(started.execution.sessionId);
  assert.notEqual(session, undefined);
  session!.worktree = worktree;
  assert.equal(store.listWorktrees().length, 0, "Nawabari owns the physical worktree without a local worktree row");
  return { root, store, nawabari, task: started.task, worktree };
}

type CommitFaultPoint = "result-persistence" | "checkpoint-persistence" | "lifecycle-transition";

class FaultingCommitStore extends WorkflowSqliteStateStore {
  private fault: CommitFaultPoint | undefined;

  armCommitFault(point: CommitFaultPoint): void {
    this.fault = point;
  }

  override recordCommitResult(...args: Parameters<WorkflowSqliteStateStore["recordCommitResult"]>) {
    if (this.fault === "result-persistence") {
      this.fault = undefined;
      throw new Error("injected commit result persistence failure");
    }
    return super.recordCommitResult(...args);
  }

  override recordHookCheckpoint(...args: Parameters<WorkflowSqliteStateStore["recordHookCheckpoint"]>) {
    if (this.fault === "checkpoint-persistence") {
      this.fault = undefined;
      throw new Error("injected checkpoint persistence failure");
    }
    return super.recordHookCheckpoint(...args);
  }

  override updateTaskLifecycleState(...args: Parameters<WorkflowSqliteStateStore["updateTaskLifecycleState"]>) {
    if (this.fault === "lifecycle-transition") {
      this.fault = undefined;
      throw new Error("injected lifecycle transition failure");
    }
    return super.updateTaskLifecycleState(...args);
  }
}

function commitBoundaryNawabari(
  repositoryRoot: string,
  worktree: string,
  branch: string,
  options: {
    failCheckpointOnce?: boolean;
    denyAuthorizationAfterCommit?: boolean;
    /** First authorize denies with INSUFFICIENT_CLAIM_MODE; escalation must retry once. */
    insufficientClaimOnce?: boolean;
    /** Even after the exclusive-write escalation, authorize keeps denying (a different reason). */
    denyAfterEscalation?: boolean;
    /** The claim call that restores the pre-escalation read claim fails. */
    failClaimRestore?: boolean;
  } = {},
): {
  client: NawabariExecutionClient;
  commitCalls: () => number;
  authorizeCalls: () => number;
  claims: () => { resource: string; mode: string }[];
} {
  const sessionId = "commit-boundary-session";
  let commitCalls = 0;
  let checkpointCalls = 0;
  let authorizeCalls = 0;
  let claims: { resource: string; mode: string }[] = [{ resource: "**", mode: "read" }];
  return {
    client: new NawabariExecutionClient({
      runner: {
        async run(_command, args, cwd): Promise<RunResult> {
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
              JSON.stringify({ ok: false, command: "session id", code: "NO_CURRENT_SESSION", message: "none" }),
              "",
              { exitCode: 3 },
            );
          if (args[0] === "session" && args[1] === "show")
            return providerResult(
              JSON.stringify({
                ok: true,
                command: "session show",
                session_id: sessionId,
                repository: path.join(repositoryRoot, ".git"),
                worktree,
                branch,
                state: "active",
              }),
            );
          if (args[0] === "session" && args[1] === "claims")
            return providerResult(JSON.stringify({ ok: true, command: "session claims", claims }));
          if (args[0] === "session" && args[1] === "release") {
            claims = [];
            return providerResult(
              JSON.stringify({ ok: true, command: "session release", session_id: sessionId, released: [] }),
            );
          }
          if (args[0] === "session" && args[1] === "claim") {
            const resource = args[args.indexOf("--resource") + 1]!;
            const mode = args[args.indexOf("--mode") + 1]!;
            if (options.failClaimRestore === true && mode === "read")
              return providerResult(
                JSON.stringify({ ok: false, command: "session claim", code: "CLAIM_FAILED", message: "injected" }),
                "",
                { exitCode: 3 },
              );
            claims.push({ resource, mode });
            return providerResult(
              JSON.stringify({ ok: true, command: "session claim", session_id: sessionId, resource, mode }),
            );
          }
          if (args[0] === "authorize") {
            authorizeCalls += 1;
            if (options.insufficientClaimOnce === true && authorizeCalls === 1)
              return providerResult(
                JSON.stringify({
                  ok: true,
                  command: "authorize",
                  allowed: false,
                  code: "INSUFFICIENT_CLAIM_MODE",
                  session_id: sessionId,
                }),
              );
            const hasExclusiveWrite = claims.some((claim) => claim.mode === "exclusive-write");
            if (options.denyAfterEscalation === true && hasExclusiveWrite)
              return providerResult(
                JSON.stringify({
                  ok: true,
                  command: "authorize",
                  allowed: false,
                  code: "SOME_OTHER_DENIAL",
                  session_id: sessionId,
                }),
              );
            return providerResult(
              JSON.stringify({
                ok: true,
                command: "authorize",
                allowed: !(options.denyAuthorizationAfterCommit === true && commitCalls > 0),
                session_id: sessionId,
              }),
            );
          }
          if (args[0] === "commit") {
            commitCalls += 1;
            const message = args[args.indexOf("--message") + 1]!;
            runGit(["commit", "--quiet", "-am", message], cwd);
            return providerResult(
              JSON.stringify({
                ok: true,
                command: "commit",
                session_id: sessionId,
                commit_sha: runGit(["rev-parse", "HEAD"], cwd),
              }),
            );
          }
          if (args[0] === "checkpoint") {
            checkpointCalls += 1;
            if (options.failCheckpointOnce && checkpointCalls === 1)
              return providerResult(
                JSON.stringify({ ok: false, command: "checkpoint", code: "CHECKPOINT_FAILED", message: "injected" }),
                "",
                { exitCode: 3 },
              );
            return providerResult(
              JSON.stringify({
                ok: true,
                command: "checkpoint",
                session_id: sessionId,
                head_id: runGit(["rev-parse", "HEAD"], cwd),
                paths: { changed: [], staged: [], unstaged: [], untracked: [] },
                in_claim: [],
                out_of_claim: [],
              }),
            );
          }
          throw new Error(`unexpected fake commit-boundary command: ${args.join(" ")}`);
        },
      },
    }),
    commitCalls: () => commitCalls,
    authorizeCalls: () => authorizeCalls,
    claims: () => claims,
  };
}

async function commitRecoveryFixture(
  t: TestContext,
  fault: CommitFaultPoint,
  options: { denyAuthorizationAfterCommit?: boolean } = {},
): Promise<{
  root: string;
  dbPath: string;
  store: FaultingCommitStore;
  taskId: string;
  nawabari: NawabariExecutionClient;
  commitCalls: () => number;
  worktree: string;
}> {
  const root = createTempGitRepo(t);
  const dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-commit-recovery-"));
  t.after(() => fs.rmSync(dbDirectory, { recursive: true, force: true }));
  const dbPath = path.join(dbDirectory, "workflow.sqlite");
  const store = new FaultingCommitStore({ dbPath });
  store.init();
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: `commit-recovery-${fault}`,
    branchType: "fix",
    issueRef: "194",
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok || started.worktree === undefined) throw new Error("commit recovery fixture setup failed");
  const sessionId = "commit-boundary-session" as never;
  store.attachNawabariSession(started.task.taskId, sessionId);
  fs.appendFileSync(path.join(started.worktree.canonicalPath, "file.txt"), `${fault}\n`);
  const boundary = commitBoundaryNawabari(root, started.worktree.canonicalPath, started.worktree.branchName, {
    failCheckpointOnce: false,
    denyAuthorizationAfterCommit: options.denyAuthorizationAfterCommit,
  });
  store.armCommitFault(fault);
  t.after(() => store.close());
  return {
    root,
    dbPath,
    store,
    taskId: started.task.taskId,
    nawabari: boundary.client,
    commitCalls: boundary.commitCalls,
    worktree: started.worktree.canonicalPath,
  };
}

async function claimEscalationFixture(
  t: TestContext,
  options: { insufficientClaimOnce?: boolean; denyAfterEscalation?: boolean; failClaimRestore?: boolean } = {},
): Promise<{
  root: string;
  store: WorkflowSqliteStateStore;
  taskId: string;
  nawabari: NawabariExecutionClient;
  authorizeCalls: () => number;
  claims: () => { resource: string; mode: string }[];
}> {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "commit-claim-escalation",
    branchType: "fix",
    issueRef: "334",
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok || started.worktree === undefined) throw new Error("claim escalation fixture setup failed");
  const sessionId = "commit-boundary-session" as never;
  store.attachNawabariSession(started.task.taskId, sessionId);
  fs.appendFileSync(path.join(started.worktree.canonicalPath, "file.txt"), "claim escalation\n");
  const boundary = commitBoundaryNawabari(root, started.worktree.canonicalPath, started.worktree.branchName, {
    insufficientClaimOnce: options.insufficientClaimOnce,
    denyAfterEscalation: options.denyAfterEscalation,
    failClaimRestore: options.failClaimRestore,
  });
  return {
    root,
    store,
    taskId: started.task.taskId,
    nawabari: boundary.client,
    authorizeCalls: boundary.authorizeCalls,
    claims: boundary.claims,
  };
}

test("commit escalates an insufficient read claim to exclusive-write and retries authorization once", async (t) => {
  const fixture = await claimEscalationFixture(t, { insufficientClaimOnce: true });
  const result = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "escalate then commit" },
    nawabari: fixture.nawabari,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  // 1: initial denial, 2: retry after escalation (succeeds), 3: the
  // post-commit reconciliation check inside reconcileKnownCommit.
  assert.equal(fixture.authorizeCalls(), 3, "must retry authorization exactly once after escalation");
  assert.deepEqual(fixture.claims(), [{ resource: "**", mode: "exclusive-write" }]);
});

test("commit restores the prior read claim when the retried authorization is still denied", async (t) => {
  const fixture = await claimEscalationFixture(t, { insufficientClaimOnce: true, denyAfterEscalation: true });
  const result = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "escalate then deny" },
    nawabari: fixture.nawabari,
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.reason, "nawabari-rejected");
  assert.deepEqual(
    fixture.claims(),
    [{ resource: "**", mode: "read" }],
    "a denied retry must restore the pre-escalation claim",
  );
});

test("commit fails closed with a distinct error when claim restoration fails after a denied retry", async (t) => {
  const fixture = await claimEscalationFixture(t, {
    insufficientClaimOnce: true,
    denyAfterEscalation: true,
    failClaimRestore: true,
  });
  const result = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "escalate then fail restore" },
    nawabari: fixture.nawabari,
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) {
    assert.notEqual(result.reason, "nawabari-rejected");
    assert.match(result.detail, /restoring the session's prior claim set also failed/u);
  }
});

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

test("#226 resolves cleanup and abandon from the canonical Nawabari worktree and rejects a conflicting task id", async (t) => {
  const fixture = await canonicalNawabariFixture(t);
  const abandonedPreview = await abandonWorkflowTask({
    workspaceRoot: fixture.worktree,
    store: fixture.store,
    policy: BUILTIN_PRESETS.standard,
    nawabari: fixture.nawabari,
    dryRun: true,
  });
  assert.equal(abandonedPreview.ok, true, JSON.stringify(abandonedPreview));
  if (abandonedPreview.ok) assert.equal(abandonedPreview.taskId, fixture.task.taskId);

  fixture.store.updateTaskLifecycleState(fixture.task.taskId, "abandoned");
  const cleanupPreview = await cleanupWorkflowTask({
    workspaceRoot: fixture.worktree,
    store: fixture.store,
    policy: BUILTIN_PRESETS.standard,
    nawabari: fixture.nawabari,
    dryRun: true,
  });
  assert.equal(cleanupPreview.ok, true, JSON.stringify(cleanupPreview));
  if (cleanupPreview.ok) {
    assert.equal("taskId" in cleanupPreview.plan, true);
    if ("taskId" in cleanupPreview.plan) assert.equal(cleanupPreview.plan.taskId, fixture.task.taskId);
  }

  const explicit = await abandonWorkflowTask({
    workspaceRoot: fixture.worktree,
    store: fixture.store,
    taskId: fixture.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    nawabari: fixture.nawabari,
    dryRun: true,
  });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));

  const other = await startTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "conflicting-task",
    branchType: "fix",
    issueRef: "227",
  });
  assert.equal(other.ok, true, JSON.stringify(other));
  if (!other.ok) return;
  const conflicting = await abandonWorkflowTask({
    workspaceRoot: fixture.worktree,
    store: fixture.store,
    taskId: other.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    nawabari: fixture.nawabari,
    dryRun: true,
  });
  assert.equal(conflicting.ok, false, JSON.stringify(conflicting));
  if (!conflicting.ok) assert.equal(conflicting.reason, "task-identity-ambiguous");
});

test("#226 keeps explicit task IDs usable from the primary checkout but fails implicit resolution in unowned worktrees", async (t) => {
  const fixture = await canonicalNawabariFixture(t);
  const primaryNawabari = fakeNawabari(fixture.root, {
    sessions: new Map([
      [
        fixture.task.nawabariSessionId!,
        {
          ok: true,
          command: "session show",
          session_id: fixture.task.nawabariSessionId!,
          repository: path.join(fixture.root, ".git"),
          worktree: fixture.worktree,
          branch: "fix/226-canonical-worktree-task-resolution",
          state: "active",
        },
      ],
    ]),
  });
  const primaryExplicit = await abandonWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    nawabari: primaryNawabari,
    dryRun: true,
  });
  assert.equal(primaryExplicit.ok, true, JSON.stringify(primaryExplicit));

  const primaryImplicit = await abandonWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    policy: BUILTIN_PRESETS.standard,
    nawabari: primaryNawabari,
    dryRun: true,
  });
  assert.equal(primaryImplicit.ok, false, JSON.stringify(primaryImplicit));
  if (!primaryImplicit.ok) {
    assert.equal(primaryImplicit.reason, "task-identity-ambiguous");
    assert.equal(primaryImplicit.detail, "no active workflow task is associated with the current worktree");
  }

  const unrelatedParent = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-226-unrelated-"));
  const unrelated = path.join(unrelatedParent, "worktree");
  runGit(["worktree", "add", "--quiet", "-b", "fix/226-unrelated", unrelated, "HEAD"], fixture.root);
  t.after(() => {
    if (fs.existsSync(fixture.root)) runGit(["worktree", "remove", "--force", unrelated], fixture.root);
    fs.rmSync(unrelatedParent, { recursive: true, force: true });
  });
  const unrelatedResult = await abandonWorkflowTask({
    workspaceRoot: unrelated,
    store: fixture.store,
    policy: BUILTIN_PRESETS.standard,
    nawabari: primaryNawabari,
    dryRun: true,
  });
  assert.equal(unrelatedResult.ok, false, JSON.stringify(unrelatedResult));
  if (!unrelatedResult.ok) {
    assert.equal(unrelatedResult.reason, "task-identity-ambiguous");
    assert.equal(unrelatedResult.detail, "no active workflow task is associated with the current worktree");
  }
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

test("managed commit follows Nawabari when the legacy staging verifier disagrees", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "nawabari-shadow-disagreement",
    branchType: "fix",
    issueRef: "202",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );

  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "shadow disagreement\n");
  const policy = { ...BUILTIN_PRESETS.standard, stagingMode: "already-staged-only" as const };
  const result = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy,
    message: { subject: "follow Nawabari authorization" },
    includePaths: ["file.txt"],
    nawabari,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    const commit = result.commit as { shadow: Record<string, unknown> };
    assert.deepEqual(commit.shadow, {
      legacyDecision: "deny",
      nawabariDecision: "allow",
      agreement: false,
    });
  }
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "committed");
  assert.equal(runGit(["status", "--porcelain"], started.execution.worktree), "");
});

test("managed mutation fails closed without its Nawabari companion", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const nawabari = new NawabariExecutionClient();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "nawabari-companion-required",
    branchType: "fix",
    issueRef: "202",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );

  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "companion required\n");
  const before = runGit(["rev-parse", "HEAD"], started.execution.worktree);
  const result = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "must not use legacy executor" },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.reason, "nawabari-unavailable");
  assert.equal(runGit(["rev-parse", "HEAD"], started.execution.worktree), before);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "active");
});

for (const fault of ["checkpoint-persistence", "lifecycle-transition"] as const) {
  test(`commit recovery converges after ${fault} without a second commit`, async (t) => {
    const fixture = await commitRecoveryFixture(t, fault);
    const first = await commitWorkflowTask({
      workspaceRoot: fixture.root,
      store: fixture.store,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
      message: { subject: `commit recovery ${fault}` },
      nawabari: fixture.nawabari,
    });
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(fixture.commitCalls(), 1);
    assert.equal(fixture.store.getTask(fixture.taskId as never)?.lifecycleState, "active");
    fixture.store.close();

    const recoveredStore = new WorkflowSqliteStateStore({ dbPath: fixture.dbPath });
    recoveredStore.init();
    t.after(() => recoveredStore.close());
    const recovered = await commitWorkflowTask({
      workspaceRoot: fixture.root,
      store: recoveredStore,
      taskId: fixture.taskId,
      policy: BUILTIN_PRESETS.standard,
      message: { subject: `commit recovery ${fault}` },
      nawabari: fixture.nawabari,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(fixture.commitCalls(), 1, "recovery must not invoke Nawabari commit again");
    assert.equal(recoveredStore.getTask(fixture.taskId as never)?.lifecycleState, "committed");
    assert.equal(runGit(["status", "--porcelain"], fixture.worktree), "");
    assert.equal(
      recoveredStore.getCommitReconciliation(fixture.taskId as never)?.commitSha,
      runGit(["rev-parse", "HEAD"], fixture.worktree),
    );
    assert.equal(recoveredStore.getCommitReconciliation(fixture.taskId as never)?.state, "reconciled");
  });
}

test("commit recovery fails closed when the persisted resources are no longer authorized", async (t) => {
  const fixture = await commitRecoveryFixture(t, "checkpoint-persistence", { denyAuthorizationAfterCommit: true });
  const first = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "commit recovery resource authorization" },
    nawabari: fixture.nawabari,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(fixture.commitCalls(), 1);
  fixture.store.close();

  const recoveredStore = new WorkflowSqliteStateStore({ dbPath: fixture.dbPath });
  recoveredStore.init();
  t.after(() => recoveredStore.close());
  const retry = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: recoveredStore,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "commit recovery resource authorization" },
    nawabari: fixture.nawabari,
  });
  assert.equal(retry.ok, false, JSON.stringify(retry));
  if (!retry.ok) assert.equal(retry.reason, "commit-result-ambiguous");
  assert.equal(fixture.commitCalls(), 1);
  assert.equal(recoveredStore.getCommitReconciliation(fixture.taskId as never)?.state, "ambiguous");
  assert.equal(recoveredStore.getTask(fixture.taskId as never)?.lifecycleState, "active");
});

test("commit result SHA remains in diagnostics when result persistence fails, and retry fails closed", async (t) => {
  const fixture = await commitRecoveryFixture(t, "result-persistence");
  const first = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "commit recovery result-persistence" },
    nawabari: fixture.nawabari,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(fixture.commitCalls(), 1);
  if (!first.ok) {
    assert.equal(first.reason, "commit-result-persistence-failed");
    assert.equal(first.commitId, runGit(["rev-parse", "HEAD"], fixture.worktree));
    assert.equal(first.recovery?.commitSha, first.commitId);
  }
  fixture.store.close();

  const recoveredStore = new WorkflowSqliteStateStore({ dbPath: fixture.dbPath });
  recoveredStore.init();
  t.after(() => recoveredStore.close());
  const retry = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: recoveredStore,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "commit recovery result-persistence" },
    nawabari: fixture.nawabari,
  });
  assert.equal(retry.ok, false, JSON.stringify(retry));
  if (!retry.ok) assert.equal(retry.reason, "commit-result-ambiguous");
  assert.equal(fixture.commitCalls(), 1);
  assert.equal(recoveredStore.getCommitReconciliation(fixture.taskId as never)?.state, "ambiguous");
  assert.equal(recoveredStore.getTask(fixture.taskId as never)?.lifecycleState, "active");
});

test("commit recovery fails closed when an advanced HEAD cannot be proven to be the intended result", async (t) => {
  const fixture = await commitRecoveryFixture(t, "result-persistence");
  const task = fixture.store.getTask(fixture.taskId as never);
  assert.notEqual(task, undefined);
  const beforeCommit = runGit(["rev-parse", "HEAD"], fixture.worktree);
  fixture.store.beginCommitReconciliation({
    taskId: fixture.taskId as never,
    instanceId: task!.instanceId,
    nawabariSessionId: "commit-boundary-session" as never,
    branchName: runGit(["branch", "--show-current"], fixture.worktree),
    beforeCommit,
    resources: ["file.txt"],
    message: "intended commit",
  });
  runGit(["commit", "--quiet", "-am", "unrelated commit"], fixture.worktree);

  const result = await commitWorkflowTask({
    workspaceRoot: fixture.root,
    store: fixture.store,
    taskId: fixture.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "intended commit" },
    nawabari: fixture.nawabari,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "commit-result-ambiguous");
  assert.equal(fixture.commitCalls(), 0);
  assert.equal(fixture.store.getCommitReconciliation(fixture.taskId as never)?.state, "ambiguous");
  assert.equal(fixture.store.getTask(fixture.taskId as never)?.lifecycleState, "active");
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
  const nawabari = new PushEvidenceNawabari();
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

/** Inject the merged Nawabari #61 push.v1 fields while tests use the pre-#61 npm artifact. */
class PushEvidenceNawabari extends NawabariExecutionClient {
  pushCalls = 0;

  constructor() {
    super({
      runner: {
        async run(command, args, cwd) {
          let observedRemoteSha: string | null = null;
          if (args[0] === "push") {
            const remote = args[args.indexOf("--remote") + 1];
            const branch = args[args.indexOf("--branch") + 1];
            if (remote !== undefined && branch !== undefined) {
              const output = runGit(["ls-remote", "--heads", remote, `refs/heads/${branch}`], cwd).trim();
              observedRemoteSha = output.length === 0 ? null : (output.split(/\s+/u)[0] ?? null);
            }
          }
          const result = await runProgram(command, [...args], cwd, 12_000, 64 * 1024);
          if (args[0] !== "push" || result.spawnError !== undefined || result.stdout.trim().length === 0) return result;
          const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
          if (parsed.ok !== true) return result;
          return {
            ...result,
            stdout: JSON.stringify({
              ...parsed,
              source_sha: runGit(["rev-parse", "HEAD"], cwd),
              target_ref: `refs/heads/${args[args.indexOf("--branch") + 1]}`,
              observed_remote_sha: observedRemoteSha,
            }),
          };
        },
      },
    });
  }

  override async push(input: Parameters<NawabariExecutionClient["push"]>[0]): Promise<NawabariPushResult> {
    this.pushCalls += 1;
    return super.push(input);
  }
}

test("push receipt recovers a successful external push after lifecycle persistence fails and a process restarts", async (t) => {
  const root = createTempGitRepo(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-push-receipt-remote-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-push-receipt-state-"));
  const dbPath = path.join(stateDir, "workflow.sqlite");
  t.after(() => {
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  runGit(["init", "--bare", "--quiet"], remote);
  runGit(["remote", "add", "origin", remote], root);

  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  const nawabari = new PushEvidenceNawabari();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "push-receipt-recovery",
    branchType: "fix",
    issueRef: "195",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );
  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "receipt\n");
  const committed = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "push receipt recovery" },
    nawabari,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));

  const originalUpdate = store.updateTaskLifecycleState.bind(store);
  let failLifecycle = true;
  store.updateTaskLifecycleState = ((taskId, next, updatedAt) => {
    if (failLifecycle && next === "pushed") {
      failLifecycle = false;
      throw new Error("injected lifecycle persistence failure");
    }
    return originalUpdate(taskId, next, updatedAt);
  }) as typeof store.updateTaskLifecycleState;

  const first = await pushWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    remote: "origin",
    createUpstream: true,
    nawabari,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  const sourceCommit = runGit(["rev-parse", "HEAD"], started.execution.worktree);
  assert.equal(
    runGit(["--git-dir", remote, "rev-parse", `refs/heads/${started.execution.branch}`], root),
    sourceCommit,
  );
  const firstReceipt = store.getPushReconciliation(started.task.taskId);
  assert.equal(firstReceipt?.sourceCommit, sourceCommit);
  assert.equal(firstReceipt?.remote, "origin");
  assert.equal(firstReceipt?.targetBranch, started.execution.branch);
  assert.equal(firstReceipt?.targetRef, `refs/heads/${started.execution.branch}`);
  assert.equal(firstReceipt?.resultRemoteSha, sourceCommit);
  assert.equal(firstReceipt?.evidenceComplete, true);
  assert.equal(store.getTask(started.task.taskId)?.lifecycleState, "committed");
  store.close();

  const restarted = new WorkflowSqliteStateStore({ dbPath });
  restarted.init();
  t.after(() => restarted.close());
  const recovered = await pushWorkflowTask({
    workspaceRoot: root,
    store: restarted,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    remote: "origin",
    nawabari,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(restarted.getTask(started.task.taskId)?.lifecycleState, "pushed");
  const recoveredReceipt = restarted.getPushReconciliation(started.task.taskId);
  assert.equal(recoveredReceipt?.state, "reconciled");
  assert.equal(recoveredReceipt?.recoveryObservedRemoteSha, sourceCommit);
  assert.equal(nawabari.pushCalls, 2, "recovery must inspect through Nawabari before converging");
  assert.equal(
    runGit(["--git-dir", remote, "rev-parse", `refs/heads/${started.execution.branch}`], root),
    sourceCommit,
  );
});

test("push receipt fails closed when the remote advances before restart recovery", async (t) => {
  const root = createTempGitRepo(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-push-race-remote-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-push-race-state-"));
  const dbPath = path.join(stateDir, "workflow.sqlite");
  t.after(() => {
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  runGit(["init", "--bare", "--quiet"], remote);
  runGit(["remote", "add", "origin", remote], root);
  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  const nawabari = new PushEvidenceNawabari();
  const started = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "push-remote-race",
    branchType: "fix",
    issueRef: "195",
    nawabari,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  t.after(() =>
    nawabari
      .closeSession({ cwd: started.execution.worktree, sessionId: started.execution.sessionId })
      .catch(() => undefined),
  );
  fs.appendFileSync(path.join(started.execution.worktree, "file.txt"), "race\n");
  const committed = await commitWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    message: { subject: "push remote race" },
    nawabari,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const originalUpdate = store.updateTaskLifecycleState.bind(store);
  store.updateTaskLifecycleState = ((taskId, next, updatedAt) => {
    if (next === "pushed") throw new Error("injected lifecycle persistence failure");
    return originalUpdate(taskId, next, updatedAt);
  }) as typeof store.updateTaskLifecycleState;
  const first = await pushWorkflowTask({
    workspaceRoot: root,
    store,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    remote: "origin",
    createUpstream: true,
    nawabari,
  });
  assert.equal(first.ok, false, JSON.stringify(first));

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-push-race-clone-"));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  runGit(["clone", "--quiet", "--branch", started.execution.branch, remote, clone], path.dirname(clone));
  runGit(["config", "user.email", "race@example.invalid"], clone);
  runGit(["config", "user.name", "Remote Race"], clone);
  fs.appendFileSync(path.join(clone, "file.txt"), "remote generation\n");
  runGit(["commit", "--quiet", "-am", "remote generation"], clone);
  runGit(["push", "--quiet", "origin", `HEAD:refs/heads/${started.execution.branch}`], clone);
  const remoteGeneration = runGit(["--git-dir", remote, "rev-parse", `refs/heads/${started.execution.branch}`], root);
  store.close();

  const restarted = new WorkflowSqliteStateStore({ dbPath });
  restarted.init();
  t.after(() => restarted.close());
  const recovered = await pushWorkflowTask({
    workspaceRoot: root,
    store: restarted,
    taskId: started.task.taskId,
    policy: BUILTIN_PRESETS.standard,
    remote: "origin",
    nawabari,
  });
  assert.equal(recovered.ok, false, JSON.stringify(recovered));
  assert.equal((recovered as { reason?: string }).reason, "push-reconciliation-ambiguous");
  assert.equal(restarted.getTask(started.task.taskId)?.lifecycleState, "committed");
  assert.equal(restarted.getPushReconciliation(started.task.taskId)?.state, "ambiguous");
  assert.equal(
    runGit(["--git-dir", remote, "rev-parse", `refs/heads/${started.execution.branch}`], root),
    remoteGeneration,
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
    const lifecycleStatesAtClose: string[] = [];
    const nawabari = fakeNawabari(root, {
      calls,
      sessions,
      beforeSessionClose: () => lifecycleStatesAtClose.push(store.listTasks()[0]?.lifecycleState ?? "deleted"),
    });
    const result = await startNawabariTask({
      workspaceRoot: root,
      store,
      policy: BUILTIN_PRESETS.standard,
      taskSlug: `fault-${point}`,
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
    assert.notEqual(lifecycleStatesAtClose[0], "active", "lifecycle must be non-active before Nawabari close");
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

test("task-start restart/retry discovers a session created before its identity record was persisted", async (t) => {
  const root = createTempGitRepo(t);
  const dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-task-start-unrecorded-restart-"));
  t.after(() => fs.rmSync(dbDirectory, { recursive: true, force: true }));
  const dbPath = path.join(dbDirectory, "workflow.sqlite");
  const identity = resolveRepositoryIdentity(root);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  const baseCommit = runGit(["rev-parse", "main"], root);
  const taskSlug = "unrecorded-restart";
  const issueRef = "193-unrecorded-restart";
  const branch = buildWorktreeNaming({ branchType: "fix", issueRef, taskSlug }).branchName;
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
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
    baseBranch: "main",
    baseCommit,
    allowMultipleActiveTasksPerIssue: false,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const taskLabel = `mottainai-task-${reserved.task.taskId}`;
  firstStore.beginTaskStartReconciliation({
    taskId: reserved.task.taskId,
    instanceId: identity.identity.instanceId,
    taskLabel,
    branchName: branch,
    baseBranch: "main",
    baseCommit,
  });

  // Model a process dying after Nawabari has durably created the session but
  // before the Mottainai callback can persist the returned session ID.
  const firstNawabari = fakeNawabari(root, { calls, sessions });
  const created = await firstNawabari.createSession({
    cwd: root,
    branch,
    base: "main",
    label: taskLabel,
  });
  assert.equal(created.state, "active");
  firstStore.close();

  const secondStore = new WorkflowSqliteStateStore({ dbPath });
  secondStore.init();
  t.after(() => secondStore.close());
  const retried = await startNawabariTask({
    workspaceRoot: root,
    store: secondStore,
    policy: BUILTIN_PRESETS.standard,
    taskSlug,
    branchType: "fix",
    issueRef,
    nawabari: fakeNawabari(root, { calls, sessions }),
  });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  if (!retried.ok) return;
  assert.equal(retried.task.taskId, reserved.task.taskId);
  assert.equal(retried.execution.sessionId, created.sessionId);
  assert.equal(secondStore.getTaskStartReconciliation(reserved.task.taskId)?.nawabariSessionId, created.sessionId);
  assert.equal(secondStore.getTask(reserved.task.taskId)?.lifecycleState, "active");
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 1);
});

test("task-start keeps an orphaned record when Nawabari ownership cannot be observed", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const calls: string[][] = [];
  const result = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "unobservable-session",
    branchType: "fix",
    issueRef: "193-unobservable",
    idempotencyKey: "unobservable-session-key",
    nawabari: fakeNawabari(root, { calls, failSessionList: true }),
  });
  assert.equal(result.ok, false);
  const task = store.listTasks()[0];
  assert.notEqual(task, undefined);
  assert.equal(task?.lifecycleState, "orphaned");
  assert.equal(store.getTaskStartReconciliation(task!.taskId)?.state, "orphaned");
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "create").length, 0);
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 0);
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
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "claim").length, 0);
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "close").length, 0);
});

test("task-start verifies a newly created session before compensating a claim failure", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const calls: string[][] = [];
  const result = await startNawabariTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "claim-failure-ownership",
    branchType: "fix",
    issueRef: "193-claim-failure",
    idempotencyKey: "claim-failure-ownership-key",
    nawabari: fakeNawabari(root, {
      calls,
      repository: path.join(root, "foreign-repository.git"),
      failSessionClaim: true,
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "nawabari-ownership-ambiguous");
  const task = store.listTasks()[0];
  assert.equal(task?.lifecycleState, "orphaned");
  assert.equal(store.getTaskStartReconciliation(task!.taskId)?.state, "orphaned");
  assert.equal(calls.filter((args) => args[0] === "session" && args[1] === "claim").length, 0);
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
