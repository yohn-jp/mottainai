import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
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

function pullRequestListJson(
  overrides: Partial<{
    number: number;
    state: string;
    isDraft: boolean;
    mergedAt: string | null;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    baseRefOid: string;
  }> = {},
): string {
  return JSON.stringify([
    {
      number: 36,
      state: "OPEN",
      isDraft: false,
      mergedAt: null,
      url: "https://github.com/org/repository/pull/36",
      headRefName: "feature/36",
      headRefOid: "abc123",
      baseRefName: "main",
      baseRefOid: "base",
      repository: {
        name: "repository",
        nameWithOwner: "org/repository",
        url: "https://github.com/org/repository",
      },
      ...overrides,
    },
  ]);
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
  const calls: string[][] = [];
  const adapter = adapterWith([runResult(issueJson())], calls);
  const result = await adapter.viewIssue(7);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.reference, "#7");
    assert.equal(result.value.repository.id, "org/repository");
    assert.deepEqual(result.value.metadata.labels, ["workflow"]);
    assert.deepEqual(result.value.metadata.assignees, ["agent"]);
  }
  const jsonFlagIndex = calls[0]?.indexOf("--json") ?? -1;
  const requestedFields = calls[0]?.[jsonFlagIndex + 1]?.split(",") ?? [];
  assert.ok(requestedFields.includes("assignees"), "gh issue view --json must request assignees");
  assert.ok(requestedFields.includes("milestone"), "gh issue view --json must request milestone");
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
    head: { name: "feature/12", revision: "abc123" },
    base: { name: "main" },
    draft: { sections: { Summary: "structured" } },
    policy: { requiredSections: ["Summary"] },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.number, 12);
    assert.equal(result.value.head.revision, "abc123");
  }
  assert.equal(calls.length, 1);
});

test("PR creation refuses to fall back to the cwd repository when the identity is opaque", async () => {
  const calls: string[][] = [];
  const adapter = adapterWith([runResult("https://github.com/org/repository/pull/12\n")], calls);
  const result = await adapter.openPullRequest({
    repository: { provider: "github", id: "opaque-node-id" },
    title: "feat(workflow): open provider pull request",
    head: { name: "feature/12", revision: "abc123" },
    base: { name: "main" },
    draft: { sections: { Summary: "structured" } },
    policy: { requiredSections: ["Summary"] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid-input");
  assert.equal(calls.length, 0, "gh pr create must not run without an explicit --repo target");
});

test("PR lookup requests all states and parses provider-neutral identity", async () => {
  const calls: string[][] = [];
  const adapter = adapterWith([runResult(pullRequestListJson())], calls);
  const result = await adapter.findPullRequests({
    repository: { provider: "github", id: "org/repository", namespace: "org", name: "repository" },
    head: { name: "feature/36", revision: "abc123" },
    base: { name: "main", revision: "base" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]?.head.revision, "abc123");
    assert.equal(result.value[0]?.base.name, "main");
  }
  assert.deepEqual(calls[0]?.slice(0, 9), [
    "pr",
    "list",
    "--state",
    "all",
    "--head",
    "feature/36",
    "--base",
    "main",
    "--json",
  ]);
});

function pushedTaskStore(dbPath = ":memory:"): {
  store: WorkflowSqliteStateStore;
  taskId: string & { readonly __brand: "TaskId" };
} {
  const store = new WorkflowSqliteStateStore({ dbPath });
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
  try {
    const adapter = adapterWith([runResult("[]"), runResult("https://github.com/org/repository/pull/36")]);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.headSha, "abc123");
      assert.equal(result.task.lifecycleState, "pull-request-open");
      assert.equal(store.listPullRequestRecordsForTask(taskId).length, 1);
    }
  } finally {
    store.close();
  }
});

test("retry after provider success and PR-row persistence failure reconciles without a second create", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const calls: string[][] = [];
    const adapter = adapterWith(
      [runResult("[]"), runResult("https://github.com/org/repository/pull/36"), runResult(pullRequestListJson())],
      calls,
    );
    const recordPullRequest = store.recordPullRequest.bind(store);
    let failPersistence = true;
    store.recordPullRequest = ((input) => {
      if (failPersistence) {
        failPersistence = false;
        throw new Error("simulated PR-row persistence failure");
      }
      return recordPullRequest(input);
    }) as typeof store.recordPullRequest;

    const first = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.equal(first.reason, "local-state-write-failed");
      assert.equal(first.providerCreated, true);
    }
    assert.deepEqual(store.listPullRequestRecordsForTask(taskId), []);

    const recovered = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.equal(recovered.reused, true);
      assert.equal(recovered.record.prNumber, 36);
    }
    assert.equal(calls.filter((args) => args[0] === "pr" && args[1] === "create").length, 1);
  } finally {
    store.close();
  }
});

test("process restart reconciles the remote PR after provider success and missing local persistence", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-pr-reconciliation-"));
  const dbPath = path.join(temporaryDirectory, "state.sqlite");
  let firstStore: WorkflowSqliteStateStore | undefined;
  let restartedStore: WorkflowSqliteStateStore | undefined;
  try {
    const first = pushedTaskStore(dbPath);
    firstStore = first.store;
    const calls: string[][] = [];
    const adapter = adapterWith(
      [runResult("[]"), runResult("https://github.com/org/repository/pull/36"), runResult(pullRequestListJson())],
      calls,
    );
    firstStore.recordPullRequest = (() => {
      throw new Error("simulated process failure after provider success");
    }) as typeof firstStore.recordPullRequest;

    const attempted = await openWorkflowPullRequest(workflowInput(firstStore, first.taskId, adapter));
    assert.equal(attempted.ok, false);
    if (!attempted.ok) assert.equal(attempted.providerCreated, true);
    assert.deepEqual(firstStore.listPullRequestRecordsForTask(first.taskId), []);

    firstStore.close();
    firstStore = undefined;
    restartedStore = new WorkflowSqliteStateStore({ dbPath });
    restartedStore.init();
    const recovered = await openWorkflowPullRequest(workflowInput(restartedStore, first.taskId, adapter));
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.reused, true);
    assert.equal(restartedStore.getTask(first.taskId)?.lifecycleState, "pull-request-open");
    assert.equal(restartedStore.listPullRequestRecordsForTask(first.taskId).length, 1);
    assert.equal(calls.filter((args) => args[0] === "pr" && args[1] === "create").length, 1);
  } finally {
    firstStore?.close();
    restartedStore?.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("exact remote candidate is recorded without creating a duplicate", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const calls: string[][] = [];
    const adapter = adapterWith([runResult(pullRequestListJson())], calls);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.reused, true);
      assert.equal(result.record.prNumber, 36);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1], "list");
  } finally {
    store.close();
  }
});

test("multiple remote candidates fail closed without selecting one", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const second = pullRequestListJson({ number: 37, headRefName: "feature/36", headRefOid: "abc123" });
    const candidates = JSON.stringify([...JSON.parse(pullRequestListJson()), ...JSON.parse(second)]);
    const calls: string[][] = [];
    const adapter = adapterWith([runResult(candidates)], calls);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "ambiguous-provider-result");
    assert.equal(calls.length, 1, "ambiguous candidates must not trigger create");
    assert.deepEqual(store.listPullRequestRecordsForTask(taskId), []);
  } finally {
    store.close();
  }
});

test("a conflicting remote candidate fails closed instead of being adopted", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const calls: string[][] = [];
    const adapter = adapterWith([runResult(pullRequestListJson({ headRefOid: "different-sha" }))], calls);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "ambiguous-provider-result");
    assert.equal(calls.length, 1, "conflicting candidate must not trigger create");
  } finally {
    store.close();
  }
});

test("retry after PR-row persistence succeeds but lifecycle persistence fails reuses the recorded PR", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const calls: string[][] = [];
    const adapter = adapterWith([runResult("[]"), runResult("https://github.com/org/repository/pull/36")], calls);
    const updateTaskLifecycleState = store.updateTaskLifecycleState.bind(store);
    let failLifecyclePersistence = true;
    store.updateTaskLifecycleState = ((id, state) => {
      if (failLifecyclePersistence) {
        failLifecyclePersistence = false;
        throw new Error("simulated lifecycle persistence failure");
      }
      return updateTaskLifecycleState(id, state);
    }) as typeof store.updateTaskLifecycleState;

    const first = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.equal(first.reason, "local-state-write-failed");
      assert.equal(first.providerCreated, true);
    }
    assert.equal(store.listPullRequestRecordsForTask(taskId).length, 1);
    assert.equal(store.getTask(taskId)?.lifecycleState, "pushed");

    const recovered = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.reused, true);
    assert.equal(store.getTask(taskId)?.lifecycleState, "pull-request-open");
    assert.equal(calls.filter((args) => args[0] === "pr" && args[1] === "create").length, 1);
  } finally {
    store.close();
  }
});

test("retry after a lifecycle-transition failure reconciles the task instead of staying stuck", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    // record 成功後 transitionTask 失敗を模擬: PR record だけ先に書き込み、task は `pushed` のまま残す。
    store.recordPullRequest({
      taskId,
      provider: "github",
      repositoryId: "org/repository",
      prNumber: 36,
      url: "https://github.com/org/repository/pull/36",
      headSha: "abc123",
      lifecycleState: "open",
    });
    assert.equal(store.getTask(taskId)?.lifecycleState, "pushed");

    const adapter = adapterWith([]);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.reused, true);
      assert.equal(result.task.lifecycleState, "pull-request-open");
    }
    assert.equal(store.getTask(taskId)?.lifecycleState, "pull-request-open");
  } finally {
    store.close();
  }
});

test("provider failure leaves task and PR record state unchanged", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const adapter = adapterWith([runResult("", "provider unavailable", { exitCode: 1 })]);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, false);
    assert.equal(store.getTask(taskId)?.lifecycleState, "pushed");
    assert.deepEqual(store.listPullRequestRecordsForTask(taskId), []);
  } finally {
    store.close();
  }
});

test("missing head revision fails before the provider is called", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    const calls: string[][] = [];
    const adapter = adapterWith([runResult("https://github.com/org/repository/pull/36")], calls);
    const input = workflowInput(store, taskId, adapter);
    const result = await openWorkflowPullRequest({ ...input, head: { name: "feature/36" } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "head-sha-required");
    assert.equal(calls.length, 0, "gh pr create must not run without a head revision");
    assert.deepEqual(store.listPullRequestRecordsForTask(taskId), []);
  } finally {
    store.close();
  }
});

test("a task lifecycle state that cannot reach pull-request-open blocks the transition before the provider call", async () => {
  const { store, taskId } = pushedTaskStore();
  try {
    store.updateTaskLifecycleState(taskId, "merged");
    const calls: string[][] = [];
    const adapter = adapterWith([runResult("https://github.com/org/repository/pull/36")], calls);
    const result = await openWorkflowPullRequest(workflowInput(store, taskId, adapter));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "lifecycle-blocked");
    assert.equal(calls.length, 0, "gh pr create must not run when the lifecycle transition is blocked");
  } finally {
    store.close();
  }
});
