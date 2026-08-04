import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** scripts/ は `src/**\/*.test.ts` の外なので、CLI は子プロセスとして実行して検証する。 */
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mcp.ts");
const publicCliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function workspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-mcp-cli-"));
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify({
    version: 2,
    mcpServers: { codegraph: { command: "__mottainai_missing_codegraph__", args: ["serve"], capabilities: ["definitions"] } },
    profiles: { development: { includeCapabilities: ["definitions"] } },
    gateway: { workspaceRoot: "." },
  }, null, 2)}\n`);
  return directory;
}

function run(directory: string, ...argv: string[]): Run {
  const cliArguments = argv[0] === "doctor" && !argv.includes("--json") ? [...argv, "--json"] : argv;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...cliArguments, "--config", path.join(directory, "config.json")],
    { encoding: "utf8" },
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
}

function runPublic(directory: string, ...argv: string[]): Run {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", publicCliPath, ...argv, "--config", path.join(directory, "config.json")],
    { encoding: "utf8" },
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
}

interface RawConfig {
  mcpServers: Record<string, Record<string, unknown>>;
  gateway?: Record<string, unknown>;
}

function config(directory: string): RawConfig {
  return JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")) as RawConfig;
}

test("mcp cli registers, toggles and removes upstreams", () => {
  const directory = workspace();

  const added = run(directory, "add", "fff", "--command", "/bin/echo", "--args", "one two", "--capabilities", "text_matches, definitions", "--priority", "5");
  assert.equal(added.status, 0);
  assert.equal(added.json.added, "fff");
  assert.deepEqual(config(directory).mcpServers.fff, {
    command: "/bin/echo", args: ["one", "two"], priority: 5, capabilities: ["text_matches", "definitions"],
  });

  // 既定値を書き戻さない。未指定フィールドは正規化後の値ではなく未指定のまま残す。
  assert.equal("enabled" in config(directory).mcpServers.fff, false);

  assert.equal(run(directory, "disable", "codegraph").status, 0);
  assert.equal(config(directory).mcpServers.codegraph.enabled, false);
  assert.equal(run(directory, "enable", "codegraph").status, 0);
  assert.equal(config(directory).mcpServers.codegraph.enabled, true);

  const listed = run(directory, "list");
  assert.equal(listed.status, 0);
  assert.deepEqual((listed.json.upstreams as Array<{ name: string }>).map((entry) => entry.name), ["codegraph", "fff"]);

  assert.equal(run(directory, "remove", "fff").status, 0);
  assert.equal("fff" in config(directory).mcpServers, false);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli registers a Streamable HTTP upstream", () => {
  const directory = workspace();

  const added = run(directory, "add", "remote", "--url", "https://mcp.example.test/mcp", "--capabilities", "text_matches");
  assert.equal(added.status, 0);
  assert.deepEqual(config(directory).mcpServers.remote, {
    transport: "streamableHttp",
    url: "https://mcp.example.test/mcp",
    capabilities: ["text_matches"],
  });

  assert.equal(run(directory, "disable", "codegraph").status, 0);
  const healthy = run(directory, "doctor");
  assert.equal(healthy.status, 0);
  assert.equal(healthy.json.checked, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli requires an OAuth provider module for OAuth remote upstreams", () => {
  const directory = workspace();

  const added = run(directory, "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--auth-profile", "github", "--capabilities", "github");
  assert.equal(added.status, 0);
  assert.deepEqual(config(directory).mcpServers.github, {
    transport: "streamableHttp",
    url: "https://api.githubcopilot.com/mcp/",
    auth: { type: "oauth", profile: "github" },
    capabilities: ["github"],
  });

  run(directory, "disable", "codegraph");
  const missingProvider = run(directory, "doctor");
  assert.equal(missingProvider.status, 1);
  assert.deepEqual(missingProvider.json.problems, [
    { severity: "error", upstream: "github", message: "oauth provider module missing" },
  ]);

  const current = config(directory);
  current.gateway = { oauthProviderModule: "./provider.mjs" };
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify(current, null, 2)}\n`);
  assert.equal(run(directory, "doctor").status, 0);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli sets and clears the active profile", () => {
  const directory = workspace();

  const used = run(directory, "profile", "use", "development");
  assert.equal(used.status, 0);
  assert.equal(config(directory).gateway?.activeProfile, "development");

  const cleared = run(directory, "profile", "clear");
  assert.equal(cleared.status, 0);
  assert.equal(cleared.json.active_profile, null);
  assert.equal("activeProfile" in (config(directory).gateway ?? {}), false);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli refuses edits that would invalidate the config", () => {
  const directory = workspace();
  const before = fs.readFileSync(path.join(directory, "config.json"), "utf8");

  const badProfile = run(directory, "profile", "use", "missing");
  assert.equal(badProfile.status, 1);
  assert.match(badProfile.stderr, /nothing written: unknown gateway activeProfile: missing/);

  const badUpstreamProfile = run(directory, "add", "broken", "--command", "/bin/echo", "--profile", "nope");
  assert.equal(badUpstreamProfile.status, 1);
  assert.match(badUpstreamProfile.stderr, /nothing written: unknown upstream profile: nope/);

  assert.equal(run(directory, "add", "codegraph", "--command", "/bin/echo").status, 1);
  assert.equal(run(directory, "remove", "absent").status, 1);
  assert.equal(run(directory, "inspect", "absent").status, 1);

  assert.equal(fs.readFileSync(path.join(directory, "config.json"), "utf8"), before);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli doctor reports unreachable commands and exits non-zero", () => {
  const directory = workspace();

  const broken = run(directory, "doctor");
  assert.equal(broken.status, 1);
  assert.deepEqual(broken.json.problems, [
    { severity: "error", upstream: "codegraph", message: "command not executable: __mottainai_missing_codegraph__" },
  ]);

  run(directory, "disable", "codegraph");
  run(directory, "add", "echo", "--command", "/bin/echo", "--capabilities", "text_matches");
  const healthy = run(directory, "doctor");
  assert.equal(healthy.status, 0);
  assert.deepEqual(healthy.json.problems, []);
  assert.equal(healthy.json.checked, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("mcp cli doctor keeps startup and connection fixtures isolated from its unit tests (#55)", () => {
  const directory = workspace();
  const current = config(directory);
  current.mcpServers.codegraph.enabled = false;
  current.mcpServers.startupFailure = {
    command: process.execPath,
    args: ["-e", "process.exit(91)"],
    capabilities: ["definitions"],
  };
  current.mcpServers.connectionFailure = {
    transport: "streamableHttp",
    url: "http://127.0.0.1:1/mcp",
    capabilities: ["text_matches"],
  };
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify(current, null, 2)}\n`);

  const doctor = run(directory, "doctor");
  assert.equal(doctor.status, 0);
  assert.equal(doctor.json.checked, 2);
  assert.deepEqual(doctor.json.problems, []);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI dispatcher exposes human and JSON doctor output", () => {
  const directory = workspace();
  run(directory, "disable", "codegraph");
  run(directory, "add", "echo", "--command", process.execPath, "--capabilities", "text_matches");

  const human = runPublic(directory, "doctor");
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^Mottainai Doctor/m);
  assert.match(human.stdout, /✓ Node\.js/);
  assert.match(human.stdout, /0 errors, 0 warnings/);

  const json = runPublic(directory, "doctor", "--json");
  assert.equal(json.status, 0);
  assert.equal(json.json.ok, true);
  assert.equal(json.json.errors, 0);
  assert.ok(Array.isArray(json.json.checks));

  fs.rmSync(directory, { recursive: true, force: true });
});
