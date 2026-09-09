import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { computeSnapshotDigest } from "../ir/serialize.js";
import { pureFunctionFixture } from "../fixtures/snapshots.js";
import { loadSemanticSource, serializeSemanticSource } from "./index.js";

/**
 * 受入基準「同一の on-disk generation を読み込んだ 2 トランザクションが両方とも
 * サイレントにコミットできない」「途中で kill してもディレクトリは pre か
 * fully-post のいずれかにしか収束しない」の直接的な検証。単一プロセス内の
 * Promise.all は真のファイルシステム競合や SIGKILL による中断を再現しないため
 * （task.concurrency.test.ts と同じ理由）、実プロセスを起動する。
 */

const WORKER_TIMEOUT_MS = 30_000;
const SEMANTIC_JOURNAL_FILE = ".mottainai/.semantics-journal.json";
const SEMANTIC_LOCK_DIR = ".mottainai/.semantics.lock";

function writeSource(rootDir: string): void {
  for (const write of serializeSemanticSource(pureFunctionFixture)) {
    assert.equal(write.operation, "write");
    const target = join(rootDir, write.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, write.content ?? "", "utf8");
  }
}

interface WorkerOptions {
  rootDir: string;
  actor: string;
  newComponentIds: string[];
  expectedSnapshotDigest?: unknown;
  signalReady?: boolean;
}

interface WorkerOutcome {
  ok: boolean;
  diagnostics: string[];
}

function spawnWorker(options: WorkerOptions): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  done: Promise<WorkerOutcome>;
} {
  const workerModule = join(import.meta.dirname, "store-persist-worker.mjs");
  const child = spawn(process.execPath, ["--import", "tsx", workerModule, JSON.stringify(options)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  let resolveReady: () => void;
  const ready = new Promise<void>((res) => {
    resolveReady = res;
  });
  let readySeen = !options.signalReady;
  if (!options.signalReady) resolveReady!();
  const done = new Promise<WorkerOutcome>((resolveDone, rejectDone) => {
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDone(new Error(`worker timed out after ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const lastLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "READY")
        .pop();
      if (lastLine === undefined) {
        rejectDone(new Error(`worker produced no result (code=${code}, signal=${signal}), stdout: ${stdout}`));
        return;
      }
      try {
        resolveDone(JSON.parse(lastLine) as WorkerOutcome);
      } catch (err) {
        rejectDone(new Error(`worker produced non-JSON stdout: ${stdout} (${(err as Error).message})`));
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!readySeen && stdout.includes("READY\n")) {
        readySeen = true;
        resolveReady();
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rejectDone(err);
    });
    child.on("exit", finish);
    child.on("close", finish);
  });
  return { child, ready, done };
}

function spawnLockWorker(options: { rootDir: string; mode: string; token?: string }): {
  child: ReturnType<typeof spawn>;
  waitFor: (event: string) => Promise<Record<string, unknown>>;
  send: (command: string) => void;
  close: Promise<void>;
} {
  const workerModule = join(import.meta.dirname, "store-lock-worker.mjs");
  const child = spawn(process.execPath, ["--import", "tsx", workerModule, JSON.stringify(options)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: Record<string, unknown>[] = [];
  const waiters = new Map<
    string,
    Array<{ resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void }>
  >();
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length === 0) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      const name = String(event.event);
      const pending = waiters.get(name);
      const resolvePending = pending?.shift();
      if (resolvePending !== undefined) resolvePending.resolve(event);
      else events.push(event);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const failPending = (error: Error) => {
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(error);
    }
    waiters.clear();
  };
  child.on("close", (code, signal) => {
    if (code !== 0 && signal !== "SIGKILL") {
      failPending(
        new Error(`lock worker exited with code=${code}, signal=${signal}; stdout=${stdout}; stderr=${stderr}`),
      );
    }
  });
  const close = new Promise<void>((resolveClose, rejectClose) => {
    child.on("error", rejectClose);
    child.on("close", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") resolveClose();
      else rejectClose(new Error(`lock worker exited with code=${code}, signal=${signal}; stdout=${stdout}`));
    });
  });
  return {
    child,
    waitFor: (eventName) => {
      const existing = events.findIndex((event) => event.event === eventName);
      if (existing >= 0) return Promise.resolve(events.splice(existing, 1)[0]!);
      if (eventName === "ACQUIRED") {
        return (async () => {
          const deadline = Date.now() + WORKER_TIMEOUT_MS;
          const ownerPath = lockOwnerPath(options.rootDir);
          while (Date.now() < deadline) {
            if (existsSync(ownerPath)) {
              const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token: string };
              return { event: "ACQUIRED", token: owner.token };
            }
            await delay(20);
          }
          throw new Error(`lock worker did not publish an owner record: stdout=${stdout}; stderr=${stderr}`);
        })();
      }
      return new Promise((resolveEvent, rejectEvent) => {
        const pending = waiters.get(eventName) ?? [];
        pending.push({ resolve: resolveEvent, reject: rejectEvent });
        waiters.set(eventName, pending);
      });
    },
    send: (command) => child.stdin!.write(`${command}\n`),
    close,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function lockOwnerPath(rootDir: string): string {
  return join(rootDir, SEMANTIC_LOCK_DIR, "owner.json");
}

test(
  "a waiter cannot break or enter a lock while its owner record is still initializing",
  { timeout: 15_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-lock-init-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeSource(root);

    const initializer = spawnLockWorker({ rootDir: root, mode: "initialize", token: "initializing-generation" });
    await initializer.waitFor("READY");
    const waiter = spawnWorker({
      rootDir: root,
      actor: "initialization-waiter",
      newComponentIds: ["initialization-waiter"],
    });
    await delay(100);
    assert.equal(existsSync(lockOwnerPath(root)), false, "the adversarial window must contain no owner record");
    assert.equal(existsSync(join(root, SEMANTIC_LOCK_DIR)), true, "the initializer must still own the lock directory");

    initializer.send("PUBLISH");
    await initializer.waitFor("PUBLISHED");
    initializer.send("RELEASE");
    await initializer.waitFor("RELEASED");
    await initializer.close;

    const result = await waiter.done;
    assert.equal(
      result.ok,
      true,
      `the waiter should enter only after initialization releases: ${JSON.stringify(result)}`,
    );
  },
);

test(
  "a live owner is never broken only because its lock is older than the former stale timeout",
  { timeout: 15_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-lock-live-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeSource(root);

    const holder = spawnLockWorker({ rootDir: root, mode: "hold" });
    const acquired = await holder.waitFor("ACQUIRED");
    const owner = JSON.parse(readFileSync(lockOwnerPath(root), "utf8")) as {
      token: string;
      pid: number;
      startedAt: number;
    };
    assert.equal(owner.token, acquired.token);
    writeFileSync(lockOwnerPath(root), JSON.stringify({ ...owner, startedAt: Date.now() - 120_000 }), "utf8");

    const waiter = spawnLockWorker({ rootDir: root, mode: "try" });
    await waiter.waitFor("FAILED");
    await waiter.close;
    assert.equal(JSON.parse(readFileSync(lockOwnerPath(root), "utf8")).token, owner.token);

    holder.send("RELEASE");
    await holder.waitFor("RELEASED");
    await holder.close;
  },
);

test("a lock owned by a dead process is recovered by the next writer", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-lock-dead-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSource(root);

  const crashed = spawnLockWorker({ rootDir: root, mode: "crash-after-acquire" });
  await crashed.waitFor("ACQUIRED");
  await crashed.close;

  const result = await spawnWorker({
    rootDir: root,
    actor: "dead-owner-recovery",
    newComponentIds: ["dead-owner-recovery"],
  }).done;
  assert.equal(result.ok, true, `dead owner recovery should permit the next writer: ${JSON.stringify(result)}`);
  assert.equal(
    existsSync(join(root, SEMANTIC_LOCK_DIR)),
    false,
    "the recovered generation must not remain after commit",
  );
});

test("an old owner cannot release a replacement generation after stale recovery", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-lock-generation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSource(root);

  const oldOwner = spawnLockWorker({ rootDir: root, mode: "hold" });
  const oldAcquired = await oldOwner.waitFor("ACQUIRED");
  const oldToken = String(oldAcquired.token);
  const { removeSemanticSourceLockGenerationForTest } = await import("./store.js");
  await removeSemanticSourceLockGenerationForTest(root, oldToken);

  const replacement = spawnLockWorker({ rootDir: root, mode: "hold" });
  const replacementAcquired = await replacement.waitFor("ACQUIRED");
  const replacementToken = String(replacementAcquired.token);
  assert.notEqual(replacementToken, oldToken);

  oldOwner.send("RELEASE");
  await oldOwner.waitFor("RELEASED");
  await oldOwner.close;
  assert.equal(JSON.parse(readFileSync(lockOwnerPath(root), "utf8")).token, replacementToken);

  replacement.send("RELEASE");
  await replacement.waitFor("RELEASED");
  await replacement.close;
});

test("corrupt commit journals fail closed and remain available for recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-journal-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSource(root);
  writeFileSync(join(root, SEMANTIC_JOURNAL_FILE), "{not-json", "utf8");

  await assert.rejects(() => loadSemanticSource(root), /semantic commit journal is corrupt/u);
  assert.equal(existsSync(join(root, SEMANTIC_JOURNAL_FILE)), true);
});

test(
  "two concurrent transactions on non-overlapping entities both persist without losing either mutation",
  { timeout: WORKER_TIMEOUT_MS * 2 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-concurrency-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeSource(root);

    const [resultA, resultB] = await Promise.all([
      spawnWorker({ rootDir: root, actor: "writer-a", newComponentIds: ["concurrency-a"] }).done,
      spawnWorker({ rootDir: root, actor: "writer-b", newComponentIds: ["concurrency-b"] }).done,
    ]);

    assert.equal(resultA.ok, true, `writer-a should succeed via automatic rebase: ${JSON.stringify(resultA)}`);
    assert.equal(resultB.ok, true, `writer-b should succeed via automatic rebase: ${JSON.stringify(resultB)}`);

    const loaded = await loadSemanticSource(root);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const componentNames = loaded.snapshot.declarations.components.map((item) => item.name);
    assert.ok(componentNames.includes("concurrency-a"), "writer-a's mutation must survive the concurrent commit");
    assert.ok(componentNames.includes("concurrency-b"), "writer-b's mutation must survive the concurrent commit");

    const transactionFiles = readdirSync(join(root, ".mottainai/semantics/transactions"));
    assert.equal(transactionFiles.length, 2, "each successful transaction must leave exactly one transaction record");
  },
);

test(
  "two concurrent transactions pinned to the same base digest: exactly one commits, the other gets a structured conflict",
  { timeout: WORKER_TIMEOUT_MS * 2 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-conflict-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeSource(root);
    const baseline = await loadSemanticSource(root);
    assert.equal(baseline.ok, true);
    if (!baseline.ok) return;
    const expectedSnapshotDigest = computeSnapshotDigest(baseline.snapshot);

    const [resultA, resultB] = await Promise.all([
      spawnWorker({ rootDir: root, actor: "pinned-a", newComponentIds: ["pinned-a"], expectedSnapshotDigest }).done,
      spawnWorker({ rootDir: root, actor: "pinned-b", newComponentIds: ["pinned-b"], expectedSnapshotDigest }).done,
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((outcome) => outcome.ok);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    assert.equal(
      succeeded.length,
      1,
      `expected exactly one writer pinned to the same base to succeed: ${JSON.stringify(outcomes)}`,
    );
    assert.equal(
      failed.length,
      1,
      `expected exactly one writer pinned to the same base to fail structurally: ${JSON.stringify(outcomes)}`,
    );
    assert.ok(
      failed[0]!.diagnostics.some(
        (code) => code === "mutation_base_digest_mismatch" || code === "semantic_persist_conflict",
      ),
      `expected a structured conflict diagnostic, got: ${JSON.stringify(failed[0])}`,
    );

    const loaded = await loadSemanticSource(root);
    assert.equal(loaded.ok, true, "the disk state must remain a single, valid, non-torn snapshot after the race");
    const transactionFiles = readdirSync(join(root, ".mottainai/semantics/transactions"));
    assert.equal(transactionFiles.length, 1, "only the winning transaction may be recorded; no torn/duplicate history");
  },
);

test(
  "killing the writer mid-persist converges to either the pre- or the fully-post-transaction state, never a torn mix",
  { timeout: WORKER_TIMEOUT_MS },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-crash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeSource(root);

    // A wide transaction (many distinct declaration files to stage, journal, and rename) widens the
    // real wall-clock window between "the journal is durable" and "every rename has been replayed",
    // which is the window this test wants a real SIGKILL to be able to land inside.
    const newComponentIds = Array.from({ length: 400 }, (_, index) => `crash-generated-${index}`);
    const { child, ready, done } = spawnWorker({
      rootDir: root,
      actor: "crash-writer",
      newComponentIds,
      signalReady: true,
    });
    await ready;

    const journalPath = resolve(root, SEMANTIC_JOURNAL_FILE);
    const deadline = Date.now() + 2_000;
    while (!existsSync(journalPath) && Date.now() < deadline) {
      // Busy-poll rather than sleep: the journal can appear and disappear again (fully replayed)
      // within a couple of milliseconds, and a coarse-grained sleep would routinely miss it.
    }
    child.kill("SIGKILL");
    await assert.rejects(done).catch(() => {
      // A SIGKILL surfaces here as either a rejection (no JSON on stdout) or, if the child had
      // already fully finished and exited before the kill signal was delivered, a resolved
      // success — both are acceptable; what matters is the on-disk state checked below.
    });

    // Recovery is not automatic in real time: it runs the next time something touches the
    // source (here, loadSemanticSource). That is the property under test — the *next* access
    // after a crash always converges, deterministically, to one of the two valid states.
    const loaded = await loadSemanticSource(root);
    assert.equal(loaded.ok, true, JSON.stringify(!loaded.ok ? loaded.diagnostics : []));
    assert.ok(!existsSync(journalPath), "a converged directory must never be left with a pending commit journal");

    if (!loaded.ok) return;
    // Declaration files are keyed by the entity's encoded LogicalId, not its human name, so the
    // parsed snapshot (not a filename match) is the reliable way to count what actually landed.
    const presentGenerated = loaded.snapshot.declarations.components.filter((item) =>
      item.name.startsWith("crash-generated-"),
    ).length;
    assert.ok(
      presentGenerated === 0 || presentGenerated === newComponentIds.length,
      `expected all-or-nothing, found ${presentGenerated} of ${newComponentIds.length} generated components ` +
        "(a torn commit would leave a partial count here)",
    );
    const componentsDir = join(root, ".mottainai/semantics/declarations/components");
    const onDiskComponentFileCount = existsSync(componentsDir) ? readdirSync(componentsDir).length : 0;
    assert.equal(
      onDiskComponentFileCount,
      1 + presentGenerated,
      "the raw file count on disk must agree with what the parser reports, with no orphaned or missing files",
    );
    if (presentGenerated === newComponentIds.length) {
      const transactionFiles = readdirSync(join(root, ".mottainai/semantics/transactions"));
      assert.equal(transactionFiles.length, 1, "a fully-converged commit must leave exactly one transaction record");
    } else {
      const transactionsDir = join(root, ".mottainai/semantics/transactions");
      const transactionFiles = existsSync(transactionsDir) ? readdirSync(transactionsDir) : [];
      assert.equal(transactionFiles.length, 0, "a converged pre-transaction state must have no transaction record");
    }
  },
);
