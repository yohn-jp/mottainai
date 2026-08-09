import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { collectDoctorReport, formatDoctorHuman } from "./commands/doctor.js";
import { resolveGatewayConfig } from "./config.js";
import { callLocalTool } from "./local-tools.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import {
  createRuntimeDiagnostic,
  enrichRuntimeDiagnostic,
  projectRuntimeUpstreams,
  projectUpstreamStatus,
  RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
} from "./runtime-diagnostic.js";
import type { RuntimeBuildMetadata } from "./runtime-diagnostic.js";

const BUILD_METADATA: RuntimeBuildMetadata = {
  schema_version: RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
  package_name: packageMetadata.name,
  package_version: packageMetadata.version,
  build_id: `${packageMetadata.name}@${packageMetadata.version}+git.0123456789abcdef0123456789abcdef01234567`,
  git_sha: "0123456789abcdef0123456789abcdef01234567",
  source_state: "clean",
  artifact: "npm",
};

test("runtime diagnostic is deterministic, versioned, and normalizes home paths", () => {
  const options = {
    cwd: "/home/user/project/consumer",
    homeDirectory: "/home/user",
    environment: {},
    entryPoint: "/home/user/project/consumer/node_modules/mottainai/dist/index.js",
    configPath: "/home/user/project/consumer/config/mottainai.json",
    startupTimestamp: "2026-08-09T00:00:00.000Z",
    buildMetadata: BUILD_METADATA,
    gitSha: null,
  } as const;
  const first = createRuntimeDiagnostic(options);
  const second = createRuntimeDiagnostic(options);

  assert.deepEqual(first, second);
  assert.equal(first.schema_version, 1);
  assert.equal(first.distribution_kind, "packed/npm");
  assert.equal(first.entry_point, "~/project/consumer/node_modules/mottainai/dist/index.js");
  assert.equal(first.startup_cwd, "~/project/consumer");
  assert.equal(first.config_path, "~/project/consumer/config/mottainai.json");
  assert.equal(first.provenance.config_path, "cli");
  assert.equal(first.provenance.build_id, "build");
  assert.doesNotMatch(JSON.stringify(first), /\/home\/user/);
});

test("source, environment/default resolution, and unknown repackaged entries remain distinguishable without git", () => {
  const source = createRuntimeDiagnostic({
    cwd: "/tmp/source-project",
    environment: {},
    entryPoint: "/tmp/source-project/src/index.ts",
    buildMetadata: null,
    gitSha: null,
    startupTimestamp: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(source.distribution_kind, "development/source");
  assert.equal(source.git_sha, undefined);
  assert.match(source.build_id, /\+no-git$/u);

  const fromEnvironment = createRuntimeDiagnostic({
    cwd: "/tmp/consumer",
    environment: { MOTTAINAI_CONFIG: "./env/config.json" },
    entryPoint: "/tmp/source-project/src/index.ts",
    buildMetadata: null,
    gitSha: null,
  });
  assert.equal(fromEnvironment.provenance.config_path, "environment");
  assert.equal(fromEnvironment.config_path, "/tmp/consumer/env/config.json");

  const fromDefault = createRuntimeDiagnostic({
    cwd: "/tmp/consumer",
    environment: {},
    entryPoint: "/tmp/source-project/src/index.ts",
    buildMetadata: null,
    gitSha: null,
  });
  assert.equal(fromDefault.provenance.config_path, "default");
  assert.equal(fromDefault.config_path, "/tmp/consumer/mottainai.config.json");

  const unknown = createRuntimeDiagnostic({
    cwd: "/tmp/repackaged",
    environment: {},
    entryPoint: "/tmp/repackaged/alternate-entry.js",
    buildMetadata: null,
    gitSha: null,
  });
  assert.equal(unknown.distribution_kind, "unknown/repackaged");
});

test("upstream projection is allowlist-first and sanitizes credential-bearing URLs and token text", () => {
  const status = projectUpstreamStatus({
    name: "remote",
    transport: "streamableHttp",
    state: "unhealthy",
    enabled: true,
    priority: 9,
    capabilities: ["private.capability"],
    toolCount: 2,
    failureCount: 3,
    lastError:
      "fetch https://alice:password@example.test/mcp?token=SECRET_TOKEN raw=SECRET_TOKEN; Bearer eyJabc.def.ghi",
    lastErrorAt: "2026-08-09T00:00:00.000Z",
  });
  const serialized = JSON.stringify(status);

  assert.deepEqual(Object.keys(status), [
    "name",
    "transport",
    "enabled",
    "state",
    "health",
    "tool_count",
    "failure_count",
    "failure",
  ]);
  assert.equal(status.health, "unhealthy");
  assert.equal(status.failure?.category, "auth");
  assert.doesNotMatch(serialized, /SECRET_TOKEN/u);
  assert.doesNotMatch(serialized, /alice:password/u);
  assert.doesNotMatch(serialized, /Authorization|Bearer eyJ/u);
  assert.ok((status.failure?.summary.length ?? 0) <= 240);
});

test("doctor missing-config identity and runtime-status identity share the canonical fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-diagnostic-"));
  try {
    const configPath = path.join(root, "missing.json");
    const runtime = createRuntimeDiagnostic({
      cwd: root,
      environment: {},
      entryPoint: "/tmp/source-project/src/index.ts",
      configPath,
      buildMetadata: null,
      gitSha: null,
      startupTimestamp: "2026-08-09T00:00:00.000Z",
    });
    const report = collectDoctorReport({
      cwd: root,
      configPath,
      dependencies: { environment: {}, nodeVersion: "22.13.0" },
      runtime: {
        entryPoint: "/tmp/source-project/src/index.ts",
        buildMetadata: null,
        gitSha: null,
        startupTimestamp: "2026-08-09T00:00:00.000Z",
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.identity.config_path, runtime.config_path);
    assert.equal(report.identity.distribution_kind, "development/source");
    assert.match(formatDoctorHuman(report), /Runtime identity/u);
    assert.match(formatDoctorHuman(report), /config_path:/u);

    const gateway = resolveGatewayConfig({ workspaceRoot: root });
    const result = await callLocalTool(
      "mottainai_runtime_status",
      {},
      gateway,
      new InMemoryArtifactStore(),
      {
        status: () => [
          {
            name: "remote",
            transport: "streamableHttp",
            state: "ready",
            enabled: true,
            priority: 0,
            capabilities: [],
            toolCount: 1,
            failureCount: 0,
          },
        ],
      },
      undefined,
      undefined,
      undefined,
      runtime,
    );
    const structured = result.structuredContent as Record<string, unknown>;
    const identity = structured.identity as Record<string, unknown>;
    assert.equal(identity.schema_version, report.identity.schema_version);
    assert.equal(identity.package_name, report.identity.package_name);
    assert.equal(identity.package_version, report.identity.package_version);
    assert.equal(identity.build_id, report.identity.build_id);
    assert.equal(identity.entry_point, report.identity.entry_point);
    assert.deepEqual((structured.facts as Array<Record<string, unknown>>)[0], {
      name: "remote",
      transport: "streamableHttp",
      enabled: true,
      state: "ready",
      health: "healthy",
      tool_count: 1,
      failure_count: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured upstream projection is sorted and contains no config secrets", () => {
  const diagnostic = createRuntimeDiagnostic({
    cwd: "/tmp/project",
    environment: {},
    entryPoint: "/tmp/project/src/index.ts",
    buildMetadata: null,
    gitSha: null,
  });
  const root = "/tmp/project";
  const enriched = enrichRuntimeDiagnostic(diagnostic, {
    configPath: "/tmp/project/mottainai.config.json",
    config: {
      version: 2,
      mcpServers: {
        zeta: {
          transport: "streamableHttp",
          url: "https://user:secret@example.test/mcp",
          headersFromEnv: { Authorization: "TOKEN_ENV" },
        },
        alpha: { command: "node", args: ["--token", "SECRET_TOKEN"] },
      },
      gateway: { workspaceRoot: root, activeProfile: "default" },
    },
    gatewayConfig: resolveGatewayConfig({ workspaceRoot: root, activeProfile: "default" }),
  });
  assert.deepEqual(
    enriched.upstreams.map((entry) => entry.name),
    ["alpha", "zeta"],
  );
  assert.doesNotMatch(JSON.stringify(enriched), /secret|SECRET_TOKEN|TOKEN_ENV|https:\/\//iu);
  assert.equal(enriched.provenance.workspace_root, "config");
  assert.equal(enriched.provenance.active_profile, "config");
});

test("runtime upstream projection preserves only bounded safe health evidence", () => {
  const projected = projectRuntimeUpstreams([
    { name: "zeta", state: "disabled", enabled: false, priority: 0, capabilities: [], failureCount: 0 },
    { name: "alpha", state: "starting", enabled: true, priority: 0, capabilities: [], failureCount: 0 },
  ]);
  assert.deepEqual(
    projected.map((entry) => ({ name: entry.name, health: entry.health, transport: entry.transport })),
    [
      { name: "alpha", health: "pending", transport: "stdio" },
      { name: "zeta", health: "disabled", transport: "stdio" },
    ],
  );
});
