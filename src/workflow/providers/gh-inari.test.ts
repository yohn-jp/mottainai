import assert from "node:assert/strict";
import test from "node:test";
import { GhInariClient, type GhInariProcess } from "../../gh-inari.js";
import type { RunResult } from "../../subprocess.js";
import { GhInariPullRequestAdapter, pullRequestFieldsForGhInari } from "./gh-inari.js";
import type { PullRequestCreateAdapter, PullRequestCreateInput } from "./github.js";

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
    runResult("gh-inari 0.7.0\n"),
    runResult(
      "  pr create --from <file.json>\n  pr get <number> --json\n  --from <path>\n  --json\n  --repository <r>\n  --template <id>\n",
    ),
    runResult(operationOutput),
  ];
}

function lookupAdapter(): Pick<PullRequestCreateAdapter, "findPullRequests"> {
  return {
    findPullRequests: async () => ({ ok: true, value: [], attempts: 1 }),
  };
}

function input(): PullRequestCreateInput {
  return {
    repository: { provider: "github", id: "acme/repo", namespace: "acme", name: "repo" },
    title: "Governed PR",
    head: { name: "feature/inari", revision: "head-sha" },
    base: { name: "main", revision: "base-sha" },
    draft: {
      issue: { reference: "acme/repo#7" },
      sections: { Summary: "typed intent", Details: ["one", "two"] },
      acceptanceCriteria: ["governance is authoritative"],
    },
    providerDraft: true,
  };
}

test("managed PR creation sends explicit repository and typed fields through gh-inari", async () => {
  const { runner, calls } = queuedRunner(
    capabilityResults(
      JSON.stringify({ ok: true, artifact: { number: 12, url: "https://github.com/acme/repo/pull/12" } }),
    ),
  );
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });

  const result = await adapter.openPullRequest(input());

  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.value, {
      identity: { provider: "github", id: "pull-request:12" },
      reference: "#12",
      number: 12,
      url: "https://github.com/acme/repo/pull/12",
      state: "open",
      lifecycleState: "draft",
      repository: input().repository,
      head: input().head,
      base: input().base,
    });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2]?.args, [
    "pr",
    "create",
    "--repository",
    "acme/repo",
    "--from",
    "-",
    "--json",
    "--template",
    "default",
  ]);
  assert.deepEqual(JSON.parse(calls[2]?.input ?? "{}"), {
    fields: pullRequestFieldsForGhInari(input().draft),
    title: "Governed PR",
    head: "feature/inari",
    base: "main",
    draft: true,
  });
});

test("governance rejection remains a structured gh-inari workflow failure", async () => {
  const { runner } = queuedRunner(
    capabilityResults(
      JSON.stringify({
        ok: false,
        error: {
          code: "GOVERNANCE_REJECTED",
          message: "repository policy rejected the PR",
          details: { path: "$.fields" },
        },
      }),
    ),
  );
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });

  const result = await adapter.openPullRequest(input());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.authority, "gh-inari");
    assert.equal(result.error.inari?.code, "INARI_REJECTED");
    assert.equal(result.error.inari?.remote?.code, "GOVERNANCE_REJECTED");
    const details = result.error.inari?.remote?.details;
    assert.equal(typeof details === "object" && details !== null && "path" in details, true);
  }
});

test("missing and incompatible gh-inari fail closed before a create operation", async () => {
  const missing = queuedRunner([runResult("", "", { spawnError: "gh-inari: not found" })]);
  const missingAdapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner: missing.runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });
  const missingResult = await missingAdapter.openPullRequest(input());
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.error.inari?.code, "INARI_COMPANION_MISSING");
  assert.deepEqual(
    missing.calls.map((call) => call.args),
    [["--version"]],
  );

  const incompatible = queuedRunner([runResult("gh-inari 0.6.9\n")]);
  const incompatibleAdapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner: incompatible.runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });
  const incompatibleResult = await incompatibleAdapter.openPullRequest(input());
  assert.equal(incompatibleResult.ok, false);
  if (!incompatibleResult.ok) assert.equal(incompatibleResult.error.inari?.code, "INARI_COMPANION_INCOMPATIBLE");
  assert.deepEqual(
    incompatible.calls.map((call) => call.args),
    [["--version"]],
  );
});

test("the Inari adapter keeps #196 lookup read-only and delegates exact reconciliation", async () => {
  const expected = { ok: true as const, value: [], attempts: 1 };
  let observedInput: unknown;
  const lookup = {
    findPullRequests: async (value: unknown) => {
      observedInput = value;
      return expected;
    },
  } as Pick<PullRequestCreateAdapter, "findPullRequests">;
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner: async () => runResult("unexpected") }),
    lookupAdapter: lookup,
  });

  const result = await adapter.findPullRequests({
    repository: input().repository,
    head: input().head,
    base: input().base,
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(observedInput, {
    repository: input().repository,
    head: input().head,
    base: input().base,
  });
});
