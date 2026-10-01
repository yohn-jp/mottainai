import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  type PiDuplexExecutionPort,
  type PiRuntime,
  type PiTransportObserver,
} from "tsukai";
import { createSemanticExecutionPlan } from "../semantics/execution-plan.js";
import { createExecutionManifest, type ExecutionManifest } from "../workflow/domain/execution-manifest.js";
import type { NawabariRepositoryEvidence } from "../workflow/nawabari.js";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";
import type { ManagerRuntimeId, ManagerSessionId, ManagerSessionRecord } from "../workflow/state/store.js";
import { resolvePiGuardPath } from "./service.js";
import {
  TSUKAI_GUARD_EXTENSION_ID,
  TsukaiAgentRunStarter,
  tsukaiExecutionProfile,
  type TsukaiAgentRunStartInput,
} from "./tsukai-integration.js";

const sessionId = "manager-session-985" as ManagerSessionId;
const worktree = "/managed/worktree-985";
const nawabariSessionId = "01985000-0000-7000-8000-000000000985";
const guardPath = resolvePiGuardPath();
const guardSha256 = crypto.createHash("sha256").update(fs.readFileSync(guardPath)).digest("hex");
const tools = { builtin: ["read", "bash"] };

interface OpenRecord {
  agentRunId: string;
  workspace: { cwd: string; workspaceSessionId?: string } | undefined;
  profile: AdmittedExecutionProfile | undefined;
}

/** Jinushi stand-in: records what Tsukai realizes and fails Pi startup so runs settle. */
function fakeJinushi(opens: OpenRecord[]): PiDuplexExecutionPort {
  return {
    executionProfile: "projected",
    async open(agentRunId: string, observer: PiTransportObserver, workspace, profile) {
      opens.push({ agentRunId, workspace, profile });
      return {
        executionRunId: `exec-${agentRunId}`,
        backend: "fake-jinushi",
        async write(bytes: Uint8Array) {
          const command = JSON.parse(Buffer.from(bytes).toString("utf8")) as { id: string; type: string };
          const response = { id: command.id, type: "response", command: command.type, success: false, error: "test" };
          queueMicrotask(() => observer.onStdout(Buffer.from(`${JSON.stringify(response)}\n`)));
        },
        async closeInput() {},
        async retire() {
          queueMicrotask(() =>
            observer.onExit({
              executionRunId: `exec-${agentRunId}`,
              status: "exited",
              exitCode: 1,
              signal: null,
              forced: false,
            }),
          );
        },
      };
    },
    async dispose() {},
  };
}

interface Harness {
  root: string;
  opens: OpenRecord[];
  openStore(): WorkflowSqliteStateStore;
  openRuntime(): PiRuntime;
}

function harness(t: TestContext): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-tsukai-"));
  const opens: OpenRecord[] = [];
  const runtimes: PiRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.detach().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    opens,
    openStore() {
      const store = new WorkflowSqliteStateStore({ dbPath: path.join(root, "state.sqlite3") });
      store.init();
      return store;
    },
    openRuntime() {
      const runtime = createPiRuntime({
        execution: fakeJinushi(opens),
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
        durableStore: createFileDurableStore({ dir: path.join(root, "tsukai"), fsync: false }),
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function seedSession(store: WorkflowSqliteStateStore): ManagerSessionRecord {
  return (
    store.getManagerSession(sessionId) ??
    store.createManagerSession({
      sessionId,
      runtimeId: "local" as ManagerRuntimeId,
      workspaceRoot: "/managed",
      worktreePath: worktree,
      executionSessionId: nawabariSessionId,
      branchName: "feat/985-tsukai",
      agentKind: "pi",
      provider: "anthropic",
      model: "claude-test",
      launchCommand: "pi",
      launchArgs: ["pi"],
      runtimeName: "pi-sdk",
      startedAt: 1,
    })
  );
}

function evidence(overrides: Partial<NawabariRepositoryEvidence> = {}): NawabariRepositoryEvidence {
  return {
    schemaVersion: 1,
    repository: "/managed/repository/.git",
    worktree,
    branchId: "branch-985",
    branch: "feat/985-tsukai",
    sessionId: nawabariSessionId,
    sessionState: "active",
    sessionCreatedAt: "2026-10-01T00:00:00Z",
    sessionUpdatedAt: "2026-10-01T00:00:01Z",
    baseRevision: "base-985",
    baseRevisionProven: true,
    head: "head-985",
    clean: true,
    complete: true,
    incompleteReasons: [],
    evidenceHash: "evidence-985",
    raw: { ok: true, command: "evidence snapshot" },
    ...overrides,
  };
}

function admittedManifest(session: ManagerSessionRecord): ExecutionManifest {
  const manifest = createExecutionManifest({
    manager: session,
    semanticPlan: createSemanticExecutionPlan({ semanticTargets: [], claims: [] }),
    nawabari: { authority: "nawabari", evidence: evidence() },
  });
  assert.equal(manifest.attachment.status, "attached");
  return manifest;
}

function startInput(session: ManagerSessionRecord, startKey: string): TsukaiAgentRunStartInput {
  return { startKey, session, manifest: admittedManifest(session), prompt: "do the task", guardPath, tools };
}

test("admitted intent maps to the Tsukai M5.5 execution profile without defaults", () => {
  assert.deepEqual(
    tsukaiExecutionProfile({
      provider: "anthropic",
      model: "claude-test",
      guardPath,
      tools: { builtin: ["read"], customTools: [{ extension: TSUKAI_GUARD_EXTENSION_ID, name: "guard_tool" }] },
    }),
    {
      schemaVersion: 1,
      provider: "anthropic",
      model: "claude-test",
      tools: [
        { source: "builtin", name: "read" },
        { source: "extension", extension: TSUKAI_GUARD_EXTENSION_ID, name: "guard_tool" },
      ],
      extensions: [{ id: TSUKAI_GUARD_EXTENSION_ID, path: guardPath, sha256: guardSha256 }],
    },
  );
  const bare = tsukaiExecutionProfile({ provider: undefined, model: undefined, guardPath, tools: { builtin: [] } });
  assert.deepEqual(bare.tools, []);
  assert.equal("provider" in bare || "model" in bare, false);
  assert.throws(() =>
    tsukaiExecutionProfile({ provider: undefined, model: undefined, guardPath: "pi-guard.ts", tools }),
  );
});

test("start creates one AgentRun through Tsukai with the admitted profile and exact Nawabari workspace", async (t) => {
  const h = harness(t);
  const store = h.openStore();
  const session = seedSession(store);
  const runtime = h.openRuntime();
  const starter = new TsukaiAgentRunStarter({ store, runs: runtime.runs });

  const result = await starter.start(startInput(session, "start-1"));

  assert.equal(result.created, true);
  assert.deepEqual(result.snapshot.workspace, { cwd: worktree, workspaceSessionId: nawabariSessionId });
  assert.equal(result.snapshot.harness.name, "pi");
  assert.equal(result.snapshot.executionProfile?.provider, "anthropic");
  assert.equal(result.snapshot.executionProfile?.model, "claude-test");
  assert.deepEqual(result.snapshot.executionProfile?.tools, [
    { source: "builtin", name: "bash" },
    { source: "builtin", name: "read" },
  ]);
  assert.deepEqual(result.snapshot.executionProfile?.extensions, [
    { id: TSUKAI_GUARD_EXTENSION_ID, sha256: guardSha256 },
  ]);
  // The physical owner receives exactly the admitted workspace and guard; nothing wider.
  assert.equal(h.opens.length, 1);
  assert.deepEqual(h.opens[0]!.workspace, { cwd: worktree, workspaceSessionId: nawabariSessionId });
  assert.deepEqual(h.opens[0]!.profile?.extensions, [
    { id: TSUKAI_GUARD_EXTENSION_ID, path: guardPath, sha256: guardSha256 },
  ]);

  const reopened = h.openStore();
  const correlation = reopened.getTsukaiRunCorrelation("start-1");
  assert.equal(correlation?.agentRunId, result.agentRunId);
  assert.equal(correlation?.managerSessionId, sessionId);
  assert.deepEqual(
    reopened.listTsukaiRunCorrelations(sessionId).map((record) => record.agentRunId),
    [result.agentRunId],
  );
});

test("a workspace that is not Nawabari-admitted for this session is refused before any AgentRun", async (t) => {
  const h = harness(t);
  const store = h.openStore();
  const session = seedSession(store);
  const runtime = h.openRuntime();
  const starter = new TsukaiAgentRunStarter({ store, runs: runtime.runs });

  const unattached = createExecutionManifest({
    manager: session,
    semanticPlan: createSemanticExecutionPlan({ semanticTargets: [], claims: [] }),
  });
  await assert.rejects(starter.start({ ...startInput(session, "start-x"), manifest: unattached }), /Nawabari/);
  const foreign = { ...session, sessionId: "other-session" as ManagerSessionId };
  await assert.rejects(starter.start({ ...startInput(session, "start-y"), manifest: admittedManifest(foreign) }));
  assert.equal(runtime.runs.list().items.length, 0);
  assert.equal(store.getTsukaiRunCorrelation("start-x"), undefined);
});

test("repeating the same start, concurrently or after restart, never creates a second AgentRun", async (t) => {
  const h = harness(t);
  const store = h.openStore();
  const session = seedSession(store);
  const runtime = h.openRuntime();
  const starter = new TsukaiAgentRunStarter({ store, runs: runtime.runs });

  const [first, second] = await Promise.all([
    starter.start(startInput(session, "start-1")),
    starter.start(startInput(session, "start-1")),
  ]);
  assert.equal(second.agentRunId, first.agentRunId);
  const third = await starter.start(startInput(session, "start-1"));
  assert.equal(third.created, false);
  assert.equal(third.agentRunId, first.agentRunId);
  await runtime.runs.wait(first.agentRunId, { timeoutMs: 5_000 });
  await runtime.detach();

  // Manager and Tsukai owner both restart; the terminal run is recovered, not resurrected.
  const restartedRuntime = h.openRuntime();
  const restarted = new TsukaiAgentRunStarter({ store: h.openStore(), runs: restartedRuntime.runs });
  const recovered = await restarted.start(startInput(session, "start-1"));
  assert.equal(recovered.created, false);
  assert.equal(recovered.agentRunId, first.agentRunId);
  assert.equal(recovered.snapshot.lifecycle, "terminal");
  assert.equal(restartedRuntime.runs.list().items.length, 1);
  assert.equal(h.opens.length, 1);
});

test("a crash between Tsukai create and durable bind is recovered through Tsukai list", async (t) => {
  const h = harness(t);
  const store = h.openStore();
  const session = seedSession(store);
  const runtime = h.openRuntime();
  const crashing = new TsukaiAgentRunStarter({
    store: {
      reserveTsukaiRunCorrelation: (input) => store.reserveTsukaiRunCorrelation(input),
      getTsukaiRunCorrelation: (startKey) => store.getTsukaiRunCorrelation(startKey),
      bindTsukaiRunCorrelation: () => {
        throw new Error("crash before bind");
      },
    },
    runs: runtime.runs,
  });
  await assert.rejects(crashing.start(startInput(session, "start-1")), /crash before bind/);
  assert.equal(store.getTsukaiRunCorrelation("start-1")?.agentRunId, undefined);
  const [orphan] = runtime.runs.list().items;
  assert.ok(orphan);
  await runtime.detach();

  const restartedRuntime = h.openRuntime();
  const restarted = new TsukaiAgentRunStarter({ store: h.openStore(), runs: restartedRuntime.runs });
  const recovered = await restarted.start(startInput(session, "start-1"));
  assert.equal(recovered.created, false);
  assert.equal(recovered.agentRunId, orphan.agentRunId);
  assert.equal(h.openStore().getTsukaiRunCorrelation("start-1")?.agentRunId, orphan.agentRunId);
  assert.equal(restartedRuntime.runs.list().items.length, 1);
});

test("a retry decision uses a new start key and gets a distinct AgentRun under the same session", async (t) => {
  const h = harness(t);
  const store = h.openStore();
  const session = seedSession(store);
  const runtime = h.openRuntime();
  const starter = new TsukaiAgentRunStarter({ store, runs: runtime.runs });

  const first = await starter.start(startInput(session, "start-1"));
  const retry = await starter.start(startInput(session, "start-2"));
  assert.notEqual(retry.agentRunId, first.agentRunId);
  assert.deepEqual(
    store.listTsukaiRunCorrelations(sessionId).map((record) => record.agentRunId),
    [first.agentRunId, retry.agentRunId],
  );
});

test("correlation store rejects rebinding and cross-session reuse of a start key", (t) => {
  const h = harness(t);
  const store = h.openStore();
  store.reserveTsukaiRunCorrelation({ startKey: "start-1", managerSessionId: sessionId });
  assert.throws(
    () => store.reserveTsukaiRunCorrelation({ startKey: "start-1", managerSessionId: "other" as ManagerSessionId }),
    /another Manager session/,
  );
  store.bindTsukaiRunCorrelation({ startKey: "start-1", agentRunId: "run-a" });
  assert.equal(store.bindTsukaiRunCorrelation({ startKey: "start-1", agentRunId: "run-a" }).agentRunId, "run-a");
  assert.throws(() => store.bindTsukaiRunCorrelation({ startKey: "start-1", agentRunId: "run-b" }), /another AgentRun/);
  assert.throws(() => store.bindTsukaiRunCorrelation({ startKey: "missing", agentRunId: "run-c" }), /not reserved/);
});
