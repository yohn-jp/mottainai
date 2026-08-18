import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { GhInariClient, type GhInariProcess } from "../../gh-inari.js";
import type { RunResult } from "../../subprocess.js";
import { createTempGitRepo } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { startTask } from "../domain/task.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { NawabariExecutionClient } from "../nawabari.js";
import { GhInariPullRequestAdapter } from "../providers/gh-inari.js";
import { GithubAdapter, type PullRequestCreateAdapter, type RunProgramFunction } from "../providers/github.js";
import type { PullRequest } from "../providers/model.js";
import type { NawabariSessionId } from "../state/store.js";
import { openWorkflowTaskPullRequest } from "./write.js";

const FAKE_NAWABARI_COMMANDS = [
  "session create",
  "session id",
  "session show",
  "session list",
  "session claim",
  "session update",
  "session claims",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

const FAKE_NAWABARI_CAPABILITIES = [
  {
    id: "resource-claims",
    commands: FAKE_NAWABARI_COMMANDS,
    claim_set_replacement: {
      commands: ["session update", "resource update"],
      atomic: true,
      pairing: "adjacent-resource-mode",
      idempotent_retry: true,
      unchanged_on_rejection: true,
    },
  },
];

/**
 * Nawabari is the sole physical authority for managed worktrees (#203); a task must have
 * an attached session before its worktree can be resolved for a managed write. This fake
 * only answers the `session id` / `session show` calls that resolution performs.
 */
function attachedNawabari(sessionId: string, session: Record<string, unknown>): NawabariExecutionClient {
  return new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        if (args[0] === "capabilities")
          return {
            stdout: JSON.stringify({
              ok: true,
              command: "capabilities",
              schema_version: 1,
              contract_id: "nawabari.standalone-execution.v1",
              package_version: "0.4.1",
              capabilities: FAKE_NAWABARI_CAPABILITIES,
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputLimit: false,
          };
        if (args[0] === "session" && args[1] === "id")
          return {
            stdout: JSON.stringify({ ok: false, command: "session id", code: "NO_CURRENT_SESSION", message: "none" }),
            stderr: "",
            exitCode: 3,
            signal: null,
            timedOut: false,
            outputLimit: false,
          };
        if (args[0] === "session" && args[1] === "show" && args[args.indexOf("--session") + 1] === sessionId)
          return {
            stdout: JSON.stringify({ ok: true, command: "session show", ...session }),
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputLimit: false,
          };
        throw new Error(`unexpected fake Nawabari command: ${args.join(" ")}`);
      },
    },
  });
}

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

function queuedRunner(results: RunResult[]): {
  runner: GhInariProcess;
  calls: Array<{ args: readonly string[]; input?: string }>;
} {
  let index = 0;
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const runner: GhInariProcess = async (request) => {
    calls.push({ args: request.args, ...(request.input === undefined ? {} : { input: request.input }) });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error("missing fake gh-inari result");
    return result;
  };
  return { runner, calls };
}

function capabilityResults(operationOutput: string): RunResult[] {
  return [
    runResult("gh-inari 0.2.0\n"),
    runResult("  pr create --from <file.json>\n  pr get <number> --json\n"),
    runResult(operationOutput),
  ];
}

async function workflowFixture(t: TestContext) {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const started = await startTask({
    workspaceRoot: root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: `inari-pr-${Date.now()}`,
    branchType: "refactor",
    issueRef: "200",
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok || started.worktree === undefined) throw new Error("workflow fixture setup failed");
  store.updateTaskLifecycleState(started.task.taskId, "pushed");

  const sessionId = `session-${started.task.taskId}`;
  store.attachNawabariSession(started.task.taskId, sessionId as NawabariSessionId);
  const nawabari = attachedNawabari(sessionId, {
    session_id: sessionId,
    repository: root,
    worktree: started.worktree.canonicalPath,
    branch: started.worktree.branchName,
    state: "active",
  });

  const githubCalls: string[][] = [];
  const execute: RunProgramFunction = async (_program, args) => {
    githubCalls.push(args);
    return runResult("[]");
  };
  const githubAdapter = new GithubAdapter({
    workspaceRoot: started.worktree.canonicalPath,
    runProgram: execute,
    sleep: async () => undefined,
  });
  return {
    store,
    taskId: started.task.taskId,
    workspaceRoot: started.worktree.canonicalPath,
    nawabari,
    githubAdapter,
    githubCalls,
  };
}

test("managed open-pr uses Inari mutation and preserves the workflow lifecycle result", async (t) => {
  const fixture = await workflowFixture(t);
  const { runner, calls } = queuedRunner(
    capabilityResults(
      JSON.stringify({ ok: true, artifact: { number: 42, url: "https://github.com/acme/repo/pull/42" } }),
    ),
  );

  const result = await openWorkflowTaskPullRequest(
    {
      workspaceRoot: fixture.workspaceRoot,
      store: fixture.store,
      taskId: fixture.taskId,
      nawabari: fixture.nawabari,
      policy: BUILTIN_PRESETS.standard,
      title: "Governed workflow PR",
      repository: "acme/repo",
      sections: { Summary: "typed workflow intent" },
      acceptanceCriteria: ["Inari owns rendering"],
    },
    {
      githubAdapter: fixture.githubAdapter,
      ghInariClient: new GhInariClient({ runner, cwd: fixture.workspaceRoot }),
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    const opened = result as unknown as {
      pullRequest: { number: number; head: { name: string } };
      task: { lifecycleState: string };
    };
    assert.equal(opened.pullRequest.number, 42);
    assert.equal(opened.task.lifecycleState, "pull-request-open");
  }
  assert.equal(
    calls.some((call) => call.args[0] === "pr" && call.args[1] === "create"),
    true,
  );
  assert.equal(
    fixture.githubCalls.some((args) => args[0] === "pr" && args[1] === "create"),
    false,
  );
  assert.equal(
    fixture.githubCalls.some((args) => args[0] === "pr" && args[1] === "list"),
    true,
  );
  const createInput = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
  assert.equal(createInput?.args.includes("acme/repo"), true);
  assert.deepEqual(JSON.parse(createInput?.input ?? "{}"), {
    fields: { Summary: "typed workflow intent", acceptanceCriteria: ["Inari owns rendering"] },
    title: "Governed workflow PR",
    head: result.ok ? (result as unknown as { pullRequest: { head: { name: string } } }).pullRequest.head.name : "",
    base: "main",
  });
});

test("managed open-pr returns structured Inari rejection and performs no direct create", async (t) => {
  const fixture = await workflowFixture(t);
  const { runner } = queuedRunner(
    capabilityResults(
      JSON.stringify({
        ok: false,
        error: {
          code: "GOVERNANCE_REJECTED",
          message: "governance rejected workflow PR",
          details: { rule: "required" },
        },
      }),
    ),
  );

  const result = await openWorkflowTaskPullRequest(
    {
      workspaceRoot: fixture.workspaceRoot,
      store: fixture.store,
      taskId: fixture.taskId,
      nawabari: fixture.nawabari,
      policy: BUILTIN_PRESETS.standard,
      title: "Rejected workflow PR",
      repository: "acme/repo",
      sections: { Summary: "intent" },
    },
    {
      githubAdapter: fixture.githubAdapter,
      ghInariClient: new GhInariClient({ runner, cwd: fixture.workspaceRoot }),
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "provider-failed");
    assert.equal(result.provider?.authority, "gh-inari");
    assert.equal(result.provider?.inari?.code, "INARI_REJECTED");
    assert.equal(result.provider?.inari?.remote?.code, "GOVERNANCE_REJECTED");
  }
  assert.equal(
    fixture.githubCalls.some((args) => args[0] === "pr" && args[1] === "create"),
    false,
  );
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pushed");
});

test("managed Inari creation reconciles after local persistence failure without a second create", async (t) => {
  const fixture = await workflowFixture(t);
  const { runner, calls } = queuedRunner(
    capabilityResults(
      JSON.stringify({ ok: true, artifact: { number: 42, url: "https://github.com/acme/repo/pull/42" } }),
    ),
  );
  let lookupCalls = 0;
  const lookupAdapter: Pick<PullRequestCreateAdapter, "findPullRequests"> = {
    findPullRequests: async (lookup) => {
      lookupCalls += 1;
      if (lookupCalls === 1) return { ok: true, value: [], attempts: 1 };
      const candidate: PullRequest = {
        identity: { provider: "github", id: "pull-request:42" },
        reference: "#42",
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "open",
        lifecycleState: "open",
        repository: lookup.repository,
        head: lookup.head,
        base: lookup.base,
      };
      return { ok: true, value: [candidate], attempts: 1 };
    },
  };
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot: fixture.workspaceRoot,
    client: new GhInariClient({ runner, cwd: fixture.workspaceRoot }),
    lookupAdapter,
  });
  const recordPullRequest = fixture.store.recordPullRequest.bind(fixture.store);
  let failPersistence = true;
  fixture.store.recordPullRequest = ((input) => {
    if (failPersistence) {
      failPersistence = false;
      throw new Error("simulated PR-row persistence failure");
    }
    return recordPullRequest(input);
  }) as typeof fixture.store.recordPullRequest;
  const input = {
    workspaceRoot: fixture.workspaceRoot,
    store: fixture.store,
    taskId: fixture.taskId,
    nawabari: fixture.nawabari,
    policy: BUILTIN_PRESETS.standard,
    title: "Governed workflow PR",
    repository: "acme/repo",
    sections: { Summary: "typed workflow intent" },
  };

  const first = await openWorkflowTaskPullRequest(input, { pullRequestAdapter: adapter });
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.providerCreated, true, JSON.stringify(first));
  assert.equal(fixture.store.listPullRequestRecordsForTask(fixture.taskId).length, 0);

  const recovered = await openWorkflowTaskPullRequest(input, { pullRequestAdapter: adapter });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  if (recovered.ok) {
    assert.equal(recovered.reused, true);
  }
  assert.equal(fixture.store.listPullRequestRecordsForTask(fixture.taskId)[0]?.prNumber, 42);
  assert.equal(lookupCalls, 2);
  assert.equal(calls.filter((call) => call.args[0] === "pr" && call.args[1] === "create").length, 1);
  assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pull-request-open");
});
