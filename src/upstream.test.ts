import assert from "node:assert/strict";
import test from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { UpstreamHandle } from "./upstream.js";
import { createUpstreamTransport, UpstreamRegistry } from "./upstream.js";

function handle(name: string): UpstreamHandle {
  return { config: { name, command: "node" }, client: { close: async () => {} } as UpstreamHandle["client"], tools: [] };
}

test("transport factory preserves stdio and creates Streamable HTTP transports", async () => {
  assert.ok(await createUpstreamTransport({ name: "stdio", command: "node" }) instanceof StdioClientTransport);
  assert.ok(await createUpstreamTransport({
    name: "remote",
    transport: "streamableHttp",
    url: "https://mcp.example.test/mcp",
  }) instanceof StreamableHTTPClientTransport);

  await assert.rejects(
    () => createUpstreamTransport({
      name: "remote",
      transport: "streamableHttp",
      url: "https://mcp.example.test/mcp",
      headersFromEnv: { Authorization: "MCP_MISSING_AUTH" },
    }),
    /upstream header environment missing: MCP_MISSING_AUTH/,
  );
});

test("oauth remote resolves a broker endpoint without receiving a token", async () => {
  let target: URL | undefined;
  let profile: string | undefined;
  const transport = await createUpstreamTransport({
    name: "github",
    transport: "streamableHttp",
    url: "https://api.githubcopilot.com/mcp/",
    auth: { type: "oauth", profile: "github" },
  }, {
    resolveEndpoint: async (targetUrl, profileName) => {
      target = targetUrl;
      profile = profileName;
      return "http://127.0.0.1:9393/github/mcp";
    },
  });

  assert.ok(transport instanceof StreamableHTTPClientTransport);
  assert.equal(target?.toString(), "https://api.githubcopilot.com/mcp/");
  assert.equal(profile, "github");
  await assert.rejects(
    () => createUpstreamTransport({
      name: "github",
      transport: "streamableHttp",
      url: "https://api.githubcopilot.com/mcp/",
      auth: { type: "oauth", profile: "github" },
    }),
    /oauth credential provider unavailable: github/,
  );
});

test("registry starts only requested enabled upstreams and retries unhealthy upstreams", async () => {
  const started: string[] = [];
  let fail = true;
  const registry = new UpstreamRegistry([
    { name: "disabled", command: "node", enabled: false },
    { name: "ready", command: "node" },
    { name: "retry", command: "node" },
  ], async (config) => {
    started.push(config.name);
    if (config.name === "retry" && fail) { fail = false; throw new Error("unavailable"); }
    return handle(config.name);
  });

  assert.equal(registry.state("disabled"), "disabled");
  assert.equal(registry.state("ready"), "registered");
  await assert.rejects(() => registry.start("disabled"), /upstream disabled/);
  assert.deepEqual(started, []);
  await registry.start("ready");
  assert.equal(registry.state("ready"), "ready");
  await assert.rejects(() => registry.start("retry"), /unavailable/);
  assert.equal(registry.state("retry"), "unhealthy");
  await registry.start("retry");
  assert.equal(registry.state("retry"), "ready");
  await registry.close();
  assert.equal(registry.state("ready"), "stopped");
});

test("status reports per-upstream failures without exposing env or args", async () => {
  const registry = new UpstreamRegistry([
    { name: "disabled", command: "node", enabled: false, capabilities: ["code.search"] },
    { name: "ready", command: "node", priority: 5 },
    { name: "broken", command: "missing", args: ["--token", "sekrit"], env: { API_KEY: "sekrit" } },
  ], async (config) => {
    if (config.name === "broken") throw new Error(`spawn ${config.command} ENOENT`);
    return { ...handle(config.name), tools: [{ name: "one", inputSchema: { type: "object" } }] };
  });

  await registry.start("ready");
  await assert.rejects(() => registry.start("broken"));
  await assert.rejects(() => registry.start("broken"));

  const status = Object.fromEntries(registry.status().map((entry) => [entry.name, entry]));
  assert.equal(status.disabled.enabled, false);
  assert.deepEqual(status.disabled.capabilities, ["code.search"]);
  assert.equal(status.ready.state, "ready");
  assert.equal(status.ready.priority, 5);
  assert.equal(status.ready.toolCount, 1);
  assert.equal(status.ready.failureCount, 0);
  assert.equal(status.broken.state, "unhealthy");
  assert.equal(status.broken.failureCount, 2);
  assert.match(status.broken.lastError ?? "", /spawn missing ENOENT/);
  assert.ok(status.broken.lastErrorAt !== undefined);
  assert.ok(!JSON.stringify(status.broken).includes("sekrit"));
});

test("a failing upstream does not block other upstreams from starting", async () => {
  const registry = new UpstreamRegistry([
    { name: "broken", command: "missing" },
    { name: "healthy", command: "node" },
  ], async (config) => {
    if (config.name === "broken") throw new Error("unavailable");
    return handle(config.name);
  });

  const started = await Promise.allSettled(registry.enabledNames().map((name) => registry.start(name)));
  assert.deepEqual(started.map((result) => result.status), ["rejected", "fulfilled"]);
  assert.equal(registry.readyHandles().length, 1);
  assert.equal(registry.state("healthy"), "ready");
});

test("invalidating an active upstream closes the stale client and reconnects on the next call", async () => {
  let connections = 0;
  let closes = 0;
  const registry = new UpstreamRegistry([{ name: "flaky", command: "node" }], async (config) => {
    connections += 1;
    return {
      config,
      client: { close: async () => { closes += 1; } } as UpstreamHandle["client"],
      tools: [],
    };
  });

  await registry.start("flaky");
  await registry.invalidate("flaky", new Error("connection reset"));

  assert.equal(registry.state("flaky"), "unhealthy");
  assert.equal(closes, 1);
  await registry.start("flaky");
  assert.equal(registry.state("flaky"), "ready");
  assert.equal(connections, 2);
  assert.equal(registry.status()[0].failureCount, 1);
});
