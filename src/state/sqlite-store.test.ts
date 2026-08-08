import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { applyMigrations, MIGRATIONS } from "./migrations.js";
import { SqliteStateStore } from "./sqlite-store.js";
import { DatabaseSync } from "node:sqlite";

const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-state-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.sqlite3");
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init(): creates the database file on disk", () => {
  const dbPath = tmpDbPath();
  assert.ok(!fs.existsSync(dbPath));
  const store = new SqliteStateStore({ dbPath });
  store.init();
  assert.ok(fs.existsSync(dbPath));
  store.close();
});

test("init(): is idempotent (safe to call twice)", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1" });
  store.close();
});

test("migrations: applyMigrations records applied versions and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  applyMigrations(db); // 二回目は何も適用しない
  const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number };
  assert.equal(row.version, MIGRATIONS[MIGRATIONS.length - 1].version);
  db.close();
});

test("migrations: a failing migration rolls back and does not record its version", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => {
    applyMigrations(db, [
      { version: 1, description: "ok", up: (handle) => handle.exec("CREATE TABLE ok (id INTEGER)") },
      { version: 2, description: "broken", up: (handle) => handle.exec("CREATE TABLE ok (id INTEGER)") }, // 既存テーブル名と衝突させ失敗させる
    ]);
  }, /migration 2 \(broken\) failed/);
  const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null };
  assert.equal(row.version, 1);
  db.close();
});

test("createSession(): persists and returns a session record", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  const created = store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });
  assert.deepEqual(created, { sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000, lastSeenAt: 1000 });
  const fetched = store.getSession("s1");
  assert.deepEqual(fetched, created);
  store.close();
});

test("getSession(): returns undefined for unknown session", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  assert.equal(store.getSession("missing"), undefined);
  store.close();
});

test("touchSession(): updates lastSeenAt without changing other fields", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });
  store.touchSession("s1", 2000);
  const fetched = store.getSession("s1");
  assert.equal(fetched?.lastSeenAt, 2000);
  assert.equal(fetched?.createdAt, 1000);
  store.close();
});

test("recordReadEvidence(): persists and round-trips a read evidence record", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });
  const input = {
    evidenceId: "rev_1",
    sessionId: "s1",
    repositoryId: "r1",
    worktreeId: "w1",
    provider: "codegraph",
    path: "src/foo.ts",
    startLine: 10,
    endLine: 20,
    reason: "structural exploration",
    createdAt: 1000,
    expiresAt: 2000,
  };
  const recorded = store.recordReadEvidence(input);
  assert.deepEqual(recorded, input);
  const fetched = store.getReadEvidence("rev_1");
  assert.deepEqual(fetched, input);
  store.close();
});

test("getReadEvidence(): returns undefined for unknown evidence id", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  assert.equal(store.getReadEvidence("missing"), undefined);
  store.close();
});

test("recordReadDecision()/listReadDecisions(): persists and lists newest first, filterable by session", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });
  store.createSession({ sessionId: "s2", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });

  store.recordReadDecision({
    decisionId: "d1",
    sessionId: "s1",
    path: "src/a.ts",
    action: "allow",
    fileClass: "source",
    capability: "code.symbol",
    policyCode: "NONE",
    reason: "small file",
    stage: "observe",
    createdAt: 1000,
  });
  store.recordReadDecision({
    decisionId: "d2",
    sessionId: "s1",
    path: "src/b.ts",
    action: "rewrite",
    fileClass: "source",
    capability: "code.symbol",
    policyCode: "FULL_READ_REQUIRES_LOCALIZATION",
    reason: "large file",
    stage: "warn",
    createdAt: 2000,
  });
  store.recordReadDecision({
    decisionId: "d3",
    sessionId: "s2",
    path: "src/c.ts",
    action: "allow",
    fileClass: "document",
    capability: "document.heading",
    policyCode: "NONE",
    reason: "small file",
    stage: "observe",
    createdAt: 1500,
  });

  const forSessionOne = store.listReadDecisions({ sessionId: "s1" });
  assert.deepEqual(forSessionOne.map((decision) => decision.decisionId), ["d2", "d1"]);

  const all = store.listReadDecisions();
  assert.deepEqual(all.map((decision) => decision.decisionId), ["d2", "d3", "d1"]);

  store.close();
});

test("listReadDecisions(): breaks ties on identical created_at by insertion order (rowid), not by decisionId", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });

  // decisionId は乱数 UUID 由来で挿入順とは無関係な値になり得る。あえて挿入順とは逆順のIDにする。
  for (const decisionId of ["z-inserted-first", "a-inserted-second", "m-inserted-third"]) {
    store.recordReadDecision({
      decisionId,
      sessionId: "s1",
      path: "src/a.ts",
      action: "allow",
      fileClass: "source",
      capability: "code.symbol",
      policyCode: "NONE",
      reason: "same millisecond",
      stage: "observe",
      createdAt: 5000,
    });
  }

  const all = store.listReadDecisions();
  assert.deepEqual(
    all.map((decision) => decision.decisionId),
    ["m-inserted-third", "a-inserted-second", "z-inserted-first"],
  );
  store.close();
});

test("listReadDecisions(): clamps negative, fractional, and oversized limits to a bounded positive integer", () => {
  const store = new SqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1", createdAt: 1000 });
  for (let i = 0; i < 5; i += 1) {
    store.recordReadDecision({
      decisionId: `d${i}`,
      sessionId: "s1",
      path: "src/a.ts",
      action: "allow",
      fileClass: "source",
      capability: "code.symbol",
      policyCode: "NONE",
      reason: "r",
      stage: "observe",
      createdAt: 1000 + i,
    });
  }

  // SQLite は負の LIMIT を「無制限」と扱うため、正規化しないと -1 が全行返却になってしまう。
  // 正規化後は「正の整数の下限 1」に丸められる。
  assert.equal(store.listReadDecisions({ limit: -1 }).length, 1);
  assert.equal(store.listReadDecisions({ limit: 2.9 }).length, 2);
  assert.equal(store.listReadDecisions({ limit: 0 }).length, 1);
  assert.equal(store.listReadDecisions({ limit: Number.POSITIVE_INFINITY }).length, 5);
  assert.equal(store.listReadDecisions({ limit: 10_000 }).length, 5);
  store.close();
});

test("init(): closes the database handle when a migration fails, leaving the store uninitialized", (t) => {
  const dbPath = tmpDbPath();
  // 事前に衝突する `sessions` テーブルを作り、migration 1 を失敗させる。
  const preexisting = new DatabaseSync(dbPath);
  preexisting.exec("CREATE TABLE sessions (id INTEGER)");
  preexisting.close();

  const closeSpy = t.mock.method(DatabaseSync.prototype, "close");
  const store = new SqliteStateStore({ dbPath });
  assert.throws(() => store.init(), /migration 1/);
  assert.equal(closeSpy.mock.callCount(), 1);
  assert.throws(
    () => store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1" }),
    /init\(\) must be called/,
  );
});

test("init(): restricts the state directory, database file, and WAL sidecars to owner-only permissions", () => {
  const dbPath = tmpDbPath();
  const dir = path.dirname(dbPath);
  // ディレクトリは既に存在する（tmpDbPath が mkdtempSync 済み）状態で、緩い permission から始める。
  fs.chmodSync(dir, 0o777);

  const store = new SqliteStateStore({ dbPath });
  store.init();
  store.createSession({ sessionId: "s1", repositoryId: "r1", worktreeId: "w1" });

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600, sidecar);
    }
  }
  store.close();
});
