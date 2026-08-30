import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("scripts/bootstrap.mjs runs main.ts end to end (status --json) via node --import tsx", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/bootstrap.mjs", "status", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.contractId, "mottainai.bootstrap-state.v1");
  assert.equal(typeof parsed.present, "boolean");
});
