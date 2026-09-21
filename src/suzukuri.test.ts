import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SUZUKURI_CONFIG, SuzukuriClient, resolveSuzukuriConfig, type SuzukuriProcess } from "./suzukuri.js";
import type { RunResult } from "./subprocess.js";

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout,
    stderr,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimit: false,
    ...overrides,
  };
}

function queuedRunner(results: RunResult[]): {
  runner: SuzukuriProcess;
  calls: Array<{ args: readonly string[]; input?: string }>;
} {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  return {
    calls,
    runner: async (request) => {
      calls.push({ args: request.args, ...(request.input === undefined ? {} : { input: request.input }) });
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected Suzukuri process call");
      return result;
    },
  };
}

function inspection(kind: string, components: readonly { id: string; version: string }[]): string {
  return JSON.stringify({ kind, components });
}

const capabilities = [
  runResult("suzukuri 0.2.2\n"),
  runResult(inspection("adapters", [{ id: "profile-json", version: "1.0.0" }])),
  runResult(inspection("views", [{ id: "profile-json-value", version: "1.0.0" }])),
  runResult(inspection("semantic-contracts", [{ id: "profile-json", version: "1.0.0" }])),
  runResult(inspection("renderers", [{ id: "json", version: "1.0.0" }])),
];

const projection = {
  adapter: { id: "profile-json", version: "1.0.0" },
  byteLength: 7,
  completeness: "complete",
  components: {
    adapter: { id: "profile-json", version: "1.0.0" },
    renderer: { id: "json", version: "1.0.0" },
    semanticContract: { id: "profile-json", version: "1.0.0" },
    view: { id: "profile-json-value", version: "1.0.0" },
  },
  contract: { id: "profile-json", version: "1.0.0" },
  coreVersion: "1.0.0",
  loss: { discarded: [], state: "none" },
  output: '{"a":1}',
  outputSize: 7,
  projectionDigest: "a".repeat(64),
  provenance: {
    adapter: { id: "profile-json", version: "1.0.0" },
    core: { id: "suzukuri-projection-core", version: "1.0.0" },
    renderer: { id: "json", version: "1.0.0" },
    semanticContract: { id: "profile-json", version: "1.0.0" },
    view: { id: "profile-json-value", version: "1.0.0" },
  },
  renderer: { id: "json", version: "1.0.0" },
  semanticContract: { id: "profile-json", version: "1.0.0" },
  view: { id: "profile-json-value", version: "1.0.0" },
};

test("resolveSuzukuriConfig applies bounded defaults and explicit overrides", () => {
  assert.deepEqual(resolveSuzukuriConfig(undefined), DEFAULT_SUZUKURI_CONFIG);
  assert.deepEqual(
    resolveSuzukuriConfig({ command: "/opt/suzukuri", timeoutMs: 700, maxOutputBytes: 800, maxInputBytes: 900 }),
    {
      command: "/opt/suzukuri",
      timeoutMs: 700,
      maxOutputBytes: 800,
      maxInputBytes: 900,
    },
  );
  assert.throws(() => resolveSuzukuriConfig({ command: "" }), /command must not be empty/);
});

test("capability discovery is cached and project uses the explicit bounded public CLI contract", async () => {
  const queued = queuedRunner([...capabilities, runResult(JSON.stringify(projection))]);
  const client = new SuzukuriClient({ runner: queued.runner, cwd: "/checkout" });
  const request = {
    source: { identity: { id: "src/example.json", revision: "r1" }, content: '{"a":1}' },
    adapter: "profile-json",
    view: "profile-json-value",
    budget: 64,
    renderer: "json",
  } as const;
  const first = await client.project(request);
  assert.equal(first.ok, true, JSON.stringify(first));
  if (first.ok) {
    assert.deepEqual(first.value.source, { id: "src/example.json", revision: "r1" });
    assert.equal(first.value.suzukuriVersion, "0.2.2");
    assert.equal(first.value.budget, 64);
    assert.equal(first.value.projectionDigest, "a".repeat(64));
  }
  const secondCapabilities = await client.checkCapabilities();
  assert.equal(secondCapabilities.ok, true);
  assert.equal(queued.calls.length, 6);
  assert.deepEqual(queued.calls[5]?.args, [
    "project",
    "--adapter",
    "profile-json",
    "--view",
    "profile-json-value",
    "--budget",
    "64",
    "--renderer",
    "json",
    "--input",
    "-",
  ]);
  assert.equal(queued.calls[5]?.input, '{"a":1}');
});

test("input, missing, incompatible, malformed, oversized, timeout, and rejection states fail explicitly", async () => {
  const inputLimit = await new SuzukuriClient({ maxInputBytes: 2, runner: async () => runResult("") }).project({
    source: { identity: "source", content: "123" },
    adapter: "a",
    view: "v",
    budget: 1,
    renderer: "json",
  });
  assert.equal(inputLimit.ok, false);
  if (!inputLimit.ok) assert.equal(inputLimit.error.code, "SUZUKURI_INPUT_LIMIT");

  const missing = await new SuzukuriClient({
    runner: async () => runResult("", "", { spawnError: "ENOENT" }),
  }).checkCapabilities();
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "SUZUKURI_COMPANION_MISSING");

  const incompatible = await new SuzukuriClient({
    runner: async () => runResult("suzukuri 0.2.1\n"),
  }).checkCapabilities();
  assert.equal(incompatible.ok, false);
  if (!incompatible.ok) assert.equal(incompatible.error.code, "SUZUKURI_COMPANION_INCOMPATIBLE");

  const malformed = queuedRunner([...capabilities, runResult("{")]);
  const malformedResult = await new SuzukuriClient({ runner: malformed.runner }).project({
    source: { identity: "source", content: "{}" },
    adapter: "profile-json",
    view: "profile-json-value",
    budget: 10,
    renderer: "json",
  });
  assert.equal(malformedResult.ok, false);
  if (!malformedResult.ok) assert.equal(malformedResult.error.code, "SUZUKURI_MALFORMED_OUTPUT");

  const outputLimit = await new SuzukuriClient({
    runner: async () => runResult("", "", { outputLimit: true }),
  }).checkCapabilities();
  assert.equal(outputLimit.ok, false);
  if (!outputLimit.ok) assert.equal(outputLimit.error.code, "SUZUKURI_OUTPUT_LIMIT");

  const timeout = await new SuzukuriClient({
    runner: async () => runResult("", "", { timedOut: true }),
  }).checkCapabilities();
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.error.code, "SUZUKURI_TIMEOUT");

  const rejection = queuedRunner([
    ...capabilities,
    runResult("", JSON.stringify({ code: "COMPONENT_NOT_FOUND", message: "view not found" }), { exitCode: 1 }),
  ]);
  const rejected = await new SuzukuriClient({ runner: rejection.runner }).project({
    source: { identity: "source", content: "{}" },
    adapter: "profile-json",
    view: "profile-json-value",
    budget: 10,
    renderer: "json",
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "SUZUKURI_REJECTED");
});

test("the packed Suzukuri 0.2.2 companion exposes the supported machine surface", async (t) => {
  const command = path.resolve("node_modules/.bin/suzukuri");
  if (!fs.existsSync(command)) {
    t.skip("packed Suzukuri dependency is unavailable");
    return;
  }
  const client = new SuzukuriClient({ command, cwd: process.cwd() });
  const result = await client.project({
    source: { identity: "packed-test", content: '{"a":1,"b":2}' },
    adapter: "profile-json",
    view: "profile-json-value",
    budget: 256,
    renderer: "json",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.suzukuriVersion, "0.2.2");
    assert.equal(result.value.completeness, "complete");
    assert.equal(result.value.loss.state, "none");
    assert.match(result.value.projectionDigest, /^[0-9a-f]{64}$/u);
  }
});
