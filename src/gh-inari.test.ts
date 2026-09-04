import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_GH_INARI_CONFIG,
  GhInariClient,
  GH_INARI_MINIMUM_VERSION,
  GH_INARI_SUPPORTED_VERSION,
  resolveGhInariConfig,
  type GhInariProcess,
} from "./gh-inari.js";
import { resolveGatewayConfig } from "./config.js";
import type { RunResult } from "./subprocess.js";

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

function queuedRunner(results: RunResult[]): {
  runner: GhInariProcess;
  calls: Array<{ args: readonly string[]; input?: string }>;
} {
  let index = 0;
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const runner: GhInariProcess = async (request) => {
    calls.push({ args: request.args, ...(request.input === undefined ? {} : { input: request.input }) });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error("missing fake gh-inari result");
    return result;
  };
  return { runner, calls };
}

function capabilityResults(operationOutput: string): RunResult[] {
  return [
    runResult("gh-inari 0.7.0\n"),
    runResult(
      "  issue get <number> --json\n  pr create --from <file.json>\n  pr get <number> --json\n  --from <path>\n  --json\n  --repository <r>\n  --template <id>\n",
    ),
    runResult(operationOutput),
  ];
}

function executableScript(source: string): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-inari-"));
  const executable = path.join(directory, "gh-inari");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable };
}

test("gh-inari config has finite defaults and resolves explicit bounds", () => {
  assert.deepEqual(resolveGhInariConfig(undefined), DEFAULT_GH_INARI_CONFIG);
  assert.deepEqual(
    resolveGhInariConfig({ command: "/opt/gh-inari", timeoutMs: 700, maxOutputBytes: 800, maxInputBytes: 900 }),
    {
      command: "/opt/gh-inari",
      timeoutMs: 700,
      maxOutputBytes: 800,
      maxInputBytes: 900,
    },
  );
  const gateway = resolveGatewayConfig({ ghInari: { timeoutMs: 701, maxOutputBytes: 801, maxInputBytes: 901 } });
  assert.equal(gateway.ghInari?.timeoutMs, 701);
  assert.equal(gateway.ghInari?.maxOutputBytes, 801);
  assert.equal(gateway.ghInari?.maxInputBytes, 901);
});

test("gh-inari exposes an explicit minimum version contract", async () => {
  assert.equal(GH_INARI_MINIMUM_VERSION, "0.7.0");
  assert.equal(GH_INARI_SUPPORTED_VERSION, ">=0.7.0");
  const { runner } = queuedRunner([
    runResult("gh-inari 0.8.0\n"),
    runResult("issue get\npr create\npr get\n--from\n--json\n--repository\n--template\n"),
  ]);
  const result = await new GhInariClient({ runner }).checkCapabilities();
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.version, "0.8.0");
    assert.deepEqual(result.value.options, ["--from", "--json", "--repository", "--template"]);
  }
});

test("client checks the bounded version/capability contract and sends an explicit repository", async () => {
  const { runner, calls } = queuedRunner(
    capabilityResults(
      JSON.stringify({ ok: true, artifact: { number: 12, url: "https://github.com/acme/repo/pull/12" } }),
    ),
  );
  const client = new GhInariClient({ runner, cwd: "/checkout" });
  const result = await client.createPullRequest({
    repository: { owner: "acme", name: "repo" },
    template: "default",
    input: { fields: { summary: "bounded client" }, head: "feature/client", base: "main" },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { number: 12, url: "https://github.com/acme/repo/pull/12" });
  assert.deepEqual(calls[0]?.args, ["--version"]);
  assert.deepEqual(calls[1]?.args, ["--help=full"]);
  assert.deepEqual(calls[2]?.args, [
    "pr",
    "create",
    "--repository",
    "acme/repo",
    "--from",
    "-",
    "--json",
    "--template",
    "default",
  ]);
  assert.deepEqual(JSON.parse(calls[2]?.input ?? "{}"), {
    fields: { summary: "bounded client" },
    head: "feature/client",
    base: "main",
  });
});

test("client resolves a canonical Issue projection through the explicit repository boundary", async () => {
  const { runner, calls } = queuedRunner(
    capabilityResults(
      JSON.stringify({
        valid: true,
        projection: "canonical",
        classification: "valid",
        kind: "issue",
        number: 411,
        url: "https://github.com/acme/repo/issues/411",
        template: { id: "feature", name: "Feature", path: ".github/ISSUE_TEMPLATE/feature.yml", source: "issue_form" },
        metadata: { title: "Governed task", state: "open", labels: ["enhancement"], assignees: ["octocat"] },
        fields: { capability: "typed projection", acceptance: ["tests"] },
        diagnostics: [],
        provenance: { generation: "tree-411" },
      }),
    ),
  );
  const result = await new GhInariClient({ runner, cwd: "/unrelated/checkout" }).getIssue({
    repository: { owner: "acme", name: "repo" },
    number: 411,
    template: "feature",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.kind, "issue");
    assert.equal(result.value.repository, "acme/repo");
    assert.equal(result.value.classification, "valid");
    assert.deepEqual(result.value.fields, { capability: "typed projection", acceptance: ["tests"] });
    assert.deepEqual(result.value.provenance, { generation: "tree-411" });
  }
  assert.deepEqual(calls[2]?.args, [
    "issue",
    "get",
    "411",
    "--repository",
    "acme/repo",
    "--json",
    "--template",
    "feature",
  ]);
});

test("invalid governed reads return no semantic fields and preserve bounded classification diagnostics", async () => {
  const { runner } = queuedRunner([
    runResult("gh-inari 0.9.0\n"),
    runResult("issue get\npr create\npr get\n--from\n--json\n--repository\n--template\n"),
    runResult(
      JSON.stringify({
        valid: false,
        projection: "unavailable",
        classification: "wrong-template",
        kind: "issue",
        number: 12,
        url: "https://github.com/acme/repo/issues/12",
        metadata: { title: "Wrong", state: "open", labels: [], assignees: [] },
        fields: { guessed: "must not cross the boundary" },
        diagnostics: [{ code: "EXISTING_WRONG_TEMPLATE", message: "wrong template" }],
      }),
      "",
      { exitCode: 2 },
    ),
  ]);
  const result = await new GhInariClient({ runner }).getIssue({ repository: "acme/repo", number: 12 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.valid, false);
    assert.equal(result.value.projection, "unavailable");
    assert.equal(result.value.classification, "wrong-template");
    assert.equal(result.value.fields, undefined);
    assert.equal(result.value.diagnostics.length, 1);
  }
});

test("missing repository is rejected before any companion process can use its cwd", async () => {
  const { runner, calls } = queuedRunner([]);
  const client = new GhInariClient({ runner, cwd: "/unrelated/checkout" });
  const result = await client.createPullRequest({
    repository: "",
    input: { fields: {}, head: "feature/client", base: "main" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INARI_INVALID_REQUEST");
    assert.equal(result.error.details.field, "repository");
  }
  assert.equal(calls.length, 0);
});

test("capability failures are stable for incompatible versions and missing operations", async () => {
  {
    const { runner, calls } = queuedRunner([runResult("gh-inari 0.6.9\n")]);
    const result = await new GhInariClient({ runner }).checkCapabilities();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INARI_COMPANION_INCOMPATIBLE");
      assert.equal(result.error.details.detected, "0.6.9");
      assert.equal(result.error.details.required, ">=0.7.0");
    }
    assert.equal(calls.length, 1);
  }
  {
    const { runner } = queuedRunner([runResult("gh-inari 0.7.0\n"), runResult("  pr create --from <file.json>\n")]);
    const result = await new GhInariClient({ runner }).checkCapabilities();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INARI_CAPABILITY_UNAVAILABLE");
  }
  {
    const { runner } = queuedRunner([
      runResult("gh-inari 0.7.0\n"),
      runResult("issue get\npr create\npr get\n--from\n--json\n--template\n"),
    ]);
    const result = await new GhInariClient({ runner }).checkCapabilities();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INARI_CAPABILITY_UNAVAILABLE");
      assert.equal(result.error.details.missing, "--repository");
    }
  }
  {
    const { runner } = queuedRunner([runResult("not gh-inari\n")]);
    const result = await new GhInariClient({ runner }).checkCapabilities();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INARI_COMPANION_INCOMPATIBLE");
      assert.equal(result.error.details.detected, "unknown");
    }
  }
});

test("missing, timeout, output-limit, and malformed process states fail closed", async () => {
  const missing = await new GhInariClient({
    command: path.join(os.tmpdir(), "mottainai-no-such-gh-inari"),
  }).checkCapabilities();
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, "INARI_COMPANION_MISSING");
    assert.equal(missing.error.details.requiredVersion, ">=0.7.0");
    assert.equal(missing.error.details.requiredOperations, "issue.get,pr.create,pr.get");
  }

  const { runner: timeoutRunner } = queuedRunner([
    runResult("gh-inari 0.7.0\n"),
    runResult("", "", { timedOut: true }),
  ]);
  const timeout = await new GhInariClient({ runner: timeoutRunner, timeoutMs: 42 }).checkCapabilities();
  assert.equal(timeout.ok, false);
  if (!timeout.ok) {
    assert.equal(timeout.error.code, "INARI_TIMEOUT");
    assert.equal(timeout.error.details.timeoutMs, 42);
  }

  const { runner: outputRunner } = queuedRunner(capabilityResults("ignored"));
  const outputClient = new GhInariClient({ runner: outputRunner, maxOutputBytes: 123 });
  const output = await outputClient.createPullRequest({
    repository: "acme/repo",
    input: { fields: {}, head: "feature/client", base: "main" },
  });
  assert.equal(output.ok, false);
  if (!output.ok) assert.equal(output.error.code, "INARI_MALFORMED_OUTPUT");

  const { runner: limitRunner } = queuedRunner([
    runResult("gh-inari 0.7.0\n"),
    runResult("  issue get\n  pr create\n  pr get\n  --from\n  --json\n  --repository\n  --template\n"),
    runResult("", "", { outputLimit: true }),
  ]);
  const limited = await new GhInariClient({ runner: limitRunner, maxOutputBytes: 123 }).getPullRequest({
    repository: "acme/repo",
    number: 12,
  });
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.error.code, "INARI_OUTPUT_LIMIT");
    assert.equal(limited.error.details.limitBytes, 123);
  }
});

test("real child-process cases preserve the same bounded failure contract", async () => {
  const incompatible = executableScript(
    'if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.6.9\\n");',
  );
  const malformed = executableScript(
    'if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.7.0\\n"); else if (process.argv.includes("--help=full")) process.stdout.write("  issue get\\n  pr create\\n  pr get\\n  --from\\n  --json\\n  --repository\\n  --template\\n"); else process.stdout.write("{");',
  );
  const limited = executableScript(
    'if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.7.0\\n"); else if (process.argv.includes("--help=full")) process.stdout.write("  issue get\\n  pr create\\n  pr get\\n  --from\\n  --json\\n  --repository\\n  --template\\n"); else process.stdout.write("x".repeat(4096));',
  );
  const timeout = executableScript(
    'if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.7.0\\n"); else if (process.argv.includes("--help=full")) process.stdout.write("  issue get\\n  pr create\\n  pr get\\n  --from\\n  --json\\n  --repository\\n  --template\\n"); else setTimeout(() => undefined, 10_000);',
  );
  try {
    const incompatibleResult = await new GhInariClient({ command: incompatible.executable }).checkCapabilities();
    assert.equal(incompatibleResult.ok, false);
    if (!incompatibleResult.ok) assert.equal(incompatibleResult.error.code, "INARI_COMPANION_INCOMPATIBLE");

    const malformedResult = await new GhInariClient({ command: malformed.executable }).getPullRequest({
      repository: "acme/repo",
      number: 12,
    });
    assert.equal(malformedResult.ok, false);
    if (!malformedResult.ok) assert.equal(malformedResult.error.code, "INARI_MALFORMED_OUTPUT");

    const limitedResult = await new GhInariClient({ command: limited.executable, maxOutputBytes: 64 }).getPullRequest({
      repository: "acme/repo",
      number: 12,
    });
    assert.equal(limitedResult.ok, false);
    if (!limitedResult.ok) assert.equal(limitedResult.error.code, "INARI_OUTPUT_LIMIT");

    const timeoutResult = await new GhInariClient({ command: timeout.executable, timeoutMs: 20 }).getPullRequest({
      repository: "acme/repo",
      number: 12,
    });
    assert.equal(timeoutResult.ok, false);
    if (!timeoutResult.ok) assert.equal(timeoutResult.error.code, "INARI_TIMEOUT");
  } finally {
    for (const script of [incompatible, malformed, limited, timeout])
      fs.rmSync(script.directory, { recursive: true, force: true });
  }
});

test("remote rejection remains structured and bounded without local reinterpretation", async () => {
  const remote = {
    ok: false,
    error: {
      code: "GOVERNANCE_REJECTED",
      message: "repository governance rejected the artifact",
      details: { explanation: "x".repeat(2_000) },
    },
  };
  const { runner } = queuedRunner(capabilityResults(JSON.stringify(remote)));
  const result = await new GhInariClient({ runner }).createPullRequest({
    repository: "acme/repo",
    input: { fields: {}, head: "feature/client", base: "main" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INARI_REJECTED");
    assert.equal(result.error.remote?.code, "GOVERNANCE_REJECTED");
    assert.ok((result.error.remote?.details as { explanation: string }).explanation.length <= 513);
  }
});

test("the installed packed gh-inari executable reports capabilities and rejects invalid input", async () => {
  const rejection = JSON.stringify({
    ok: false,
    error: { code: "TEMPLATE_NOT_FOUND", message: "template not found" },
  });
  const fake = executableScript(
    `if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.7.0\\n");
     else if (process.argv.includes("--help=full")) process.stdout.write("  issue get <number> --json\\n  pr create --from <file.json>\\n  pr get <number> --json\\n  --from <path>\\n  --json\\n  --repository <r>\\n  --template <id>\\n");
     else process.stdout.write(${JSON.stringify(rejection)});`,
  );
  try {
    const client = new GhInariClient({ command: fake.executable, cwd: process.cwd() });
    const capabilities = await client.checkCapabilities();
    assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
    if (capabilities.ok) {
      assert.equal(capabilities.value.version, "0.7.0");
      assert.deepEqual(capabilities.value.operations, ["issue.get", "pr.create", "pr.get"]);
    }

    const rejected = await client.createPullRequest({
      repository: "yohn-jp/mottainai",
      template: "missing-template-for-client-test",
      input: { fields: {}, head: "feat/inari-client-test", base: "main" },
    });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    if (!rejected.ok) {
      assert.equal(rejected.error.code, "INARI_REJECTED");
      assert.equal(rejected.error.remote?.code, "TEMPLATE_NOT_FOUND");
    }
  } finally {
    fs.rmSync(fake.directory, { recursive: true, force: true });
  }
});

test("a real executable can be replaced only by an explicit configured companion path", () => {
  const script = executableScript(
    'process.stdout.write(process.argv.includes("--version") ? "gh-inari 0.1.0\\n" : "");',
  );
  try {
    assert.equal(resolveGhInariConfig({ command: script.executable }).command, script.executable);
  } finally {
    fs.rmSync(script.directory, { recursive: true, force: true });
  }
});
