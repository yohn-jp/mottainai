import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BLACKBOX_TIMEOUTS } from "./mcp-blackbox-timeouts.mjs";

export const CLIENT_INFO = { name: "mottainai-blackbox-suite", version: "0.0.0" };
export const INITIALIZE_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: CLIENT_INFO,
};
export const FIXTURE_TOOL_NAME = "fixture__fixture_echo";

export function isolatedEnv(homeDir) {
  const env = { ...process.env };
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.XDG_STATE_HOME = path.join(homeDir, "xdg-state");
  env.XDG_CONFIG_HOME = path.join(homeDir, "xdg-config");
  env.XDG_CACHE_HOME = path.join(homeDir, "xdg-cache");
  for (const name of [
    "MOTTAINAI_CONFIG",
    "MOTTAINAI_TELEMETRY",
    "MOTTAINAI_TELEMETRY_FILE",
    "MOTTAINAI_COMPRESS",
    "MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS",
    "MOTTAINAI_COMPRESS_CODE",
    "MOTTAINAI_LOG",
    "MOTTAINAI_TRACE_RAW",
  ])
    delete env[name];
  return env;
}

export function createWorkspace({
  config = { version: 2, mcpServers: {}, gateway: { workspaceRoot: "." } },
  extraFiles = {},
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-e2e-ws-"));
  if (config !== null) writeConfig(directory, config);
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const absolute = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return directory;
}

export function writeConfig(directory, config, fileName = "mottainai.config.json") {
  const configPath = path.join(directory, fileName);
  fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return configPath;
}

export function createFixtureWorkspace(repoRoot, mode, options = {}) {
  const workspace = createWorkspace({ config: null });
  const pidFile = path.join(workspace, "fixture.pid");
  const readyFile = path.join(workspace, "fixture.ready");
  const fixturePath = path.join(repoRoot, "scripts", "fixtures", "mcp-upstream.mjs");
  const config = {
    version: 2,
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        env: {
          MOTTAINAI_FIXTURE_MODE: mode,
          MOTTAINAI_FIXTURE_PID_FILE: pidFile,
          MOTTAINAI_FIXTURE_READY_FILE: readyFile,
          ...(options.stderrBytes === undefined
            ? {}
            : {
                MOTTAINAI_FIXTURE_STDERR_BYTES: String(options.stderrBytes),
              }),
        },
      },
    },
    gateway: { workspaceRoot: "." },
  };
  const configPath = writeConfig(workspace, config);
  return { workspace, configPath, pidFile, readyFile };
}

export async function waitForFile(filePath, timeoutMs = BLACKBOX_TIMEOUTS.fixtureReady) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, BLACKBOX_TIMEOUTS.statePoll));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for fixture file: ${filePath}`);
}

export function readPid(pidFile) {
  return Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function waitForProcessGone(pid, timeoutMs = BLACKBOX_TIMEOUTS.forcedCleanup) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, BLACKBOX_TIMEOUTS.statePoll));
  }
  throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`);
}

export async function cleanupClient(client, workspace) {
  client.forceKill();
  await client.waitForExit(2_000).catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
}
