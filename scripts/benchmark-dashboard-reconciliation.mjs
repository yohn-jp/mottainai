import assert from "node:assert/strict";
import { LOCAL_MANAGER_RUNTIME_ID, ManagerSessionService } from "../src/manager/service.ts";
import { WorkflowSqliteStateStore } from "../src/workflow/state/sqlite-store.ts";

/**
 * issue #872 acceptance: "A benchmark exercising 10/100/500 sessions and concurrent dashboard
 * clients measures external-call count, write count, and response latency before/after."
 *
 * `ManagerService.list()` (backing `GET /sessions`, the dashboard's `setInterval(refresh, 5000)`
 * poll target) used to `await this.reconcile()` inline: a strictly sequential `for` loop over
 * every control-plane session doing real `execution.observe` / `execution.validate` /
 * `runtime.inspect` I/O, then an UNCONDITIONAL `updateManagerSession` write per session, on every
 * single GET, with no sharing across concurrently polling dashboard clients.
 *
 * This replays that same per-session I/O shape twice against the same fixture and the same
 * artificially-latent instrumented dependencies:
 *
 *   before: a standalone reimplementation of the pre-fix algorithm (sequential await per
 *           session, unconditional write) — the literal shape `reconcile()`/`reconcileOneUnlocked`
 *           had prior to this fix, restated here because the fixed class no longer contains it.
 *   after:  the real, shipped `ManagerSessionService.list()` — bounded-concurrency reconciliation
 *           (`RECONCILE_CONCURRENCY` in flight at once), a write-skip when the observed
 *           projection did not change, and one shared in-flight pass for concurrent callers.
 *
 * Both measure external-call count (observe + validate + inspect), full-row write count
 * (`updateManagerSession` invocations), freshness-checkpoint count, and wall-clock response
 * latency.
 */

// Small artificial per-call latency stands in for the real subprocess/IO cost `execution.observe`,
// `execution.validate`, and the Zellij `runtime.inspect` subprocess call carry in production —
// without it, both algorithms would appear near-instant against in-memory fakes and the
// concurrency benefit this fix delivers would not show up in wall-clock latency at all.
const EXTERNAL_CALL_LATENCY_MS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contextFromRecord(session) {
  return {
    taskId: session.taskId,
    executionSessionId: session.executionSessionId,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    taskSlug: session.taskSlug,
    issueRef: session.issueRef,
    branchType: session.branchType,
    semanticLifecycleState: session.semanticLifecycleState,
  };
}

/** A steady-state receipt: matches what a "nothing changed since last poll" session already has. */
function steadyReceipt() {
  return { code: "runtime_running", message: "managed Zellij session is running", source: "zellij", recordedAt: 0 };
}

/**
 * Counting instrumented dependencies shared by both algorithms. `observe`/`validate`/`inspect`
 * report a steady "nothing changed" observation, which is the dominant case for a dashboard
 * polling every 5 seconds — most polls land between real state transitions.
 */
function createInstrumentedDependencies() {
  const counts = { observe: 0, validate: 0, inspect: 0, write: 0, freshnessWrite: 0 };
  const execution = {
    async observe(context) {
      counts.observe += 1;
      await sleep(EXTERNAL_CALL_LATENCY_MS);
      return { semanticLifecycleState: context.semanticLifecycleState, status: "steady", receipt: undefined };
    },
    async validate() {
      counts.validate += 1;
      await sleep(EXTERNAL_CALL_LATENCY_MS);
      return { ok: true };
    },
  };
  const runtime = {
    async checkAvailability() {
      return { version: "bench-zellij 0.0.0" };
    },
    async inspect() {
      counts.inspect += 1;
      await sleep(EXTERNAL_CALL_LATENCY_MS);
      return "running";
    },
    async start() {},
    async attach() {},
    async terminate() {},
    binaryName() {
      return "bench-zellij";
    },
  };
  return { counts, execution, runtime };
}

/** Wraps a real store so every `updateManagerSession` call is counted without changing behavior. */
function countingStore(store, counts) {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "updateManagerSession") {
        return (...args) => {
          counts.write += 1;
          return target.updateManagerSession(...args);
        };
      }
      if (prop === "checkpointManagerSessionRuntimeObservedAt") {
        return (...args) => {
          counts.freshnessWrite += 1;
          return target.checkpointManagerSessionRuntimeObservedAt(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const WORKSPACE_ROOT = "/bench/manager-workspace";

function seedSteadySessions(store, count) {
  const sessions = [];
  for (let index = 0; index < count; index += 1) {
    const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    sessions.push(
      store.createManagerSession({
        sessionId,
        workspaceRoot: WORKSPACE_ROOT,
        executionMode: "workspace",
        worktreePath: `${WORKSPACE_ROOT}/session-${index}`,
        agentKind: "codex",
        launchProfile: "codex",
        instruction: "bench",
        launchCommand: "codex",
        launchArgs: ["--", "bench"],
        runtimeName: `mottainai-bench-${index}`,
        lifecycleState: "running",
        runtimeState: "running",
        semanticLifecycleState: "active",
        attachable: true,
        reconciliationState: "synced",
        latestStatus: "steady",
        latestReceipt: steadyReceipt(),
      }),
    );
  }
  return sessions;
}

/**
 * The pre-fix shape: `reconcile()` was a plain sequential `for` loop, and the matching branch of
 * `reconcileOneUnlocked` (session already running, validation ok, runtime still observed running)
 * called `store.updateManagerSession` unconditionally — even though nothing here changed.
 */
async function legacySequentialUnconditionalReconcile(sessions, { execution, runtime, store }) {
  for (const session of sessions) {
    const observed = await execution.observe(contextFromRecord(session));
    const validation = await execution.validate(contextFromRecord(session));
    assert.ok(validation.ok, "bench fixture always validates cleanly");
    await runtime.inspect(session.runtimeName, session.worktreePath);
    store.updateManagerSession(session.sessionId, {
      lifecycleState: "running",
      runtimeState: "running",
      semanticLifecycleState: observed.semanticLifecycleState,
      attachable: true,
      reconciliationState: "synced",
      reconciliationMessage: null,
      latestStatus: observed.status,
      latestReceipt: steadyReceipt(),
      finishedAt: null,
      runtimeObservedAt: Date.now(),
      terminationState: "running",
      errorMessage: null,
    });
  }
}

async function measure(fn) {
  const startedAt = performance.now();
  await fn();
  return performance.now() - startedAt;
}

async function runBefore(sessionCount, concurrentClients) {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  const deps = createInstrumentedDependencies();
  const store_ = countingStore(store, deps.counts);
  const sessions = seedSteadySessions(store, sessionCount);

  const latencyMs = await measure(() =>
    Promise.all(
      Array.from({ length: concurrentClients }, () =>
        legacySequentialUnconditionalReconcile(sessions, { ...deps, store: store_ }),
      ),
    ),
  );
  return { ...deps.counts, latencyMs };
}

async function runAfter(sessionCount, concurrentClients) {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  const deps = createInstrumentedDependencies();
  const service = new ManagerSessionService({
    workspaceRoot: WORKSPACE_ROOT,
    store: countingStore(store, deps.counts),
    runtime: deps.runtime,
    executionAuthority: deps.execution,
  });
  await service.initialize();
  seedSteadySessions(store, sessionCount);
  // `initialize()` reconciled zero sessions and holds no runtime identity assumption the fixture
  // above violates; reset counters so only the measured GET-equivalent calls below are counted.
  deps.counts.observe = 0;
  deps.counts.validate = 0;
  deps.counts.inspect = 0;
  deps.counts.write = 0;
  deps.counts.freshnessWrite = 0;

  const results = { observe: 0, validate: 0, inspect: 0, write: 0, freshnessWrite: 0 };
  const latencyMs = await measure(async () => {
    await Promise.all(
      Array.from({ length: concurrentClients }, () => service.list({ runtimeId: LOCAL_MANAGER_RUNTIME_ID })),
    );
  });
  results.observe = deps.counts.observe;
  results.validate = deps.counts.validate;
  results.inspect = deps.counts.inspect;
  results.write = deps.counts.write;
  results.freshnessWrite = deps.counts.freshnessWrite;
  return { ...results, latencyMs };
}

function externalCalls(row) {
  return row.observe + row.validate + row.inspect;
}

function summarizeRow(sessionCount, concurrentClients, before, after) {
  return {
    sessions: sessionCount,
    concurrentClients,
    before: {
      externalCalls: externalCalls(before),
      writes: before.write,
      freshnessWrites: before.freshnessWrite,
      latencyMs: Number(before.latencyMs.toFixed(2)),
    },
    after: {
      externalCalls: externalCalls(after),
      writes: after.write,
      freshnessWrites: after.freshnessWrite,
      latencyMs: Number(after.latencyMs.toFixed(2)),
    },
    externalCallReductionRatio: 1 - externalCalls(after) / Math.max(externalCalls(before), 1),
    writeReductionRatio: 1 - after.write / Math.max(before.write, 1),
    latencySpeedup: before.latencyMs / Math.max(after.latencyMs, Number.EPSILON),
  };
}

async function main() {
  const sessionCounts = [10, 100, 500];
  const singleClientRows = [];
  for (const sessionCount of sessionCounts) {
    const before = await runBefore(sessionCount, 1);
    const after = await runAfter(sessionCount, 1);
    // The write-skip must actually fire on this steady-state fixture, and the fixed path must
    // never observe/validate/inspect more than the legacy path did for the same one client.
    assert.equal(after.write, 0, `steady-state reconciliation must skip all ${sessionCount} no-op writes`);
    assert.equal(
      after.freshnessWrite,
      sessionCount,
      `steady-state reconciliation must checkpoint freshness once per observed session`,
    );
    assert.equal(before.write, sessionCount, "legacy path writes once per session unconditionally");
    singleClientRows.push(summarizeRow(sessionCount, 1, before, after));
  }

  const concurrentClientCounts = [1, 5, 20];
  const fixedSessionCount = 100;
  const concurrencyRows = [];
  for (const concurrentClients of concurrentClientCounts) {
    const before = await runBefore(fixedSessionCount, concurrentClients);
    const after = await runAfter(fixedSessionCount, concurrentClients);
    // Concurrent dashboard clients polling at once must share one reconciliation pass after the
    // fix: external-call count must stay flat as concurrentClients grows, not scale with it.
    assert.equal(
      externalCalls(after),
      fixedSessionCount * 3,
      `after the fix, ${concurrentClients} concurrent clients must still cost exactly one pass`,
    );
    assert.equal(
      after.freshnessWrite,
      fixedSessionCount,
      "coalesced reconciliation must checkpoint freshness once per session",
    );
    assert.equal(
      externalCalls(before),
      fixedSessionCount * 3 * concurrentClients,
      "the legacy path has no coalescing and re-runs a full pass per concurrent client",
    );
    concurrencyRows.push(summarizeRow(fixedSessionCount, concurrentClients, before, after));
  }

  console.log(
    JSON.stringify(
      {
        benchmark: "dashboard-reconciliation",
        issue: 872,
        externalCallLatencyMsPerCall: EXTERNAL_CALL_LATENCY_MS,
        note:
          "reconciliation input is up to 1000 records (active+recent, 500 each); the GET /sessions " +
          "response itself is separately clamped to 500 by projectSessions. This benchmark's " +
          "sessionCounts (10/100/500) measure the reconciliation-input side of that distinction.",
        bySessionCount: singleClientRows,
        byConcurrentClients: concurrencyRows,
      },
      null,
      2,
    ),
  );
}

await main();
