import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DIRECT_BOUNDARIES } from "./boundary.js";
import { resolveGatewayConfig } from "./config.js";
import { runInit } from "./init.js";
import { createLogger } from "./logging.js";
import { InMemoryArtifactStore, MIN_ARTIFACT_BYTES } from "./retrieve.js";
import { runProgram, ManagedProcess } from "./subprocess.js";
import { applyMigrations } from "./state/migrations.js";
import { SqliteStateStore } from "./state/sqlite-store.js";
import { createTelemetrySink } from "./telemetry.js";
import { FaultInjector } from "./test-support/fault-injection.js";
import { connectUpstream, UpstreamRegistry } from "./upstream.js";
import type { UpstreamHandle } from "./upstream.js";
import { applyExecutionBudget, normalizeExecutionOutcome } from "./execution.js";

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mottainai-${prefix}-`));
}

async function initialize(workspace: string, boundaries = DIRECT_BOUNDARIES, force = false, config?: string) {
  return runInit({
    args: [
      "--yes",
      "--workspace",
      workspace,
      "--scope",
      "project",
      "--client",
      "none",
      "--no-doctor",
      ...(force ? ["--force"] : []),
      ...(config === undefined ? [] : ["--config", config]),
    ],
    cwd: workspace,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    boundaries,
  });
}

function temporaryFiles(workspace: string): string[] {
  return fs.readdirSync(workspace).filter((entry) => entry.startsWith(".mottainai-init-"));
}

test("configuration replacement preserves the original and cleans temporary state at every injected phase", async () => {
  const operations = [
    "config.temp.write",
    "config.temp.close",
    "config.temp.permission",
    "config.rename",
    "config.backup.copy",
  ];
  for (const operation of operations) {
    const workspace = temporaryDirectory("fault-config");
    try {
      const first = await initialize(workspace);
      const original = fs.readFileSync(first.configuration, "utf8");
      const faults = new FaultInjector({ [operation]: { error: new Error(`primary ${operation}`) } });
      await assert.rejects(() => initialize(workspace, faults, true), new RegExp(`primary ${operation}`));
      assert.equal(fs.readFileSync(first.configuration, "utf8"), original, operation);
      assert.deepEqual(temporaryFiles(path.dirname(first.configuration)), [], operation);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("configuration replacement preserves the primary error when cleanup fails as well", async () => {
  const workspace = temporaryDirectory("fault-config-secondary");
  try {
    const first = await initialize(workspace);
    const original = fs.readFileSync(first.configuration, "utf8");
    const faults = new FaultInjector({
      "config.rename": { error: new Error("primary rename failure") },
      "config.temp.cleanup": { error: new Error("cleanup failure") },
      "config.temp.cleanup.retry": { error: new Error("cleanup retry failure") },
    });
    await assert.rejects(
      () => initialize(workspace, faults, true),
      (error: unknown) => {
        assert.equal((error as Error).message, "primary rename failure");
        assert.deepEqual((error as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
          { operation: "config.temp.cleanup", message: "cleanup retry failure" },
        ]);
        return true;
      },
    );
    assert.equal(fs.readFileSync(first.configuration, "utf8"), original);
    assert.deepEqual(temporaryFiles(path.dirname(first.configuration)), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("nested configuration replacement cleans temporary state beside the configuration", async () => {
  const workspace = temporaryDirectory("fault-config-nested");
  try {
    const first = await initialize(workspace, DIRECT_BOUNDARIES, false, "nested/mottainai.config.json");
    const original = fs.readFileSync(first.configuration, "utf8");
    const faults = new FaultInjector({ "config.rename": { error: new Error("primary nested rename failure") } });
    await assert.rejects(
      () => initialize(workspace, faults, true, "nested/mottainai.config.json"),
      /primary nested rename failure/,
    );
    assert.equal(fs.readFileSync(first.configuration, "utf8"), original);
    assert.deepEqual(temporaryFiles(path.dirname(first.configuration)), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("backup allocation is collision-safe and never overwrites an existing backup", async () => {
  const workspace = temporaryDirectory("fault-backup");
  try {
    const first = await initialize(workspace);
    const original = fs.readFileSync(first.configuration, "utf8");
    fs.writeFileSync(`${first.configuration}.bak`, "first backup\n");
    fs.writeFileSync(`${first.configuration}.1.bak`, "second backup\n");
    const replaced = await initialize(workspace, DIRECT_BOUNDARIES, true);
    assert.equal(replaced.backup, `${first.configuration}.2.bak`);
    assert.equal(fs.readFileSync(replaced.backup as string, "utf8"), original);
    assert.equal(fs.readFileSync(`${first.configuration}.bak`, "utf8"), "first backup\n");
    assert.equal(fs.readFileSync(`${first.configuration}.1.bak`, "utf8"), "second backup\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("backup allocation retries a deterministic concurrent collision without overwriting a backup", async () => {
  const workspace = temporaryDirectory("fault-backup-race");
  try {
    const first = await initialize(workspace);
    const original = fs.readFileSync(first.configuration, "utf8");
    const collision = Object.assign(new Error("backup appeared concurrently"), { code: "EEXIST" });
    const faults = new FaultInjector({ "config.backup.copy": { error: collision } });
    const replaced = await initialize(workspace, faults, true);

    assert.equal(replaced.backup, `${first.configuration}.1.bak`);
    assert.equal(fs.readFileSync(replaced.backup as string, "utf8"), original);
    assert.deepEqual(temporaryFiles(path.dirname(first.configuration)), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("logging directory and write failures degrade to a non-throwing sink without leaking fallback secrets", async () => {
  const directory = temporaryDirectory("fault-log");
  const secret = "log-secret-value";
  const messages: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => messages.push(args.join(" "));
  try {
    const directoryFault = new FaultInjector({
      "logging.directory.create": { error: new Error(`path token=${secret}`) },
    });
    const unavailable = createLogger({ MOTTAINAI_LOG_DIR: path.join(directory, "directory") }, directoryFault);
    await assert.doesNotReject(() =>
      unavailable.log({ upstreamName: "u", toolName: "t", arguments: { token: secret }, rawResult: {} }),
    );

    const writeFault = new FaultInjector({
      "logging.write": { error: new Error(`write token=${secret}`) },
    });
    const logger = createLogger({ MOTTAINAI_LOG_DIR: path.join(directory, "write") }, writeFault);
    await assert.doesNotReject(() =>
      logger.log({ upstreamName: "u", toolName: "t", arguments: { token: secret }, rawResult: {} }),
    );
    assert.equal(
      messages.some((message) => message.includes(secret)),
      false,
    );
  } finally {
    console.error = previousError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("telemetry persistence failures are non-fatal and flush is deterministic", async () => {
  const directory = temporaryDirectory("fault-telemetry");
  const messages: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => messages.push(args.join(" "));
  try {
    const faults = new FaultInjector({
      "telemetry.write": { error: new Error("telemetry secret=should-not-print") },
    });
    const sink = createTelemetrySink(
      { MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: path.join(directory, "summary.json") },
      faults,
    );
    sink.recordToolCall({ provider: "test", originalBytes: 10, compressedBytes: 5, isError: false });
    await assert.doesNotReject(() => sink.flush?.() ?? Promise.resolve());
    assert.equal(sink.snapshot().totals.calls, 1);
    assert.equal(
      messages.some((message) => message.includes("should-not-print")),
      false,
    );

    const readFault = new FaultInjector({ "telemetry.read": 1 });
    const recovering = createTelemetrySink(
      { MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: path.join(directory, "missing.json") },
      readFault,
    );
    assert.equal(recovering.snapshot().totals.calls, 0);
  } finally {
    console.error = previousError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("logging retention and telemetry directory faults remain non-fatal and secret-free", async () => {
  const directory = temporaryDirectory("fault-retention");
  const secret = "retention-secret";
  const messages: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => messages.push(args.join(" "));
  try {
    const stalePath = path.join(directory, "stale.jsonl");
    fs.writeFileSync(stalePath, `${secret}\n`);
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, oldTime, oldTime);
    const logger = createLogger(
      { MOTTAINAI_LOG_DIR: directory, MOTTAINAI_LOG_RETENTION_DAYS: "1" },
      new FaultInjector({ "logging.retention.delete": { error: new Error(`delete ${secret}`) } }),
    );
    await assert.doesNotReject(() => logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: {} }));
    assert.equal(
      messages.some((message) => message.includes(secret)),
      false,
    );

    const rotating = createLogger(
      { MOTTAINAI_LOG_DIR: path.join(directory, "rotate"), MOTTAINAI_LOG_MAX_FILE_BYTES: "256" },
      new FaultInjector({ "logging.rotate": { error: new Error(`rotate ${secret}`) } }),
    );
    await rotating.log({ upstreamName: "u", toolName: "t", arguments: { first: true }, rawResult: {} });
    await assert.doesNotReject(() =>
      rotating.log({ upstreamName: "u", toolName: "t", arguments: { second: true }, rawResult: {} }),
    );
    assert.equal(
      messages.some((message) => message.includes(secret)),
      false,
    );

    const telemetry = createTelemetrySink(
      { MOTTAINAI_TELEMETRY: "1", MOTTAINAI_TELEMETRY_FILE: path.join(directory, "nested", "summary.json") },
      new FaultInjector({ "telemetry.directory.create": { error: new Error(`mkdir ${secret}`) } }),
    );
    telemetry.recordToolCall({ provider: "test", originalBytes: 1, compressedBytes: 1, isError: false });
    await assert.doesNotReject(() => telemetry.flush?.() ?? Promise.resolve());
    assert.equal(
      messages.some((message) => message.includes(secret)),
      false,
    );
  } finally {
    console.error = previousError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration failure rolls back partial work, preserves cause and secondary rollback evidence, then retries cleanly", () => {
  const db = new DatabaseSync(":memory:");
  const primary = new Error("partial migration failed");
  const faults = new FaultInjector({ "sqlite.rollback": { error: new Error("rollback cleanup failed") } });
  const firstMigration = {
    version: 1,
    description: "base",
    up: (handle: DatabaseSync) => handle.exec("CREATE TABLE base (value TEXT)"),
  };
  try {
    assert.throws(
      () =>
        applyMigrations(
          db,
          [
            firstMigration,
            {
              version: 2,
              description: "partial",
              up: (handle: DatabaseSync) => {
                handle.exec("CREATE TABLE transient (value TEXT)");
                throw primary;
              },
            },
          ],
          faults,
        ),
      (error: unknown) => {
        assert.match((error as Error).message, /migration 2 \(partial\) failed/);
        assert.equal((error as Error).cause, primary);
        assert.deepEqual((error as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
          { operation: "sqlite.rollback", message: "rollback cleanup failed" },
        ]);
        return true;
      },
    );
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 1);
    assert.throws(() => db.prepare("SELECT * FROM transient").all(), /no such table/);

    applyMigrations(db, [
      firstMigration,
      {
        version: 2,
        description: "partial",
        up: (handle: DatabaseSync) => handle.exec("CREATE TABLE transient (value TEXT)"),
      },
    ]);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 2);
  } finally {
    db.close();
  }
});

test("SQLite store closes failed initialization handles and can retry after an injected migration failure", () => {
  const faults = new FaultInjector({
    "sqlite.migrations": 1,
    "sqlite.close.after-init-failure": 1,
  });
  const store = new SqliteStateStore({ dbPath: ":memory:", boundaries: faults });
  assert.throws(() => store.init(), /injected failure: sqlite\.migrations/);
  assert.doesNotThrow(() => store.init());
  store.close();
});

test("SQLite initialization preserves the migration error and records a close cleanup fault", () => {
  const primary = new Error("migration setup failed");
  const faults = new FaultInjector({
    "sqlite.migrations": { error: primary },
    "sqlite.close.after-init-failure": { error: new Error("close setup failed") },
  });
  const store = new SqliteStateStore({ dbPath: ":memory:", boundaries: faults });
  assert.throws(
    () => store.init(),
    (error: unknown) => {
      assert.equal((error as Error).message, primary.message);
      assert.deepEqual((error as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
        { operation: "sqlite.close.after-init-failure", message: "close setup failed" },
      ]);
      return true;
    },
  );
  assert.doesNotThrow(() => store.init());
  store.close();
});

test("artifact insertion is transactional: a failed insert leaves no unreachable reference and preserves limits", () => {
  const faults = new FaultInjector();
  const store = new InMemoryArtifactStore({
    maxEntries: 2,
    createId: (() => {
      let value = 0;
      return () => String(++value);
    })(),
    boundaries: faults,
  });
  const first = store.putArtifact({ text: "first", metadata: { operation: "test" } });
  faults.arm("artifact.insert", { error: new Error("artifact insertion failed") });
  assert.throws(
    () => store.putArtifact({ text: "second", metadata: { operation: "test" } }),
    /artifact insertion failed/,
  );
  assert.equal(store.retrieve(first)?.text, "first");
  assert.equal(store.search("second").length, 0);
  const second = store.putArtifact({ text: "second", metadata: { operation: "test" } });
  assert.equal(store.retrieve(second)?.text, "second");
  assert.equal(store.search("first").length, 1);
});

test("execution does not expose a compression marker when artifact insertion fails", () => {
  const faults = new FaultInjector({ "artifact.insert": 1 });
  const store = new InMemoryArtifactStore({ boundaries: faults, createId: () => "unreachable" });
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "large output\n".repeat(500) }] },
    selectedProvider: "test",
    selectedTool: "test",
    capability: "test",
    risk: "unknown",
  });
  assert.throws(
    () => applyExecutionBudget(outcome, "test", "test", resolveGatewayConfig({ tokenBudgets: { default: 10 } }), store),
    /artifact\.insert|injected failure/,
  );
  assert.equal(store.search("unreachable").length, 0);
});

test("artifact storage rejects impossible byte limits at construction and accepts the minimum", () => {
  assert.throws(
    () => new InMemoryArtifactStore({ maxBytes: MIN_ARTIFACT_BYTES - 1 }),
    new RegExp(`maxBytes must be at least ${MIN_ARTIFACT_BYTES} bytes`),
  );
  const store = new InMemoryArtifactStore({ maxBytes: MIN_ARTIFACT_BYTES, createId: () => "minimum" });
  const id = store.putArtifact({ text: "payload", metadata: { operation: "test" } });
  assert.equal(store.retrieve(id)?.text, "");
});

test("process launcher faults are deterministic and return a bounded spawn diagnostic", async () => {
  const faults = new FaultInjector({ "process.spawn": { times: 2, error: new Error("spawn seam failure") } });
  const result = await runProgram(
    process.execPath,
    ["-e", "process.stdout.write('unreachable')"],
    process.cwd(),
    1_000,
    1_000,
    undefined,
    faults,
  );
  assert.equal(result.spawnError, "spawn seam failure");
  assert.equal(result.stdout, "");

  const managed = new ManagedProcess(process.execPath, process.cwd(), 1_000, false, undefined, faults);
  assert.equal((await managed.settled).spawnError, "spawn seam failure");
  assert.equal(managed.state, "exited");
});

test("upstream startup timeout closes the failed client and preserves the timeout diagnostic", async () => {
  let closeCalls = 0;
  const pending = new Promise<void>(() => {});
  await assert.rejects(
    () =>
      connectUpstream(
        { name: "timeout", command: "node" },
        undefined,
        () =>
          ({
            connect: async () => pending,
            listTools: async () => ({ tools: [] }),
            close: async () => {
              closeCalls += 1;
            },
          }) as unknown as Client,
        { startupTimeoutMs: 1, closeTimeoutMs: 10 },
      ),
    /timeout_ms=1/,
  );
  assert.equal(closeCalls, 1);
});

test("upstream transport timeout closes a late transport before it can leak", async () => {
  let release: ((transport: Transport) => void) | undefined;
  const pendingTransport = new Promise<Transport>((resolve) => {
    release = resolve;
  });
  let closeCalls = 0;
  let closeCompleted!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    closeCompleted = resolve;
  });
  const lateTransport = {
    close: async () => {
      closeCalls += 1;
      closeCompleted();
    },
  } as unknown as Transport;

  await assert.rejects(
    () =>
      connectUpstream(
        { name: "late-transport", command: "node" },
        undefined,
        () => {
          throw new Error("client should not be created before transport resolves");
        },
        { startupTimeoutMs: 1, closeTimeoutMs: 10, transportFactory: () => pendingTransport },
      ),
    /phase=transport timeout_ms=1/,
  );
  assert.equal(closeCalls, 0);
  release?.(lateTransport);
  await closeFinished;
  assert.equal(closeCalls, 1);
});

test("late transport cleanup preserves the timeout and records its failure secondarily", async () => {
  let release: ((transport: Transport) => void) | undefined;
  const pendingTransport = new Promise<Transport>((resolve) => {
    release = resolve;
  });
  const cleanupError = new Error("late transport close failed");
  const lateTransport = {
    close: async () => {
      throw cleanupError;
    },
  } as unknown as Transport;
  let timeoutError: unknown;

  await assert.rejects(
    () =>
      connectUpstream(
        { name: "late-transport-failure", command: "node" },
        undefined,
        () => {
          throw new Error("client should not be created before transport resolves");
        },
        { startupTimeoutMs: 1, closeTimeoutMs: 10, transportFactory: () => pendingTransport },
      ),
    (error: unknown) => {
      timeoutError = error;
      assert.match((error as Error).message, /phase=transport timeout_ms=1/);
      return true;
    },
  );
  release?.(lateTransport);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((timeoutError as Error).message, "upstream=late-transport-failure phase=transport timeout_ms=1");
  assert.deepEqual((timeoutError as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
    { operation: "upstream.transport.late_cleanup", message: cleanupError.message },
  ]);
});

test("upstream cleanup failure is recorded as secondary evidence without replacing the startup error", async () => {
  const primary = new Error("list tools failed");
  await assert.rejects(
    () =>
      connectUpstream(
        { name: "cleanup", command: "node" },
        undefined,
        () =>
          ({
            connect: async () => {},
            listTools: async () => {
              throw primary;
            },
            close: async () => {
              throw new Error("close failed");
            },
          }) as unknown as Client,
        { closeTimeoutMs: 10 },
      ),
    (error: unknown) => {
      assert.equal(error, primary);
      assert.deepEqual((error as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
        { operation: "upstream.client.close", message: "close failed" },
      ]);
      return true;
    },
  );
});

test("upstream close race cannot publish a handle after shutdown even when close ignores termination", async () => {
  let release: (() => void) | undefined;
  const connecting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new UpstreamRegistry(
    [{ name: "race", command: "node" }],
    async (config) => {
      await connecting;
      return {
        config,
        client: { close: async () => new Promise<void>(() => {}) } as UpstreamHandle["client"],
        tools: [],
      };
    },
    undefined,
    { closeTimeoutMs: 1 },
  );

  const starting = registry.start("race");
  const closing = registry.close();
  release?.();
  await assert.rejects(() => starting, /closed while starting/);
  await closing;
  assert.equal(registry.readyHandles().length, 0);
  assert.equal(registry.state("race"), "stopped");
});
