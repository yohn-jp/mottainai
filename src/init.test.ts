import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInit } from "./init.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-init-test-"));
}

async function initialize(workspace: string, ...args: string[]) {
  return runInit({
    args: ["--yes", "--workspace", workspace, "--client", "none", "--no-doctor", ...args],
    cwd: workspace,
    stdinIsTTY: false,
    stdoutIsTTY: false,
  });
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
      /Interactive input is unavailable/,
    );
    assert.equal(fs.existsSync(path.join(workspace, "mottainai.config.json")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("init import drops literal credentials from upstream registrations", async () => {
  const workspace = temporaryWorkspace();
  const bin = path.join(workspace, "bin");
  fs.mkdirSync(bin);
  const client = path.join(bin, "claude");
  const registrationOutput = JSON.stringify({
    mcpServers: {
      safe: { command: "node", args: ["--safe"] },
      secretArgs: { command: "node", args: ["--token", "literal-secret", "--safe"] },
      secretUrl: { transport: "streamableHttp", url: "https://example.test/mcp?token=literal-secret" },
      secretHeader: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        headersFromEnv: { Authorization: "literal-secret" },
      },
    },
  });
  fs.writeFileSync(client, `#!/bin/sh\nprintf '%s' '${registrationOutput}'\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const summary = await runInit({
      args: ["--yes", "--workspace", workspace, "--scope", "project", "--import", "claude", "--client", "none", "--no-doctor"],
      cwd: workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    const config = JSON.parse(fs.readFileSync(summary.configuration, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.deepEqual(config.mcpServers.safe, { command: "node", args: ["--safe"] });
    assert.deepEqual(config.mcpServers.secretArgs, { command: "node", args: ["--safe"] });
    assert.equal("secretUrl" in config.mcpServers, false);
    assert.deepEqual(config.mcpServers.secretHeader, { transport: "streamableHttp", url: "https://example.test/mcp" });
    assert.ok(summary.warnings.some((warning) => warning.includes("argument secrets")));
    assert.ok(summary.warnings.some((warning) => warning.includes("URL contains credentials")));
    assert.ok(summary.warnings.some((warning) => warning.includes("header secret")));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
