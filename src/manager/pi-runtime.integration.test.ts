import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../workflow/policy/presets.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import type { NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import type {
  WorkerRuntimeAdapter,
  WorkerRuntimeBinding,
  WorkerRuntimeControlReceipt,
  WorkerRuntimeIdentity,
  WorkerRuntimeObservation,
  WorkerRuntimeObservationEvent,
  WorkerRuntimeStartResult,
  WorkerRuntimeStatusReportInput,
  WorkerRuntimeSteerInput,
  WorkerRuntimeStopInput,
  WorkerRuntimeInput,
} from "./worker-runtime.js";
import { ManagerSessionService, type ManagerPiWorkerFactoryInput } from "./service.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";
import { createTempGitRepo } from "../test-support/tmp-git-repo.js";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import { startNawabariManagedTask } from "../test-support/nawabari-fixture.js";

class InertZellij implements ZellijRuntime {
  readonly started: string[] = [];

  async checkAvailability(): Promise<{ version: string }> {
    return { version: "inert-zellij 0.0.0" };
  }

  async inspect(_sessionName: string): Promise<ZellijObservedState> {
    return "absent";
  }

  async start(input: { sessionName: string }): Promise<void> {
    this.started.push(input.sessionName);
  }

  async attach(): Promise<void> {
    throw new Error("Pi SDK workers do not expose a terminal attachment");
  }

  async terminate(): Promise<void> {}

  binaryName(): string {
    return "inert-zellij";
  }
}

class FakePiWorker implements WorkerRuntimeAdapter {
  binding: WorkerRuntimeBinding | undefined;
  status: WorkerRuntimeStatusReportInput = {
    lifecycleState: "running",
    phase: "ready",
    activity: { kind: "idle" },
    progress: { completed: 0, current: null, remaining: null },
    attention: "none",
  };
  readonly calls: string[] = [];
  private readonly queued: WorkerRuntimeObservationEvent[] = [];
  private readonly waiters: ((event: WorkerRuntimeObservationEvent) => void)[] = [];
  private sequence = 0;

  async start(input: { identity: WorkerRuntimeIdentity }): Promise<WorkerRuntimeStartResult> {
    this.calls.push("start");
    this.binding = { identity: { ...input.identity }, boundAt: "2026-09-22T00:00:00.000Z" };
    this.emit({ kind: "started", binding: this.binding, observedAt: this.timestamp() });
    return { binding: this.binding };
  }

  async bind(input: { identity: WorkerRuntimeIdentity }): Promise<WorkerRuntimeStartResult> {
    this.calls.push("bind");
    this.binding = { identity: { ...input.identity }, boundAt: "2026-09-22T00:00:00.000Z" };
    return { binding: this.binding };
  }

  async observe(binding: WorkerRuntimeBinding): Promise<WorkerRuntimeObservation> {
    assert.deepEqual(binding, this.binding);
    this.calls.push("observe");
    return { binding, status: this.status, observedAt: this.timestamp() };
  }

  events(binding: WorkerRuntimeBinding): AsyncIterable<WorkerRuntimeObservationEvent> {
    assert.deepEqual(binding, this.binding);
    const next = async (): Promise<WorkerRuntimeObservationEvent> => {
      const queued = this.queued.shift();
      if (queued !== undefined) return queued;
      return new Promise((resolve) => this.waiters.push(resolve));
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: await next() }),
      }),
    };
  }

  async steer(input: WorkerRuntimeSteerInput): Promise<WorkerRuntimeControlReceipt> {
    assert.deepEqual(input.binding, this.binding);
    this.calls.push(`steer:${input.directive}`);
    return { operation: "steer", acceptedAt: this.timestamp() };
  }

  async stop(input: WorkerRuntimeStopInput): Promise<WorkerRuntimeControlReceipt> {
    assert.deepEqual(input.binding, this.binding);
    this.calls.push("stop");
    this.status = { ...this.status, lifecycleState: "stopped", phase: "complete", activity: { kind: "idle" } };
    this.emit({ kind: "stopped", binding: input.binding, observedAt: this.timestamp(), reason: input.reason });
    return { operation: "stop", acceptedAt: this.timestamp() };
  }

  async sendInput(input: WorkerRuntimeInput): Promise<WorkerRuntimeControlReceipt> {
    assert.deepEqual(input.binding, this.binding);
    this.calls.push(`input:${input.input}`);
    return { operation: "input", acceptedAt: this.timestamp() };
  }

  reportStatus(status: WorkerRuntimeStatusReportInput): void {
    assert.ok(this.binding);
    this.status = status;
    this.emit({ kind: "status", binding: this.binding, status, observedAt: this.timestamp() });
  }

  private timestamp(): string {
    this.sequence += 1;
    return `2026-09-22T00:00:${String(this.sequence).padStart(2, "0")}.000Z`;
  }

  private emit(event: WorkerRuntimeObservationEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(event);
    else this.queued.push(event);
  }
}

function evidenceFor(
  task: { taskId: string; nawabariSessionId?: string; baseCommit: string },
  worktree: string,
  branch: string,
): NawabariRepositoryEvidence {
  return {
    schemaVersion: 1,
    repository: `${worktree}/.git`,
    worktree,
    branchId: "branch-954",
    branch,
    sessionId: task.nawabariSessionId!,
    sessionState: "active",
    sessionCreatedAt: "2026-09-22T00:00:00Z",
    sessionUpdatedAt: "2026-09-22T00:00:01Z",
    baseRevision: task.baseCommit,
    baseRevisionProven: true,
    head: task.baseCommit,
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "evidence-954",
    raw: { ok: true, command: "repository evidence" },
  };
}

test("managed Pi admission binds a read-only worker and explicit controls", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const fixture = await startNawabariManagedTask(t, {
    root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "managed-pi-runtime",
    branchType: "feat",
    issueRef: "954",
  });
  const nawabari = fixture.nawabari;
  nawabari.listClaimEvidence = async () => ({ sessions: [], claims: [] });
  nawabari.repositoryEvidence = async () =>
    evidenceFor(fixture.task, fixture.worktree.canonicalPath, fixture.worktree.branchName);

  const authority: ManagerExecutionAuthority = {
    async start() {
      return {
        context: {
          taskId: fixture.task.taskId,
          executionSessionId: fixture.task.nawabariSessionId,
          worktreeId: undefined,
          worktreePath: fixture.worktree.canonicalPath,
          branchName: fixture.worktree.branchName,
          taskSlug: fixture.task.taskSlug,
          issueRef: fixture.task.issueRef,
          branchType: "feat",
          semanticLifecycleState: fixture.task.lifecycleState,
        },
      };
    },
    async validate() {
      return { ok: true };
    },
    async observe(context) {
      return { semanticLifecycleState: context.semanticLifecycleState, status: "task active", receipt: undefined };
    },
  };

  const adapter = new FakePiWorker();
  const zellij = new InertZellij();
  let factoryInput: ManagerPiWorkerFactoryInput | undefined;
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    nawabari,
    runtime: zellij,
    executionAuthority: authority,
    piWorkerFactory: async (input) => {
      factoryInput = input;
      return adapter;
    },
  });
  await service.initialize();

  const session = await service.start({
    agentKind: "pi",
    provider: "pi",
    instruction: "prompt text is not part of the worker context",
    taskSlug: fixture.task.taskSlug,
    issueRef: fixture.task.issueRef,
    branchType: "feat",
    canon: { prefix_id: "prefix-954", execution_state_id: "state-954" },
  });

  assert.equal(session.runtimeState, "running");
  assert.deepEqual(adapter.calls.slice(0, 4), [
    "start",
    "bind",
    "observe",
    "input:prompt text is not part of the worker context",
  ]);
  assert.equal(zellij.started.length, 0);
  assert.ok(factoryInput);
  const captured = factoryInput;
  assert.equal(captured.executionContext.repository.worktree, fixture.worktree.canonicalPath);
  assert.equal(captured.executionContext.task?.baseCommit, fixture.task.baseCommit);
  assert.equal(captured.executionSurface.tool.name, "mottainai_execution");
  assert.equal(captured.executionSurface.resourceLoader().uri, "mottainai://execution");
  const toolResult = await captured.executionSurface.tool.execute();
  assert.equal(toolResult.details.readOnly, true);
  assert.equal(toolResult.content[0]?.text.includes("prompt text"), false);

  adapter.reportStatus({
    lifecycleState: "running",
    phase: "executing",
    activity: { kind: "working", label: "bounded work" },
    progress: { completed: 1, current: "step 2", remaining: 2 },
    attention: "none",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const worker = service.getWorkerSupervision(session.sessionId);
  assert.equal(worker.progress?.current, "step 2");
  const observedCalls = adapter.calls.length;
  assert.equal(service.listWorkerSupervision()[0]?.progress?.current, "step 2");
  assert.equal(adapter.calls.length, observedCalls, "read-only worker projection must not observe or control Pi");

  await service.steer(session.sessionId, "continue bounded work");
  await service.stop(session.sessionId);
  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("steer") || call === "stop"),
    ["steer:continue bounded work", "stop"],
  );
  assert.deepEqual(
    store.listWorkerControlAudit(session.sessionId).map((audit) => audit.operation),
    ["input", "steer", "stop"],
  );
});
