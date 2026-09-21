import assert from "node:assert/strict";
import test from "node:test";
import type { RunResult } from "../subprocess.js";
import { resolveCanon } from "./resolver.js";
import { NawabariExecutionClient, type NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import type { RepositoryInstanceId, RootCommitDigest } from "../workflow/domain/identity.js";
import type { RepositorySourceId, TaskId, TaskRecord, WorkflowStateStore } from "../workflow/state/store.js";

const sourceId = "source-1" as RepositorySourceId;
const instanceId = "instance-1" as RepositoryInstanceId;
const taskBase = "a".repeat(40);

function evidence(
  sessionId: string,
  worktree: string,
  branch: string,
  baseRevision = taskBase,
): NawabariRepositoryEvidence {
  return {
    schemaVersion: 1,
    repository: "/repo/.git",
    worktree,
    branchId: `refs/heads/${branch}`,
    branch,
    sessionId,
    sessionState: "active",
    sessionCreatedAt: "2026-01-01T00:00:00.000Z",
    sessionUpdatedAt: "2026-01-01T00:00:00.000Z",
    baseRevision,
    baseRevisionProven: true,
    head: taskBase,
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "b".repeat(64),
    raw: {
      ok: true,
      command: "evidence snapshot",
      generation: 1,
    },
  };
}

function task(taskId: string, sessionId?: string): TaskRecord {
  return {
    taskId: taskId as TaskId,
    instanceId,
    taskSlug: "canon-task",
    issueRef: "921",
    ...(sessionId === undefined ? {} : { nawabariSessionId: sessionId as TaskRecord["nawabariSessionId"] }),
    lifecycleState: "active",
    version: 1,
    baseBranch: "main",
    baseCommit: taskBase,
    createdAt: 1,
    updatedAt: 1,
  };
}

function storeFor(tasks: readonly TaskRecord[], pathCount = 1): WorkflowStateStore {
  return {
    getTask: (taskId: TaskId) => tasks.find((candidate) => candidate.taskId === taskId),
    listRepositoryPaths: () =>
      Array.from({ length: pathCount }, (_, index) => ({
        instanceId,
        canonicalPath: `/repo${index === 0 ? "" : `-${index}`}`,
        isCurrent: true,
        observedAt: 1,
      })),
    getRepositoryInstance: () => ({
      instanceId,
      sourceId,
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      lastSeenAt: 1,
    }),
    getRepositorySource: () => ({ sourceId, rootCommitDigest: "c".repeat(64) as RootCommitDigest, createdAt: 1 }),
  } as unknown as WorkflowStateStore;
}

class EvidenceClient extends NawabariExecutionClient {
  constructor(private readonly result: NawabariRepositoryEvidence) {
    super();
  }

  override async repositoryEvidence(): Promise<NawabariRepositoryEvidence> {
    return this.result;
  }
}

test("Nawabari repository evidence adapter consumes the machine JSON contract", async () => {
  const run = async (_command: string, args: readonly string[]): Promise<RunResult> => {
    if (args[0] === "capabilities")
      return {
        stdout: JSON.stringify({
          ok: true,
          command: "capabilities",
          schema_version: 1,
          contract_id: "nawabari.standalone-execution.v1",
          package_version: "0.6.1",
          capabilities: [
            {
              id: "resource-claims",
              commands: [
                "session create",
                "session id",
                "session show",
                "session inspect",
                "session list",
                "session claim",
                "session update",
                "session claims",
                "session release",
                "session close",
                "authorize",
                "checkpoint",
                "commit",
                "push",
                "gc",
                "evidence snapshot",
              ],
              claim_set_replacement: {
                commands: ["session update"],
                atomic: true,
                pairing: "adjacent-resource-mode",
                idempotent_retry: true,
                unchanged_on_rejection: true,
              },
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimit: false,
      };
    return {
      stdout: JSON.stringify({
        ok: true,
        command: "evidence snapshot",
        schema_version: 1,
        source: "git",
        guarantee: "git-observable-only",
        repository: "/repo/.git",
        worktree: "/repo-worktree",
        branch_id: "refs/heads/feat/example",
        branch: "feat/example",
        session_id: "00000000-0000-7000-8000-000000000001",
        session_state: "active",
        session_created_at: "2026-01-01T00:00:00.000Z",
        session_updated_at: "2026-01-01T00:00:00.000Z",
        base_revision: taskBase,
        base_revision_proven: true,
        head: taskBase,
        clean: true,
        complete: true,
        incomplete_reasons: [],
        paths: { changed: [], staged: [], unstaged: [], untracked: [], stats: [] },
        evidence_hash: "b".repeat(64),
        bounds: { max_paths: 4096, max_diff_paths: 64, max_diff_bytes: 65536, max_diff_hunks: 128 },
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimit: false,
    };
  };
  const client = new NawabariExecutionClient({ runner: { run } });
  const result = await client.repositoryEvidence({
    cwd: "/repo",
    sessionId: "00000000-0000-7000-8000-000000000001",
  });
  assert.equal(result.baseRevision, taskBase);
  assert.equal(result.head, taskBase);
  assert.equal(result.evidenceHash, "b".repeat(64));
});

test("explicit task resolution keeps prefix identity separate from physical attachment identity", async () => {
  const first = task("task-1", "00000000-0000-7000-8000-000000000001");
  const second = task("task-2", "00000000-0000-7000-8000-000000000002");
  const firstResult = await resolveCanon({
    store: storeFor([first, second]),
    taskId: first.taskId,
    nawabari: new EvidenceClient(evidence(first.nawabariSessionId!, "/repo-worktree-1", "feat/one")),
  });
  const secondResult = await resolveCanon({
    store: storeFor([first, second]),
    taskId: second.taskId,
    nawabari: new EvidenceClient(evidence(second.nawabariSessionId!, "/repo-worktree-2", "feat/two")),
  });
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  if (!firstResult.ok || !secondResult.ok) return;
  assert.equal(firstResult.prefix_id, secondResult.prefix_id);
  assert.notEqual(firstResult.execution_state_id, secondResult.execution_state_id);
  assert.equal(firstResult.executionAttachment.worktreeId, "/repo-worktree-1");
  assert.equal(secondResult.executionAttachment.branchName, "feat/two");
});

test("resolution fails closed when Nawabari's immutable base proof does not match the task", async () => {
  const managedTask = task("task-1", "00000000-0000-7000-8000-000000000001");
  const result = await resolveCanon({
    store: storeFor([managedTask]),
    taskId: managedTask.taskId,
    nawabari: new EvidenceClient(
      evidence(managedTask.nawabariSessionId!, "/repo-worktree", "feat/one", "d".repeat(40)),
    ),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "base-revision-mismatch");
  assert.equal(result.diagnostics.baseRevisionProven, true);
});

test("resolution rejects missing session references and ambiguous repository anchors", async () => {
  const legacyTask = task("task-legacy");
  const missingSession = await resolveCanon({
    store: storeFor([legacyTask]),
    taskId: legacyTask.taskId,
    nawabari: new NawabariExecutionClient(),
  });
  assert.equal(missingSession.ok, false);
  if (!missingSession.ok) assert.equal(missingSession.code, "task-session-missing");

  const managedTask = task("task-ambiguous", "00000000-0000-7000-8000-000000000003");
  const ambiguous = await resolveCanon({
    store: storeFor([managedTask], 2),
    taskId: managedTask.taskId,
    nawabari: new NawabariExecutionClient(),
  });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, "repository-path-unavailable");
});
