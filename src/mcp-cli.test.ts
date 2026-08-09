import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("server entry points report configuration failures without an unhandled rejection", () => {
  const directory = workspace();
  const missingConfig = path.join(directory, "missing.json");
  const server = spawnSync(process.execPath, ["--import", "tsx", publicCliPath], {
    encoding: "utf8",
    env: { ...process.env, MOTTAINAI_CONFIG: missingConfig },
  });
  assert.equal(server.status, 1);
  assert.equal(server.stdout, "");
  assert.match(server.stderr, /Mottainai configuration was not found/);
  assert.match(server.stderr, /npx -y mottainai init/);
  assert.match(server.stderr, /ENOENT: no such file or directory/);
  assert.match(server.stderr, /Runtime diagnostic:/);
  assert.match(server.stderr, /package: mottainai@/);
  assert.match(server.stderr, /distribution: development\/source/);
  assert.match(server.stderr, /config_path:/);
  assert.doesNotMatch(server.stderr, /UnhandledPromiseRejection/);

  const developmentServe = spawnSync(process.execPath, ["--import", "tsx", cliPath, "serve", "--config"], {
    encoding: "utf8",
  });
  assert.equal(developmentServe.status, 1);
  assert.match(developmentServe.stderr, /missing value for --config/);

  fs.rmSync(directory, { recursive: true, force: true });
});

function gitWorkspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-workflow-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  fs.writeFileSync(path.join(directory, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: directory });
  return directory;
}

/** `task`/`policy` サブコマンドは git repo を対象にする（`config.json` は使わない）。
 * `MOTTAINAI_STATE_DIR` を使い捨てディレクトリへ向け、実 state と分離する。 */
function runWorkflow(...argv: string[]): Run {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-workflow-state-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", publicCliPath, ...argv],
      { encoding: "utf8", env: { ...process.env, MOTTAINAI_STATE_DIR: stateDir } },
    );
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test("public CLI policy explain reports the standard preset for a plain repository", () => {
  const directory = gitWorkspace();
  const result = runWorkflow("policy", "explain", "--workspace", directory);
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.preset, "standard");
  assert.equal(result.json.policySourceAuthority, "preset");
  const rules = result.json.rules as { protectedBranchRule: { directPush: { mode: string; authority: string } } };
  assert.equal(rules.protectedBranchRule.directPush.mode, "enforce");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI task start creates a dedicated worktree/branch, and task status reports it from inside that worktree", () => {
  const directory = gitWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-workflow-state-"));
  const environment = { ...process.env, MOTTAINAI_STATE_DIR: stateDir };
  const spawn = (...argv: string[]): Run => {
    const result = spawnSync(process.execPath, ["--import", "tsx", publicCliPath, ...argv], { encoding: "utf8", env: environment });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
  };

  const before = spawn("task", "status", "--workspace", directory);
  assert.equal(before.status, 0);
  assert.equal(before.json.active, false);
  assert.equal(before.json.branch, "main");

  const started = spawn("task", "start", "my-task", "--type", "fix", "--issue", "9", "--workspace", directory);
  assert.equal(started.status, 0);
  assert.equal(started.json.ok, true);
  const worktree = started.json.worktree as { branchName: string; canonicalPath: string };
  assert.equal(worktree.branchName, "fix/9-my-task");
  assert.notEqual(worktree.branchName, "main");

  const statusInWorktree = spawn("task", "status", "--workspace", worktree.canonicalPath);
  assert.equal(statusInWorktree.status, 0);
  assert.equal(statusInWorktree.json.active, true);

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI task start validates taskSlug/issueRef at the boundary, same as the MCP tool", () => {
  const directory = gitWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-workflow-state-"));
  const environment = { ...process.env, MOTTAINAI_STATE_DIR: stateDir };
  const spawn = (...argv: string[]): Run => {
    const result = spawnSync(process.execPath, ["--import", "tsx", publicCliPath, ...argv], { encoding: "utf8", env: environment });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
  };

  const badSlug = spawn("task", "start", "Bad Slug", "--type", "fix", "--issue", "7", "--workspace", directory);
  assert.equal(badSlug.status, 1);
  assert.match(badSlug.stderr, /invalid task slug/);

  const badIssueRef = spawn("task", "start", "ok-slug", "--type", "fix", "--issue", "7..9", "--workspace", directory);
  assert.equal(badIssueRef.status, 1);
  assert.match(badIssueRef.stderr, /invalid issue ref/);

  const status = spawn("task", "status", "--workspace", directory);
  assert.equal(status.status, 0);
  assert.equal(status.json.active, false);

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI task start rejects starting a second task from inside its own already-active worktree", () => {
  const directory = gitWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-workflow-state-"));
  const environment = { ...process.env, MOTTAINAI_STATE_DIR: stateDir };
  const spawn = (...argv: string[]): Run => {
    const result = spawnSync(process.execPath, ["--import", "tsx", publicCliPath, ...argv], { encoding: "utf8", env: environment });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
  };

  const outer = spawn("task", "start", "outer", "--type", "fix", "--issue", "13", "--workspace", directory);
  assert.equal(outer.status, 0);
  const worktree = outer.json.worktree as { canonicalPath: string };

  const inner = spawn("task", "start", "inner", "--type", "fix", "--issue", "14", "--workspace", worktree.canonicalPath);
  assert.equal(inner.status, 1);
  assert.equal(inner.json.ok, false);
  assert.equal(inner.json.reason, "active-task-in-workspace");

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI policy explain fails closed on a corrupted .mottainai/workflow.json", () => {
  const directory = gitWorkspace();
  fs.mkdirSync(path.join(directory, ".mottainai"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".mottainai", "workflow.json"), "{ not json");
  const result = runWorkflow("policy", "explain", "--workspace", directory);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public CLI init emits one JSON document and creates the workspace configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-public-init-"));
  const result = runPublic(directory, "init", "--yes", "--workspace", directory, "--scope", "project", "--client", "none", "--no-doctor", "--json");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.json.ok, true);
  assert.equal(result.json.scope, "project");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")), {
    version: 2,
    mcpServers: {},
    gateway: { workspaceRoot: "." },
  });
  fs.rmSync(directory, { recursive: true, force: true });
});
