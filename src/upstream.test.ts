import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../package.json" with { type: "json" };
import type { UpstreamHandle } from "./upstream.js";
import {
  connectUpstream,
  createUpstreamTransport,
  fetchWithoutRedirects,
  resolveUpstreamClientInfo,
  UpstreamRegistry,
} from "./upstream.js";

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

test("transport factory rejects configured HTTP userinfo before creating a transport", async () => {
  const url = "https://direct-user:direct-password@example.test/mcp";
  await assert.rejects(
    () => createUpstreamTransport({
      name: "remote",
      transport: "streamableHttp",
      url,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid upstream url: remote; userinfo is not allowed/);
      assert.doesNotMatch(error.message, /direct-user|direct-password|example\.test/iu);
      return true;
    },
  );
});

test("remote fetch disables redirect following and forwards credential headers", async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    requestInit = init;
    return new Response(null, { status: 204 });
  };
  try {
    await fetchWithoutRedirects("https://mcp.example.test/mcp", {
      headers: { Authorization: "secret" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestInit?.redirect, "error");
  assert.equal(new Headers(requestInit?.headers).get("Authorization"), "secret");
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

  process.env.MCP_REMOTE_AUTH = "secret";
  try {
    await assert.rejects(
      () => createUpstreamTransport({
        name: "insecure",
        transport: "streamableHttp",
        url: "http://mcp.example.test/mcp",
        headersFromEnv: { Authorization: "MCP_REMOTE_AUTH" },
      }),
      /credentialed upstream requires https: insecure/,
    );
  } finally {
    delete process.env.MCP_REMOTE_AUTH;
  }
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

test("status stores the base upstream error without stderr diagnostics", async () => {
  const secret = "SECRET_SHOULD_NOT_LEAK_123";
  const error = new Error("upstream connection failed");
  Object.defineProperty(error, "mottainaiUpstreamDiagnostic", {
    value: `provider=broken phase=initialize stderr_tail=${JSON.stringify(secret)} transcript=[]`,
  });
  const registry = new UpstreamRegistry([{ name: "broken", command: "node" }], async () => {
    throw error;
  });

  await assert.rejects(() => registry.start("broken"), error);

  const status = registry.status()[0];
  assert.equal(status.lastError, error.message);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
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

test("connectUpstream closes the client and preserves the original error when listTools fails", async () => {
  let closed = false;
  const listToolsError = new Error("tools/list failed");
  await assert.rejects(
    () => connectUpstream(
      { name: "broken-discovery", command: "node" },
      undefined,
      () => ({
        connect: async () => {},
        listTools: async () => { throw listToolsError; },
        close: async () => { closed = true; },
      }) as unknown as Client,
    ),
    (error: unknown) => error === listToolsError,
  );
  assert.equal(closed, true);
});

test("connectUpstream still propagates the original error even if closing the client also fails", async () => {
  const listToolsError = new Error("tools/list failed");
  await assert.rejects(
    () => connectUpstream(
      { name: "broken-discovery", command: "node" },
      undefined,
      () => ({
        connect: async () => {},
        listTools: async () => { throw listToolsError; },
        close: async () => { throw new Error("close also failed"); },
      }) as unknown as Client,
    ),
    (error: unknown) => error === listToolsError,
  );
});

test("resolveUpstreamClientInfo advertises the running package version, not a hard-coded one", () => {
  assert.deepEqual(resolveUpstreamClientInfo("github"), {
    name: "mottainai/github",
    version: packageMetadata.version,
  });
  assert.notEqual(resolveUpstreamClientInfo("github").version, "0.1.0");
});

function respondingTransport(): Transport & { requests: JSONRPCMessage[] } {
  const transport: Transport & { requests: JSONRPCMessage[] } = {
    requests: [],
    start: async () => {},
    close: async () => {
      transport.onclose?.();
    },
    send: async (message) => {
      transport.requests.push(message);
      if (!("method" in message) || !("id" in message)) return;
      queueMicrotask(() => {
        if (message.method === "initialize") {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: "fake-upstream", version: "0.0.0" },
            },
          });
        } else if (message.method === "tools/list") {
          transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
        }
      });
    },
  };
  return transport;
}

test("connectUpstream's default client advertises the running package version to upstream servers", async () => {
  const transport = respondingTransport();
  const handle = await connectUpstream(
    { name: "github", command: "node" },
    undefined,
    undefined,
    { transportFactory: async () => transport },
  );
  await handle.client.close();

  const initializeRequest = transport.requests.find(
    (message): message is JSONRPCMessage & { method: "initialize"; params: { clientInfo: unknown } } =>
      "method" in message && message.method === "initialize",
  );
  assert.deepEqual(initializeRequest?.params?.clientInfo, resolveUpstreamClientInfo("github"));
  assert.notEqual((initializeRequest?.params?.clientInfo as { version?: string } | undefined)?.version, "0.1.0");
});

test("connectUpstream closes the client and preserves the original error when connect() itself fails", async () => {
  let closed = false;
  let listToolsCalled = false;
  const connectError = new Error("connect failed");
  await assert.rejects(
    () => connectUpstream(
      { name: "broken-connect", command: "node" },
      undefined,
      () => ({
        connect: async () => { throw connectError; },
        listTools: async () => { listToolsCalled = true; return { tools: [] }; },
        close: async () => { closed = true; },
      }) as unknown as Client,
    ),
    (error: unknown) => error === connectError,
  );
  assert.equal(closed, true);
  assert.equal(listToolsCalled, false);
});

test("connectUpstream preserves UTF-8 stderr diagnostics across stream chunks", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, stderr: "pipe" });
  const stderr = transport.stderr;
  assert.ok(stderr instanceof PassThrough);
  const expected = "upstream 日本語🙂";
  const bytes = Buffer.from(expected, "utf8");
  const connectError = new Error("connect failed after stderr");

  await assert.rejects(
    () =>
      connectUpstream(
        { name: "split-stderr", command: process.execPath },
        undefined,
        () =>
          ({
            connect: async () => {
              stderr?.push(bytes.subarray(0, 2));
              await new Promise<void>((resolve) => setImmediate(resolve));
              stderr?.push(bytes.subarray(2));
              stderr?.push(null);
              throw connectError;
            },
            listTools: async () => ({ tools: [] }),
            close: async () => {},
          }) as unknown as Client,
        { transportFactory: async () => transport },
      ),
    (error: unknown) => error === connectError,
  );

  assert.ok(
    (connectError as Error & { mottainaiUpstreamDiagnostic: string }).mottainaiUpstreamDiagnostic.includes(
      `stderr_tail=${JSON.stringify(expected)}`,
    ),
  );
  assert.doesNotMatch(
    (connectError as Error & { mottainaiUpstreamDiagnostic: string }).mottainaiUpstreamDiagnostic,
    /\uFFFD/u,
  );
});

test("upstream stderr tail cuts only at valid UTF-8 boundaries", async () => {
  const maxBytes = 16 * 1024;
  const suffix = "x".repeat(maxBytes - 3);
  const expectedTail = suffix;
  const transport = new StdioClientTransport({ command: process.execPath, stderr: "pipe" });
  const stderr = transport.stderr;
  assert.ok(stderr instanceof PassThrough);
  const bytes = Buffer.from(`a😀${suffix}`, "utf8");
  const connectError = new Error("connect failed after large stderr");

  await assert.rejects(
    () =>
      connectUpstream(
        { name: "bounded-stderr", command: process.execPath },
        undefined,
        () =>
          ({
            connect: async () => {
              stderr?.push(bytes.subarray(0, 2));
              await new Promise<void>((resolve) => setImmediate(resolve));
              stderr?.push(bytes.subarray(2));
              stderr?.push(null);
              throw connectError;
            },
            listTools: async () => ({ tools: [] }),
            close: async () => {},
          }) as unknown as Client,
        { transportFactory: async () => transport },
      ),
    (error: unknown) => error === connectError,
  );

  const diagnostic = (connectError as Error & { mottainaiUpstreamDiagnostic: string }).mottainaiUpstreamDiagnostic;
  assert.ok(diagnostic.includes(`stderr_tail=${JSON.stringify(expectedTail)}`));
  assert.doesNotMatch(diagnostic, /\uFFFD/u);
  assert.ok(Buffer.byteLength(expectedTail, "utf8") <= maxBytes);
});

test("close is resilient to one upstream's close failure and still stops the rest", async () => {
  let goodClosed = false;
  const registry = new UpstreamRegistry([
    { name: "bad", command: "node" },
    { name: "good", command: "node" },
  ], async (config) => ({
    config,
    client: {
      close: async () => {
        if (config.name === "bad") throw new Error("close failed");
        goodClosed = true;
      },
    } as UpstreamHandle["client"],
    tools: [],
  }));

  await registry.start("bad");
  await registry.start("good");
  await registry.close();

  assert.equal(goodClosed, true);
  assert.equal(registry.state("bad"), "stopped");
  assert.equal(registry.state("good"), "stopped");
});

test("close proceeds when an upstream ignores client.close", async () => {
  const registry = new UpstreamRegistry([{ name: "stubborn", command: "node" }], async (config) => ({
    config,
    client: { close: async () => new Promise<void>(() => {}) } as UpstreamHandle["client"],
    tools: [],
  }));

  await registry.start("stubborn");
  const startedAt = Date.now();
  await registry.close();

  assert.ok(Date.now() - startedAt < 2_500);
  assert.equal(registry.state("stubborn"), "stopped");
});

test("close is idempotent: a second call does not attempt to close handles again", async () => {
  let closes = 0;
  const registry = new UpstreamRegistry([{ name: "one", command: "node" }], async (config) => ({
    config,
    client: { close: async () => { closes += 1; } } as UpstreamHandle["client"],
    tools: [],
  }));

  await registry.start("one");
  await Promise.all([registry.close(), registry.close()]);
  await registry.close();

  assert.equal(closes, 1);
  assert.equal(registry.state("one"), "stopped");
});

test("an in-flight start cannot resurrect a ready handle after close begins", async () => {
  let releaseConnect: (() => void) | undefined;
  const connecting = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let handleClosed = false;

  const registry = new UpstreamRegistry([{ name: "slow", command: "node" }], async (config) => {
    await connecting;
    return {
      config,
      client: { close: async () => { handleClosed = true; } } as UpstreamHandle["client"],
      tools: [],
    };
  });

  const starting = registry.start("slow");
  const closing = registry.close();
  releaseConnect?.();

  await assert.rejects(() => starting);
  await closing;

  assert.equal(registry.state("slow"), "stopped");
  assert.equal(registry.readyHandles().length, 0);
  assert.equal(handleClosed, true);

  await assert.rejects(() => registry.start("slow"), /shutting down/);
});
