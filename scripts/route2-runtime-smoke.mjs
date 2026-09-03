#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_REQUEST_MS = 10_000;
const MAX_SHUTDOWN_MS = 5_000;

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

const generationPath = path.resolve(option("generation"));
const packagePath = path.resolve(option("package-root"));
const metadataPath = path.resolve(option("metadata"));
const payloadIdentityPath = path.resolve(option("payload-identity"));
const evidencePath = path.resolve(option("evidence"));
const declaredRuntimeDependencies = JSON.parse(
  process.argv.includes("--runtime-dependencies") ? option("runtime-dependencies") : "[]",
);

function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function environment(home, binDirectory) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    PATH: binDirectory,
  };
}

function protocolClient(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const pending = new Map();
  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  let closeInfo;

  const closePromise = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.trim() === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          reject(new Error(`MCP stdout was not JSON: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (message.id === undefined || message.id === null) continue;
        const waiter = pending.get(message.id);
        if (waiter === undefined) continue;
        pending.delete(message.id);
        waiter.resolve(message);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.once("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      reject(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      closeInfo = { code, signal };
      const error = new Error(`MCP process exited before responding (code=${code} signal=${signal})`);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      resolve(closeInfo);
    });
  });

  let nextId = 1;
  function request(method, params) {
    if (closed) throw new Error(`cannot request ${method} after MCP process closed`);
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return withTimeout(response, MAX_REQUEST_MS, `MCP ${method}`);
  }

  function notify(method, params) {
    if (closed) throw new Error(`cannot notify ${method} after MCP process closed`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function close() {
    if (!closed) child.stdin.end();
    try {
      await withTimeout(closePromise, MAX_SHUTDOWN_MS, "MCP shutdown");
    } catch (error) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`);
    }
    assert.equal(closeInfo?.code, 0, `MCP process failed: ${JSON.stringify({ closeInfo, stderr })}`);
    assert.equal(closeInfo?.signal, null, `MCP process was signaled: ${JSON.stringify({ closeInfo, stderr })}`);
  }

  return { request, notify, close, child };
}

function initializeConfig(workspace) {
  const configPath = path.join(workspace, "mottainai.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ version: 2, mcpServers: {}, gateway: { workspaceRoot: "." } }, null, 2),
  );
  return configPath;
}

async function searchThroughCli(
  workspace,
  configPath,
  env,
  marker,
  entrypoint = path.join(generationPath, "bin", "mottainai"),
) {
  const client = protocolClient(entrypoint, ["serve", "--config", configPath], workspace, env);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "route2-runtime-smoke", version: "1" },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    client.notify("notifications/initialized", {});
    const response = await client.request("tools/call", {
      name: "mottainai_search",
      arguments: { query: marker, path: "." },
    });
    return response;
  } finally {
    await client.close();
  }
}

async function nativeMcpSmoke(workspace, configPath, env) {
  const client = protocolClient(
    path.join(generationPath, "bin", "mottainai-mcp"),
    ["--config", configPath],
    workspace,
    env,
  );
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "route2-runtime-smoke", version: "1" },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    client.notify("notifications/initialized", {});
    const listed = await client.request("tools/list", {});
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    assert.ok(
      listed.result?.tools?.some((tool) => tool.name === "mottainai_harness_capabilities"),
      "packaged Route 2 MCP entrypoint did not expose harness capabilities",
    );
    const capabilities = await client.request("tools/call", {
      name: "mottainai_harness_capabilities",
      arguments: {},
    });
    assert.equal(capabilities.error, undefined, JSON.stringify(capabilities));
    assert.equal(capabilities.result?.structuredContent?.capabilities?.transport, "stdio");
  } finally {
    await client.close();
  }
}

function runtimeDependencyEvidence() {
  const commands =
    declaredRuntimeDependencies.length > 0
      ? declaredRuntimeDependencies.map((dependency) => dependency.command)
      : ["git", "rg"];
  return commands.map((command) => {
    const commandPath = path.join(generationPath, "bin", command);
    assert.ok(fs.existsSync(commandPath), `Route 2 generation is missing declared executable: ${command}`);
    const resolvedPath = fs.realpathSync(commandPath);
    const version = spawnSync(commandPath, ["--version"], {
      cwd: os.tmpdir(),
      env: environment(path.join(os.tmpdir(), "route2-runtime-version-home"), path.join(generationPath, "bin")),
      encoding: "utf8",
      shell: false,
    });
    assert.equal(version.status, 0, `${command} --version failed: ${version.stderr}`);
    const packageStorePath = resolvedPath.replace(new RegExp(`/bin/${command}$`, "u"), "");
    const declared = declaredRuntimeDependencies.find((dependency) => dependency.command === command);
    if (declared !== undefined) assert.equal(packageStorePath, declared.storePath, `wrong store path for ${command}`);
    return {
      packageId: declared?.packageId ?? (command === "rg" ? "ripgrep" : command),
      command,
      version: declared?.version ?? version.stdout.split("\n", 1)[0].trim(),
      storePath: packageStorePath,
    };
  });
}

async function main() {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const payloadIdentity = JSON.parse(fs.readFileSync(payloadIdentityPath, "utf8"));
  assert.equal(metadata.nixOutput?.storePath, generationPath, "metadata and generation store identity differ");
  assert.equal(payloadIdentity.contractId, "mottainai.canonical-application-payload.v1");
  assert.equal(payloadIdentity.packageName, "mottainai");
  const applicationPackage = metadata.nixOutput.packages.find((entry) => entry.packageId === "mottainai");
  assert.ok(applicationPackage, "managed-generation metadata has no Mottainai application package");
  assert.equal(
    applicationPackage.storePath,
    packagePath,
    "managed generation uses a different Mottainai package output",
  );

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-route2-smoke-"));
  const negativeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-route2-negative-"));
  const home = path.join(workspace, "home");
  const negativeHome = path.join(negativeWorkspace, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(negativeHome, { recursive: true });
  const marker = "route2-runtime-closure-marker";
  fs.writeFileSync(path.join(workspace, "marker.txt"), `${marker}\n`);
  fs.writeFileSync(path.join(negativeWorkspace, "marker.txt"), `${marker}\n`);
  const configPath = initializeConfig(workspace);
  const negativeConfigPath = initializeConfig(negativeWorkspace);

  const runtimeEnv = environment(home, path.join(generationPath, "bin"));
  const negativeBin = path.join(negativeWorkspace, "bin");
  fs.mkdirSync(negativeBin);
  fs.symlinkSync(path.join(generationPath, "bin", "mottainai"), path.join(negativeBin, "mottainai"));
  const negativeEnv = environment(negativeHome, negativeBin);

  const runtimeDependencies = runtimeDependencyEvidence();
  const cliResponse = await searchThroughCli(workspace, configPath, runtimeEnv, marker);
  assert.equal(cliResponse.error, undefined, JSON.stringify(cliResponse));
  assert.equal(cliResponse.result?.structuredContent?.status, "success", JSON.stringify(cliResponse));
  assert.match(JSON.stringify(cliResponse.result.structuredContent), new RegExp(marker, "u"));

  await nativeMcpSmoke(workspace, configPath, runtimeEnv);

  const missingDependencyResponse = await searchThroughCli(
    negativeWorkspace,
    negativeConfigPath,
    negativeEnv,
    marker,
    path.join(negativeBin, "mottainai"),
  );
  assert.ok(
    missingDependencyResponse.error !== undefined || missingDependencyResponse.result?.isError === true,
    `search did not fail after the declared rg dependency was removed from PATH: ${JSON.stringify(missingDependencyResponse)}`,
  );
  assert.match(
    JSON.stringify(missingDependencyResponse),
    /rg unavailable|spawn rg|ENOENT/u,
    "missing dependency failure did not identify rg",
  );

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        contractId: "mottainai.route2-functional-readiness.v1",
        schemaVersion: 1,
        route: 2,
        readiness: "route2-functional-ready",
        canonicalPayload: {
          contractId: payloadIdentity.contractId,
          packageVersion: payloadIdentity.packageVersion,
          sha256: payloadIdentity.sha256,
        },
        generation: {
          storePath: generationPath,
          packages: metadata.nixOutput.packages,
          runtimeDependencies,
        },
        functional: {
          cli: {
            entrypoint: path.join(generationPath, "bin", "mottainai"),
            operation: "serve -> mottainai_search",
            externalTool: "rg",
            status: "success",
          },
          mcp: {
            entrypoint: path.join(generationPath, "bin", "mottainai-mcp"),
            protocol: "stdio",
            operation: "initialize -> tools/list -> mottainai_harness_capabilities",
            status: "success",
          },
        },
        dependencyRemoval: { command: "rg", status: "failed-as-expected" },
      },
      null,
      2,
    )}\n`,
  );
  console.log(fs.readFileSync(evidencePath, "utf8").trim());
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(negativeWorkspace, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
