import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkflowSqliteStateStore } from "./sqlite-store.js";

function tables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

test("the workflow store persists only Tsukai correlation, never worker-supervision AgentRun state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-tsukai-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.sqlite3");

  // An existing database from before the cutover keeps its legacy rows untouched.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE worker_supervision_records (manager_session_id TEXT PRIMARY KEY, binding_json TEXT)");
  legacy.prepare("INSERT INTO worker_supervision_records VALUES (?, ?)").run("legacy-session", "{}");
  legacy.close();

  const store = new WorkflowSqliteStateStore({ dbPath });
  store.init();
  store.close();
  const names = tables(dbPath);
  assert.ok(names.includes("tsukai_run_correlations"));
  assert.ok(!names.includes("worker_control_audit"), "no worker control audit table is created");
  assert.equal("recordWorkerSupervision" in store, false);
  assert.equal("recordWorkerControlAudit" in store, false);

  const reopened = new DatabaseSync(dbPath);
  const preserved = reopened.prepare("SELECT COUNT(*) AS count FROM worker_supervision_records").get() as {
    count: number;
  };
  reopened.close();
  assert.equal(preserved.count, 1, "legacy rows are neither migrated nor deleted");

  const fresh = path.join(root, "fresh.sqlite3");
  const freshStore = new WorkflowSqliteStateStore({ dbPath: fresh });
  freshStore.init();
  freshStore.close();
  assert.ok(!tables(fresh).includes("worker_supervision_records"));
});
