import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDoctorReport, formatDoctorHuman, type DoctorDependencies } from "./doctor.js";

function fixture(config: Record<string, unknown>): { directory: string; configPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-doctor-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { directory, configPath };
}

function dependencies(overrides: Partial<DoctorDependencies> = {}): Partial<DoctorDependencies> {
  return {
    nodeVersion: "22.13.0",
    environment: {},
    resolveCommand: (command) => `/bin/${command}`,
    pathKind: () => "directory",
    isWritable: () => true,
    ...overrides,
  };
}

test("doctor reports the required runtime and local prerequisites without spawning upstreams", () => {
  const { directory, configPath } = fixture({
    version: 2,
    mcpServers: { codegraph: { command: "codegraph", capabilities: ["definitions"] } },
    profiles: { coding: { includeCapabilities: ["definitions"] } },
    gateway: { workspaceRoot: "./workspace", activeProfile: "coding" },
  });
  let commandChecks = 0;
  const report = collectDoctorReport({ configPath, cwd: directory, dependencies: dependencies({
    resolveCommand: (command) => { commandChecks += 1; return `/tools/${command}`; },
  }) });

  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 0);
  assert.equal(report.checked, 1);
  assert.equal(commandChecks, 2);
  assert.match(formatDoctorHuman(report), /✓ Node\.js 22\.13\.0/);
  assert.match(formatDoctorHuman(report), /0 errors, 0 warnings$/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("doctor collects Node, rg, workspace and state-directory failures", () => {
  const { directory, configPath } = fixture({ version: 2, mcpServers: {} });
  const report = collectDoctorReport({ configPath, cwd: directory, dependencies: dependencies({
    nodeVersion: "22.12.9",
    resolveCommand: () => undefined,
    pathKind: (candidate) => candidate.endsWith(".mottainai") ? "missing" : "directory",
    isWritable: () => false,
  }) });

  assert.equal(report.ok, false);
  assert.equal(report.errors, 3);
  assert.equal(report.warnings, 1);
  assert.deepEqual(report.problems.map((problem) => problem.message), [
    "Node.js 22.12.9; requires >= 22.13.0",
    "rg command not executable",
    `.mottainai is not writable: ${path.join(directory, ".mottainai")}`,
    "no upstream is enabled; only local tools will be served",
  ]);
  assert.match(formatDoctorHuman(report), /3 errors, 1 warning$/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("doctor preserves upstream diagnostics in the JSON-compatible report", () => {
  const { directory, configPath } = fixture({
    version: 2,
    mcpServers: {
      local: { command: "missing", cwd: "./absent" },
      oauthRemote: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        auth: { type: "oauth", profile: "test" },
        capabilities: ["text_matches"],
      },
      headerRemote: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        headersFromEnv: { Authorization: "TEST_TOKEN" },
        capabilities: ["text_matches"],
      },
    },
  });
  const report = collectDoctorReport({ configPath, dependencies: dependencies({
    environment: {},
    resolveCommand: (command) => command === "rg" ? "/bin/rg" : undefined,
    pathKind: (candidate) => candidate.endsWith("absent") ? "missing" : "directory",
  }) });

  assert.equal(report.checked, 3);
  assert.deepEqual(report.problems, [
    { severity: "error", upstream: "local", message: "command not executable: missing" },
    { severity: "error", upstream: "local", message: `cwd does not exist: ${path.join(directory, "absent")}` },
    { severity: "warning", upstream: "local", message: "no declared capabilities; routing falls back to unspecified" },
    { severity: "error", upstream: "oauthRemote", message: "oauth provider module missing" },
    { severity: "error", upstream: "headerRemote", message: "header environment missing: Authorization <- TEST_TOKEN" },
  ]);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("doctor rejects a workspaceRoot that is missing or not a directory", () => {
  const { directory, configPath } = fixture({ version: 2, mcpServers: {}, gateway: { workspaceRoot: "./workspace" } });
  for (const kind of ["missing", "other"] as const) {
    const report = collectDoctorReport({ configPath, dependencies: dependencies({
      pathKind: (candidate) => candidate.endsWith("workspace") ? kind : "directory",
    }) });
    assert.equal(report.problems[0]?.message, kind === "missing"
      ? `workspaceRoot does not exist: ${path.join(directory, "workspace")}`
      : `workspaceRoot is not a directory: ${path.join(directory, "workspace")}`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("doctor throws for an invalid active profile through config validation", () => {
  const { directory, configPath } = fixture({
    version: 2,
    mcpServers: {},
    profiles: { coding: {} },
    gateway: { activeProfile: "missing" },
  });
  assert.throws(() => collectDoctorReport({ configPath, dependencies: dependencies() }), /unknown gateway activeProfile: missing/);
  fs.rmSync(directory, { recursive: true, force: true });
});
