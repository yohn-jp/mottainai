// Issue #22 package-compatible subset。full protocol/fault suiteは built dist suite にあり、
// ここでは npm pack artifact の bin/runtime 解決と最小 MCP handshake を確認する。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupClient, createWorkspace, INITIALIZE_PARAMS, isolatedEnv } from "./lib/mcp-blackbox-test-support.mjs";
import { BLACKBOX_TIMEOUTS } from "./lib/mcp-blackbox-timeouts.mjs";
import {
  extractTarball,
  linkDependencies,
  McpStdioClient,
  packRepository,
  resolvePackagedBin,
  resolvePackagedCommand,
} from "./lib/mcp-blackbox-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let suiteRoot;
let binPath;
let packedFiles;
let distMtimeBeforePack;

before(() => {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before pnpm run test:package");
  const suppliedTarball = process.env.MOTTAINAI_PACKAGE_TARBALL;
  distMtimeBeforePack = Number(process.env.MOTTAINAI_DIST_MTIME ?? fs.statSync(distEntry).mtimeMs);
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-package-e2e-"));
  const packed = suppliedTarball === undefined ? packRepository(repoRoot, suiteRoot) : undefined;
  const tarballPath = packed?.tarballPath ?? path.resolve(suppliedTarball);
  packedFiles = packed?.packedFiles ?? JSON.parse(process.env.MOTTAINAI_PACKED_FILES ?? "[]");
  if (!fs.existsSync(tarballPath)) throw new Error(`package tarball is missing: ${tarballPath}`);
  const extracted = extractTarball(tarballPath, path.join(suiteRoot, "extracted"));
  linkDependencies(extracted, repoRoot);
  binPath = resolvePackagedBin(extracted);
});

after(() => {
  if (suiteRoot !== undefined) fs.rmSync(suiteRoot, { recursive: true, force: true });
});

test("packed artifact contains its declared runtime entry and pack does not rebuild dist", () => {
  assert.ok(packedFiles.includes("package.json"));
  assert.ok(packedFiles.includes("dist/index.js"));
  assert.ok(packedFiles.includes("dist/manager/pi-guard.js"));
  assert.ok(packedFiles.includes("dist/runtime-build-metadata.json"));
  assert.match(
    fs.readFileSync(path.join(path.dirname(binPath), "manager", "pi-guard.js"), "utf8"),
    /mottainai-managed-pi-guard-v1/u,
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(binPath), "runtime-build-metadata.json"), "utf8"));
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(path.dirname(path.dirname(binPath)), "package.json"), "utf8"),
  );
  assert.equal(metadata.package_name, packageJson.name);
  assert.equal(metadata.package_version, packageJson.version);
  assert.equal(metadata.artifact, "npm");
  assert.match(metadata.build_id, new RegExp(`^${packageJson.name}@${packageJson.version}\\+`, "u"));
  assert.equal(fs.statSync(path.join(repoRoot, "dist", "index.js")).mtimeMs, distMtimeBeforePack);
});

test("packed identity survives consumer cwd, explicit config, environment config, and default config resolution", () => {
  const consumer = createWorkspace();
  const alternateCwd = createWorkspace();
  const configPath = path.join(consumer, "mottainai.config.json");
  const runDoctor = (cwd, env, args = []) => {
    const result = spawnSync(binPath, ["doctor", "--json", ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.ok(result.status === 0 || result.status === 1, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  try {
    const explicit = runDoctor(alternateCwd, isolatedEnv(alternateCwd), ["--config", configPath]);
    const fromEnvironment = runDoctor(alternateCwd, { ...isolatedEnv(alternateCwd), MOTTAINAI_CONFIG: configPath });
    const fromDefault = runDoctor(consumer, isolatedEnv(consumer));

    for (const report of [explicit, fromEnvironment, fromDefault]) {
      assert.equal(report.identity.package_name, "mottainai");
      assert.equal(report.identity.distribution_kind, "packed/npm");
      assert.equal(report.identity.provenance.build_id, "build");
      assert.equal(report.identity.provenance.entry_point, "runtime");
    }
    assert.equal(explicit.identity.provenance.config_path, "cli");
    assert.equal(fromEnvironment.identity.provenance.config_path, "environment");
    assert.equal(fromDefault.identity.provenance.config_path, "default");
    assert.match(fromDefault.identity.startup_cwd, /^~/u);
    assert.deepEqual(fromDefault.identity.upstreams, []);
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
    fs.rmSync(alternateCwd, { recursive: true, force: true });
  }
});

function initializeGitWorkspace(workspace) {
  const commands = [
    ["init", "-b", "main"],
    ["config", "user.email", "package-test@example.invalid"],
    ["config", "user.name", "Mottainai Package Test"],
  ];
  fs.writeFileSync(path.join(workspace, "README.md"), "package companion test\n");
  commands.push(["add", "README.md"], ["commit", "-m", "initial"]);
  for (const args of commands) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
}

function writeAmbiguousNawabari(commandPath) {
  fs.writeFileSync(
    commandPath,
    `#!/bin/sh
case "$1:$2" in
  capabilities:*) printf '%s\\n' '{"ok":true,"command":"capabilities","schema_version":1,"contract_id":"nawabari.standalone-execution.v1","package_version":"0.2.0","capabilities":[{"commands":["session create","session id","session show","session list","session claim","session claims","session close","authorize","checkpoint","commit","push","gc"]}]}' ;;
  session:id) printf '%s\\n' '{"ok":false,"command":"session id","code":"NO_SESSION","message":"none"}'; exit 3 ;;
  session:list) printf '%s\\n' '{"ok":true,"command":"session list","sessions":[]}' ;;
  session:create|session:show) printf '%s\\n' '{"ok":true,"command":"session show","session_id":"foreign-session","repository":"/tmp/foreign-repository.git","worktree":"/tmp/foreign-worktree","branch":"fix/181-ambiguous-companion","state":"active"}' ;;
  *) printf '%s\\n' '{"ok":false,"command":"unsupported","code":"UNEXPECTED","message":"unexpected test command"}'; exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
}

test("packed managed task reports a missing companion and uses a compatible standalone Nawabari", (t) => {
  const missingWorkspace = createWorkspace();
  const compatibleWorkspace = createWorkspace();
  try {
    initializeGitWorkspace(missingWorkspace);
    initializeGitWorkspace(compatibleWorkspace);
    const gitPath = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    assert.ok(gitPath.length > 0);
    const isolatedPath = path.join(suiteRoot, "git-only-bin");
    fs.mkdirSync(isolatedPath, { recursive: true });
    fs.symlinkSync(gitPath, path.join(isolatedPath, "git"));

    const missing = spawnSync(
      process.execPath,
      [binPath, "task", "start", "missing-companion", "--type", "fix", "--issue", "181"],
      {
        cwd: missingWorkspace,
        env: { ...isolatedEnv(missingWorkspace), PATH: isolatedPath },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
    assert.equal(JSON.parse(missing.stdout).reason, "nawabari-unavailable");
    assert.equal(fs.existsSync(path.join(missingWorkspace, ".mottainai", "worktrees")), false);

    // A foreign session returned by the external authority is a genuine ownership
    // ambiguity. The package-visible classification must survive compensation;
    // absence of a Mottainai physical worktree is not evidence for fallback.
    writeAmbiguousNawabari(path.join(isolatedPath, "nawabari"));
    const ambiguousWorkspace = createWorkspace();
    t.after(() => fs.rmSync(ambiguousWorkspace, { recursive: true, force: true }));
    initializeGitWorkspace(ambiguousWorkspace);
    const ambiguous = spawnSync(
      process.execPath,
      [binPath, "task", "start", "ambiguous-companion", "--type", "fix", "--issue", "181"],
      {
        cwd: ambiguousWorkspace,
        env: { ...isolatedEnv(ambiguousWorkspace), PATH: isolatedPath },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(ambiguous.status, 1, `${ambiguous.stdout}\n${ambiguous.stderr}`);
    assert.equal(JSON.parse(ambiguous.stdout).reason, "nawabari-ownership-ambiguous");
    assert.equal(fs.existsSync(path.join(ambiguousWorkspace, ".mottainai", "worktrees")), false);

    if (spawnSync("which", ["nawabari"], { encoding: "utf8", env: isolatedEnv(compatibleWorkspace) }).status !== 0) {
      t.skip("nawabari companion is not installed");
      return;
    }

    const compatible = spawnSync(
      process.execPath,
      [binPath, "task", "start", "compatible-companion", "--type", "fix", "--issue", "181"],
      {
        cwd: compatibleWorkspace,
        env: isolatedEnv(compatibleWorkspace),
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(compatible.status, 0, `${compatible.stdout}\n${compatible.stderr}`);
    const started = JSON.parse(compatible.stdout);
    assert.equal(started.ok, true);
    assert.equal(typeof started.execution?.sessionId, "string");
    assert.equal(started.semanticExecutionPlan?.claimGeneration?.strategy, "conservative-broad");

    const closed = spawnSync("nawabari", ["session", "close", "--session", started.execution.sessionId, "--json"], {
      cwd: started.execution.worktree,
      env: isolatedEnv(compatibleWorkspace),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
  } finally {
    fs.rmSync(missingWorkspace, { recursive: true, force: true });
    fs.rmSync(compatibleWorkspace, { recursive: true, force: true });
  }
});

test("pack and extract helpers preserve paths containing spaces", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const spacedRoot = path.join(suiteRoot, "temporary package root");
  fs.mkdirSync(spacedRoot, { recursive: true });
  const packed = packRepository(repoRoot, spacedRoot);
  const extracted = extractTarball(packed.tarballPath, path.join(spacedRoot, "extracted package"));
  linkDependencies(extracted, repoRoot);
  const spacedBinPath = resolvePackagedBin(extracted);
  const workspace = createWorkspace();
  let client;
  try {
    client = McpStdioClient.launchPackaged(spacedBinPath, { cwd: workspace, env: isolatedEnv(workspace) });
    const response = await client.request("initialize", INITIALIZE_PARAMS, BLACKBOX_TIMEOUTS.request);
    assert.equal(response.error, undefined);
    const exitInfo = await client.closeGracefully(BLACKBOX_TIMEOUTS.shutdown);
    assert.equal(exitInfo.code, 0);
    assert.equal(exitInfo.signal, null);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    if (client === undefined) {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      await cleanupClient(client, workspace);
    }
  }
});

test(
  "packed artifact serves a minimal MCP handshake, list, call, and EOF shutdown",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const workspace = createWorkspace();
    const client = McpStdioClient.launchPackaged(binPath, { cwd: workspace, env: isolatedEnv(workspace) });
    try {
      const initializeResponse = await client.request("initialize", INITIALIZE_PARAMS, BLACKBOX_TIMEOUTS.request);
      assert.equal(initializeResponse.error, undefined);
      client.notify("notifications/initialized", {});
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const listResponse = await client.request("tools/list", {}, BLACKBOX_TIMEOUTS.request);
      assert.equal(listResponse.error, undefined);
      assert.ok(listResponse.result.tools.some((tool) => tool.name === "mottainai_list"));
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const callResponse = await client.request(
        "tools/call",
        { name: "mottainai_list", arguments: {} },
        BLACKBOX_TIMEOUTS.request,
      );
      assert.equal(callResponse.error, undefined);
      assert.equal(callResponse.result.structuredContent.status, "success");
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const statusResponse = await client.request(
        "tools/call",
        { name: "mottainai_runtime_status", arguments: {} },
        BLACKBOX_TIMEOUTS.request,
      );
      assert.equal(statusResponse.error, undefined);
      assert.equal(statusResponse.result.structuredContent.identity.package_name, "mottainai");
      assert.equal(statusResponse.result.structuredContent.identity.distribution_kind, "packed/npm");
      assert.equal(statusResponse.result.structuredContent.identity.provenance.build_id, "build");
      assert.deepEqual(statusResponse.result.structuredContent.facts, []);
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const exitInfo = await client.closeGracefully(BLACKBOX_TIMEOUTS.shutdown);
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);
      assert.deepEqual(client.stdoutPurityViolations(), []);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "packed artifact serves the dashboard from a consumer workspace",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const workspace = createWorkspace();
    const { command, args } = resolvePackagedCommand(binPath);
    const managerAsset = path.join(path.dirname(binPath), "dashboard", "manager-v0.html");
    assert.equal(fs.existsSync(managerAsset), true, "packed artifact must include the Manager UI asset");
    const child = spawn(command, [...args, "dashboard", "--no-open", "--port", "0"], {
      cwd: workspace,
      env: isolatedEnv(workspace),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const ready = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/Mottainai dashboard listening at (http:\/\/127\.0\.0\.1:\d+\/)/);
        if (match?.[1] !== undefined) resolve(match[1]);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`packed dashboard exited before ready: ${code}\n${stderr}`)));
    });
    try {
      const url = await ready;
      const response = await fetch(`${url}api/v1/project`);
      assert.equal(response.status, 200);
      const project = await response.json();
      assert.equal(project.project.name, "mottainai");
      const viewer = await fetch(url);
      assert.match(viewer.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(await viewer.text(), /Semantic Project Viewer/);
      child.kill("SIGTERM");
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    } finally {
      if (!child.killed) child.kill("SIGTERM");
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "packed artifact starts Manager and serves the strengthened control-plane asset",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const workspace = createWorkspace();
    const fakeZellij = path.join(workspace, "zellij");
    fs.writeFileSync(
      fakeZellij,
      "#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args[0]==='--version'){console.log('zellij 0.40.0');process.exit(0)}if(args[0]==='list-sessions'){process.exit(0)}process.exit(0);\n",
      { mode: 0o755 },
    );
    const { command, args } = resolvePackagedCommand(binPath);
    const child = spawn(command, [...args, "manager", "--no-open", "--port", "0"], {
      cwd: workspace,
      env: { ...isolatedEnv(workspace), MOTTAINAI_ZELLIJ_BINARY: fakeZellij },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const ready = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/Mottainai manager listening at (http:\/\/127\.0\.0\.1:\d+\/)/u);
        if (match?.[1] !== undefined) resolve(match[1]);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`packed Manager exited before ready: ${code}\n${stderr}`)));
    });
    try {
      const url = await ready;
      const health = await fetch(`${url}api/v1/manager/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).zellij.version, "zellij 0.40.0");
      const piResponse = await fetch(`${url}api/v1/manager/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentKind: "pi",
          instruction: "packed Pi profile",
        }),
      });
      assert.equal(piResponse.status, 201);
      const piSession = (await piResponse.json()).session;
      assert.equal(piSession.agentKind, "pi");
      assert.equal(piSession.launchCommand, "pi");
      const guardIndex = piSession.launchArgs.indexOf("--extension");
      assert.ok(guardIndex >= 0);
      const guardPath = piSession.launchArgs[guardIndex + 1];
      assert.equal(typeof guardPath, "string");
      assert.match(guardPath, /[\\/]dist[\\/]manager[\\/]pi-guard\.js$/u);
      assert.equal(fs.existsSync(guardPath), true);
      const viewer = await fetch(url);
      assert.match(viewer.headers.get("content-type") ?? "", /^text\/html/u);
      const html = await viewer.text();
      assert.match(html, /Mottainai Manager/u);
      assert.match(html, /Claude Code CLI/u);
      assert.match(html, /value="pi">Pi/u);
      child.kill("SIGTERM");
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    } finally {
      if (!child.killed) child.kill("SIGTERM");
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  },
);
