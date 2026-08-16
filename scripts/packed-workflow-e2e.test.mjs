import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkspace, isolatedEnv, writeConfig } from "./lib/mcp-blackbox-test-support.mjs";
import {
  extractTarball,
  linkDependencies,
  packRepository,
  resolvePackagedBin,
} from "./lib/mcp-blackbox-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 120_000;
let suiteRoot;
let binPath;

before(() => {
  const suppliedTarball = process.env.MOTTAINAI_PACKAGE_TARBALL;
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-packed-workflow-e2e-"));
  const packed = suppliedTarball === undefined ? packRepository(repoRoot, suiteRoot) : undefined;
  const tarballPath = packed?.tarballPath ?? path.resolve(suppliedTarball);
  const extracted = extractTarball(tarballPath, path.join(suiteRoot, "extracted"));
  linkDependencies(extracted, repoRoot);
  binPath = resolvePackagedBin(extracted);
});

after(() => {
  if (suiteRoot !== undefined) fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error !== undefined) throw result.error;
  return result;
}

function runGit(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function workflowPolicy() {
  return {
    schemaVersion: 1,
    preset: "standard",
    protectedBranches: ["main", "master"],
    protectedBranchRule: {
      sourceWrite: "advisory",
      stage: "advisory",
      commit: "advisory",
      directPush: "enforce",
      forcePush: "enforce",
      destructiveBranchOp: "enforce",
    },
    controlPlaneRole: "any",
    worktree: {
      required: "off",
      issueRequired: "off",
      bootstrapMode: "suggest",
      multipleActiveTasksPerIssue: "advisory",
      multipleWorktreesPerTask: "advisory",
      staleBaseBranch: "advisory",
    },
    stagingMode: "already-staged-only",
    cleanup: {
      worktreeRemoval: "advisory",
      localBranchDeletion: "advisory",
      remoteBranchDeletion: "off",
      worktreePrune: "advisory",
      forceCleanup: "off",
    },
  };
}

function fakePiSource() {
  return String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const cwd = process.cwd();
const tracePath = process.env.MOTTAINAI_PI_TRACE;
const mode = process.env.MOTTAINAI_FAKE_PI_MODE ?? "golden";
const packedBin = process.env.MOTTAINAI_PACKED_BIN;

function trace(value) {
  if (tracePath !== undefined) fs.appendFileSync(tracePath, JSON.stringify(value) + "\n");
}

function git(args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + result.stderr);
  return result.stdout.trim();
}

function invoke(args) {
  if (packedBin === undefined) throw new Error("packed Mottainai bin is missing");
  const result = spawnSync(packedBin, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  trace({ kind: "mottainai", args, status: result.status, stdout: result.stdout, stderr: result.stderr });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(args.join(" ") + " failed: " + result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function fail(error) {
  fs.writeFileSync(
    path.join(cwd, "pi-failure.json"),
    JSON.stringify({ message: String(error?.stack ?? error) }, null, 2),
  );
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const extensionIndex = args.indexOf("--extension");
  const extensionPath = extensionIndex < 0 ? undefined : args[extensionIndex + 1];
  if (extensionPath === undefined) throw new Error("Pi guard extension was not supplied");
  const extension = await import(pathToFileURL(extensionPath).href);
  let toolCall;
  extension.default({
    on(event, handler) {
      if (event === "tool_call") toolCall = handler;
    },
  });
  if (typeof toolCall !== "function") throw new Error("Pi guard did not register its tool handler");

  const beforeHead = git(["rev-parse", "HEAD"]);
  const attempted = [
    "git commit -am 'raw Pi bypass'",
    "git push origin HEAD",
    "gh pr create --title 'raw Pi bypass'",
  ].map((command) => ({ command, decision: toolCall({ toolName: "bash", input: { command } }) }));
  for (const attempt of attempted) assert.equal(attempt.decision?.block, true, attempt.command);
  const afterHead = git(["rev-parse", "HEAD"]);
  assert.equal(afterHead, beforeHead, "guarded raw mutation changed Git state");
  fs.writeFileSync(
    path.join(cwd, "pi-guard-evidence.json"),
    JSON.stringify({ beforeHead, afterHead, attempted }, null, 2),
  );
  fs.writeFileSync(path.join(cwd, "pi-started.json"), JSON.stringify({ cwd, extensionPath }, null, 2));

  if (mode === "early-exit") {
    fs.writeFileSync(path.join(cwd, "pi-early-exit.json"), "early exit\n");
    return;
  }

  const gate = process.env.MOTTAINAI_PI_GATE;
  if (gate !== undefined) {
    while (!fs.existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  fs.writeFileSync(path.join(cwd, "pi-implementation.mjs"), "export const result = 42;\n");
  fs.writeFileSync(
    path.join(cwd, "pi-implementation.test.mjs"),
    "import assert from 'node:assert/strict'; import { result } from './pi-implementation.mjs'; assert.equal(result, 42);\n",
  );
  const validation = spawnSync(process.execPath, ["--test", "pi-implementation.test.mjs"], {
    cwd,
    env: process.env,
    encoding: "utf8",
  });
  trace({ kind: "validation", status: validation.status, stdout: validation.stdout, stderr: validation.stderr });
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);

  const branch = git(["branch", "--show-current"]);
  const committed = invoke([
    "task",
    "commit",
    "--message",
    "test(workflow): prove packed Pi issue-to-PR path",
    "--include",
    "pi-guard-evidence.json,pi-started.json,pi-implementation.mjs,pi-implementation.test.mjs",
  ]);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.task.lifecycleState, "committed");
  const pushed = invoke([
    "task",
    "push",
    "--remote",
    "origin",
    "--remote-branch",
    branch,
    "--create-upstream",
  ]);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(pushed.task.lifecycleState, "pushed");
  const opened = invoke([
    "task",
    "open-pr",
    "--title",
    "test(workflow): prove packed Pi issue-to-PR path",
    "--repo",
    "fixture-owner/fixture-repo",
    "--issue-reference",
    "334",
    "--acceptance-criteria",
    "pull-request-open",
  ]);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.task.lifecycleState, "pull-request-open");
  fs.writeFileSync(
    path.join(cwd, "pi-done.json"),
    JSON.stringify({ taskId: opened.task.taskId, prNumber: opened.pullRequest.number }, null, 2),
  );
}

main().catch(fail);
`;
}

function fakeGhSource() {
  return String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.MOTTAINAI_GH_TRACE !== undefined)
  fs.appendFileSync(process.env.MOTTAINAI_GH_TRACE, JSON.stringify(args) + "\n");
if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]\n");
else process.stdout.write("[]\n");
`;
}

function fakeGhInariSource() {
  return String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
if (process.env.MOTTAINAI_GH_INARI_TRACE !== undefined)
  fs.appendFileSync(process.env.MOTTAINAI_GH_INARI_TRACE, JSON.stringify({ args, input }) + "\n");
if (args.includes("--version")) process.stdout.write("gh-inari 0.2.0\n");
else if (args.includes("--help")) process.stdout.write("pr create --from <file.json>\npr get <number> --json\n");
else if (args[0] === "pr" && args[1] === "create") {
  const head = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim();
  process.stdout.write(JSON.stringify({
    ok: true,
    artifact: {
      number: 33401,
      url: "https://github.com/fixture-owner/fixture-repo/pull/33401",
      head,
      base: "main",
    },
  }));
} else if (args[0] === "pr" && args[1] === "get") {
  process.stdout.write(JSON.stringify({
    ok: true,
    artifact: { valid: true, number: Number(args[2]), url: "https://github.com/fixture-owner/fixture-repo/pull/33401" },
  }));
} else process.stdout.write(JSON.stringify({ ok: false, error: { code: "UNEXPECTED", message: "unexpected gh-inari call" } }));
`;
}

function nawabariWrapperSource() {
  return String.raw`
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.MOTTAINAI_NAWABARI_TRACE, JSON.stringify(args) + "\n");
const result = spawnSync(process.env.MOTTAINAI_REAL_NAWABARI, args, { stdio: "inherit" });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
`;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function companionPath(name, env) {
  return run("which", [name], { env }).stdout.trim();
}

function createFixture({ mode = "golden", missingGhInari = false, zellijPath, nawabariPath }) {
  const workspace = createWorkspace({ config: null });
  const companionDirectory = fs.mkdtempSync(path.join(suiteRoot, "companions-"));
  const stateDirectory = fs.mkdtempSync(path.join(suiteRoot, "state-"));
  const remote = path.join(suiteRoot, `remote-${path.basename(workspace)}.git`);
  const piTrace = path.join(workspace, "pi-trace.ndjson");
  const ghTrace = path.join(workspace, "gh-trace.ndjson");
  const ghInariTrace = path.join(workspace, "gh-inari-trace.ndjson");
  const gate = path.join(workspace, "pi-gate");
  const configPath = path.join(workspace, "mottainai.config.json");

  fs.mkdirSync(path.join(workspace, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".mottainai", "workflow.json"), JSON.stringify(workflowPolicy(), null, 2));
  fs.writeFileSync(path.join(workspace, "README.md"), "packed workflow fixture\n");
  writeConfig(workspace, {
    version: 2,
    mcpServers: {},
    gateway: { workspaceRoot: "." },
    ghInari: {
      command: missingGhInari ? path.join(companionDirectory, "missing-gh-inari") : path.join(companionDirectory, "gh-inari"),
    },
  });
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "packed-workflow@example.invalid"]);
  runGit(workspace, ["config", "user.name", "Mottainai Packed Workflow"]);
  runGit(workspace, ["add", "README.md", ".mottainai/workflow.json", "mottainai.config.json"]);
  runGit(workspace, ["commit", "-m", "initial packed workflow fixture"]);
  runGit(workspace, ["init", "--bare", remote]);
  runGit(workspace, ["remote", "add", "origin", remote]);

  writeExecutable(path.join(companionDirectory, "pi"), fakePiSource());
  writeExecutable(path.join(companionDirectory, "gh"), fakeGhSource());
  if (!missingGhInari) writeExecutable(path.join(companionDirectory, "gh-inari"), fakeGhInariSource());
  writeExecutable(path.join(companionDirectory, "nawabari"), nawabariWrapperSource());

  const baseEnv = isolatedEnv(workspace);
  const env = {
    ...baseEnv,
    MOTTAINAI_CONFIG: configPath,
    MOTTAINAI_STATE_DIR: stateDirectory,
    MOTTAINAI_PACKED_BIN: binPath,
    MOTTAINAI_FAKE_PI_MODE: mode,
    MOTTAINAI_PI_GATE: gate,
    MOTTAINAI_PI_TRACE: piTrace,
    MOTTAINAI_GH_TRACE: ghTrace,
    MOTTAINAI_GH_INARI_TRACE: ghInariTrace,
    MOTTAINAI_REAL_NAWABARI: nawabariPath,
    MOTTAINAI_NAWABARI_TRACE: path.join(workspace, "nawabari-trace.ndjson"),
    MOTTAINAI_ZELLIJ_BINARY: zellijPath,
    PATH: [companionDirectory, baseEnv.PATH].join(path.delimiter),
  };
  return { workspace, remote, worktree: undefined, env, realNawabari: nawabariPath, gate, ghTrace, ghInariTrace };
}

function invoke(fixture, cwd, args, expectedStatus = 0) {
  const result = run(binPath, args, { cwd, env: fixture.env, timeout: 30_000 });
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, `${args.join(" ")} returned no JSON`);
  return JSON.parse(result.stdout);
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function closeFixture(fixture, sessionId, worktree) {
  if (sessionId !== undefined && worktree !== undefined && fs.existsSync(worktree)) {
    run(fixture.realNawabari, ["session", "close", "--session", sessionId, "--json"], {
      cwd: worktree,
      env: fixture.env,
      timeout: 15_000,
    });
  }
  fs.rmSync(fixture.workspace, { recursive: true, force: true });
}

function companionAvailability() {
  const env = isolatedEnv(repoRoot);
  return {
    zellij: companionPath("zellij", env),
    nawabari: companionPath("nawabari", env),
  };
}

test(
  "packed Pi Issue-to-PR golden path reaches pull-request-open through the owning authorities",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const companions = companionAvailability();
    if (companions.zellij.length === 0 || companions.nawabari.length === 0) {
      t.skip("compatible Zellij and Nawabari companions are required for the packed golden path");
      return;
    }
    const fixture = createFixture({ zellijPath: companions.zellij, nawabariPath: companions.nawabari });
    let sessionId;
    let worktree;
    t.after(() => closeFixture(fixture, sessionId, worktree));

    const runArgs = [
      "task",
      "run",
      "pi-golden-path",
      "--type",
      "feat",
      "--issue",
      "334",
      "--agent",
      "pi",
      "--idempotency-key",
      "issue-334-golden-path",
    ];
    const started = invoke(fixture, fixture.workspace, runArgs);
    assert.equal(started.ok, true, JSON.stringify(started));
    sessionId = started.execution.sessionId;
    worktree = started.execution.worktree;
    assert.equal(started.manager.agentKind, "pi");
    assert.equal(started.manager.launchProfile, "pi");
    assert.equal(fs.realpathSync(started.manager.worktreePath), fs.realpathSync(worktree));

    await waitForFile(path.join(worktree, "pi-started.json"));
    const resumed = invoke(fixture, fixture.workspace, runArgs);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.task.taskId, started.task.taskId);
    assert.equal(resumed.execution.sessionId, started.execution.sessionId);
    assert.equal(resumed.manager.sessionId, started.manager.sessionId);
    fs.writeFileSync(fixture.gate, "resume checkpoint\n");

    await waitForFile(path.join(worktree, "pi-done.json"));
    const status = invoke(fixture, worktree, ["task", "status"]);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.currentState, "pull-request-open");
    assert.equal(status.task.taskId, started.task.taskId);
    assert.equal(status.pullRequests.length, 1);
    assert.equal(status.pullRequests[0].prNumber, 33401);

    const nawabariCalls = readJsonLines(path.join(fixture.workspace, "nawabari-trace.ndjson"));
    assert.equal(nawabariCalls.filter((args) => args[0] === "commit").length, 1);
    assert.equal(nawabariCalls.filter((args) => args[0] === "push").length, 1);
    const ghInariCreates = readJsonLines(fixture.ghInariTrace).filter(
      (entry) => entry.args[0] === "pr" && entry.args[1] === "create",
    );
    assert.equal(ghInariCreates.length, 1);
    const repositoryFlagIndex = ghInariCreates[0].args.indexOf("--repository");
    assert.ok(repositoryFlagIndex >= 0);
    assert.equal(ghInariCreates[0].args[repositoryFlagIndex + 1], "fixture-owner/fixture-repo");
    assert.equal(readJsonLines(fixture.ghTrace).filter((args) => args[1] === "list").length, 1);
    assert.equal(runGit(fixture.remote, ["show-ref", "--heads", started.execution.branch]).includes(started.execution.branch), true);
  },
);

test(
  "packed Pi exit before PR creation is incomplete evidence",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const companions = companionAvailability();
    if (companions.zellij.length === 0 || companions.nawabari.length === 0) {
      t.skip("compatible Zellij and Nawabari companions are required for the packed negative path");
      return;
    }
    const fixture = createFixture({ mode: "early-exit", zellijPath: companions.zellij, nawabariPath: companions.nawabari });
    let sessionId;
    let worktree;
    t.after(() => closeFixture(fixture, sessionId, worktree));
    const started = invoke(fixture, fixture.workspace, [
      "task",
      "run",
      "pi-early-exit",
      "--type",
      "feat",
      "--issue",
      "334",
      "--agent",
      "pi",
      "--idempotency-key",
      "issue-334-early-exit",
    ]);
    sessionId = started.execution.sessionId;
    worktree = started.execution.worktree;
    await waitForFile(path.join(worktree, "pi-early-exit.json"));
    const statusResult = run(binPath, ["task", "status"], {
      cwd: worktree,
      env: fixture.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (statusResult.status === 0) assert.notEqual(JSON.parse(statusResult.stdout).currentState, "pull-request-open");
    else assert.equal(statusResult.status, 1);
  },
);

test(
  "packed workflow fails closed when gh-inari is missing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const companions = companionAvailability();
    if (companions.zellij.length === 0 || companions.nawabari.length === 0) {
      t.skip("compatible Zellij and Nawabari companions are required for the packed negative path");
      return;
    }
    const fixture = createFixture({ missingGhInari: true, zellijPath: companions.zellij, nawabariPath: companions.nawabari });
    let sessionId;
    let worktree;
    t.after(() => closeFixture(fixture, sessionId, worktree));
    const started = invoke(fixture, fixture.workspace, [
      "task",
      "run",
      "pi-missing-gh-inari",
      "--type",
      "feat",
      "--issue",
      "334",
      "--agent",
      "pi",
      "--idempotency-key",
      "issue-334-missing-gh-inari",
    ]);
    sessionId = started.execution.sessionId;
    worktree = started.execution.worktree;
    await waitForFile(path.join(worktree, "pi-started.json"));
    fs.writeFileSync(fixture.gate, "no restart checkpoint needed\n");
    await waitForFile(path.join(worktree, "pi-failure.json"));
    const statusResult = run(binPath, ["task", "status"], {
      cwd: worktree,
      env: fixture.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (statusResult.status === 0) assert.notEqual(JSON.parse(statusResult.stdout).currentState, "pull-request-open");
    else assert.equal(statusResult.status, 1);
    assert.equal(readJsonLines(fixture.ghInariTrace).filter((entry) => entry.args[0] === "pr").length, 0);
  },
);
