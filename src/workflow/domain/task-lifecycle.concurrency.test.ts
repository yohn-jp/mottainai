import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import type { RepositoryInstanceId, RootCommitDigest } from "./identity.js";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { createTempDir } from "../../test-support/tmp-dir.js";

/**
 * Issue #867 の直接的な検証:「2 プロセスが同一 taskId に対し同一 prior state からの
 * 合法な遷移を同時発行した場合、片方だけが成功し、もう片方は構造化された conflict を
 * 受け取る（サイレントな二重成功は起きない）」。
 *
 * task.concurrency.test.ts と同じ理由で、単一 Node プロセス内の Promise.all は
 * node:sqlite の同期呼び出しが真の競合を再現しないため、実プロセスを 2 つ同時起動し、
 * file-backed（`:memory:` ではない）DB を共有させる。
 */

interface WorkerOutcome {
  ok: boolean;
  kind?: "blocked" | "conflict";
  task?: { taskId: string; lifecycleState: string; version: number };
  conflict?: {
    taskId: string;
    expectedLifecycle: string;
    expectedVersion: number;
    requestedTransition: string;
    current: { lifecycleState: string; version: number };
  };
}

const WORKER_TIMEOUT_MS = 30_000;

/** worker がハングした場合に test runner 自体がブロックされないよう、
 * kill timer で上限を設ける（node:test は既定でこの種の子プロセス待ちに timeout を掛けない）。 */
function runWorker(
  dbPath: string,
  taskId: string,
  to: string,
  workerId: "a" | "b",
  barrierDir: string,
): Promise<WorkerOutcome> {
  const workerModule = path.join(import.meta.dirname, "task-lifecycle-transition-worker.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerModule, dbPath, taskId, to, workerId, barrierDir],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`worker timed out after ${WORKER_TIMEOUT_MS}ms for taskId=${taskId}`));
    }, WORKER_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`worker exited with code ${code}, stdout: ${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerOutcome);
      } catch (err) {
        reject(new Error(`worker produced non-JSON stdout: ${stdout} (${(err as Error).message})`));
      }
    });
  });
}

test(
  "two concurrent processes transitioning the same task from the same prior state: exactly one succeeds, the other gets a structured conflict",
  { timeout: WORKER_TIMEOUT_MS * 2 },
  async (t) => {
    const dbDir = createTempDir(t, "mottainai-task-lifecycle-concurrency-db-");
    const dbPath = path.join(dbDir, "workflow.sqlite");
    const instanceId = "inst-1" as RepositoryInstanceId;

    // Seed one task in "active" state (both workers observe the same prior
    // lifecycleState/version) from the main process, then close before racing
    // the two independent worker connections against the same file-backed DB.
    const seedStore = new WorkflowSqliteStateStore({ dbPath });
    seedStore.init();
    seedStore.observeRepositoryInstance({
      rootCommitDigest: "digest-1" as RootCommitDigest,
      instanceId,
      gitCommonDir: "/repo/.git",
      canonicalWorktreePath: "/repo",
    });
    const reserved = seedStore.reserveTask({
      instanceId,
      taskSlug: "lifecycle-race",
      issueRef: undefined,
      baseBranch: "main",
      baseCommit: "deadbeef",
      allowMultipleActiveTasksPerIssue: true,
    });
    if (!reserved.ok) throw new Error("expected reserveTask to succeed in test setup");
    const active = seedStore.updateTaskLifecycleState(reserved.task.taskId, "active");
    seedStore.close();

    const barrierDir = createTempDir(t, "mottainai-task-lifecycle-concurrency-barrier-");
    const [resultA, resultB] = await Promise.all([
      runWorker(dbPath, active.taskId, "committed", "a", barrierDir),
      runWorker(dbPath, active.taskId, "committed", "b", barrierDir),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((outcome) => outcome.ok);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    assert.equal(succeeded.length, 1, `expected exactly one process to succeed, got: ${JSON.stringify(outcomes)}`);
    assert.equal(failed.length, 1, `expected exactly one process to lose the race, got: ${JSON.stringify(outcomes)}`);
    assert.equal(
      failed[0]?.kind,
      "conflict",
      `expected the loser to receive a structured conflict (never a silent second success), got: ${JSON.stringify(failed[0])}`,
    );
    assert.equal(failed[0]?.conflict?.current.lifecycleState, "committed");
    assert.equal(failed[0]?.conflict?.expectedLifecycle, "active");
    assert.equal(succeeded[0]?.task?.lifecycleState, "committed");

    // DB 側でも task_version がちょうど 1 回だけ進んでいることを直接確認する
    // （両者が書き込めていたら 2 回進んでしまう）。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT lifecycle_state, task_version FROM tasks WHERE task_id = ?").get(active.taskId) as
        | { lifecycle_state: string; task_version: number }
        | undefined;
      assert.equal(row?.lifecycle_state, "committed");
      assert.equal(row?.task_version, active.version + 1, "expected exactly one version bump, not two");
    } finally {
      db.close();
    }
  },
);
