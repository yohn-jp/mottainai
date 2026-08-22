import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return { findPullRequests: async () => ({ ok: true, value: [], attempts: 1 }) };
}

function input(): PullRequestCreateInput {
  return {
    repository: { provider: "github", id: "acme/repo", namespace: "acme", name: "repo" },
    title: "Governed PR",
    head: { name: "feature/inari", revision: "head-sha" },
    base: { name: "main", revision: "base-sha" },
    draft: {
      issue: { reference: "7" },
      sections: {
        summary: "typed intent",
        changes: "bounded implementation",
        validation: "- [x] Tests",
        review_focus: "linked Issue rendering",
      },
    },
    providerDraft: true,
  };
}

function workspaceWithContract(fieldIds: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-inari-contract-"));
  const directory = path.join(root, ".github", "inari", "pull-requests");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "default.json"),
    JSON.stringify({ version: 1, kind: "pull_request", id: "default", sections: fieldIds.map((id) => ({ id })) }),
  );
  return root;
}

test("issue reference maps to linked_issue instead of undeclared issue field", () => {
  assert.deepEqual(pullRequestFieldsForGhInari(input().draft), {
    summary: "typed intent",
    changes: "bounded implementation",
    validation: "- [x] Tests",
    review_focus: "linked Issue rendering",
    linked_issue: "Closes #7",
  });
});

test("cross-repository issue references preserve GitHub closing syntax", () => {
  assert.deepEqual(
    pullRequestFieldsForGhInari({ issue: { reference: "acme/other#42" }, sections: { summary: "cross repo" } }),
    { summary: "cross repo", linked_issue: "Closes acme/other#42" },
  );
});

test("managed PR creation sends linked_issue through gh-inari", async (t) => {
  const workspaceRoot = workspaceWithContract(["summary", "linked_issue", "changes", "validation", "review_focus"]);
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const { runner, calls } = queuedRunner(
    capabilityResults(JSON.stringify({ ok: true, artifact: { number: 12, url: "https://github.com/acme/repo/pull/12" } })),
  );
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot,
    client: new GhInariClient({ runner, cwd: workspaceRoot }),
    lookupAdapter: lookupAdapter(),
  });

  const result = await adapter.openPullRequest(input());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 3);
  const payload = JSON.parse(calls[2]?.input ?? "{}") as { fields?: Record<string, unknown> };
  assert.equal(payload.fields?.linked_issue, "Closes #7");
  assert.equal("issue" in (payload.fields ?? {}), false);
});

test("missing linked_issue in the compiled repository contract fails before provider execution", async (t) => {
  const workspaceRoot = workspaceWithContract(["summary", "changes", "validation", "review_focus"]);
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const { runner, calls } = queuedRunner(
    capabilityResults(JSON.stringify({ ok: true, artifact: { number: 12, url: "https://github.com/acme/repo/pull/12" } })),
  );
  const adapter = new GhInariPullRequestAdapter({
    workspaceRoot,
    client: new GhInariClient({ runner, cwd: workspaceRoot }),
    lookupAdapter: lookupAdapter(),
  });

  const result = await adapter.openPullRequest(input());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.inari?.code, "INARI_INVALID_REQUEST");
    assert.match(result.error.message, /does not declare a linked_issue field/u);
    assert.equal(result.error.inari?.details.field, "linked_issue");
  }
  assert.deepEqual(calls, []);
});

test("sections-json-only behavior remains unchanged when issue reference is omitted", () => {
  const draft = {
    sections: {
      summary: "typed intent",
      linked_issue: "Relates #99",
      changes: ["one", "two"],
    },
  };
  assert.deepEqual(pullRequestFieldsForGhInari(draft), {
    summary: "typed intent",
    linked_issue: "Relates #99",
    changes: ["one", "two"],
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
  const withoutIssue = { ...input(), draft: { sections: input().draft.sections } };
  const result = await adapter.openPullRequest(withoutIssue);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.authority, "gh-inari");
    assert.equal(result.error.inari?.code, "INARI_REJECTED");
    assert.equal(result.error.inari?.remote?.code, "GOVERNANCE_REJECTED");
  }
});

test("missing and incompatible gh-inari fail closed before a create operation", async () => {
  const withoutIssue = { ...input(), draft: { sections: input().draft.sections } };
  const missing = queuedRunner([runResult("", "", { spawnError: "gh-inari: not found" })]);
  const missingAdapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner: missing.runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });
  const missingResult = await missingAdapter.openPullRequest(withoutIssue);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.error.inari?.code, "INARI_COMPANION_MISSING");

  const incompatible = queuedRunner([runResult("gh-inari 0.6.9\n")]);
  const incompatibleAdapter = new GhInariPullRequestAdapter({
    workspaceRoot: "/checkout",
    client: new GhInariClient({ runner: incompatible.runner, cwd: "/checkout" }),
    lookupAdapter: lookupAdapter(),
  });
  const incompatibleResult = await incompatibleAdapter.openPullRequest(withoutIssue);
  assert.equal(incompatibleResult.ok, false);
  if (!incompatibleResult.ok) assert.equal(incompatibleResult.error.inari?.code, "INARI_COMPANION_INCOMPATIBLE");
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
  assert.deepEqual(observedInput, { repository: input().repository, head: input().head, base: input().base });
});
