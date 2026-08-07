import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";

/**
 * 受入基準「2 プロセス同時 task start が同一 repository/Issue/branch/worktree path
 * を両方とも claim できない」の直接的な検証。単一 Node プロセス内の Promise.all は
 * node:sqlite の同期呼び出しが真の競合を再現しないため（task.test.ts の他のテストは
 * すべて単一プロセス・単一 store）、ここでは実プロセスを 2 つ同時起動し、
 * file-backed（`:memory:` ではない）DB を共有させる。
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t: TestContext): string {
  const root = tmpDir(t, "mottainai-task-concurrency-test-");
  git(["init", "--quiet", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
  git(["add", "file.txt"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  return root;
}

interface WorkerOutcome {
  ok: boolean;
  reason?: string;
  task?: { taskId: string };
  worktree?: { worktreeId: string };
}

const WORKER_TIMEOUT_MS = 30_000;

/** worker がハングした場合に test runner 自体がブロックされないよう、
 * kill timer で上限を設ける（node:test は既定でこの種の子プロセス待ちに timeout を掛けない）。 */
function runWorker(workspaceRoot: string, dbPath: string, taskSlug: string, issueRef: string): Promise<WorkerOutcome> {
  const workerModule = path.join(import.meta.dirname, "task-start-worker.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerModule, workspaceRoot, dbPath, taskSlug, issueRef], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`worker timed out after ${WORKER_TIMEOUT_MS}ms for taskSlug=${taskSlug}`));
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

test("two concurrent processes starting a task with the same issueRef/taskSlug: exactly one wins", { timeout: WORKER_TIMEOUT_MS * 2 }, async (t) => {
  const root = initRepo(t);
  const dbDir = tmpDir(t, "mottainai-task-concurrency-db-");
  const dbPath = path.join(dbDir, "workflow.sqlite");

  const [resultA, resultB] = await Promise.all([
    runWorker(root, dbPath, "concurrent-task", "42"),
    runWorker(root, dbPath, "concurrent-task", "42"),
  ]);

  const outcomes = [resultA, resultB];
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  assert.equal(succeeded.length, 1, `expected exactly one process to succeed, got: ${JSON.stringify(outcomes)}`);
  assert.equal(failed.length, 1, `expected exactly one process to fail, got: ${JSON.stringify(outcomes)}`);
  assert.ok(
    failed[0]?.reason === "issue-already-claimed" || failed[0]?.reason === "branch-collision",
    `expected a structured collision reason, got: ${failed[0]?.reason}`,
  );

  // DB 側にも重複が残っていないことを直接確認する。
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const taskCount = (db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE issue_ref = ?").get("42") as { count: number }).count;
    const worktreeCount = (db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE branch_name = ?").get("issue-42/concurrent-task") as {
      count: number;
    }).count;
    assert.equal(taskCount, 1, "expected exactly one task row to persist for the contested issue");
    assert.equal(worktreeCount, 1, "expected exactly one worktree row to persist for the contested branch");
  } finally {
    db.close();
  }
});

test("two concurrent processes starting a task with the same taskSlug but no issueRef: branch collision leaves exactly one worktree", { timeout: WORKER_TIMEOUT_MS * 2 }, async (t) => {
  const root = initRepo(t);
  const dbDir = tmpDir(t, "mottainai-task-concurrency-db-");
  const dbPath = path.join(dbDir, "workflow.sqlite");

  const [resultA, resultB] = await Promise.all([
    runWorker(root, dbPath, "no-issue-task", ""),
    runWorker(root, dbPath, "no-issue-task", ""),
  ]);

  const outcomes = [resultA, resultB];
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  assert.equal(succeeded.length, 1, `expected exactly one process to succeed, got: ${JSON.stringify(outcomes)}`);
  assert.equal(failed.length, 1, `expected exactly one process to fail, got: ${JSON.stringify(outcomes)}`);
  assert.equal(failed[0]?.reason, "branch-collision");

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const worktreeCount = (db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE branch_name = ?").get("task/no-issue-task") as {
      count: number;
    }).count;
    assert.equal(worktreeCount, 1, "expected exactly one worktree row to persist for the contested branch");
  } finally {
    db.close();
  }
});
