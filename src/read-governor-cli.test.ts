import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** scripts/ は `src/**\/*.test.ts` の外なので、CLI は子プロセスとして実行して検証する。 */
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "read-governor.ts");

function run(input: string, logDir?: string): { status: number; json: Record<string, unknown> } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...(logDir === undefined ? {} : { MOTTAINAI_READ_GOVERNOR_LOG_DIR: logDir }) },
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: result.status ?? -1, json };
}

test("returns an allow decision for a small file over stdin", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-read-governor-"));
  const { status, json } = run(JSON.stringify({ path: "apps/gateway/src/small.ts", estimatedLines: 40 }), directory);
  assert.equal(status, 0);
  assert.equal(json.action, "allow");
  assert.equal(json.policyCode, "NONE");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("reports the policy code a later stage would apply to a large source file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-read-governor-"));
  const { json } = run(JSON.stringify({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }), directory);
  assert.equal(json.action, "allow");
  assert.equal(json.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
  assert.ok(Array.isArray(json.suggestedTools) && (json.suggestedTools as unknown[]).length > 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("allows and does not crash on malformed stdin", () => {
  const { status, json } = run("not json");
  assert.equal(status, 0);
  assert.equal(json.action, "allow");
});

test("allows and does not crash when path is missing", () => {
  const { status, json } = run(JSON.stringify({ estimatedLines: 900 }));
  assert.equal(status, 0);
  assert.equal(json.action, "allow");
});

test("appends a bounded metadata record to the log directory, without file content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-read-governor-"));
  run(JSON.stringify({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }), directory);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(directory, files[0]), "utf8").trim();
  const record = JSON.parse(content) as Record<string, unknown>;
  assert.equal(record.path, "apps/gateway/src/big.ts");
  assert.equal(record.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
  assert.ok(!("content" in record));
  fs.rmSync(directory, { recursive: true, force: true });
});
