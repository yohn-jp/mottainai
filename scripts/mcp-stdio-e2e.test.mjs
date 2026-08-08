// Issue #22: built dist を実際の stdio MCP server として起動し、process外部から
// JSON-RPC を送受信する black-box test。src/ の関数を直接 import しない。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpStdioClient } from "./lib/mcp-blackbox-client.mjs";
import {
  cleanupClient,
  createFixtureWorkspace,
  createWorkspace,
  FIXTURE_TOOL_NAME,
  INITIALIZE_PARAMS,
  isolatedEnv,
  readPid,
  waitForFile,
  waitForProcessGone,
  writeConfig,
} from "./lib/mcp-blackbox-test-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

before(() => {
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before pnpm run e2e:test");
});

function launch(cwd) {
  return McpStdioClient.launchNode(distEntry, { cwd, env: isolatedEnv(cwd) });
}

async function initialize(client) {
  const response = await client.request("initialize", INITIALIZE_PARAMS, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(response.error, undefined, `initialize failed: ${JSON.stringify(response.error)}`);
  client.notify("notifications/initialized", {});
  return response;
}

async function closeAndAssert(client) {
  const exitInfo = await client.closeGracefully(5_000);
  assert.equal(exitInfo.code, 0, `expected clean exit: ${JSON.stringify(exitInfo)}`);
  assert.equal(exitInfo.signal, null);
  assert.deepEqual(client.stdoutPurityViolations(), [], "stdout must carry only JSON-RPC frames");
  return exitInfo;
}

test(
  "built dist completes MCP handshake, exposes tool contracts, and exits cleanly on EOF",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      const initializeResponse = await initialize(client);
      assert.equal(initializeResponse.jsonrpc, "2.0");
      assert.equal(initializeResponse.id, 1);
      assert.equal(initializeResponse.result.serverInfo.name, "mottainai");
      assert.equal(typeof initializeResponse.result.protocolVersion, "string");
      assert.equal(typeof initializeResponse.result.capabilities.tools, "object");

      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      const tools = listResponse.result.tools;
      assert.ok(Array.isArray(tools) && tools.length > 5, "tools/list should expose a non-trivial tool catalog");

      const listTool = tools.find((tool) => tool.name === "mottainai_list");
      assert.ok(listTool !== undefined, "mottainai_list must be discoverable");
      assert.equal(typeof listTool.description, "string");
      assert.ok(listTool.description.length > 0);
      assert.equal(listTool.inputSchema.type, "object");
      assert.equal(typeof listTool.inputSchema.properties, "object");
      assert.equal(listTool.annotations.readOnlyHint, true);
      assert.equal(listTool.annotations.destructiveHint, false);
      for (const tool of tools) {
        assert.equal(typeof tool.name, "string");
        assert.ok(tool.name.length > 0);
        assert.equal(typeof tool.inputSchema, "object");
      }

      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "built dist executes a representative local tools/call in an isolated workspace",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace({ extraFiles: { "sample-data/hello.txt": "black-box marker file\n" } });
    const client = launch(workspace);
    try {
      await initialize(client);
      const callResponse = await client.request(
        "tools/call",
        { name: "mottainai_list", arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      assert.equal(callResponse.error, undefined, `unexpected tool error: ${JSON.stringify(callResponse.error)}`);
      assert.equal(callResponse.result.isError, undefined);
      assert.equal(callResponse.result.content[0].type, "text");
      const structured = callResponse.result.structuredContent;
      for (const field of [
        "operation",
        "status",
        "summary",
        "facts",
        "diagnostics",
        "metrics",
        "result_id",
        "truncated",
      ]) {
        assert.ok(field in structured, `structuredContent is missing required envelope field: ${field}`);
      }
      assert.equal(structured.status, "success");
      const normalizedEntries = structured.entries.map((entry) => entry.replaceAll("\\", "/"));
      assert.ok(normalizedEntries.includes("sample-data/hello.txt"));
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "malformed JSON-RPC input is dropped without crashing or desyncing later responses",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      await initialize(client);
      client.writeRawLine("{this is not valid json at all");
      assert.equal(client.exited, false);
      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      assert.ok(Array.isArray(listResponse.result.tools));
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test("partial JSON sent in two chunks is parsed as one request", { timeout: 20_000 }, async () => {
  const workspace = createWorkspace();
  const client = launch(workspace);
  try {
    await initialize(client);
    const prepared = client.prepareRequest("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
    const serialized = `${JSON.stringify(prepared.message)}\n`;
    const splitAt = Math.max(1, Math.floor(serialized.length / 2));
    client.writeRaw(serialized.slice(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 25));
    client.writeRaw(serialized.slice(splitAt));
    const response = await prepared.response;
    assert.equal(response.error, undefined);
    assert.ok(Array.isArray(response.result.tools));
    await closeAndAssert(client);
  } finally {
    await cleanupClient(client, workspace);
  }
});

test(
  "incomplete JSON followed by EOF has bounded cleanup and no stdout contamination",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      client.writeRaw('{"jsonrpc":"2.0","id":1,"method":"initialize"');
      const exitInfo = await client.closeGracefully(1_000);
      assert.ok(exitInfo.code !== undefined || exitInfo.signal !== undefined);
      assert.deepEqual(client.stdoutPurityViolations(), []);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "calls before initialization follow SDK behavior and the session can initialize afterward",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      const beforeInit = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      // SDK 1.29 permits tools/list before initialize; the contract is no crash/desync.
      assert.equal(beforeInit.error, undefined);
      assert.ok(Array.isArray(beforeInit.result.tools));
      assert.equal(client.exited, false);
      await initialize(client);
      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "duplicate initialization follows SDK behavior without desynchronizing later requests",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      await initialize(client);
      const duplicate = await client.request("initialize", INITIALIZE_PARAMS, DEFAULT_REQUEST_TIMEOUT_MS);
      // SDK 1.29 treats a repeated initialize as an idempotent successful handshake.
      assert.equal(duplicate.error, undefined);
      assert.equal(duplicate.result.serverInfo.name, "mottainai");
      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "unsupported method, unknown tool, and invalid tool arguments return errors while the process stays alive",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace();
    const client = launch(workspace);
    try {
      await initialize(client);
      const unknownMethod = await client.request("definitely/not/a/method", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(unknownMethod.result, undefined);
      assert.equal(unknownMethod.error.code, -32601);

      const unknownTool = await client.request(
        "tools/call",
        { name: "definitely_not_a_real_tool", arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      assert.equal(unknownTool.result, undefined);
      assert.equal(typeof unknownTool.error.code, "number");
      assert.equal(typeof unknownTool.error.message, "string");

      const missingRequiredArg = await client.request(
        "tools/call",
        { name: "mottainai_exec", arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      assert.equal(missingRequiredArg.result, undefined);
      assert.match(missingRequiredArg.error.message, /command/);

      const escapesWorkspace = await client.request(
        "tools/call",
        {
          name: "mottainai_list",
          arguments: { path: "../../../../../../etc" },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      assert.equal(escapesWorkspace.result, undefined);
      assert.match(escapesWorkspace.error.message, /workspaceRoot/);

      assert.equal(client.exited, false);
      const stillAlive = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(stillAlive.error, undefined);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

async function runStartupFailure(configContent) {
  const workspace = createWorkspace({ config: null });
  writeConfig(workspace, configContent);
  const client = launch(workspace);
  try {
    const exitInfo = await client.waitForExit(3_000);
    return { client, workspace, exitInfo, stderr: client.stderrText() };
  } catch (error) {
    await cleanupClient(client, workspace);
    throw error;
  }
}

test(
  "missing configuration emits deterministic stderr, non-zero exit, and no stdout protocol data",
  { timeout: 20_000 },
  async () => {
    const workspace = createWorkspace({ config: null });
    const client = launch(workspace);
    try {
      const exitInfo = await client.waitForExit(3_000);
      const configPath = path.join(workspace, "mottainai.config.json");
      assert.notEqual(exitInfo.code, 0);
      assert.equal(client.stdoutLines.length, 0);
      assert.deepEqual(client.stdoutPurityViolations(), []);
      assert.equal(
        client.stderrText(),
        [
          "Mottainai configuration was not found:",
          `  ${configPath}`,
          "",
          "Initialize this workspace with:",
          "  npx -y mottainai init",
          "",
          "ENOENT: no such file or directory",
          "",
        ].join("\n"),
      );
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test("malformed configuration is deterministic, non-zero, and stdout-clean", { timeout: 20_000 }, async () => {
  const first = await runStartupFailure("{ not valid json");
  const firstStderr = first.stderr;
  assert.notEqual(first.exitInfo.code, 0);
  assert.equal(first.client.stdoutLines.length, 0);
  assert.deepEqual(first.client.stdoutPurityViolations(), []);
  await cleanupClient(first.client, first.workspace);

  const second = await runStartupFailure("{ not valid json");
  try {
    assert.notEqual(second.exitInfo.code, 0);
    assert.equal(second.stderr, firstStderr);
    assert.match(second.stderr, /JSON|property name|Unexpected/);
    assert.equal(second.client.stdoutLines.length, 0);
    assert.deepEqual(second.client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(second.client, second.workspace);
  }
});

test("spawn/startup errors are captured without leaving a child", { timeout: 20_000 }, async () => {
  const workspace = createWorkspace();
  const client = new McpStdioClient(path.join(workspace, "command-does-not-exist"), [], {
    cwd: workspace,
    env: isolatedEnv(workspace),
  });
  try {
    const exitInfo = await client.waitForExit(3_000);
    assert.notEqual(exitInfo.code, 0);
    assert.match(client.startupError?.message ?? "", /ENOENT|not found/i);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(client, workspace);
  }
});

async function runSignalTest(signal) {
  const workspace = createWorkspace();
  const client = launch(workspace);
  try {
    await initialize(client);
    client.child.kill(signal);
    const exitInfo = await client.waitForExit(5_000);
    assert.equal(exitInfo.code, 0, `${signal} should reach the registered graceful shutdown handler`);
    assert.equal(exitInfo.signal, null);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(client, workspace);
  }
}

test(
  "SIGINT triggers bounded graceful shutdown on POSIX",
  { timeout: 20_000, skip: process.platform === "win32" },
  async () => {
    await runSignalTest("SIGINT");
  },
);

test(
  "SIGTERM triggers bounded graceful shutdown on POSIX",
  { timeout: 20_000, skip: process.platform === "win32" },
  async () => {
    await runSignalTest("SIGTERM");
  },
);

test("client disconnect is bounded and leaves no gateway process", { timeout: 20_000 }, async () => {
  const workspace = createWorkspace();
  const client = launch(workspace);
  try {
    await initialize(client);
    client.disconnect();
    const exitInfo = await client.closeGracefully(1_000);
    assert.ok(exitInfo.code !== undefined || exitInfo.signal !== undefined);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(client, workspace);
  }
});

test(
  "normal upstream initializes through a real subprocess and is cleaned up on stdin EOF",
  { timeout: 25_000 },
  async () => {
    const fixture = createFixtureWorkspace(repoRoot, "normal");
    const client = launch(fixture.workspace);
    try {
      const listPromise = client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      await waitForFile(fixture.readyFile);
      const listResponse = await listPromise;
      assert.equal(listResponse.error, undefined);
      assert.ok(listResponse.result.tools.some((tool) => tool.name === FIXTURE_TOOL_NAME));
      const upstreamPid = readPid(fixture.pidFile);
      await closeAndAssert(client);
      await waitForProcessGone(upstreamPid);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);

test(
  "upstream immediate exit is a bounded provider error and later requests remain synchronized",
  { timeout: 25_000 },
  async () => {
    const fixture = createFixtureWorkspace(repoRoot, "exit-immediately");
    const client = launch(fixture.workspace);
    try {
      const callPromise = client.request(
        "tools/call",
        { name: FIXTURE_TOOL_NAME, arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      await waitForFile(fixture.readyFile);
      const callResponse = await callPromise;
      assert.equal(callResponse.result, undefined);
      assert.equal(typeof callResponse.error.code, "number");
      assert.equal(typeof callResponse.error.message, "string");
      assert.equal(client.exited, false);
      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);

test(
  "startup-hanging upstream fails at the request deadline with diagnostics and tree cleanup",
  { timeout: 25_000 },
  async () => {
    const fixture = createFixtureWorkspace(repoRoot, "hang-startup");
    const client = launch(fixture.workspace);
    try {
      const callPromise = client.request("tools/call", { name: FIXTURE_TOOL_NAME, arguments: {} }, 750);
      await waitForFile(fixture.readyFile);
      await assert.rejects(callPromise, (error) => {
        assert.match(error.message, /timed out after 750ms/);
        assert.match(error.message, /method=tools\/call/);
        assert.match(error.message, /request_id=1/);
        assert.match(error.message, /stderr_tail=/);
        assert.match(error.message, /stdout_transcript=/);
        return true;
      });
      const upstreamPid = readPid(fixture.pidFile);
      client.forceKill();
      await client.waitForExit(3_000);
      await waitForProcessGone(upstreamPid);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);

test("large upstream stderr does not deadlock stdio or contaminate gateway stdout", { timeout: 25_000 }, async () => {
  const fixture = createFixtureWorkspace(repoRoot, "large-stderr", { stderrBytes: 768 * 1024 });
  const client = launch(fixture.workspace);
  try {
    const listPromise = client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
    await waitForFile(fixture.readyFile);
    const listResponse = await listPromise;
    assert.equal(listResponse.error, undefined);
    assert.ok(client.stderrBytes >= 768 * 1024);
    assert.match(client.stderrText(), /fixture-large-stderr-end/);
    await closeAndAssert(client);
    await waitForProcessGone(readPid(fixture.pidFile));
  } finally {
    await cleanupClient(client, fixture.workspace);
  }
});

test(
  "listTools failure is surfaced through a JSON-RPC provider error and leaves the gateway usable",
  { timeout: 25_000 },
  async () => {
    const fixture = createFixtureWorkspace(repoRoot, "fail-list");
    const client = launch(fixture.workspace);
    try {
      const callPromise = client.request(
        "tools/call",
        { name: FIXTURE_TOOL_NAME, arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      await waitForFile(fixture.readyFile);
      const callResponse = await callPromise;
      assert.equal(callResponse.result, undefined);
      assert.equal(typeof callResponse.error.code, "number");
      assert.match(callResponse.error.message, /fixture listTools failure|Connection closed|listTools/i);
      const listResponse = await client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
      assert.equal(listResponse.error, undefined);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);

test(
  "malformed upstream result becomes a provider error without corrupting gateway stdout",
  { timeout: 25_000 },
  async () => {
    const fixture = createFixtureWorkspace(repoRoot, "malformed-result");
    const client = launch(fixture.workspace);
    try {
      const callPromise = client.request(
        "tools/call",
        { name: FIXTURE_TOOL_NAME, arguments: {} },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      await waitForFile(fixture.readyFile);
      const callResponse = await callPromise;
      assert.equal(callResponse.result, undefined);
      assert.equal(typeof callResponse.error.code, "number");
      assert.equal(client.exited, false);
      await closeAndAssert(client);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);

test("termination-ignoring upstream is removed by forced process-tree cleanup", { timeout: 25_000 }, async () => {
  const fixture = createFixtureWorkspace(repoRoot, "ignore-termination");
  const client = launch(fixture.workspace);
  try {
    const listPromise = client.request("tools/list", {}, DEFAULT_REQUEST_TIMEOUT_MS);
    await waitForFile(fixture.readyFile);
    const listResponse = await listPromise;
    assert.equal(listResponse.error, undefined);
    const upstreamPid = readPid(fixture.pidFile);
    const exitInfo = await client.closeGracefully(1_000);
    assert.ok(exitInfo.code !== undefined || exitInfo.signal !== undefined);
    await waitForProcessGone(upstreamPid);
  } finally {
    await cleanupClient(client, fixture.workspace);
  }
});

test("unterminated stdout is retained as a protocol violation until close", { timeout: 20_000 }, async () => {
  const workspace = createWorkspace({
    config: null,
    extraFiles: {
      "write-garbage.mjs": "process.stdout.write('garbage'); process.exit(0);\n",
    },
  });
  const client = McpStdioClient.launchNode(path.join(workspace, "write-garbage.mjs"), {
    cwd: workspace,
    env: isolatedEnv(workspace),
  });
  try {
    await client.waitForExit(3_000);
    assert.deepEqual(client.stdoutPurityViolations(), ["garbage"]);
    assert.deepEqual(client.stdoutLines, ["garbage"]);
  } finally {
    await cleanupClient(client, workspace);
  }
});
