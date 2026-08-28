import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { resolveRepositoryIdentity } from "../domain/identity.js";
import { isContinuableLifecycleState } from "../domain/lifecycle.js";
import { transitionTask } from "../domain/task-lifecycle.js";
import type { ManagerSessionRecord, ManagerSessionId, WorkflowStateStore } from "../state/store.js";
import { ManagerError } from "../../manager/service.js";
import type { ManagerResourceScope, NewManagerSessionInput, ManagerSessionService } from "../../manager/service.js";
import {
  HARNESS_CAPABILITIES_TOOL_NAME,
  HARNESS_DELEGATION_TOOL_NAMES,
  callHarnessDelegationTool,
  harnessDelegationTools,
} from "./mcp-delegation.js";
import {
  HarnessDelegationService,
  HARNESS_DELEGATION_SCHEMA_VERSION,
  type HarnessOperationResult,
} from "../domain/harness-delegation.js";
import { NawabariExecutionClient } from "../nawabari.js";

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function fakeManager(store: WorkflowStateStore, workspaceRoot: string): ManagerSessionService {
  const start = async (input: NewManagerSessionInput): Promise<ManagerSessionRecord> => {
    const existing = store
      .listManagerSessions(workspaceRoot)
      .find((candidate) => candidate.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) return existing;
    const identity = resolveRepositoryIdentity(workspaceRoot);
    if (!identity.ok) throw new Error(identity.reason);
    store.observeRepositoryInstance({
      rootCommitDigest: identity.identity.rootCommitDigest,
      instanceId: identity.identity.instanceId,
      gitCommonDir: identity.identity.gitCommonDir,
      canonicalWorktreePath: identity.identity.worktreePath,
    });
    const taskResult = store.reserveTask({
      instanceId: identity.identity.instanceId,
      taskSlug: input.taskSlug!,
      issueRef: input.issueRef,
      baseBranch: "main",
      baseCommit: runGit(["rev-parse", "HEAD"], workspaceRoot),
      allowMultipleActiveTasksPerIssue: true,
    });
    if (!taskResult.ok) throw new Error(taskResult.existingTask.taskId);
    const active = transitionTask(store, taskResult.task.taskId, "active");
    if (!active.ok) throw new Error(active.blocked.blockingRule);
    return store.createManagerSession({
      sessionId: "00000000-0000-4000-8000-000000000548" as ManagerSessionId,
      workspaceRoot,
      idempotencyKey: input.idempotencyKey,
      taskId: taskResult.task.taskId,
      executionSessionId: "nawabari-session-548",
      executionMode: "task-bound",
      worktreePath: workspaceRoot,
      branchName: `feat/${input.taskSlug}`,
      agentKind: "codex",
      launchProfile: "codex",
      instruction: input.instruction,
      launchCommand: "codex",
      launchArgs: ["--", input.instruction],
      runtimeName: "mottainai-harness-runtime",
      lifecycleState: "running",
      runtimeState: "running",
      semanticLifecycleState: "active",
    });
  };
  const manager = {
    start,
    get: async (sessionId: ManagerSessionId): Promise<ManagerSessionRecord> => {
      const session = store.getManagerSession(sessionId);
      if (session === undefined) throw new Error("manager session missing");
      return session;
    },
    continueWork: async (sessionId: ManagerSessionId, followUp: string): Promise<ManagerSessionRecord> => {
      const session = store.getManagerSession(sessionId);
      if (session === undefined) throw new Error("manager session missing");
      // Mirror ManagerSessionService.continueWork()'s real eligibility gate so
      // this fake stays faithful to the authority the harness now defers to.
      // Production reconciles semanticLifecycleState from the task before this
      // check; this fake reads the task directly to reproduce that freshness.
      const task = session.taskId === undefined ? undefined : store.getTask(session.taskId);
      const currentState = task?.lifecycleState ?? session.semanticLifecycleState;
      const continuable = currentState !== "unbound" && isContinuableLifecycleState(currentState);
      if (!continuable)
        throw new ManagerError(
          "session_continue_rejected",
          `cannot continue a session whose semantic task lifecycle is ${currentState}`,
        );
      return store.updateManagerSession(sessionId, {
        instruction: `${session.instruction}\n${followUp}`,
        launchArgs: ["--", `${session.instruction}\n${followUp}`],
        restartCount: session.restartCount + 1,
        runtimeState: "running",
        lifecycleState: "running",
      });
    },
    stop: async (sessionId: ManagerSessionId): Promise<ManagerSessionRecord> =>
      store.updateManagerSession(sessionId, {
        lifecycleState: "stopped",
        runtimeState: "stopped",
        attachable: false,
        terminationState: "stopped",
      }),
  } as unknown as ManagerSessionService;
  return manager;
}

test("native delegation tools expose a versioned bounded surface", async () => {
  const names = harnessDelegationTools().map((tool) => tool.name);
  assert.deepEqual(names, [...HARNESS_DELEGATION_TOOL_NAMES, HARNESS_CAPABILITIES_TOOL_NAME]);
  for (const tool of harnessDelegationTools()) {
    assert.equal(tool.outputSchema?.required?.includes("schemaVersion"), true);
    assert.equal(tool.outputSchema?.required?.includes("workId"), true);
  }
  const capabilities = structured(await callHarnessDelegationTool(HARNESS_CAPABILITIES_TOOL_NAME, {}, undefined));
  assert.equal(capabilities.schemaVersion, HARNESS_DELEGATION_SCHEMA_VERSION);
  assert.deepEqual((capabilities.capabilities as Record<string, unknown>).statuses, ["accepted", "running", "completed", "failed", "cancelled", "blocked", "missing"]);
  assert.equal((capabilities.capabilities as Record<string, unknown>).launch instanceof Object, true);
  assert.equal(
    ((capabilities.capabilities as Record<string, unknown>).launch as Record<string, unknown>).executable,
    "mottainai-mcp",
  );
});

test("delegate retry, keyed inspect/continue/cancel remain on one work identity", async (t) => {
  const workspaceRoot = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const manager = fakeManager(store, workspaceRoot);
  const service = new HarnessDelegationService({
    defaultWorkspaceRoot: workspaceRoot,
    store: async () => store,
    nawabari: new NawabariExecutionClient(),
    managerForWorkspace: async () => manager,
  });
  const constraints: ManagerResourceScope = { paths: ["src"], claims: [{ resource: "src", mode: "read" }] };
  const first = await service.delegate({
    goal: "inspect the selected source",
    idempotencyKey: "harness-test-key",
    constraints,
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, "running");
  assert.equal(typeof first.work?.workId, "string");
  const workId = first.work!.workId;
  const retry = await service.delegate({
    goal: "inspect the selected source",
    idempotencyKey: "harness-test-key",
    constraints,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.work?.workId, workId);
  assert.equal(store.listTasks().length, 1);

  const inspected = await service.inspect(workId);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.work?.workId, workId);
  const serialized = JSON.stringify(inspected);
  assert.doesNotMatch(serialized, /worktreePath|runtimeName|launchArgs|initial instruction/u);

  const continued = await service.continueWork({ workId, followUp: "record the result" });
  assert.equal(continued.ok, true);
  assert.equal(continued.work?.workId, workId);
  assert.equal(store.listTasks().length, 1);

  const cancelled = await service.cancelWork({ workId, reason: "test cancellation" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.work?.lifecycle.taskState, "abandoned");

  const terminalContinue = await service.continueWork({ workId, followUp: "must be rejected" });
  assert.equal(terminalContinue.ok, false);
  assert.equal(terminalContinue.status, "cancelled");
  assert.equal(terminalContinue.error?.class, "lifecycle_conflict");

  const missing = structured(await callHarnessDelegationTool("mottainai_inspect_work", { workId: "missing-work" }, service));
  assert.equal(missing.status, "missing");
  assert.equal((missing.error as Record<string, unknown>).class, "lifecycle_conflict");
});

test("native delegation output schemas declare closed nested shapes, not opaque objects", async () => {
  for (const tool of harnessDelegationTools()) {
    const schema = tool.outputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of ["lifecycle", "identity", "outcome", "evidence", "error"] as const) {
      const nested = properties[key];
      assert.ok(nested, `${tool.name} is missing ${key} in its output schema`);
      assert.ok(nested.properties, `${tool.name}.${key} must declare explicit nested properties`);
      assert.equal(nested.additionalProperties, false, `${tool.name}.${key} must be a closed schema`);
    }
    const artifacts = properties.artifacts as Record<string, unknown>;
    const artifactItems = artifacts.items as Record<string, unknown>;
    assert.equal(artifactItems.additionalProperties, false);
    assert.ok(artifactItems.properties);
  }
  const capabilitiesTool = harnessDelegationTools().find((tool) => tool.name === HARNESS_CAPABILITIES_TOOL_NAME)!;
  const capabilitiesSchema = (capabilitiesTool.outputSchema as Record<string, unknown>).properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(capabilitiesSchema.capabilities.additionalProperties, false);
  assert.ok(capabilitiesSchema.capabilities.properties);
});

test("handler rejects unversioned unknown input without invoking orchestration", async () => {
  let invoked = false;
  const fake = {
    delegate: async (): Promise<HarnessOperationResult> => {
      invoked = true;
      return { ok: true, status: "accepted" };
    },
  } as unknown as HarnessDelegationService;
  const result = await callHarnessDelegationTool("mottainai_delegate_work", { goal: "x", unexpected: true }, fake);
  const content = structured(result);
  assert.equal(result.isError, true);
  assert.equal(content.status, "failed");
  assert.equal((content.error as Record<string, unknown>).class, "invalid_input");
  assert.equal(invoked, false);
});
