// 並行性テスト用の子プロセス worker。既存 task に対して 1 回 transitionTask() を
// 呼び出し、結果を JSON で stdout に出す。同一プロセス内の Promise.all では
// node:sqlite の同期呼び出しが真の競合を再現しないため（task-start-worker.mjs
// と同様）、実プロセスを複数同時起動して file-backed DB を共有させる
// （task.concurrency.test.ts 参照）。
//
// transitionTask は「読む(getTask)→検証→書く(updateTaskLifecycleStateIfCurrent)」の
// 2 ステップに分かれるため、単純に 2 プロセス同時起動するだけでは、片方の書き込みが
// もう片方の読み込みより先に完了してしまい（同じ prior state を観測できず）、
// 意図した CAS 競合ではなく通常の "blocked"（re-entrant遷移）を再現してしまうことがある。
// beforeCasWrite フックでファイルベースの barrier を張り、両プロセスが「読み込み＋検証」
// を終えるまで互いを待たせてから初めて CAS 書き込みへ進ませることで、
// 「同一 prior state を観測した 2 並行 caller」という Issue #867 が問題にしている
// 状況を確実に再現する。
import fs from "node:fs";
import path from "node:path";
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { transitionTask } from "./task-lifecycle.js";

const [, , dbPath, taskId, to, workerId, barrierDir] = process.argv;
const otherId = workerId === "a" ? "b" : "a";
const selfMarker = path.join(barrierDir, `${workerId}.ready`);
const otherMarker = path.join(barrierDir, `${otherId}.ready`);
const BARRIER_TIMEOUT_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForOther() {
  fs.writeFileSync(selfMarker, String(process.pid));
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!fs.existsSync(otherMarker)) {
    if (Date.now() > deadline) throw new Error(`barrier wait timed out for worker ${workerId}`);
    sleepSync(10);
  }
}

const store = new WorkflowSqliteStateStore({ dbPath });
store.init();

try {
  const result = transitionTask(store, taskId, to, { beforeCasWrite: waitForOther });
  process.stdout.write(JSON.stringify(result));
} finally {
  store.close();
}
