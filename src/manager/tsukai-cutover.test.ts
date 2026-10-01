import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createFileDurableStore,
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type AdmittedExecutionProfile,
  type PiAttachResult,
  type PiDuplexExecution,
  type PiDuplexExecutionPort,
  type PiRuntime,
  type PiTransportObserver,
} from "tsukai";
import { BUILTIN_PRESETS } from "../workflow/policy/presets.js";
import type { ManagerExecutionAuthority } from "../workflow/domain/manager-execution.js";
import type { NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import type { WorkflowStateStore } from "../workflow/state/store.js";
import { ManagerSessionService } from "./service.js";
import { TSUKAI_GUARD_EXTENSION_ID, tsukaiStartKey, type ManagerTsukaiRuntimeFactory } from "./tsukai-integration.js";
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
    throw new Error("Tsukai AgentRuns do not expose a terminal attachment");
  }

  async terminate(): Promise<void> {}

  binaryName(): string {
    return "inert-zellij";
  }
}

/** Scripted Pi RPC process standing in for one Jinushi Run. */
class FakePiProcess {
  readonly prompts: string[] = [];
  aborts = 0;
  exited = false;
  private readonly stdout: Buffer[] = [];

  constructor(
    readonly executionRunId: string,
    public observer: PiTransportObserver,
  ) {}

  execution(): PiDuplexExecution {
    return {
      executionRunId: this.executionRunId,
      backend: "fake-jinushi",
      write: async (bytes) => {
        for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
          if (line.trim().length > 0) this.command(JSON.parse(line) as { id: string; type: string; message?: string });
        }
      },
      closeInput: async () => {},
      retire: async (reason) => this.exit(reason === "cancel" ? null : 0, reason === "cancel" ? "SIGTERM" : null),
    };
  }

  replay(): void {
    for (const chunk of this.stdout) this.observer.onStdout(chunk);
  }

  complete(text: string): void {
    this.emit({ type: "agent_start" });
    this.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
  }

  private command(command: { id: string; type: string; message?: string }): void {
    const respond = (data?: unknown) =>
      queueMicrotask(() => this.emit({ id: command.id, type: "response", command: command.type, success: true, data }));
    if (command.type === "get_state") respond({ sessionId: `pi-${this.executionRunId}` });
    else if (command.type === "prompt") {
      this.prompts.push(command.message ?? "");
      respond({ disposition: "started" });
    } else if (command.type === "abort") {
      this.aborts += 1;
      respond();
    }
  }

  private emit(record: unknown): void {
    const chunk = Buffer.from(`${JSON.stringify(record)}\n`);
    this.stdout.push(chunk);
    this.observer.onStdout(chunk);
  }

  private exit(exitCode: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() =>
      this.observer.onExit({ executionRunId: this.executionRunId, status: "exited", exitCode, signal, forced: false }),
    );
  }
}

/** Jinushi stand-in: owns every fake Pi process and survives Manager restarts. */
class FakeJinushi implements PiDuplexExecutionPort {
  readonly executionProfile = "projected" as const;
  readonly opens: {
    agentRunId: string;
    workspace: { cwd: string; workspaceSessionId?: string } | undefined;
    profile: AdmittedExecutionProfile | undefined;
  }[] = [];
  readonly processes = new Map<string, FakePiProcess>();

  async open(
    agentRunId: string,
    observer: PiTransportObserver,
    workspace?: { cwd: string; workspaceSessionId?: string },
    profile?: AdmittedExecutionProfile,
  ): Promise<PiDuplexExecution> {
    this.opens.push({ agentRunId, workspace, profile });
    const process = new FakePiProcess(`exec-${agentRunId}`, observer);
    this.processes.set(agentRunId, process);
    return process.execution();
  }

  async attach(
    executionRunId: string,
    observer: PiTransportObserver,
    _resume: { eventSeq: number; stderrOffset: number },
    onOpen: (execution: PiDuplexExecution) => void,
  ): Promise<PiAttachResult> {
    const process = [...this.processes.values()].find((candidate) => candidate.executionRunId === executionRunId);
    if (process === undefined || process.exited) return { status: "missing", reason: "fake Jinushi Run is gone" };
    process.observer = observer;
    const execution = process.execution();
    onOpen(execution);
    process.replay();
    return { status: "attached", execution };
  }

  async detach(): Promise<void> {}

  async dispose(): Promise<void> {}

  process(agentRunId: string): FakePiProcess {
    const process = this.processes.get(agentRunId);
    assert.ok(process, `no fake Pi process for ${agentRunId}`);
    return process;
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
    branchId: "branch-986",
    branch,
    sessionId: task.nawabariSessionId!,
    sessionState: "active",
    sessionCreatedAt: "2026-10-01T00:00:00Z",
    sessionUpdatedAt: "2026-10-01T00:00:01Z",
    baseRevision: task.baseCommit,
    baseRevisionProven: true,
    head: task.baseCommit,
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "evidence-986",
    raw: { ok: true, command: "repository evidence" },
  };
}

interface CutoverHarness {
  store: WorkflowStateStore;
  jinushi: FakeJinushi;
  zellij: InertZellij;
  fixture: Awaited<ReturnType<typeof startNawabariManagedTask>>;
  creates: () => number;
  /** A fresh Manager process over the same durable state, Tsukai store, and Jinushi. */
  manager(overrides?: { tsukai?: ManagerTsukaiRuntimeFactory }): Promise<ManagerSessionService>;
}

async function cutoverHarness(t: TestContext): Promise<CutoverHarness> {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  const tsukaiDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-tsukai-cutover-"));
  const fixture = await startNawabariManagedTask(t, {
    root,
    store,
    policy: BUILTIN_PRESETS.standard,
    taskSlug: "tsukai-cutover",
    branchType: "feat",
    issueRef: "986",
  });
  fixture.nawabari.listClaimEvidence = async () => ({ sessions: [], claims: [] });
  fixture.nawabari.repositoryEvidence = async () =>
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
  const jinushi = new FakeJinushi();
  const zellij = new InertZellij();
  const runtimes: PiRuntime[] = [];
  const services: ManagerSessionService[] = [];
  let creates = 0;
  t.after(async () => {
    for (const service of services) await service.close().catch(() => undefined);
    for (const runtime of runtimes) await runtime.detach().catch(() => undefined);
    fs.rmSync(tsukaiDir, { recursive: true, force: true });
  });
  return {
    store,
    jinushi,
    zellij,
    fixture,
    creates: () => creates,
    async manager(overrides = {}) {
      const service = new ManagerSessionService({
        workspaceRoot: root,
        store,
        nawabari: fixture.nawabari,
        runtime: zellij,
        executionAuthority: authority,
        tsukai:
          overrides.tsukai ??
          (async () => {
            const runtime = createPiRuntime({
              execution: jinushi,
              piVersion: SUPPORTED_PI_VERSION,
              piRevision: SUPPORTED_PI_REVISION,
              durableStore: createFileDurableStore({ dir: tsukaiDir, fsync: false }),
            });
            runtimes.push(runtime);
            const create = runtime.runs.create.bind(runtime.runs);
            runtime.runs.create = async (input) => {
              creates += 1;
              return create(input);
            };
            return runtime;
          }),
      });
      services.push(service);
      await service.initialize();
      return service;
    },
  };
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startPi(harness: CutoverHarness, service: ManagerSessionService, instruction = "implement the cutover") {
  return service.start({
    agentKind: "pi",
    instruction,
    taskSlug: harness.fixture.task.taskSlug,
    issueRef: harness.fixture.task.issueRef,
    branchType: "feat",
    canon: { prefix_id: "prefix-986", execution_state_id: "state-986" },
  });
}

function currentAgentRunId(store: WorkflowStateStore, sessionId: string, attempt: number): string {
  const correlation = store.getTsukaiRunCorrelation(tsukaiStartKey(sessionId as never, attempt));
  assert.ok(correlation?.agentRunId, `attempt ${attempt} has no bound AgentRun`);
  return correlation.agentRunId;
}

test("production Pi assignment creates a Tsukai AgentRun and observes, replays, and reads its result through Tsukai", async (t) => {
  const harness = await cutoverHarness(t);
  const service = await harness.manager();
  const session = await startPi(harness, service);

  assert.equal(harness.creates(), 1);
  assert.equal(harness.zellij.started.length, 0, "Pi never launches through the Zellij CLI path");
  const agentRunId = currentAgentRunId(harness.store, session.sessionId, 0);
  assert.equal(session.latestReceipt?.code, "agent_run_created");
  assert.ok(session.runtimeState === "starting" || session.runtimeState === "running");

  // Jinushi received the Nawabari-admitted workspace unchanged and the admitted profile.
  const opened = harness.jinushi.opens.find((open) => open.agentRunId === agentRunId);
  assert.ok(opened);
  assert.deepEqual(opened.workspace, {
    cwd: harness.fixture.worktree.canonicalPath,
    workspaceSessionId: harness.fixture.task.nawabariSessionId,
  });
  assert.deepEqual(opened.profile?.effective.tools.map((tool) => tool.name).sort(), ["bash", "edit", "read", "write"]);
  assert.deepEqual(
    opened.profile?.extensions.map((extension) => extension.id),
    [TSUKAI_GUARD_EXTENSION_ID],
  );

  const pi = harness.jinushi.process(agentRunId);
  await eventually(
    () => pi.prompts.length,
    (count) => count === 1,
    "prompt dispatch",
  );
  assert.match(pi.prompts[0]!, /# Mottainai governed execution/u);
  assert.match(pi.prompts[0]!, /implement the cutover$/u);
  assert.ok(pi.prompts[0]!.includes(harness.fixture.worktree.canonicalPath));

  const running = await eventually(
    () => service.get(session.sessionId),
    (record) => record.runtimeState === "running",
    "running AgentRun",
  );
  assert.match(running.latestStatus ?? "", new RegExp(`Tsukai AgentRun ${agentRunId} is running`, "u"));
  const worker = service.getWorkerSupervision(session.sessionId);
  assert.equal(worker.agentRun?.provenance, "tsukai");
  assert.equal(worker.agentRun?.agentRunId, agentRunId);
  assert.equal(worker.agentRun?.lifecycle, "running");
  // Legacy self-reported fields are unavailable, never defaulted to idle or zero.
  assert.equal(worker.usage, null);
  assert.equal(worker.progress, null);
  assert.equal(worker.lifecycleState, null);
  assert.equal(harness.store.getWorkerSupervision(session.sessionId), undefined, "no duplicate worker supervision");
  assert.equal(service.getWorkerResult(session.sessionId).ready, false);

  pi.complete("cutover done");
  const exited = await eventually(
    () => service.get(session.sessionId),
    (record) => record.runtimeState === "exited",
    "terminal AgentRun",
  );
  assert.equal(exited.lifecycleState, "exited");
  assert.equal(exited.latestReceipt?.code, "agent_run_completed");
  assert.equal(exited.exitCode, 0);

  const result = service.getWorkerResult(session.sessionId);
  assert.equal(result.provenance, "tsukai");
  assert.equal(result.ready, true);
  assert.equal(result.ready && result.outcome, "completed");
  assert.equal(result.ready && result.reportedText, "cutover done");

  const events = service.getWorkerEvents(session.sessionId);
  assert.equal(events.agentRunId, agentRunId);
  assert.equal(events.gap, false);
  assert.ok(events.items.some((event) => event.kind === "harness.prompt_accepted"));
  const replayTail = service.getWorkerEvents(session.sessionId, { afterSeq: events.items[1]!.seq, limit: 2 });
  assert.equal(replayTail.items[0]?.seq, events.items[2]?.seq);

  const detail = service.getWorkerSupervision(session.sessionId);
  assert.equal(detail.agentRunObservation?.run?.outcome, "completed");
  assert.ok(detail.agentRunObservation?.metrics);
  assert.equal(detail.agentRunObservation?.completeness?.status, "complete");
  assert.equal(harness.creates(), 1);
});

test("cancellation flows through Tsukai scoped control and steer is not invented", async (t) => {
  const harness = await cutoverHarness(t);
  const service = await harness.manager();
  const session = await startPi(harness, service);
  const agentRunId = currentAgentRunId(harness.store, session.sessionId, 0);
  await eventually(
    () => service.get(session.sessionId),
    (record) => record.runtimeState === "running",
    "running AgentRun",
  );

  await assert.rejects(
    service.steer(session.sessionId, "change course"),
    (error: Error & { code?: string }) => error.code === "agent_run_capability_unsupported",
  );

  const stopping = await service.stop(session.sessionId);
  assert.notEqual(stopping.runtimeState, "exited");
  const stopped = await eventually(
    () => service.get(session.sessionId),
    (record) => record.runtimeState === "stopped",
    "cancelled AgentRun",
  );
  assert.equal(stopped.terminationState, "stopped");
  assert.equal(harness.jinushi.process(agentRunId).aborts, 1);
  const result = service.getWorkerResult(session.sessionId);
  assert.equal(result.ready && result.outcome, "cancelled");
  assert.equal(harness.creates(), 1);
});

test("retry is a new attempt with a distinct AgentRun and never resurrects the terminal run", async (t) => {
  const harness = await cutoverHarness(t);
  const service = await harness.manager();
  const session = await startPi(harness, service);
  const first = currentAgentRunId(harness.store, session.sessionId, 0);

  await assert.rejects(
    service.restart(session.sessionId),
    (error: Error & { code?: string }) => error.code === "session_restart_rejected",
    "a live AgentRun is never overlapped by a retry",
  );

  harness.jinushi.process(first).complete("first attempt");
  await eventually(
    () => service.get(session.sessionId),
    (record) => record.runtimeState === "exited",
    "first attempt terminal",
  );

  const retried = await service.restart(session.sessionId);
  assert.equal(retried.restartCount, 1);
  assert.equal(retried.latestReceipt?.code, "agent_run_created");
  const second = currentAgentRunId(harness.store, session.sessionId, 1);
  assert.notEqual(second, first);
  assert.equal(harness.creates(), 2);

  // Orchestration correlation survives: both runs belong to the same Manager session.
  assert.deepEqual(
    harness.store.listTsukaiRunCorrelations(session.sessionId).map((correlation) => correlation.agentRunId),
    [first, second],
  );
  const worker = service.getWorkerSupervision(session.sessionId);
  assert.equal(worker.agentRun?.agentRunId, second);
  assert.equal(worker.agentRun?.attempt, 1);
  assert.equal(worker.identity.managerSessionId, session.sessionId);

  // The terminal first run is untouched by the retry.
  const firstProcess = harness.jinushi.process(first);
  assert.equal(firstProcess.prompts.length, 1);
  assert.equal(harness.jinushi.opens.filter((open) => open.agentRunId === first).length, 1);
});

test("an idempotent start retry for a live AgentRun returns it without creating another", async (t) => {
  const harness = await cutoverHarness(t);
  const service = await harness.manager();
  const input = {
    agentKind: "pi" as const,
    instruction: "idempotent launch",
    taskSlug: harness.fixture.task.taskSlug,
    issueRef: harness.fixture.task.issueRef,
    branchType: "feat",
    idempotencyKey: "launch-986",
    canon: { prefix_id: "prefix-986", execution_state_id: "state-986" },
  };
  const first = await service.start(input);
  const again = await service.start(input);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(harness.creates(), 1);
});

test("Manager restart reconciles the durable agentRunId with Tsukai before anything is created", async (t) => {
  const harness = await cutoverHarness(t);
  const before = await harness.manager();
  const session = await startPi(harness, before);
  const agentRunId = currentAgentRunId(harness.store, session.sessionId, 0);
  await eventually(
    () => before.get(session.sessionId),
    (record) => record.runtimeState === "running",
    "running AgentRun",
  );
  await before.close();

  const after = await harness.manager();
  const reconnected = await after.get(session.sessionId);
  assert.equal(harness.creates(), 1, "restart never creates a duplicate AgentRun");
  assert.equal(reconnected.runtimeState, "running");
  assert.equal(currentAgentRunId(harness.store, session.sessionId, 0), agentRunId);
  const worker = after.getWorkerSupervision(session.sessionId);
  assert.equal(worker.agentRun?.agentRunId, agentRunId);
  assert.equal(worker.agentRun?.recovery?.state, "attached");

  harness.jinushi.process(agentRunId).complete("finished after reconnect");
  const exited = await eventually(
    () => after.get(session.sessionId),
    (record) => record.runtimeState === "exited",
    "terminal after reconnect",
  );
  assert.equal(exited.latestReceipt?.code, "agent_run_completed");
  assert.equal(harness.creates(), 1);
});

test("a start reserved but unbound before a crash is recovered from Tsukai, not created again", async (t) => {
  const harness = await cutoverHarness(t);
  const before = await harness.manager();
  const session = await startPi(harness, before);
  const startKey = tsukaiStartKey(session.sessionId, 0);
  const agentRunId = currentAgentRunId(harness.store, session.sessionId, 0);
  await before.close();

  // Simulate a crash between Tsukai create and the durable bind.
  const db = (
    harness.store as unknown as { handle(): { prepare(sql: string): { run(...args: unknown[]): void } } }
  ).handle();
  db.prepare("UPDATE tsukai_run_correlations SET agent_run_id = NULL, bound_at = NULL WHERE start_key = ?").run(
    startKey,
  );

  const after = await harness.manager();
  await after.get(session.sessionId);
  assert.equal(harness.creates(), 1);
  assert.equal(harness.store.getTsukaiRunCorrelation(startKey)?.agentRunId, agentRunId);
});

test("unconfirmed AgentRun state stays uncertain and is never strengthened or retried", async (t) => {
  const harness = await cutoverHarness(t);
  const before = await harness.manager();
  const session = await startPi(harness, before);
  const agentRunId = currentAgentRunId(harness.store, session.sessionId, 0);
  await eventually(
    () => before.get(session.sessionId),
    (record) => record.runtimeState === "running",
    "running AgentRun",
  );
  await before.close();

  // Jinushi can no longer prove the execution's state: Tsukai reports it unresolved.
  harness.jinushi.attach = async () => ({ status: "ambiguous", reason: "fake Jinushi lost ownership evidence" });
  const after = await harness.manager();
  const observed = await after.get(session.sessionId);
  assert.equal(observed.runtimeState, "stale");
  assert.equal(observed.reconciliationState, "unresolved");
  assert.equal(observed.lifecycleState, "running", "Manager lifecycle is not advanced on uncertain evidence");
  const worker = after.getWorkerSupervision(session.sessionId);
  assert.equal(worker.agentRun?.agentRunId, agentRunId);
  assert.notEqual(worker.agentRun?.lifecycle, "terminal");
  assert.notEqual(worker.agentRun?.lifecycle, "running");
  assert.equal(worker.usage, null);
  assert.equal(after.getWorkerResult(session.sessionId).ready, false);

  await assert.rejects(
    after.restart(session.sessionId),
    (error: Error & { code?: string }) => error.code === "session_restart_rejected",
  );
  assert.equal(harness.creates(), 1);
});

test("an unavailable Tsukai runtime fails admitted Pi launches explicitly and never falls back", async (t) => {
  const harness = await cutoverHarness(t);
  const service = await harness.manager({
    tsukai: async () => {
      throw new Error("MOTTAINAI_JINUSHI_STATE_DIR is not configured");
    },
  });
  await assert.rejects(
    startPi(harness, service, "no fallback"),
    /Tsukai AgentRun runtime is unavailable: MOTTAINAI_JINUSHI_STATE_DIR is not configured/u,
  );
  assert.equal(harness.zellij.started.length, 0);
  assert.equal(harness.jinushi.opens.length, 0);
});

test("an unadmitted Pi launch is rejected by orchestration admission before Tsukai is contacted", async (t) => {
  const root = createTempGitRepo(t);
  const store = createWorkflowStore(t);
  let opened = 0;
  const service = new ManagerSessionService({
    workspaceRoot: root,
    store,
    runtime: new InertZellij(),
    tsukai: async () => {
      opened += 1;
      throw new Error("MOTTAINAI_JINUSHI_STATE_DIR is not configured");
    },
  });
  await service.initialize();
  const openedAtInitialize = opened;
  await assert.rejects(
    service.start({ agentKind: "pi", instruction: "no admission" }),
    (error: Error & { code?: string }) => error.code === "execution_unresolved",
  );
  assert.equal(opened, openedAtInitialize);
});
