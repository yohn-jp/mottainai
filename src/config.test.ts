import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigSnapshot, loadGatewayConfig, loadMottainaiConfig, loadRawConfig, resolveConfigPath, resolveGatewayConfig, saveRawConfig } from "./config.js";
import { FaultInjector } from "./test-support/fault-injection.js";

function writeConfig(content: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-config-"));
  const configPath = path.join(directory, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify(content));
  return configPath;
}

function temporaryArtifacts(configPath: string): string[] {
  return fs.readdirSync(path.dirname(configPath)).filter((entry) => entry.startsWith(".mottainai-tmp-"));
}

test("loadMottainaiConfig normalizes v1 upstream defaults", () => {
  const config = loadMottainaiConfig(writeConfig({
    mcpServers: { legacy: { command: "node", args: ["server.js"] } },
  }));

  assert.equal(config.version, 1);
  assert.deepEqual(config.mcpServers.legacy, {
    command: "node",
    args: ["server.js"],
    env: undefined,
    cwd: undefined,
    enabled: true,
    profile: undefined,
    priority: 0,
    capabilities: [],
    preferredFor: [],
    fallbackFor: [],
    metadata: undefined,
  });
});

test("loadMottainaiConfig accepts v2-only fields (profiles) without declaring version: 2", () => {
  const config = loadMottainaiConfig(writeConfig({
    mcpServers: {
      codegraph: { command: "codegraph", profile: "readonly" },
    },
    profiles: {
      readonly: { includeCapabilities: ["code.search"], denyRisk: ["destructive"] },
    },
  }));

  assert.equal(config.version, 1);
  assert.deepEqual(config.profiles?.readonly, {
    includeCapabilities: ["code.search"],
    denyRisk: ["destructive"],
    rawToolAccess: undefined,
  });
});

test("loadMottainaiConfig accepts Streamable HTTP upstreams without storing header values", () => {
  const config = loadMottainaiConfig(writeConfig({
    version: 2,
    mcpServers: {
      github: {
        transport: "streamableHttp",
        url: "https://mcp.example.test/mcp",
        headersFromEnv: { Authorization: "MCP_GITHUB_AUTH" },
      },
    },
  }));

  assert.deepEqual(config.mcpServers.github, {
    transport: "streamableHttp",
    url: "https://mcp.example.test/mcp",
    headersFromEnv: { Authorization: "MCP_GITHUB_AUTH" },
    enabled: true,
    profile: undefined,
    priority: 0,
    capabilities: [],
    preferredFor: [],
    fallbackFor: [],
    metadata: undefined,
  });
});

test("loadMottainaiConfig rejects invalid Streamable HTTP upstreams", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { remote: { transport: "streamableHttp", url: "file:///tmp/mcp" } },
    })),
    /invalid upstream url: remote/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { remote: { transport: "unknown", url: "https:\/\/mcp.example.test\/mcp" } },
    })),
    /invalid upstream transport: remote/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { remote: { transport: "streamableHttp" } },
    })),
    /invalid upstream url: remote/,
  );
});

test("loadMottainaiConfig accepts OAuth broker profiles and rejects token headers beside them", () => {
  const config = loadMottainaiConfig(writeConfig({
    version: 2,
    mcpServers: {
      github: {
        transport: "streamableHttp",
        url: "https://api.githubcopilot.com/mcp/",
        auth: { type: "oauth", profile: "github" },
      },
    },
    gateway: { oauthProviderModule: "./oauth-provider.mjs" },
  }));

  assert.deepEqual(config.mcpServers.github.auth, { type: "oauth", profile: "github" });
  assert.equal(config.gateway?.oauthProviderModule, "./oauth-provider.mjs");
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: {
        github: {
          transport: "streamableHttp",
          url: "https://api.githubcopilot.com/mcp/",
          auth: { type: "oauth", profile: "github" },
          headersFromEnv: { Authorization: "GITHUB_TOKEN" },
        },
      },
    })),
    /invalid upstream auth headers: github/,
  );
});

test("loadMottainaiConfig keeps disabled v2 upstreams and profile metadata", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: {
      enabled: { command: "node", profile: "development", priority: 10, capabilities: ["code.search"] },
      disabled: { command: "node", enabled: false },
    },
    profiles: { development: { includeCapabilities: ["code.search"], denyRisk: ["destructive"] } },
  });

  assert.equal(loadMottainaiConfig(configPath).mcpServers.enabled.enabled, true);
  assert.equal(loadMottainaiConfig(configPath).mcpServers.disabled.enabled, false);
  assert.deepEqual(loadMottainaiConfig(configPath).profiles, {
    development: { includeCapabilities: ["code.search"], denyRisk: ["destructive"], rawToolAccess: undefined },
  });
});

test("loadMottainaiConfig accepts and rejects profile rawToolAccess (#26)", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    profiles: { locked: { rawToolAccess: "restricted" } },
  });
  assert.equal(loadMottainaiConfig(configPath).profiles?.locked.rawToolAccess, "restricted");

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      profiles: { locked: { rawToolAccess: "nonsense" } },
    })),
    /invalid profile rawToolAccess: locked/,
  );
});

test("loadMottainaiConfig rejects denyRisk values outside the shared risk enum", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      // "destrucive" は typo。文字列配列であることだけを見るチェックだと通ってしまい、
      // 本来 deny すべき tool を静かに許可してしまう。
      profiles: { locked: { denyRisk: ["destrucive"] } },
    })),
    /invalid profile denyRisk value: destrucive for locked/,
  );

  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    profiles: { locked: { denyRisk: ["destructive", "mutating"] } },
  });
  assert.deepEqual(loadMottainaiConfig(configPath).profiles?.locked.denyRisk, ["destructive", "mutating"]);
});

test("loadMottainaiConfig rejects worktree.allowedBranchPrefixes containing an empty prefix", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      // "" は任意のブランチ名にマッチしてしまい、allow list を無効化する。
      gateway: { worktree: { allowedBranchPrefixes: ["task/", ""] } },
    })),
    /invalid gateway worktree\.allowedBranchPrefixes must be a non-empty string array/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { worktree: { allowedBranchPrefixes: [] } },
    })),
    /invalid gateway worktree\.allowedBranchPrefixes must be a non-empty string array/,
  );

  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: { worktree: { allowedBranchPrefixes: ["task/"] } },
  });
  assert.deepEqual(loadMottainaiConfig(configPath).gateway?.worktree?.allowedBranchPrefixes, ["task/"]);
});

test("loadMottainaiConfig rejects invalid v2 metadata", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { invalid: { command: "node", priority: -1, capabilities: ["code.search", 1] } },
    })),
    /invalid upstream priority: invalid/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { invalid: { command: "node", profile: "missing" } },
      profiles: {},
    })),
    /unknown upstream profile: missing for invalid/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      mcpServers: { valid: { command: "node" } },
      gateway: { maxTimeoutMs: 0 },
    })),
    /invalid gateway maxTimeoutMs/,
  );
});

test("loadMottainaiConfig accepts activeProfile only when the profile exists", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    profiles: { development: { includeCapabilities: ["code.search"] } },
    gateway: { activeProfile: "development" },
  });
  assert.equal(loadMottainaiConfig(configPath).gateway?.activeProfile, "development");

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      profiles: { development: {} },
      gateway: { activeProfile: "missing" },
    })),
    /unknown gateway activeProfile: missing/,
  );
});

test("saveRawConfig writes only what the caller set and validates before writing", () => {
  const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
  const { filePath, raw } = loadRawConfig(configPath);
  assert.equal(filePath, configPath);

  (raw.mcpServers as Record<string, unknown>).two = { command: "node", enabled: false };
  saveRawConfig(filePath, raw);
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(written.mcpServers.one, { command: "node" });
  assert.deepEqual(written.mcpServers.two, { command: "node", enabled: false });

  const before = fs.readFileSync(configPath, "utf8");
  (raw.mcpServers as Record<string, unknown>).broken = { command: 1 };
  assert.throws(() => saveRawConfig(filePath, raw), /invalid upstream config: broken/);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("saveRawConfig leaves no temporary artifact behind on success", () => {
  const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
  const { filePath, raw } = loadRawConfig(configPath);
  (raw.mcpServers as Record<string, unknown>).two = { command: "node" };
  saveRawConfig(filePath, raw);
  assert.deepEqual(temporaryArtifacts(filePath), []);
});

test("saveRawConfig preserves the destination's existing file mode across atomic replacement", () => {
  for (const mode of [0o600, 0o640]) {
    const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
    fs.chmodSync(configPath, mode);
    const { filePath, raw } = loadRawConfig(configPath);
    (raw.mcpServers as Record<string, unknown>).two = { command: "node" };
    saveRawConfig(filePath, raw);
    assert.equal(fs.statSync(filePath).mode & 0o777, mode, mode.toString(8));
  }
});

test("saveRawConfig rejects an invalid candidate before touching the filesystem at all", () => {
  const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
  const { filePath, raw } = loadRawConfig(configPath);
  (raw.mcpServers as Record<string, unknown>).broken = { command: 1 };
  const faults = new FaultInjector();
  assert.throws(() => saveRawConfig(filePath, raw, faults), /invalid upstream config: broken/);
  assert.deepEqual([...faults.calls.keys()], []);
});

test("saveRawConfig preserves the previous config byte-for-byte when write, sync, close, or rename fails", () => {
  const operations = ["config.temp.write", "config.temp.sync", "config.temp.close", "config.rename"];
  for (const operation of operations) {
    const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
    const { filePath, raw } = loadRawConfig(configPath);
    const original = fs.readFileSync(filePath, "utf8");
    (raw.mcpServers as Record<string, unknown>).two = { command: "node" };
    const faults = new FaultInjector({ [operation]: { error: new Error(`primary ${operation}`) } });
    assert.throws(() => saveRawConfig(filePath, raw, faults), new RegExp(`primary ${operation}`), operation);
    assert.equal(fs.readFileSync(filePath, "utf8"), original, operation);
    assert.deepEqual(temporaryArtifacts(filePath), [], operation);
  }
});

test("saveRawConfig cleanup failure preserves the primary error and attaches bounded secondary evidence", () => {
  const configPath = writeConfig({ mcpServers: { one: { command: "node" } } });
  const { filePath, raw } = loadRawConfig(configPath);
  const original = fs.readFileSync(filePath, "utf8");
  (raw.mcpServers as Record<string, unknown>).two = { command: "node" };
  const faults = new FaultInjector({
    "config.rename": { error: new Error("primary rename failure") },
    "config.temp.cleanup": { error: new Error("cleanup failure") },
    "config.temp.cleanup.retry": { error: new Error("cleanup retry failure") },
  });
  assert.throws(
    () => saveRawConfig(filePath, raw, faults),
    (error: unknown) => {
      assert.equal((error as Error).message, "primary rename failure");
      assert.deepEqual((error as { secondaryDiagnostics?: unknown[] }).secondaryDiagnostics, [
        { operation: "config.temp.cleanup", message: "cleanup retry failure" },
      ]);
      return true;
    },
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("loadMottainaiConfig accepts upstream and gateway tool metadata overrides", () => {
  const configPath = writeConfig({
      version: 2,
      mcpServers: {
      slow: { command: "node", metadata: { contract: "search.v1", cost: "low", latency: "fast", workspace: true, network: false } },
    },
    gateway: {
      toolMetadata: {
        slow__heavy_call: { risk: "mutating", outputSize: "small" },
      },
    },
  });
  const config = loadMottainaiConfig(configPath);
  assert.deepEqual(config.mcpServers.slow.metadata, {
    contract: "search.v1", risk: undefined, cost: "low", latency: "fast", outputSize: undefined, workspace: true, network: false,
  });
  assert.deepEqual(config.gateway?.toolMetadata, {
    slow__heavy_call: { contract: undefined, risk: "mutating", cost: undefined, latency: undefined, outputSize: "small", workspace: undefined, network: undefined },
  });
});

test("loadMottainaiConfig rejects invalid tool metadata values", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node", metadata: { cost: "extreme" } } },
    })),
    /invalid tool metadata: one\.metadata\.cost/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { toolMetadata: { one__call: { network: "yes" } } },
    })),
    /invalid tool metadata: invalid gateway toolMetadata\.one__call\.network/,
  );
});

test("loadMottainaiConfig accepts tokenBudgets in tool/capability/profile/default form and normalizes numbers", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    profiles: { readonly: {} },
    gateway: {
      activeProfile: "readonly",
      tokenBudgets: {
        tools: { "one__call": 500 },
        capabilities: { definitions: { success: 400, failure: 900 } },
        profiles: { readonly: 600 },
        default: 800,
      },
    },
  });
  const gateway = loadGatewayConfig(configPath);
  assert.deepEqual(gateway.tokenBudgets, {
    tools: { "one__call": { success: 500, failure: 500 } },
    capabilities: { definitions: { success: 400, failure: 900 } },
    profiles: { readonly: { success: 600, failure: 600 } },
    default: { success: 800, failure: 800 },
  });
  assert.equal(gateway.activeProfile, "readonly");
});

test("resolveGatewayConfig defaults tokenBudgets to empty maps (opt-in: no config, no limit)", () => {
  const resolved = resolveGatewayConfig(undefined);
  assert.deepEqual(resolved.tokenBudgets, { tools: {}, capabilities: {}, profiles: {}, default: undefined });
  assert.deepEqual(resolved.responseBudget, { softTokens: 1_500, hardTokens: 3_000, hardBytes: 12_000 });
  assert.equal(resolved.activeProfile, undefined);
});

test("gateway.responseBudget configures the final projection boundary and rejects unsafe values", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: { responseBudget: { softTokens: 500, hardTokens: 900, hardBytes: 3_600 } },
  });
  assert.deepEqual(loadGatewayConfig(configPath).responseBudget, { softTokens: 500, hardTokens: 900, hardBytes: 3_600 });
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { responseBudget: { hardBytes: 1_023 } } })),
    /invalid response budget hardBytes/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { responseBudget: { softTokens: 900, hardTokens: 500 } } })),
    /softTokens must not exceed hardTokens/,
  );
});

test("resolveGatewayConfig defaults burstBudget to mode off with dogfood-scale limits", () => {
  const resolved = resolveGatewayConfig(undefined);
  assert.deepEqual(resolved.burstBudget, {
    mode: "off",
    maxConcurrentProjectedTokens: 6_000,
    rollingWindowMs: 1_500,
    rollingProjectedTokens: 8_000,
    rollingProjectedBytes: 32_000,
  });
});

test("gateway.burstBudget configures the connection-level burst boundary and rejects unsafe values", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: {
      burstBudget: {
        mode: "enforce", maxConcurrentProjectedTokens: 2_000, rollingWindowMs: 1_000,
        rollingProjectedTokens: 4_000, rollingProjectedBytes: 16_000,
      },
    },
  });
  assert.deepEqual(loadGatewayConfig(configPath).burstBudget, {
    mode: "enforce", maxConcurrentProjectedTokens: 2_000, rollingWindowMs: 1_000,
    rollingProjectedTokens: 4_000, rollingProjectedBytes: 16_000,
  });
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { burstBudget: { mode: "aggressive" } } })),
    /invalid gateway burstBudget.mode/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { burstBudget: { rollingWindowMs: 0 } } })),
    /invalid gateway burstBudget.rollingWindowMs/,
  );
  // rollingWindowMs: 10 は positiveIntegerConfig (>0 の整数) は通すが、
  // resolveBurstBudgetPolicy の MIN_BURST_BUDGET (50ms 以上) 未満で弾かれる。
  // この場合はエラーメッセージに "gateway burstBudget" prefix が付かない
  // （resolveBurstBudgetPolicy 内部の positiveInteger が投げるため）。
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { burstBudget: { rollingWindowMs: 10 } } })),
    /invalid burst budget rollingWindowMs/,
  );
});

test("resolveGatewayConfig defaults workflowTasks to false (mottainai_task_start/status stay unpublished)", () => {
  assert.equal(resolveGatewayConfig(undefined).workflowTasks, false);
  assert.equal(resolveGatewayConfig({ workflowTasks: true }).workflowTasks, true);
  assert.equal(resolveGatewayConfig({ workflowTasks: false }).workflowTasks, false);
});

test("resolveGatewayConfig resolves the aggregate artifact byte budget", () => {
  const defaults = resolveGatewayConfig(undefined);
  assert.equal(Number.isFinite(defaults.resultMaxBytes), true);
  assert.equal(resolveGatewayConfig({ resultMaxBytes: 8_192 }).resultMaxBytes, 8_192);

  const configPath = writeConfig({
    version: 2,
    mcpServers: {},
    gateway: { resultMaxBytes: 16_384 },
  });
  assert.equal(loadGatewayConfig(configPath).resultMaxBytes, 16_384);
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { resultMaxBytes: 0 } })),
    /invalid gateway resultMaxBytes/,
  );
});

test("resolveGatewayConfig defaults await policy and clamps maxPollIntervalMs to at least minPollIntervalMs", () => {
  const defaults = resolveGatewayConfig(undefined).await;
  assert.equal(defaults.minPollIntervalMs, 250);
  assert.equal(defaults.maxPollIntervalMs, 15_000);
  assert.equal(defaults.maxAwaitMs, 120_000);
  assert.equal(defaults.jitterRatio, 0.2);

  const clamped = resolveGatewayConfig({ await: { minPollIntervalMs: 5_000, maxPollIntervalMs: 1_000 } }).await;
  assert.equal(clamped.minPollIntervalMs, 5_000);
  assert.equal(clamped.maxPollIntervalMs, 5_000);
});

test("resolveGatewayConfig resolves finite managed-process bounds", () => {
  assert.deepEqual(resolveGatewayConfig(undefined).managedProcesses, {
    maxActiveProcesses: 8,
    maxRetainedHandles: 32,
    maxLifetimeMs: 300_000,
  });
  assert.deepEqual(resolveGatewayConfig({
    managedProcesses: { maxActiveProcesses: 2, maxRetainedHandles: 0, maxLifetimeMs: 10_000 },
  }).managedProcesses, {
    maxActiveProcesses: 2,
    maxRetainedHandles: 0,
    maxLifetimeMs: 10_000,
  });
});

test("managed-process policy rejects non-finite, unsafe, and out-of-range bounds", () => {
  assert.throws(
    () => resolveGatewayConfig({ managedProcesses: { maxActiveProcesses: 0 } }),
    /invalid managed process policy maxActiveProcesses/,
  );
  assert.throws(
    () => resolveGatewayConfig({ managedProcesses: { maxRetainedHandles: -1 } }),
    /invalid managed process policy maxRetainedHandles/,
  );
  assert.throws(
    () => resolveGatewayConfig({ managedProcesses: { maxLifetimeMs: Number.POSITIVE_INFINITY } }),
    /invalid managed process policy maxLifetimeMs/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: {},
      gateway: { managedProcesses: { maxLifetimeMs: 2_147_483_648 } },
    })),
    /invalid managed process policy maxLifetimeMs/,
  );
});

test("resolveGatewayConfig falls back to the default jitterRatio when out of [0,1]", () => {
  assert.equal(resolveGatewayConfig({ await: { jitterRatio: -0.1 } }).await.jitterRatio, 0.2);
  assert.equal(resolveGatewayConfig({ await: { jitterRatio: 1.5 } }).await.jitterRatio, 0.2);
  assert.equal(resolveGatewayConfig({ await: { jitterRatio: 0.5 } }).await.jitterRatio, 0.5);
});

test("loadMottainaiConfig rejects an invalid gateway.await.jitterRatio", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { await: { jitterRatio: 2 } },
    })),
    /invalid gateway await\.jitterRatio/,
  );
});

test("loadMottainaiConfig round-trips gateway.await bounds", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: { await: { minPollIntervalMs: 500, maxPollIntervalMs: 8_000, maxAwaitMs: 60_000, jitterRatio: 0.1 } },
  });
  const resolved = loadGatewayConfig(configPath);
  assert.equal(resolved.await.minPollIntervalMs, 500);
  assert.equal(resolved.await.maxPollIntervalMs, 8_000);
  assert.equal(resolved.await.maxAwaitMs, 60_000);
  assert.equal(resolved.await.jitterRatio, 0.1);
});

test("loadMottainaiConfig rejects a non-boolean gateway.workflowTasks", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { workflowTasks: "yes" },
    })),
    /invalid gateway workflowTasks/,
  );
});

test("loadMottainaiConfig round-trips gateway.workflowTasks=true", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: { workflowTasks: true },
  });
  assert.equal(loadMottainaiConfig(configPath).gateway?.workflowTasks, true);
});

test("config snapshot resolves MOTTAINAI_CONFIG once from its startup cwd (#59)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-config-snapshot-"));
  const configDirectory = path.join(directory, "config");
  const startupDirectory = path.join(directory, "startup");
  fs.mkdirSync(configDirectory);
  fs.mkdirSync(startupDirectory);
  const configPath = path.join(configDirectory, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    mcpServers: { fixture: { command: "node", cwd: "./upstream" } },
    gateway: { workspaceRoot: "./workspace" },
  }));
  const relativePath = path.relative(startupDirectory, configPath);
  const previous = process.env.MOTTAINAI_CONFIG;
  try {
    process.env.MOTTAINAI_CONFIG = relativePath;
    const relative = loadConfigSnapshot(undefined, startupDirectory);
    const absolute = loadConfigSnapshot(configPath, directory);
    assert.equal(resolveConfigPath(undefined, startupDirectory), configPath);
    assert.equal(relative.configPath, configPath);
    assert.deepEqual(relative.gatewayConfig, absolute.gatewayConfig);
    assert.deepEqual(relative.config.mcpServers, absolute.config.mcpServers);
    assert.equal(relative.gatewayConfig.workspaceRoot, path.join(configDirectory, "workspace"));
    assert.equal(relative.config.mcpServers.fixture.cwd, path.join(configDirectory, "upstream"));
  } finally {
    if (previous === undefined) delete process.env.MOTTAINAI_CONFIG;
    else process.env.MOTTAINAI_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config snapshot defaults omitted workspaceRoot to startup cwd", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-config-installed-"));
  const installedPackageDirectory = path.join(directory, "installed-package");
  const projectDirectory = path.join(directory, "project");
  fs.mkdirSync(installedPackageDirectory);
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(installedPackageDirectory, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    mcpServers: { fixture: { command: "node" } },
  }));
  try {
    const snapshot = loadConfigSnapshot(configPath, projectDirectory);
    assert.equal(snapshot.gatewayConfig.workspaceRoot, projectDirectory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("loadMottainaiConfig rejects invalid tokenBudgets values", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { tokenBudgets: { tools: { "one__call": 0 } } },
    })),
    /invalid gateway tokenBudgets\.tools\.one__call/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { tokenBudgets: { default: { success: -1 } } },
    })),
    /invalid gateway tokenBudgets\.default\.success/,
  );
});

test("gateway.readGovernor resolves the four policy modes and bounded defaults", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: { one: { command: "node" } },
    gateway: {
      readGovernor: {
        mode: "enforce",
        maxRawLines: 80,
        maxRawBytes: 4_000,
        allowWholeFileBelowLines: 20,
        preferAuto: true,
        allowWholeFile: false,
      },
    },
  });
  assert.deepEqual(loadGatewayConfig(configPath).readGovernor, {
    mode: "enforce",
    maxRawLines: 80,
    maxRawBytes: 4_000,
    allowWholeFileBelowLines: 20,
    preferAuto: true,
    allowWholeFile: false,
  });
  assert.equal(resolveGatewayConfig(undefined).readGovernor?.mode, "observe");
});

test("loadMottainaiConfig rejects unknown keys in closed configuration objects (#445)", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      mcpServers: { one: { command: "node" } },
      unknownRootKey: true,
    })),
    /invalid mottainai config: unknown property "unknownRootKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { unknownGatewayKey: true },
    })),
    /invalid gateway config: unknown property "unknownGatewayKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      profiles: { locked: { unknownProfileKey: true } },
    })),
    /invalid profile config: locked: unknown property "unknownProfileKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node", unknownUpstreamKey: true } },
    })),
    /invalid upstream config: one: unknown property "unknownUpstreamKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: {
        remote: { transport: "streamableHttp", url: "https://mcp.example.test/mcp", unknownHttpKey: true },
      },
    })),
    /invalid upstream config: remote: unknown property "unknownHttpKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { worktree: { allowedBranchPrefixes: ["task/"], unknownWorktreeKey: true } },
    })),
    /invalid gateway worktree: unknown property "unknownWorktreeKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { await: { maxAwaitMs: 1_000, unknownAwaitKey: true } },
    })),
    /invalid gateway await: unknown property "unknownAwaitKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { managedProcesses: { maxActiveProcesses: 4, unknownManagedProcessKey: true } },
    })),
    /invalid gateway managedProcesses: unknown property "unknownManagedProcessKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { responseBudget: { softTokens: 500, hardTokens: 900, hardBytes: 3_600, unknownBudgetKey: true } },
    })),
    /invalid gateway responseBudget: unknown property "unknownBudgetKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { tokenBudgets: { default: { success: 100, failure: 100, unknownEntryKey: true } } },
    })),
    /invalid gateway tokenBudgets\.default: unknown property "unknownEntryKey"/,
  );

  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { ghInari: { command: "gh-inari", unknownGhInariKey: true } },
    })),
    /invalid gateway ghInari: unknown property "unknownGhInariKey"/,
  );
});

test("loadMottainaiConfig rejects a misspelled safety setting instead of falling back to its default (#445)", () => {
  // "rawToolAcess" (typo) must fail loading, not silently keep the permissive `open` default.
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      profiles: { locked: { rawToolAcess: "restricted" } },
    })),
    /invalid profile config: locked: unknown property "rawToolAcess"/,
  );

  // "workflowTasks" typo must fail loading, not silently keep the disabled default.
  assert.throws(
    () => loadMottainaiConfig(writeConfig({
      version: 2,
      mcpServers: { one: { command: "node" } },
      gateway: { workflowTaks: true },
    })),
    /invalid gateway config: unknown property "workflowTaks"/,
  );
});

test("loadMottainaiConfig keeps intentionally extensible config maps open to arbitrary keys (#445)", () => {
  const configPath = writeConfig({
    version: 2,
    mcpServers: {
      one: {
        transport: "streamableHttp",
        url: "https://mcp.example.test/mcp",
        headersFromEnv: { "X-Custom-Header": "SOME_ENV_VAR" },
      },
    },
    gateway: {
      capabilityMap: { "one__call": ["custom.capability"] },
      tokenBudgets: { tools: { "one__call": 500 }, capabilities: { "custom.capability": 400 } },
    },
  });
  const config = loadMottainaiConfig(configPath);
  assert.deepEqual(config.mcpServers.one.headersFromEnv, { "X-Custom-Header": "SOME_ENV_VAR" });
  assert.deepEqual(config.gateway?.capabilityMap, { "one__call": ["custom.capability"] });
  assert.deepEqual(loadGatewayConfig(configPath).tokenBudgets.tools, { "one__call": { success: 500, failure: 500 } });
});

test("gateway.readGovernor rejects invalid modes and unsafe limits", () => {
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { readGovernor: { mode: "block" } } })),
    /invalid gateway readGovernor\.mode/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { readGovernor: { maxRawLines: 0 } } })),
    /invalid gateway readGovernor\.maxRawLines/,
  );
  assert.throws(
    () => loadMottainaiConfig(writeConfig({ version: 2, mcpServers: {}, gateway: { readGovernor: { allowWholeFileBelowLines: -1 } } })),
    /invalid gateway readGovernor\.allowWholeFileBelowLines/,
  );
});
