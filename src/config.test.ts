import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigSnapshot, loadGatewayConfig, loadMottainaiConfig, loadRawConfig, resolveConfigPath, resolveGatewayConfig, saveRawConfig } from "./config.js";

function writeConfig(content: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-config-"));
  const configPath = path.join(directory, "mottainai.config.json");
  fs.writeFileSync(configPath, JSON.stringify(content));
  return configPath;
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
});

test("resolveGatewayConfig defaults workflowTasks to false (mottainai_task_start/status stay unpublished)", () => {
  assert.equal(resolveGatewayConfig(undefined).workflowTasks, false);
  assert.equal(resolveGatewayConfig({ workflowTasks: true }).workflowTasks, true);
  assert.equal(resolveGatewayConfig({ workflowTasks: false }).workflowTasks, false);
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
