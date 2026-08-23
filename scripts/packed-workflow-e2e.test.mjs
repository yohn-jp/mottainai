import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkspace, isolatedEnv, writeConfig } from "./lib/mcp-blackbox-test-support.mjs";
import { extractTarball, linkDependencies, packRepository, resolvePackagedBin } from "./lib/mcp-blackbox-client.mjs";

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
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(gate)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the Pi gate: " + gate);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
    "--sections-json",
    JSON.stringify({
      summary: "packed workflow summary",
      changes: "packed workflow change",
      validation: "- [x] Typecheck\n- [x] Tests\n- [x] Build",
      review_focus: "packed lifecycle",
    }),
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

function managerPiSource() {
  return String.raw`
const fs = require("node:fs");
const marker = process.env.MOTTAINAI_MANAGER_AGENT_MARKER;
if (marker === undefined) throw new Error("Manager agent marker is missing");
fs.appendFileSync(marker, JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) }) + "\n");
// Keep the real Zellij pane alive until Manager stops it. The fixture observes
// this process only through the Zellij/Nawabari authorities; it never mutates
// the managed worktree itself.
setInterval(() => {}, 1_000);
`;
}

function fakeGhSource() {
  return String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.MOTTAINAI_GH_TRACE !== undefined)
  fs.appendFileSync(process.env.MOTTAINAI_GH_TRACE, JSON.stringify(args) + "\n");
if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]\n");
else if (args[0] === "pr" && args[1] === "view") {
  // Authoritative integration evidence for the merged-task transition: reports
  // the PR merged with the exact head/merge revision the test pushed, so
  // Mottainai's own head-identity check (not this fixture) is what proves the
  // close request is safe.
  const headSha = process.env.MOTTAINAI_GH_PR_HEAD_SHA || "";
  const mergeSha = process.env.MOTTAINAI_GH_PR_MERGE_SHA || headSha;
  process.stdout.write(JSON.stringify({
    number: Number(args[2]),
    state: "MERGED",
    isDraft: false,
    mergedAt: "2026-01-01T00:00:00Z",
    mergeCommit: { oid: mergeSha },
    url: "https://github.com/fixture-owner/fixture-repo/pull/" + args[2],
    headRefName: process.env.MOTTAINAI_GH_PR_HEAD_REF || "",
    headRefOid: headSha,
    baseRefName: "main",
    baseRefOid: headSha,
  }) + "\n");
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\n");
  process.exit(1);
}
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
if (args.includes("--version")) process.stdout.write("gh-inari 0.7.0\n");
else if (args.includes("--help=full")) process.stdout.write("pr create --from <file.json>\npr get <number> --json\n--from <path>\n--json\n--repository <r>\n--template <id>\n");
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

function createFixture({ mode = "golden", missingGhInari = false, managerAgent = false, zellijPath, nawabariPath }) {
  const workspace = createWorkspace({ config: null });
  const companionDirectory = fs.mkdtempSync(path.join(suiteRoot, "companions-"));
  const stateDirectory = fs.mkdtempSync(path.join(suiteRoot, "state-"));
  const remote = path.join(suiteRoot, `remote-${path.basename(workspace)}.git`);
  const piTrace = path.join(workspace, "pi-trace.ndjson");
  const ghTrace = path.join(workspace, "gh-trace.ndjson");
  const ghInariTrace = path.join(workspace, "gh-inari-trace.ndjson");
  const gate = path.join(workspace, "pi-gate");
  const managerAgentMarker = path.join(workspace, "manager-agent.ndjson");
  const configPath = path.join(workspace, "mottainai.config.json");

  fs.mkdirSync(path.join(workspace, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".mottainai", "workflow.json"), JSON.stringify(workflowPolicy(), null, 2));
  fs.writeFileSync(path.join(workspace, "README.md"), "packed workflow fixture\n");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "fixture.ts"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(workspace, "docs", "fixture.md"), "# Fixture\n");
  writeConfig(workspace, {
    version: 2,
    mcpServers: {},
    gateway: { workspaceRoot: "." },
    ghInari: {
      command: missingGhInari
        ? path.join(companionDirectory, "missing-gh-inari")
        : path.join(companionDirectory, "gh-inari"),
    },
  });
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "packed-workflow@example.invalid"]);
  runGit(workspace, ["config", "user.name", "Mottainai Packed Workflow"]);
  runGit(workspace, [
    "add",
    "README.md",
    "src/fixture.ts",
    "docs/fixture.md",
    ".mottainai/workflow.json",
    "mottainai.config.json",
  ]);
  runGit(workspace, ["commit", "-m", "initial packed workflow fixture"]);
  runGit(workspace, ["init", "--bare", remote]);
  runGit(workspace, ["remote", "add", "origin", remote]);

  assert.notEqual(
    path.dirname(path.resolve(nawabariPath)),
    path.resolve(companionDirectory),
    "the real Nawabari binary must not resolve inside the fixture companion directory",
  );

  writeExecutable(path.join(companionDirectory, "pi"), managerAgent ? managerPiSource() : fakePiSource());
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
    MOTTAINAI_MANAGER_AGENT_MARKER: managerAgentMarker,
    MOTTAINAI_REAL_NAWABARI: nawabariPath,
    MOTTAINAI_NAWABARI_TRACE: path.join(workspace, "nawabari-trace.ndjson"),
    MOTTAINAI_ZELLIJ_BINARY: zellijPath,
    PATH: [companionDirectory, baseEnv.PATH].join(path.delimiter),
  };
  return {
    workspace,
    remote,
    worktree: undefined,
    env,
    realNawabari: nawabariPath,
    stateDirectory,
    managerAgentMarker,
    gate,
    ghTrace,
    ghInariTrace,
  };
}

function invoke(fixture, cwd, args, expectedStatus = 0) {
  const result = run(binPath, args, { cwd, env: fixture.env, timeout: 30_000 });
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, `${args.join(" ")} returned no JSON`);
  return JSON.parse(result.stdout);
}

async function startManagerProcess(fixture) {
  const child = spawn(binPath, ["manager", "--no-open", "--port", "0", "--workspace", fixture.workspace], {
    cwd: fixture.workspace,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = stdout.match(/Mottainai manager listening at (http:\/\/127\.0\.0\.1:\d+\/)/u);
    if (match !== null) return { child, url: match[1], stderr: () => stderr };
    if (child.exitCode !== null) throw new Error(`Manager exited before readiness: ${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error(`timed out waiting for Manager readiness\n${stdout}\n${stderr}`);
}

async function stopManagerProcess(manager) {
  if (manager === undefined || manager.child.exitCode !== null) return;
  manager.child.kill("SIGTERM");
  await new Promise((resolve) => manager.child.once("close", resolve));
}

async function managerRequest(manager, route, options = {}) {
  const response = await fetch(`${manager.url}api/v1/manager/${route}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Manager returned non-JSON (${response.status}): ${text}`);
  }
  return { response, body };
}

function managerSessionIdentity(session) {
  return {
    sessionId: session.sessionId,
    taskId: session.taskId,
    executionSessionId: session.executionSessionId,
    executionMode: session.executionMode,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    taskSlug: session.taskSlug,
    issueRef: session.issueRef,
    runtimeName: session.runtimeName,
    lifecycleState: session.lifecycleState,
    runtimeState: session.runtimeState,
    semanticLifecycleState: session.semanticLifecycleState,
    restartCount: session.restartCount,
    terminationState: session.terminationState,
  };
}

function readTaskSnapshot(fixture) {
  const dbPath = path.join(fixture.stateDirectory, "state.sqlite3");
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT task_id, task_slug, issue_ref, nawabari_session_id, lifecycle_state, base_branch, base_commit FROM tasks ORDER BY task_id",
      )
      .all();
  } finally {
    db.close();
  }
}

function readGitSnapshot(fixture) {
  return {
    worktrees: runGit(fixture.workspace, ["worktree", "list", "--porcelain"]),
    branches: runGit(fixture.workspace, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]),
  };
}

function readNawabariSnapshot(fixture) {
  const sessionList = run(fixture.realNawabari, ["session", "list", "--json"], {
    cwd: fixture.workspace,
    env: fixture.env,
    timeout: 15_000,
  });
  assert.equal(sessionList.status, 0, sessionList.stderr);
  const claims = run(fixture.realNawabari, ["session", "claims", "--json"], {
    cwd: fixture.workspace,
    env: fixture.env,
    timeout: 15_000,
  });
  assert.equal(claims.status, 0, claims.stderr);
  return { sessions: JSON.parse(sessionList.stdout), claims: JSON.parse(claims.stdout) };
}

async function readManagerSnapshot(manager) {
  const listed = await managerRequest(manager, "sessions");
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  return listed.body.sessions
    .map(managerSessionIdentity)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

async function readManagerFixtureSnapshot(fixture, manager) {
  return {
    manager: await readManagerSnapshot(manager),
    tasks: readTaskSnapshot(fixture),
    git: readGitSnapshot(fixture),
    nawabari: readNawabariSnapshot(fixture),
  };
}

async function waitForManagerRuntime(manager, sessionId, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await managerRequest(manager, `sessions/${encodeURIComponent(sessionId)}`);
    if (detail.response.status === 200 && detail.body.session.runtimeState === expected) return detail.body.session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = await managerRequest(manager, `sessions/${encodeURIComponent(sessionId)}`);
  throw new Error(`timed out waiting for Manager runtime ${expected}: ${JSON.stringify(detail.body)}`);
}

async function stopAndCleanManagerTask(fixture, manager, session) {
  if (session === undefined) return;
  if (manager !== undefined) {
    const stopped = await managerRequest(manager, `sessions/${encodeURIComponent(session.sessionId)}/stop`, {
      method: "POST",
    });
    assert.ok(stopped.response.status === 200, JSON.stringify(stopped.body));
  }
  if (session.taskId === undefined) return;
  const abandoned = invoke(fixture, fixture.workspace, ["task", "abandon", "--task-id", session.taskId]);
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  const cleaned = invoke(fixture, fixture.workspace, [
    "task",
    "cleanup",
    "--task-id",
    session.taskId,
    "--idempotency-key",
    `issue-510-cleanup-${session.taskId}`,
  ]);
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
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
  const zellij = companionPath("zellij", env);
  const zellijVersion = zellij.length === 0 ? "" : run(zellij, ["--version"], { env }).stdout.trim();
  const parsed = /(\d+)\.(\d+)\.(\d+)/u.exec(zellijVersion);
  const zellijSupported = parsed !== null && (Number(parsed[1]) > 0 || Number(parsed[2]) >= 44);
  return {
    zellij: zellijSupported ? zellij : "",
    nawabari: companionPath("nawabari", env),
  };
}

test(
  "packed Manager Issue-first dogfood proves real Zellij/Nawabari conflict recovery without touching unrelated sessions",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const companions = companionAvailability();
    // This fixture is the mandatory real-companion evidence for #510. A
    // missing or incompatible companion must fail the suite, never become a
    // skipped or fake-only pass.
    assert.ok(companions.zellij.length > 0, "Zellij >= 0.44 is required for the real Manager dogfood");
    assert.ok(companions.nawabari.length > 0, "Nawabari >= 0.5 is required for the real Manager dogfood");
    const fixture = createFixture({
      managerAgent: true,
      zellijPath: companions.zellij,
      nawabariPath: companions.nawabari,
    });
    let manager;
    const sessions = [];
    t.after(async () => {
      // Cleanup follows the same Manager -> Mottainai -> Nawabari authorities
      // used by the scenario. It deliberately never adopts or force-releases
      // another session.
      for (const session of [...sessions].reverse()) {
        try {
          await stopAndCleanManagerTask(fixture, manager, session);
        } catch {
          // Preserve the original assertion while the final authority-owned
          // fixture teardown below still removes only this temporary repo.
        }
      }
      await stopManagerProcess(manager);
      fs.rmSync(fixture.workspace, { recursive: true, force: true });
    });

    manager = await startManagerProcess(fixture);
    const health = await managerRequest(manager, "health");
    assert.equal(health.response.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.zellij.available, true);
    assert.match(health.body.zellij.version, /^zellij 0\.44\./u);

    const unrelatedBody = {
      instruction: "keep this unrelated Issue session active",
      agentKind: "pi",
      taskSlug: "manager-510-unrelated",
      issueRef: "362",
      branchType: "feat",
      idempotencyKey: "issue-510-unrelated",
      scope: { claims: [{ resource: "docs/**", mode: "exclusive-write" }] },
    };
    const unrelatedResponse = await managerRequest(manager, "sessions", {
      method: "POST",
      body: JSON.stringify(unrelatedBody),
    });
    assert.equal(unrelatedResponse.response.status, 201, JSON.stringify(unrelatedResponse.body));
    const unrelated = unrelatedResponse.body.session;
    sessions.push(unrelated);
    await waitForFile(fixture.managerAgentMarker);
    assert.equal(unrelated.agentKind, "pi");
    assert.equal(unrelated.issueRef, "362");
    assert.equal(unrelated.operational.identities.executionSessionId, unrelated.executionSessionId);

    const blockerBody = {
      instruction: "establish the bounded overlapping blocker",
      agentKind: "pi",
      taskSlug: "manager-510-blocker",
      issueRef: "362",
      branchType: "feat",
      idempotencyKey: "issue-510-blocker",
      scope: { claims: [{ resource: "src/**", mode: "exclusive-write" }] },
    };
    const blockerResponse = await managerRequest(manager, "sessions", {
      method: "POST",
      body: JSON.stringify(blockerBody),
    });
    assert.equal(blockerResponse.response.status, 201, JSON.stringify(blockerResponse.body));
    const blocker = blockerResponse.body.session;
    sessions.push(blocker);
    assert.equal(blocker.issueRef, "362");
    assert.equal(blocker.operational.identities.executionSessionId, blocker.executionSessionId);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const targetBody = {
      instruction: "bounded Issue #362 Manager dogfood",
      agentKind: "pi",
      taskSlug: "manager-510-target",
      issueRef: "362",
      branchType: "feat",
      idempotencyKey: "issue-510-target",
      scope: { claims: [{ resource: "src/**", mode: "exclusive-write" }] },
    };
    const previewResponse = await managerRequest(manager, "sessions/preview", {
      method: "POST",
      body: JSON.stringify(targetBody),
    });
    assert.equal(previewResponse.response.status, 200, JSON.stringify(previewResponse.body));
    const preview = previewResponse.body.preview;
    assert.equal(preview.identity.task.issueRef, "362");
    assert.equal(preview.identity.task.taskSlug, "manager-510-target");
    assert.deepEqual(preview.claims, [{ resource: "src/**", mode: "exclusive-write" }]);
    assert.equal(preview.claimPreflight.status, "conflict", JSON.stringify(preview));
    const previewConflict = preview.claimPreflight.conflicts.find(
      (conflict) => conflict.existing.sessionId === blocker.executionSessionId,
    );
    assert.ok(previewConflict, JSON.stringify(preview.claimPreflight));
    assert.equal(previewConflict.existing.branch, blocker.branchName);
    assert.equal(previewConflict.existing.taskId, blocker.taskId);
    assert.equal(previewConflict.existing.taskSlug, blocker.taskSlug);
    assert.equal(previewConflict.existing.issueRef, blocker.issueRef);

    const beforeConflict = await readManagerFixtureSnapshot(fixture, manager);
    const beforeUnrelated = beforeConflict.manager.find((session) => session.sessionId === unrelated.sessionId);
    assert.ok(beforeUnrelated, JSON.stringify(beforeConflict));
    const conflictResponse = await managerRequest(manager, "sessions", {
      method: "POST",
      body: JSON.stringify(targetBody),
    });
    assert.equal(conflictResponse.response.status, 409, JSON.stringify(conflictResponse.body));
    assert.equal(conflictResponse.body.error.code, "claim_conflict");
    const returnedConflict = conflictResponse.body.error.details.claimPreflight.conflicts.find(
      (conflict) => conflict.existing.sessionId === blocker.executionSessionId,
    );
    assert.ok(returnedConflict, JSON.stringify(conflictResponse.body));
    assert.equal(returnedConflict.existing.branch, blocker.branchName);
    assert.equal(returnedConflict.existing.taskId, blocker.taskId);
    assert.equal(returnedConflict.existing.taskSlug, blocker.taskSlug);
    assert.equal(returnedConflict.existing.issueRef, blocker.issueRef);

    // The rejected launch is a read-only preflight failure: every physical and
    // durable identity must be byte-for-byte unchanged, including the active
    // unrelated Manager/Zellij/Nawabari session.
    const afterConflict = await readManagerFixtureSnapshot(fixture, manager);
    assert.deepEqual(afterConflict, beforeConflict);
    assert.deepEqual(
      afterConflict.manager.find((session) => session.sessionId === unrelated.sessionId),
      beforeUnrelated,
    );
    assert.equal(
      afterConflict.tasks.some((task) => task.task_slug === "manager-510-target"),
      false,
    );

    const blockerStopped = await managerRequest(manager, `sessions/${encodeURIComponent(blocker.sessionId)}/stop`, {
      method: "POST",
    });
    assert.equal(blockerStopped.response.status, 200, JSON.stringify(blockerStopped.body));
    assert.equal(blockerStopped.body.session.runtimeState, "stopped");
    const blockerAbandoned = invoke(fixture, fixture.workspace, ["task", "abandon", "--task-id", blocker.taskId]);
    assert.equal(blockerAbandoned.ok, true, JSON.stringify(blockerAbandoned));
    const blockerCleaned = invoke(fixture, fixture.workspace, [
      "task",
      "cleanup",
      "--task-id",
      blocker.taskId,
      "--idempotency-key",
      "issue-510-blocker-cleanup",
    ]);
    assert.equal(blockerCleaned.ok, true, JSON.stringify(blockerCleaned));
    const unrelatedDuringRecovery = await readManagerSnapshot(manager);
    assert.deepEqual(
      unrelatedDuringRecovery.find((session) => session.sessionId === unrelated.sessionId),
      beforeUnrelated,
    );

    const recoveredResponse = await managerRequest(manager, "sessions", {
      method: "POST",
      body: JSON.stringify(targetBody),
    });
    assert.equal(recoveredResponse.response.status, 201, JSON.stringify(recoveredResponse.body));
    const recovered = recoveredResponse.body.session;
    sessions.push(recovered);
    assert.equal(recovered.taskSlug, targetBody.taskSlug);
    assert.equal(recovered.issueRef, "362");
    assert.equal(recovered.executionMode, "task-bound");
    await waitForFile(fixture.managerAgentMarker);

    const detailResponse = await managerRequest(manager, `sessions/${encodeURIComponent(recovered.sessionId)}`);
    assert.equal(detailResponse.response.status, 200, JSON.stringify(detailResponse.body));
    assert.equal(detailResponse.body.session.sessionId, recovered.sessionId);
    assert.equal(detailResponse.body.session.runtimeName, recovered.runtimeName);
    assert.equal(detailResponse.body.session.operational.identities.executionSessionId, recovered.executionSessionId);
    const inspectResponse = await managerRequest(
      manager,
      `nawabari/sessions/${encodeURIComponent(recovered.executionSessionId)}/inspect`,
      { method: "POST" },
    );
    assert.equal(inspectResponse.response.status, 200, JSON.stringify(inspectResponse.body));
    assert.equal(inspectResponse.body.session.sessionId, recovered.executionSessionId);
    assert.equal(inspectResponse.body.session.branch, recovered.branchName);

    const stoppedResponse = await managerRequest(manager, `sessions/${encodeURIComponent(recovered.sessionId)}/stop`, {
      method: "POST",
    });
    assert.equal(stoppedResponse.response.status, 200, JSON.stringify(stoppedResponse.body));
    assert.equal(stoppedResponse.body.session.runtimeState, "stopped");
    const restartedResponse = await managerRequest(
      manager,
      `sessions/${encodeURIComponent(recovered.sessionId)}/restart`,
      { method: "POST" },
    );
    assert.equal(restartedResponse.response.status, 200, JSON.stringify(restartedResponse.body));
    assert.equal(restartedResponse.body.session.runtimeState, "running");
    assert.equal(restartedResponse.body.session.restartCount, 1);
    await waitForManagerRuntime(manager, recovered.sessionId, "running");
    const markerLines = readJsonLines(fixture.managerAgentMarker);
    assert.ok(markerLines.length >= 2, JSON.stringify(markerLines));
    assert.equal(markerLines.at(-1).cwd, recovered.worktreePath);

    const targetStopped = await managerRequest(manager, `sessions/${encodeURIComponent(recovered.sessionId)}/stop`, {
      method: "POST",
    });
    assert.equal(targetStopped.response.status, 200, JSON.stringify(targetStopped.body));
    assert.equal(targetStopped.body.session.runtimeState, "stopped");
    const unrelatedBeforeFinalCleanup = await managerRequest(
      manager,
      `sessions/${encodeURIComponent(unrelated.sessionId)}`,
    );
    assert.equal(unrelatedBeforeFinalCleanup.response.status, 200);
    assert.equal(unrelatedBeforeFinalCleanup.body.session.runtimeState, "running");

    const targetAbandoned = invoke(fixture, fixture.workspace, ["task", "abandon", "--task-id", recovered.taskId]);
    assert.equal(targetAbandoned.ok, true, JSON.stringify(targetAbandoned));
    const targetCleaned = invoke(fixture, fixture.workspace, [
      "task",
      "cleanup",
      "--task-id",
      recovered.taskId,
      "--idempotency-key",
      "issue-510-target-cleanup",
    ]);
    assert.equal(targetCleaned.ok, true, JSON.stringify(targetCleaned));
    await stopAndCleanManagerTask(fixture, manager, unrelated);

    const finalSnapshot = await readManagerFixtureSnapshot(fixture, manager);
    assert.equal(
      finalSnapshot.tasks.every((task) => task.lifecycle_state === "cleaned"),
      true,
    );
    assert.equal(finalSnapshot.nawabari.claims.claims?.length ?? 0, 0);
    assert.equal(finalSnapshot.nawabari.sessions.sessions?.length ?? 0, 0);
    for (const task of finalSnapshot.tasks) {
      assert.equal(finalSnapshot.git.worktrees.includes(task.task_slug), false);
    }
    for (const session of finalSnapshot.manager) {
      assert.notEqual(session.semanticLifecycleState, "orphaned");
      assert.equal(session.runtimeState, "stopped");
    }
    const zellijSessions = run(companions.zellij, ["list-sessions"], {
      cwd: fixture.workspace,
      env: fixture.env,
      timeout: 15_000,
    });
    const zellijOutput = `${zellijSessions.stdout}\n${zellijSessions.stderr}`;
    assert.equal(
      finalSnapshot.manager.some((session) => zellijOutput.includes(session.runtimeName)),
      false,
    );
  },
);

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
    const createPayload = JSON.parse(ghInariCreates[0].input ?? "{}");
    assert.equal(createPayload.fields?.linked_issue, "Closes #334");
    assert.equal(createPayload.fields?.validation, "- [x] Typecheck\n- [x] Tests\n- [x] Build");
    assert.equal("issue" in (createPayload.fields ?? {}), false);
    assert.equal(readJsonLines(fixture.ghTrace).filter((args) => args[1] === "list").length, 1);
    assert.match(
      runGit(fixture.remote, ["show-ref", "--heads", started.execution.branch]),
      new RegExp(`refs/heads/${started.execution.branch}$`, "u"),
    );

    // #378: authoritative integration observed -> Mottainai requests Nawabari's
    // normal safe-close -> the session's write claims release -> the next
    // managed task start needs no manual `nawabari session close`. This is the
    // exact #373 (task) -> PR #376 (merge) -> #377 (next start) shape.
    // `pi-done.json` is a test-harness-only completion signal (never committed
    // by the fake Pi, since it is written after `task open-pr` already ran);
    // remove it so the worktree is clean the way a real completed execution's
    // would be before Mottainai requests Nawabari's safe close.
    fs.rmSync(path.join(worktree, "pi-done.json"));
    const prHeadSha = status.pullRequests[0].headSha;
    fixture.env.MOTTAINAI_GH_PR_HEAD_SHA = prHeadSha;
    fixture.env.MOTTAINAI_GH_PR_HEAD_REF = started.execution.branch;

    // The fake `gh pr view` reports the PR as MERGED, but that alone has no
    // git-level effect. Nawabari's close-fetch independently re-verifies the
    // integrated revision via exact tree-object equivalence by fetching the
    // real base branch tip from the remote (never trusting the provider API
    // blindly). A real GitHub squash-merge lands a *new* commit on `main`
    // carrying the same tree as the PR branch tip (not the identical commit,
    // which reads as a trivial ancestry case Nawabari does not accept as
    // non-ancestry proof), so simulate that exact shape here.
    const priorMainSha = started.task.baseCommit;
    const headTree = runGit(worktree, ["rev-parse", `${prHeadSha}^{tree}`]);
    const squashCommit = runGit(worktree, [
      "commit-tree",
      headTree,
      "-p",
      priorMainSha,
      "-m",
      "test(workflow): prove packed Pi issue-to-PR path (#33401)",
    ]);
    runGit(worktree, ["push", "origin", `${squashCommit}:refs/heads/main`]);
    fixture.env.MOTTAINAI_GH_PR_MERGE_SHA = squashCommit;

    const finished = invoke(fixture, worktree, ["task", "finish"]);
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.transition, "merged");
    assert.equal(finished.close.alreadyClosed, false);

    const inspected = JSON.parse(
      run(fixture.realNawabari, ["session", "inspect", "--session", sessionId, "--json"], {
        cwd: fixture.workspace,
        env: fixture.env,
        timeout: 15_000,
      }).stdout,
    );
    assert.equal(inspected.session.state, "closed");

    // Crash/retry idempotency: finishing an already-merged task again must not
    // fail and must not re-request a close (the session is already gone).
    const finishedAgain = invoke(fixture, fixture.workspace, ["task", "finish", "--task-id", started.task.taskId]);
    assert.equal(finishedAgain.ok, true, JSON.stringify(finishedAgain));
    assert.equal(finishedAgain.close.alreadyClosed, true);

    const next = invoke(fixture, fixture.workspace, ["task", "start", "issue-377", "--type", "fix", "--issue", "377"]);
    assert.equal(next.ok, true, JSON.stringify(next), "the next task start must not require a manual session close");
    runGit(fixture.workspace, ["worktree", "remove", "--force", next.execution.worktree]);
  },
);

test("packed Pi exit before PR creation is incomplete evidence", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const companions = companionAvailability();
  if (companions.zellij.length === 0 || companions.nawabari.length === 0) {
    t.skip("compatible Zellij and Nawabari companions are required for the packed negative path");
    return;
  }
  const fixture = createFixture({
    mode: "early-exit",
    zellijPath: companions.zellij,
    nawabariPath: companions.nawabari,
  });
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
  if (statusResult.status === 0) {
    assert.notEqual(JSON.parse(statusResult.stdout).currentState, "pull-request-open");
  } else {
    assert.equal(statusResult.status, 1, statusResult.stdout + statusResult.stderr);
    assert.ok(
      statusResult.stdout.trim().length > 0 || statusResult.stderr.trim().length > 0,
      "task status failed without diagnostics",
    );
  }
});

test("packed workflow fails closed when gh-inari is missing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const companions = companionAvailability();
  if (companions.zellij.length === 0 || companions.nawabari.length === 0) {
    t.skip("compatible Zellij and Nawabari companions are required for the packed negative path");
    return;
  }
  const fixture = createFixture({
    missingGhInari: true,
    zellijPath: companions.zellij,
    nawabariPath: companions.nawabari,
  });
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
  if (statusResult.status === 0) {
    assert.notEqual(JSON.parse(statusResult.stdout).currentState, "pull-request-open");
  } else {
    assert.equal(statusResult.status, 1, statusResult.stdout + statusResult.stderr);
    assert.ok(
      statusResult.stdout.trim().length > 0 || statusResult.stderr.trim().length > 0,
      "task status failed without diagnostics",
    );
  }
  const failure = JSON.parse(fs.readFileSync(path.join(worktree, "pi-failure.json"), "utf8"));
  assert.match(failure.message, /gh-inari/u);
  assert.equal(fs.existsSync(fixture.ghInariTrace), false);
});
