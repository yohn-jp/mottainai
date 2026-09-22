import assert from "node:assert/strict";
import { test } from "node:test";
import { createSemanticExecutionPlan } from "../semantics/execution-plan.js";
import type { ManagerExecutionAuthority, ManagerExecutionContext } from "../workflow/domain/manager-execution.js";
import { createExecutionManifest } from "../workflow/domain/execution-manifest.js";
import { NawabariExecutionClient, type NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import type { TaskRecord } from "../workflow/state/store.js";
import { admitExecution } from "./execution-admission.js";

const task = {
  taskId: "task-953",
  instanceId: "instance-953",
  taskSlug: "issue-953",
  issueRef: "#953",
  nawabariSessionId: "01953000-0000-7000-8000-000000000953",
  lifecycleState: "active",
  version: 1,
  baseBranch: "epic/946-agent-runtime-supervision",
  baseCommit: "base-953",
  createdAt: 1,
  updatedAt: 1,
} as unknown as TaskRecord;

const manager: ManagerExecutionContext = {
  taskId: task.taskId,
  executionSessionId: task.nawabariSessionId,
  worktreeId: undefined,
  worktreePath: "/managed/worktree",
  branchName: "feat/953-execution-admission",
  taskSlug: task.taskSlug,
  issueRef: task.issueRef,
  branchType: "feat",
  semanticLifecycleState: "active",
};

const semanticPlan = createSemanticExecutionPlan({
  semanticTargets: [{ kind: "path", id: "src/manager/execution-admission.ts" }],
  claims: [{ resource: "src/manager/execution-admission.ts", mode: "exclusive-write" }],
  verification: {
    requiredChecks: ["node --test --import tsx src/manager/execution-admission.test.ts"],
    rationale: "admission proof",
  },
});

function evidence(overrides: Partial<NawabariRepositoryEvidence> = {}): NawabariRepositoryEvidence {
  return {
    schemaVersion: 1,
    repository: "/managed/repository/.git",
    worktree: "/managed/worktree",
    branchId: "branch-953",
    branch: "feat/953-execution-admission",
    sessionId: task.nawabariSessionId!,
    sessionState: "active",
    sessionCreatedAt: "2026-09-22T00:00:00Z",
    sessionUpdatedAt: "2026-09-22T00:00:01Z",
    baseRevision: "base-953",
    baseRevisionProven: true,
    head: "head-953",
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "evidence-953",
    raw: { ok: true, command: "evidence snapshot" },
    ...overrides,
  };
}

class FakeNawabari extends NawabariExecutionClient {
  readonly anchors: string[] = [];
  current = evidence();

  override async repositoryEvidence(input: { cwd: string; sessionId: string }): Promise<NawabariRepositoryEvidence> {
    this.anchors.push(`${input.cwd}:${input.sessionId}`);
    return this.current;
  }
}

function authority(calls: string[]): ManagerExecutionAuthority {
  return {
    async start() {
      throw new Error("not used by admission");
    },
    async validate(context) {
      calls.push(context.worktreePath);
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: undefined, receipt: undefined };
    },
  };
}

function input(nawabari: FakeNawabari, managerAuthority: ManagerExecutionAuthority) {
  return {
    task,
    manager,
    canon: { prefix_id: "prefix-953", execution_state_id: "state-953" },
    semanticPlan,
    nawabari,
    projectManifest: createExecutionManifest,
    managerAuthority,
    callerCwd: "/attacker/controlled/cwd",
  };
}

test("admission projects governed intent and revalidates through Nawabari", async () => {
  const nawabari = new FakeNawabari();
  const managerCalls: string[] = [];
  const result = await admitExecution(input(nawabari, authority(managerCalls)));

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.admitted, true);
  assert.equal(result.manifest.intent.task?.taskId, task.taskId);
  assert.equal(result.manifest.intent.manager?.executionSessionId, task.nawabariSessionId);
  assert.equal(result.manifest.attachment.physical?.worktree, "/managed/worktree");
  assert.equal(result.attachment.branch, "feat/953-execution-admission");
  assert.deepEqual(managerCalls, ["/managed/worktree"]);
  assert.deepEqual(nawabari.anchors, [`/managed/worktree:${task.nawabariSessionId}`]);
});

test("stale Nawabari evidence fails closed before runtime attachment", async () => {
  const nawabari = new FakeNawabari();
  nawabari.current = evidence({ sessionState: "stopped", complete: false, incompleteReasons: ["session stopped"] });
  const result = await admitExecution(input(nawabari, authority([])));

  assert.equal(result.ok, false);
  assert.equal(result.admitted, false);
  assert.equal(result.attachment, undefined);
  assert.equal(result.manifest.attachment.status, "stale");
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "nawabari-evidence-incomplete"),
    true,
  );
});

test("mismatched physical identity is ambiguous and cannot be attached", async () => {
  const nawabari = new FakeNawabari();
  nawabari.current = evidence({ branch: "feat/other-task" });
  const result = await admitExecution(input(nawabari, authority([])));

  assert.equal(result.ok, false);
  assert.equal(result.attachment, undefined);
  assert.equal(result.manifest.attachment.status, "ambiguous");
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "branch-mismatch"),
    true,
  );
});

test("a prior manifest attachment and caller cwd cannot redirect explicit execution identity", async () => {
  const nawabari = new FakeNawabari();
  const prior = createExecutionManifest({
    task,
    manager,
    semanticPlan,
    nawabari: {
      authority: "nawabari",
      evidence: evidence({ worktree: "/attacker/worktree", branch: "feat/attacker" }),
    },
  });
  const result = await admitExecution({ ...input(nawabari, authority([])), manifest: prior });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.attachment.worktree, "/managed/worktree");
  assert.equal(nawabari.anchors[0], `/managed/worktree:${task.nawabariSessionId}`);
});
