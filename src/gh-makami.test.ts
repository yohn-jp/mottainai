import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_GH_MAKAMI_CONFIG,
  GH_MAKAMI_MACHINE_CONTRACT,
  GH_MAKAMI_REQUIRED_CAPABILITIES,
  GH_MAKAMI_SUPPORTED_OPERATIONS,
  GH_MAKAMI_SUPPORTED_VERSION,
  GhMakamiClient,
  resolveGhMakamiConfig,
  type GhMakamiJsonObject,
  type GhMakamiProcess,
} from "./gh-makami.js";
import { resolveGatewayConfig } from "./config.js";
import type { RunResult } from "./subprocess.js";

const repository = "acme/example";
const headSha = "a".repeat(40);

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

function contractResult(overrides: Record<string, unknown> = {}): RunResult {
  return runResult(
    JSON.stringify({
      identifier: GH_MAKAMI_MACHINE_CONTRACT,
      package: { name: "gh-makami", version: "0.1.0" },
      capabilities: GH_MAKAMI_REQUIRED_CAPABILITIES.map((id) => ({ id, version: 0, stability: "stable" })),
      ...overrides,
    }),
  );
}

function snapshot(overrides: Record<string, unknown> = {}): GhMakamiJsonObject {
  return {
    kind: "pr-snapshot",
    schemaVersion: 0,
    repository,
    prNumber: 12,
    generation: { repository, prNumber: 12, headSha },
    headSha,
    ...overrides,
  };
}

function queuedRunner(results: RunResult[]): {
  runner: GhMakamiProcess;
  calls: Array<{ args: readonly string[]; input?: string; cwd: string }>;
} {
  let index = 0;
  const calls: Array<{ args: readonly string[]; input?: string; cwd: string }> = [];
  const runner: GhMakamiProcess = async (request) => {
    calls.push({
      args: request.args,
      cwd: request.cwd,
      ...(request.input === undefined ? {} : { input: request.input }),
    });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error("missing fake gh-makami result");
    return result;
  };
  return { runner, calls };
}

function executableScript(source: string): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-makami-"));
  const executable = path.join(directory, "gh-makami");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable };
}

test("gh-makami config has finite defaults and resolves explicit bounds", () => {
  assert.deepEqual(resolveGhMakamiConfig(undefined), DEFAULT_GH_MAKAMI_CONFIG);
  assert.deepEqual(
    resolveGhMakamiConfig({ command: "/opt/gh-makami", timeoutMs: 700, maxOutputBytes: 800, maxInputBytes: 900 }),
    { command: "/opt/gh-makami", timeoutMs: 700, maxOutputBytes: 800, maxInputBytes: 900 },
  );
  assert.equal(GH_MAKAMI_SUPPORTED_VERSION, ">=0.1.0");
  assert.deepEqual([...GH_MAKAMI_SUPPORTED_OPERATIONS], ["status", "reconcile", "await"]);
  const gateway = resolveGatewayConfig({ ghMakami: { timeoutMs: 701, maxOutputBytes: 801, maxInputBytes: 901 } });
  assert.deepEqual(gateway.ghMakami, {
    command: "gh-makami",
    timeoutMs: 701,
    maxOutputBytes: 801,
    maxInputBytes: 901,
  });
});

test("the client consumes the released contract and sends explicit status identity", async () => {
  const { runner, calls } = queuedRunner([contractResult(), runResult(JSON.stringify(snapshot()))]);
  const client = new GhMakamiClient({ runner, cwd: "/unrelated/caller-cwd" });

  const result = await client.status({ repository, prNumber: 12 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.value.generation, { repository, prNumber: 12, headSha });
    assert.deepEqual(result.value.snapshot, snapshot());
  }
  assert.deepEqual(
    calls.map(({ args }) => [...args]),
    [["--contract"], ["status", "--repository", repository, "--pr", "12", "--json"]],
  );
  assert.equal(calls[1]?.cwd, "/unrelated/caller-cwd");
});

test("reconcile passes the bounded prior snapshot as deterministic JSON stdin", async () => {
  const previous = snapshot({ state: "open" });
  const delta = {
    kind: "unchanged",
    changed: false,
    generation: { repository, prNumber: 12, headSha },
    changes: [],
    snapshot: previous,
  };
  const { runner, calls } = queuedRunner([contractResult(), runResult(JSON.stringify(delta))]);
  const client = new GhMakamiClient({ runner });

  const result = await client.reconcile({ repository, prNumber: 12, previous });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.delta.kind, "unchanged");
    assert.deepEqual(result.value.generation, { repository, prNumber: 12, headSha });
  }
  assert.deepEqual(calls[1]?.args, ["reconcile", "--repository", repository, "--pr", "12", "--from", "-", "--json"]);
  assert.deepEqual(JSON.parse(calls[1]?.input ?? "{}"), previous);
});

test("await returns a normalized transition and suppresses no local state model", async () => {
  const previous = snapshot({ state: "open" });
  const awaitResult = {
    kind: "state-change",
    changed: true,
    generation: { repository, prNumber: 12, headSha },
    changes: [{ kind: "lifecycle-change", path: "lifecycle", before: "open", after: "merged" }],
    snapshot: snapshot({ state: "closed", merged: true }),
  };
  const { runner, calls } = queuedRunner([contractResult(), runResult(JSON.stringify(awaitResult))]);
  const client = new GhMakamiClient({ runner });

  const result = await client.await({ repository, prNumber: 12, startingSnapshot: previous });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.result.kind, "state-change");
    assert.equal(result.value.snapshot?.state, "closed");
  }
  assert.deepEqual(calls[1]?.args, ["await", "--repository", repository, "--pr", "12", "--from", "-", "--json"]);
});

test("missing starting snapshot and mismatched identity fail before observation", async () => {
  const { runner, calls } = queuedRunner([]);
  const client = new GhMakamiClient({ runner, cwd: "/unrelated/caller-cwd" });

  const missing = await client.await({ repository, prNumber: 12 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "MAKAMI_INVALID_REQUEST");

  const mismatched = await client.reconcile({
    repository,
    prNumber: 12,
    previous: { generation: { repository: "other/repository", prNumber: 12, headSha } },
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.error.code, "MAKAMI_IDENTITY_MISMATCH");
    assert.equal(mismatched.error.phase, "input");
  }
  assert.equal(calls.length, 0);
});

test("malformed, missing, incompatible, timeout, and output-limit states fail closed", async () => {
  {
    const { runner, calls } = queuedRunner([]);
    const limitedInput = await new GhMakamiClient({ runner, maxInputBytes: 32 }).reconcile({
      repository,
      prNumber: 12,
      previous: snapshot({ detail: "x".repeat(100) }),
    });
    assert.equal(limitedInput.ok, false);
    if (!limitedInput.ok) assert.equal(limitedInput.error.code, "MAKAMI_INPUT_LIMIT");
    assert.equal(calls.length, 0);
  }
  {
    const missing = await new GhMakamiClient({
      command: path.join(os.tmpdir(), "mottainai-no-such-gh-makami"),
    }).checkCapabilities();
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "MAKAMI_COMPANION_MISSING");
      assert.equal(missing.error.details.requiredContract, GH_MAKAMI_MACHINE_CONTRACT);
    }
  }
  {
    const { runner } = queuedRunner([contractResult({ identifier: "other/contracts/v1" })]);
    const incompatible = await new GhMakamiClient({ runner }).checkCapabilities();
    assert.equal(incompatible.ok, false);
    if (!incompatible.ok) assert.equal(incompatible.error.code, "MAKAMI_COMPANION_INCOMPATIBLE");
  }
  {
    const { runner } = queuedRunner([contractResult(), runResult("{")]);
    const malformed = await new GhMakamiClient({ runner }).status({ repository, prNumber: 12 });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "MAKAMI_MALFORMED_OUTPUT");
  }
  {
    const { runner } = queuedRunner([runResult("", "", { timedOut: true })]);
    const timeout = await new GhMakamiClient({ runner, timeoutMs: 42 }).checkCapabilities();
    assert.equal(timeout.ok, false);
    if (!timeout.ok) {
      assert.equal(timeout.error.code, "MAKAMI_TIMEOUT");
      assert.equal(timeout.error.details.timeoutMs, 42);
    }
  }
  {
    const { runner } = queuedRunner([contractResult(), runResult("", "", { outputLimit: true })]);
    const limited = await new GhMakamiClient({ runner, maxOutputBytes: 123 }).status({ repository, prNumber: 12 });
    assert.equal(limited.ok, false);
    if (!limited.ok) {
      assert.equal(limited.error.code, "MAKAMI_OUTPUT_LIMIT");
      assert.equal(limited.error.details.limitBytes, 123);
    }
  }
});

test("a returned generation for another repository is rejected without a GitHub fallback", async () => {
  const wrong = snapshot({
    repository: "other/repository",
    generation: { repository: "other/repository", prNumber: 12, headSha },
  });
  const { runner, calls } = queuedRunner([contractResult(), runResult(JSON.stringify(wrong))]);
  const result = await new GhMakamiClient({ runner }).status({ repository, prNumber: 12 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "MAKAMI_IDENTITY_MISMATCH");
  assert.equal(
    calls.some(({ args }) => args.includes("gh")),
    false,
  );
  assert.equal(
    calls.some(({ args }) => args.includes("create")),
    false,
  );
});

test("packed-style executable process uses only the public contract and operation commands", async () => {
  const fake = executableScript(`
const contract = ${JSON.stringify({
    identifier: GH_MAKAMI_MACHINE_CONTRACT,
    package: { name: "gh-makami", version: "0.1.0" },
    capabilities: GH_MAKAMI_REQUIRED_CAPABILITIES.map((id) => ({ id, version: 0, stability: "stable" })),
  })};
const generation = { repository: "${repository}", prNumber: 12, headSha: "${headSha}" };
if (process.argv.includes("--contract")) process.stdout.write(JSON.stringify(contract));
else if (process.argv[2] === "status") process.stdout.write(JSON.stringify({ generation, headSha: generation.headSha }));
else setTimeout(() => undefined, 10_000);
`);
  try {
    const client = new GhMakamiClient({ command: fake.executable, cwd: os.tmpdir() });
    const result = await client.status({ repository, prNumber: 12 });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.deepEqual(result.value.generation, { repository, prNumber: 12, headSha });
  } finally {
    fs.rmSync(fake.directory, { recursive: true, force: true });
  }
});
