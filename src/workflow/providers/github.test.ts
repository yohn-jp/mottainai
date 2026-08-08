import assert from "node:assert/strict";
import { test } from "node:test";
import { getPreset } from "../policy/presets.js";
import { GithubAdapter, openWorkflowPullRequest, type RunProgramFunction } from "./github.js";
import type { RunResult } from "../../subprocess.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../domain/identity.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

function issueJson(): string {
  return JSON.stringify({
    id: "issue-node-7",
    number: 7,
    title: "valid issue",
    state: "OPEN",
    labels: [{ name: "workflow" }],
    assignees: [{ login: "agent" }],
    body: "issue body is read transiently",
    url: "https://github.com/org/repository/issues/7",
    repository: {
      id: "repo-node-1",
      name: "repository",
      nameWithOwner: "org/repository",
      url: "https://github.com/org/repository",
    },
  });
}

function adapterWith(sequence: RunResult[], calls: string[][] = []): GithubAdapter {
  let index = 0;
  const execute: RunProgramFunction = async (_program, args) => {
    calls.push(args);
    const result = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (result === undefined) throw new Error("missing mocked result");
    return result;
  };
  return new GithubAdapter({ workspaceRoot: "/repo", runProgram: execute, sleep: async () => undefined });
}

test("GitHub adapter parses successful gh issue JSON into provider-neutral Issue", async () => {
  const adapter = adapterWith([runResult(issueJson())]);
  const result = await adapter.viewIssue(7);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.reference, "#7");
    assert.equal(result.value.repository.id, "org/repository");
    assert.deepEqual(result.value.metadata.labels, ["workflow"]);
  }
});

test("GitHub adapter returns stable failures for malformed JSON and gh failure", async () => {
  const malformed = await adapterWith([runResult("not json")]).viewIssue(7);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "malformed-json");

  const failed = await adapterWith([runResult("", "authentication failed", { exitCode: 1 })]).viewIssue(7);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "provider-failed");
    assert.equal(failed.error.retryable, false);
  }
});

test("retryable gh failure retries bounded read and succeeds", async () => {
  const calls: string[][] = [];
  const adapter = adapterWith(
    [runResult("", "temporary network failure", { exitCode: 1 }), runResult(issueJson())],
    calls,
  );
  const result = await adapter.viewIssue(7);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test("PR creation parses gh URL and does not retry mutation", async () => {
  const calls: string[][] = [];
  const adapter = adapterWith([runResult("https://github.com/org/repository/pull/12\n")], calls);
  const result = await adapter.openPullRequest({
    repository: { provider: "github", id: "org/repository", namespace: "org", name: "repository" },
    title: "feat(workflow): open provider pull request",
    body: "## Summary\nstructured",
    head: { name: "feature/12", revision: "abc123" },
    base: { name: "main" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.number, 12);
    assert.equal(result.value.head.revision, "abc123");
  }
  assert.equal(calls.length, 1);
});

function pushedTaskStore(): { store: WorkflowSqliteStateStore; taskId: string & { readonly __brand: "TaskId" } } {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.observeRepositoryInstance({
    rootCommitDigest: "digest" as RootCommitDigest,
    instanceId: "instance" as RepositoryInstanceId,
    gitCommonDir: "/repo/.git",
    canonicalWorktreePath: "/repo",
  });
  const reserved = store.reserveTask({
    instanceId: "instance" as RepositoryInstanceId,
    taskSlug: "task",
    issueRef: "36",
    baseBranch: "main",
    baseCommit: "base",
    allowMultipleActiveTasksPerIssue: true,
  });
  if (!reserved.ok) throw new Error("task reservation failed");
  store.updateTaskLifecycleState(reserved.task.taskId, "pushed");
  return { store, taskId: reserved.task.taskId };
}

function workflowPolicy() {
  return {
    ...getPreset("minimal"),
    pullRequest: {
      issue: "required" as const,
      closingIssue: "exactly-one" as const,
      requiredSections: ["Summary"],
      acceptanceCriteriaSection: "Acceptance criteria",
      acceptanceCriteriaChecklist: true,
      templates: {},
    },
  };
}

function workflowInput(
  store: WorkflowSqliteStateStore,
  taskId: string & { readonly __brand: "TaskId" },
  adapter: GithubAdapter,
) {
  return {
    adapter,
    store,
    taskId,
    policy: workflowPolicy(),
    repository: { provider: "github", id: "org/repository", namespace: "org", name: "repository" },
    title: "feat(workflow): open provider pull request",
    head: { name: "feature/36", revision: "abc123" },
    base: { name: "main" },
    draft: {
      issue: { reference: "#36", number: 36 },
      sections: { Summary: "structured" },
      acceptanceCriteria: ["tests pass"],
    },
  };
}

test("provider success writes PR metadata and transitions the task", async () => {
  const { store, taskId } = pushedTaskStore();
  const adapter = adapterWith([runResult("https://github.com/org/repository/pull/36")]);
  const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.headSha, "abc123");
    assert.equal(result.task.lifecycleState, "pull-request-open");
    assert.equal(store.listPullRequestRecordsForTask(taskId).length, 1);
  }
  store.close();
});

test("provider failure leaves task and PR record state unchanged", async () => {
  const { store, taskId } = pushedTaskStore();
  const adapter = adapterWith([runResult("", "provider unavailable", { exitCode: 1 })]);
  const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
  assert.equal(result.ok, false);
  assert.equal(store.getTask(taskId)?.lifecycleState, "pushed");
  assert.deepEqual(store.listPullRequestRecordsForTask(taskId), []);
  store.close();
});
