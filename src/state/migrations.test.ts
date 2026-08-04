import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations } from "./migrations.js";

test("applyMigrations discovers and applies one ordered migration per transaction", () => {
  const db = new DatabaseSync(":memory:");
  const applied: number[] = [];
  try {
    applyMigrations(db, [
      { version: 2, description: "second", up: () => { applied.push(2); } },
      { version: 1, description: "first", up: () => { applied.push(1); } },
    ]);

    assert.deepEqual(applied, [1, 2]);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 2);

    applyMigrations(db, [
      { version: 1, description: "first", up: () => { applied.push(1); } },
      { version: 2, description: "second", up: () => { applied.push(2); } },
    ]);
    assert.deepEqual(applied, [1, 2]);
  } finally {
    db.close();
  }
});
