import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatInitHuman, runInit } from "./init.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-init-test-"));
}

async function initialize(workspace: string, ...args: string[]) {
  const previousConfig = process.env.MOTTAINAI_CONFIG;
  delete process.env.MOTTAINAI_CONFIG;
  try {
    return await runInit({
      args: ["--yes", "--workspace", workspace, "--client", "none", "--no-doctor", ...args],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
  } finally {
    if (previousConfig === undefined) delete process.env.MOTTAINAI_CONFIG;
    else process.env.MOTTAINAI_CONFIG = previousConfig;
  }
}

test("init creates a portable empty v2 configuration with non-interactive defaults", async () => {
  const workspace = temporaryWorkspace();
  try {
    const summary = await initialize(workspace, "--scope", "project");
    assert.equal(summary.config_written, true);
    assert.equal(summary.configuration, path.join(workspace, "mottainai.config.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(summary.configuration, "utf8")), {
      version: 2,
      mcpServers: {},
      gateway: { workspaceRoot: "." },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init resolves explicit and MOTTAINAI_CONFIG paths with server precedence", async () => {
  const workspace = temporaryWorkspace();
  const environmentConfig = path.join(workspace, "environment.json");
  const explicitConfig = path.join(workspace, "explicit.json");
  const previousConfig = process.env.MOTTAINAI_CONFIG;
  process.env.MOTTAINAI_CONFIG = environmentConfig;
  try {
    const runWithEnvironment = (args: string[]) => runInit({
      args: ["--yes", "--workspace", workspace, "--client", "none", "--no-doctor", ...args],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    const fromEnvironment = await runWithEnvironment(["--scope", "project"]);
    assert.equal(fromEnvironment.configuration, environmentConfig);
    assert.equal(fs.existsSync(environmentConfig), true);

    const fromExplicit = await runWithEnvironment(["--scope", "project", "--config", explicitConfig]);
    assert.equal(fromExplicit.configuration, explicitConfig);
    assert.equal(fs.existsSync(explicitConfig), true);
  } finally {
    if (previousConfig === undefined) delete process.env.MOTTAINAI_CONFIG;
    else process.env.MOTTAINAI_CONFIG = previousConfig;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init discovers Windows executables through fixed and PATHEXT extensions", async () => {
  const workspace = temporaryWorkspace();
  const binaryDirectory = path.join(workspace, "bin");
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(path.join(binaryDirectory, "claude.cmd"), "");
  fs.writeFileSync(path.join(binaryDirectory, "codex.CUSTOM"), "");
  const previousPath = process.env.PATH;
  const previousPathExtensions = process.env.PATHEXT;
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.PATH = binaryDirectory;
  process.env.PATHEXT = ".CUSTOM";
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    const summary = await initialize(workspace, "--scope", "project");
    assert.deepEqual(summary.detected_clients, ["claude", "codex"]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathExtensions === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathExtensions;
    if (previousPlatform === undefined) delete (process as { platform?: string }).platform;
    else Object.defineProperty(process, "platform", previousPlatform);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init personal scope updates Git info/exclude without touching .gitignore", async () => {
  const workspace = temporaryWorkspace();
  try {
    execFileSync("git", ["init", "-q", workspace]);
    const summary = await initialize(workspace, "--scope", "personal");
    assert.equal(summary.scope, "personal");
    assert.equal(fs.existsSync(path.join(workspace, ".gitignore")), false);
    const exclude = fs.readFileSync(path.join(workspace, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /mottainai\.config\.json/);
    assert.match(exclude, /\.mottainai\//);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init dry-run does not write configuration or personal Git exclusions", async () => {
  const workspace = temporaryWorkspace();
  try {
    execFileSync("git", ["init", "-q", workspace]);
    const excludePath = path.join(workspace, ".git", "info", "exclude");
    const before = fs.readFileSync(excludePath, "utf8");
    const summary = await initialize(workspace, "--scope", "personal", "--dry-run");
    assert.equal(summary.dry_run, true);
    assert.equal(summary.config_written, false);
    assert.equal(fs.existsSync(path.join(workspace, "mottainai.config.json")), false);
    assert.equal(fs.readFileSync(excludePath, "utf8"), before);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init force creates a backup before replacing an existing configuration", async () => {
  const workspace = temporaryWorkspace();
  try {
    const first = await initialize(workspace, "--scope", "project");
    const original = fs.readFileSync(first.configuration, "utf8");
    const second = await initialize(workspace, "--scope", "project", "--force");
    assert.ok(second.backup);
    assert.equal(fs.readFileSync(second.backup as string, "utf8"), original);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init refuses to wait for input in a non-TTY without --yes", async () => {
  const workspace = temporaryWorkspace();
  try {
    await assert.rejects(
      runInit({ args: ["--workspace", workspace], cwd: workspace, stdinIsTTY: false, stdoutIsTTY: false }),
      /interactive input is unavailable/,
    );
    assert.equal(fs.existsSync(path.join(workspace, "mottainai.config.json")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

/** unix shebang + 実行ビットで client を偽装するため、Windows では別スキップとする。 */
test("init import drops literal credentials from upstream registrations", { skip: process.platform === "win32" }, async () => {
  const workspace = temporaryWorkspace();
  const binaryDirectory = path.join(workspace, "bin");
  fs.mkdirSync(binaryDirectory);
  const client = path.join(binaryDirectory, "claude");
  const registrationOutput = JSON.stringify({
    mcpServers: {
      safe: { command: "node", args: ["--safe"] },
      secretArgs: { command: "node", args: ["--token", "literal-secret", "--safe"] },
      secretArgsEquals: { command: "node", args: ["--token=literal-secret", "--safe"] },
      secretHeaderArg: { command: "node", args: ["--header", "Authorization: Bearer literal-secret", "--safe"] },
      secretUrl: { transport: "streamableHttp", url: "https://example.test/mcp?token=literal-secret" },
      obscureQueryUrl: { transport: "streamableHttp", url: "https://example.test/mcp?sig=literal-secret" },
      fragmentUrl: { transport: "streamableHttp", url: "https://example.test/mcp#access_token=literal-secret" },
      nonHttpUrl: { transport: "streamableHttp", url: "ftp://example.test/mcp" },
      secretHeader: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        headersFromEnv: { Authorization: "literal-secret" },
      },
      httpCredentials: {
        transport: "streamableHttp",
        url: "http://example.test/mcp",
        auth: { type: "oauth", profile: "http" },
        headersFromEnv: { Authorization: "HTTP_AUTH" },
      },
      httpsCredentials: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        auth: { type: "oauth", profile: "https" },
        headersFromEnv: { Authorization: "literal-secret" },
      },
    },
  });
  fs.writeFileSync(client, `#!/bin/sh\nprintf '%s' '${registrationOutput}'\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`;
  try {
    const summary = await runInit({
      args: ["--yes", "--workspace", workspace, "--config", path.join(workspace, "mottainai.config.json"), "--scope", "project", "--import", "claude", "--client", "none", "--no-doctor"],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    const config = JSON.parse(fs.readFileSync(summary.configuration, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.deepEqual(config.mcpServers.safe, { command: "node", args: ["--safe"] });
    assert.equal("secretArgs" in config.mcpServers, false);
    assert.equal("secretArgsEquals" in config.mcpServers, false);
    assert.equal("secretHeaderArg" in config.mcpServers, false);
    assert.equal("secretUrl" in config.mcpServers, false);
    assert.equal("obscureQueryUrl" in config.mcpServers, false);
    assert.equal("fragmentUrl" in config.mcpServers, false);
    assert.equal("nonHttpUrl" in config.mcpServers, false);
    assert.deepEqual(config.mcpServers.secretHeader, { transport: "streamableHttp", url: "https://example.test/mcp" });
    assert.deepEqual(config.mcpServers.httpCredentials, { transport: "streamableHttp", url: "http://example.test/mcp" });
    assert.deepEqual(config.mcpServers.httpsCredentials, {
      transport: "streamableHttp",
      url: "https://example.test/mcp",
      auth: { type: "oauth", profile: "https" },
    });
    assert.ok(summary.warnings.some((warning) => warning.includes("secretArgs") && warning.includes("arguments contain credentials")));
    assert.ok(summary.warnings.some((warning) => warning === "secretArgsEquals was not imported because its arguments contain credentials"));
    assert.ok(summary.warnings.some((warning) => warning.includes("secretHeaderArg") && warning.includes("arguments contain credentials")));
    assert.ok(summary.warnings.some((warning) => warning.includes("secretUrl") && warning.includes("not a plain http(s) URL")));
    assert.ok(summary.warnings.some((warning) => warning.includes("obscureQueryUrl") && warning.includes("not a plain http(s) URL")));
    assert.ok(summary.warnings.some((warning) => warning.includes("fragmentUrl") && warning.includes("not a plain http(s) URL")));
    assert.ok(summary.warnings.some((warning) => warning.includes("nonHttpUrl") && warning.includes("not a plain http(s) URL")));
    assert.ok(summary.warnings.some((warning) => warning.includes("header secret")));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init does not register when a client listing fails", { skip: process.platform === "win32" }, async () => {
  const workspace = temporaryWorkspace();
  const binaryDirectory = path.join(workspace, "bin");
  const client = path.join(binaryDirectory, "claude");
  const registrationMarker = path.join(workspace, "registered");
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(client, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'if (process.argv[2] === "mcp" && process.argv[3] === "list") process.exit(1);',
    `fs.writeFileSync(${JSON.stringify(registrationMarker)}, "registered");`,
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`;
  try {
    const summary = await runInit({
      args: [
        "--yes",
        "--workspace",
        workspace,
        "--config",
        path.join(workspace, "mottainai.config.json"),
        "--scope",
        "project",
        "--client",
        "claude",
        "--no-doctor",
      ],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    assert.equal(summary.clients[0]?.status, "list-failed");
    assert.equal(fs.existsSync(registrationMarker), false);
    assert.ok(summary.warnings.some((warning) => warning.includes("MCP list failed")));
    assert.equal(summary.ok, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init fails when an explicitly requested client binary is unavailable", async () => {
  const workspace = temporaryWorkspace();
  const emptyBinaryDirectory = path.join(workspace, "empty-bin");
  fs.mkdirSync(emptyBinaryDirectory);
  const previousPath = process.env.PATH;
  process.env.PATH = emptyBinaryDirectory;
  try {
    const summary = await runInit({
      args: [
        "--yes",
        "--workspace",
        workspace,
        "--config",
        path.join(workspace, "mottainai.config.json"),
        "--scope",
        "project",
        "--client",
        "codex",
        "--no-doctor",
      ],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    assert.equal(summary.clients[0]?.status, "unavailable");
    assert.equal(summary.ok, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init does not fail when --client none is used", async () => {
  const workspace = temporaryWorkspace();
  try {
    const summary = await initialize(workspace, "--scope", "project");
    assert.deepEqual(summary.clients, []);
    assert.equal(summary.ok, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init warns when an imported client listing times out", { skip: process.platform === "win32" }, async () => {
  const workspace = temporaryWorkspace();
  const binaryDirectory = path.join(workspace, "bin");
  const client = path.join(binaryDirectory, "claude");
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(client, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`;
  try {
    const summary = await runInit({
      args: [
        "--yes",
        "--workspace",
        workspace,
        "--config",
        path.join(workspace, "mottainai.config.json"),
        "--scope",
        "project",
        "--import",
        "claude",
        "--client",
        "none",
        "--no-doctor",
      ],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    assert.ok(summary.warnings.some((warning) => warning.includes("claude MCP list timed out")));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init human output points doctor at the generated configuration", async () => {
  const workspace = temporaryWorkspace();
  const configuration = path.join(workspace, "custom.json");
  try {
    const summary = await initialize(workspace, "--scope", "project", "--config", configuration);
    assert.ok(formatInitHuman(summary).includes(`doctor --config ${JSON.stringify(configuration)}`));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("registration command quotes a configuration path that contains whitespace", async () => {
  const workspace = temporaryWorkspace();
  const spacedWorkspace = path.join(workspace, "path with space");
  fs.mkdirSync(spacedWorkspace);
  try {
    const summary = await runInit({
      args: [
        "--yes",
        "--workspace",
        spacedWorkspace,
        "--config",
        path.join(spacedWorkspace, "mottainai.config.json"),
        "--scope",
        "project",
        "--client",
        "claude",
        "--no-doctor",
        "--dry-run",
      ],
      cwd: spacedWorkspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    assert.ok(summary.configuration.includes(" "), "test fixture path must contain a space");
    assert.equal(summary.clients[0]?.registrationCommand.includes(`"${summary.configuration}"`), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("generated client registration command is self-sufficient regardless of MCP client cwd", { skip: process.platform === "win32" }, async () => {
  const workspace = temporaryWorkspace();
  const unrelatedCwd = temporaryWorkspace();
  const binaryDirectory = path.join(workspace, "bin");
  const argsMarker = path.join(workspace, "registration-args.json");
  fs.mkdirSync(binaryDirectory);
  const client = path.join(binaryDirectory, "claude");
  // 実際に registerClient が組み立てた argv をそのまま捕捉する（テストが自前で argv を組み立てない）。
  fs.writeFileSync(client, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(argsMarker)}, JSON.stringify(process.argv.slice(2)));`,
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`;
  try {
    const summary = await runInit({
      args: ["--yes", "--workspace", workspace, "--config", path.join(workspace, "mottainai.config.json"), "--scope", "project", "--client", "claude", "--no-doctor"],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    assert.equal(summary.clients[0]?.status, "registered");
    const capturedArgs = JSON.parse(fs.readFileSync(argsMarker, "utf8")) as string[];
    // capturedArgs: ["mcp", "add", "-s", "user", "mottainai", "--", "npx", "-y", "<pkgRef>", "serve", "--config", "<absPath>"]
    const separatorIndex = capturedArgs.indexOf("--");
    const registeredCommand = capturedArgs.slice(separatorIndex + 1);
    assert.deepEqual(registeredCommand.slice(-2), ["--config", summary.configuration]);
    assert.equal(registeredCommand[registeredCommand.length - 3], "serve");

    // MCP クライアントは init を実行したディレクトリとは無関係な cwd からサーバーを起動しうる。
    // npx 部分を除き、実際に捕捉した "serve --config <path>" をそのまま unrelated cwd から実行して検証する。
    const servedArgs = registeredCommand.slice(registeredCommand.indexOf("serve"));
    const publicCliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
    const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const mcpClient = new Client({ name: "mottainai-registration-check", version: "0.0.0-test" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoaderUrl, publicCliPath, ...servedArgs],
      cwd: unrelatedCwd,
      env: (() => {
        const environment: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (key !== "MOTTAINAI_CONFIG" && value !== undefined) environment[key] = value;
        }
        return environment;
      })(),
    });
    try {
      await mcpClient.connect(transport);
      const tools = await mcpClient.listTools();
      assert.ok(Array.isArray(tools.tools));
    } finally {
      await mcpClient.close().catch(() => {});
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});
