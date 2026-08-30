import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runBootstrapCli } from "./cli.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";

function captureStdout(): { restore: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string) => {
    buffer += chunk;
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
      return buffer;
    },
  };
}

test("status --json against a fresh path reports a bounded, fixed-shape envelope (present:false)", async () => {
  // CANONICAL_BOOTSTRAP_STATE_FILE_PATH is a fixed constant the CLI always
  // uses in production, so this test exercises the real path and expects
  // it not to exist in this sandboxed environment — verifying the CLI
  // never fabricates a present:true report for a path it can't read.
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["status", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["contractId", "present", "schemaVersion"]);
  assert.equal(parsed.contractId, "mottainai.bootstrap-state.v1");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.present, false);
});

test("verify --json against a fresh path reports bounded, machine-readable output", async () => {
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["verify", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["contractId", "reason", "schemaVersion", "verified"]);
  assert.equal(parsed.verified, false);
});

test("an unknown command is rejected deterministically", async () => {
  const exitCode = await runBootstrapCli(["nonsense"]);
  assert.equal(exitCode, 1);
});

test("build has no --state-file flag: no code path reads one as a state-path override", async () => {
  // The CLI never parses a --state-file flag value anywhere in its source;
  // this asserts that structurally rather than behaviorally (a real
  // `build` run needs a valid manifest + Nix, which this unit test
  // intentionally does not exercise — see build.test.ts for the full
  // pipeline). Matches actual flag-reading calls, not prose that merely
  // discusses the absence of such a flag (this file's own doc comment
  // mentions "--state-file" while explaining that it deliberately doesn't
  // exist).
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  assert.doesNotMatch(source, /requireFlagValue\([^)]*["'`]state-file["'`]/u);
  assert.doesNotMatch(source, /hasFlag\([^)]*["'`]state-file["'`]/u);
  assert.doesNotMatch(source, /process\.env\.\w*STATE/u);
  assert.doesNotMatch(source, /process\.env\.MOTTAINAI_CONTROL_STATE_ROOT/u);
});

test("the CLI's production dispatch always uses CANONICAL_BOOTSTRAP_STATE_FILE_PATH, never a caller-supplied path", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  const stateFilePathUsages = [...source.matchAll(/stateFilePath:\s*(\S+)/gu)].map((match) => match[1].replace(/,$/u, ""));
  assert.ok(stateFilePathUsages.length > 0, "expected at least one stateFilePath: usage in cli.ts");
  for (const usage of stateFilePathUsages) {
    assert.equal(usage, "CANONICAL_BOOTSTRAP_STATE_FILE_PATH");
  }
  assert.equal(CANONICAL_BOOTSTRAP_STATE_FILE_PATH, "/var/lib/mottainai-control/bootstrap/state.json");
});
