import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../../test-support/workflow-store.js";
import { ManagerError } from "../../manager/service.js";
import type {
  ManagerResourceScope,
  ManagerSessionService,
  NewManagerSessionInput,
} from "../../manager/service.js";
import { resolveRepositoryIdentity } from "../domain/identity.js";
import { isContinuableLifecycleState } from "../domain/lifecycle.js";
import { transitionTask } from "../domain/task-lifecycle.js";
import {
  HarnessDelegationService,
  HARNESS_DELEGATION_SCHEMA_VERSION,
  type HarnessOperationResult,
} from "../domain/harness-delegation.js";
import { NawabariExecutionClient } from "../nawabari.js";
import type {
  ManagerSessionId,
  ManagerSessionRecord,
  WorkflowStateStore,
} from "../state/store.js";
import {
  HARNESS_CAPABILITIES_TOOL_NAME,
  HARNESS_DELEGATION_TOOL_NAMES,
  callHarnessDelegationTool,
  harnessDelegationTools,
} from "./mcp-delegation.js";

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

  return {
    start,
    get: async (sessionId: ManagerSessionId): Promise<ManagerSessionRecord> => {
      const session = store.getManagerSession(sessionId);
      if (session === undefined) throw new Error("manager session missing");
      return session;
    },
    continueWork: async (sessionId: ManagerSessionId, followUp: string): Promise<ManagerSessionRecord> => {
      const session = store.getManagerSession(sessionId);
      if (session === undefined) throw new Error("manager session missing");
      const task = session.taskId === undefined ? undefined : store.getTask(session.taskId);
      const state = task?.lifecycleState ?? session.semanticLifecycleState;
      if (state === "unbound" || !isContinuableLifecycleState(state)) {
        throw new ManagerError(
          "session_continue_rejected",
          `cannot continue a session whose semantic task lifecycle is ${state}`,
        );
      }
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
}

test("native delegation exposes only the bounded public harness surface", async () => {
  assert.deepEqual(harnessDelegationTools().map((tool) => tool.name), [
    ...HARNESS_DELEGATION_TOOL_NAMES,
    HARNESS_CAPABILITIES_TOOL_NAME,
  ]);
  for (const tool of harnessDelegationTools()) {
    assert.equal(tool.outputSchema?.required?.includes("schemaVersion"), true);
    assert.equal(tool.outputSchema?.required?.includes("workId"), true);
    assert.equal(tool.outputSchema?.required?.includes("lifecycle"), true);
    assert.equal(tool.outputSchema?.required?.includes("evidence"), true);
    assert.equal(tool.outputSchema?.required?.includes("artifacts"), true);
  }

  const result = structured(await callHarnessDelegationTool(HARNESS_CAPABILITIES_TOOL_NAME, {}, undefined));
  const capabilities = result.capabilities as Record<string, unknown>;
  assert.equal(result.schemaVersion, HARNESS_DELEGATION_SCHEMA_VERSION);
  assert.equal(capabilities.executable, "mottainai-mcp");
  assert.deepEqual(capabilities.tools, [...HARNESS_DELEGATION_TOOL_NAMES]);
});

test("keyed delegate retry, inspect, continue, and cancel stay on one work identity", async (t) => {
  const workspaceRoot = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const manager = fakeManager(store, workspaceRoot);
  const service = new HarnessDelegationService({
    defaultWorkspaceRoot: workspaceRoot,
    store: async () => store,
    nawabari: new NawabariExecutionClient(),
    managerForWorkspace: async () => manager,
  });
  const constraints: ManagerResourceScope = {
    paths: ["src"],
    claims: [{ resource: "src", mode: "read" }],
  };

  const first = await service.delegate({
    goal: "inspect the selected source",
    idempotencyKey: "harness-test-key",
    constraints,
  });
  assert.equal(first.ok, true);
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
  assert.doesNotMatch(JSON.stringify(inspected), /worktreePath|runtimeName|launchArgs|initial instruction/u);

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
  assert.equal(terminalContinue.error?.class, "lifecycle_conflict");

  const missing = structured(
    await callHarnessDelegationTool("mottainai_inspect_work", { workId: "missing-work" }, service),
  );
  assert.equal(missing.status, "missing");
  assert.equal((missing.error as Record<string, unknown>).class, "lifecycle_conflict");
});

test("result schemas are closed and bounded without a second result taxonomy", () => {
  for (const tool of harnessDelegationTools()) {
    const schema = tool.outputSchema as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.lifecycle.additionalProperties, false);
    assert.equal(properties.evidence.additionalProperties, false);
    assert.equal((properties.artifacts.items as Record<string, unknown>).additionalProperties, false);
    assert.equal("identity" in properties, false);
    assert.equal("outcome" in properties, false);
    assert.equal("facts" in properties, false);
    assert.equal("metrics" in properties, false);
  }
});

test("handler rejects unknown input before invoking orchestration", async () => {
  let invoked = false;
  const fake = {
    delegate: async (): Promise<HarnessOperationResult> => {
      invoked = true;
      return { ok: true, status: "accepted" };
    },
  } as unknown as HarnessDelegationService;
  const result = await callHarnessDelegationTool(
    "mottainai_delegate_work",
    { goal: "x", unexpected: true },
    fake,
  );
  const content = structured(result);
  assert.equal(result.isError, true);
  assert.equal(content.status, "failed");
  assert.equal((content.error as Record<string, unknown>).class, "invalid_input");
  assert.equal(invoked, false);
});
