// Issue #22: mottainai を実際の stdio MCP server として起動し、process外部から
// JSON-RPC を送受信する black-box test。src/ の関数を直接 import しない。
//
// 起動経路: npm pack でパッケージ化 -> tar 展開 -> package.json の bin エントリを解決し
// shebang 経由で直接実行する（POSIX）。実際に npm/pnpm install したユーザーが叩く経路に
// 最も近い、build 済み artifact そのものを起動する。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractTarball, linkDependencies, McpStdioClient, packRepository, resolvePackagedBin } from "./lib/mcp-blackbox-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CLIENT_INFO = { name: "mottainai-blackbox-suite", version: "0.0.0" };
const INITIALIZE_PARAMS = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: CLIENT_INFO };

let suiteRoot;
let binPath;
let packedFiles;

before(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-e2e-"));
  const { tarballPath, packedFiles: files } = packRepository(repoRoot, suiteRoot);
  packedFiles = files;
  const extractedPackageDir = extractTarball(tarballPath, path.join(suiteRoot, "extracted"));
  linkDependencies(extractedPackageDir, repoRoot);
  binPath = resolvePackagedBin(extractedPackageDir);
});

after(() => {
  if (suiteRoot !== undefined) fs.rmSync(suiteRoot, { recursive: true, force: true });
});

/** developer の実 HOME/config を読ませないための、workspace ごとの隔離環境。 */
function makeWorkspace(extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-e2e-ws-"));
  fs.writeFileSync(path.join(dir, "mottainai.config.json"), JSON.stringify({ version: 2, mcpServers: {} }));
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const absolute = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return dir;
}

function isolatedEnv(homeDir) {
  const env = { ...process.env };
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.XDG_STATE_HOME = path.join(homeDir, "xdg-state");
  env.XDG_CONFIG_HOME = path.join(homeDir, "xdg-config");
  env.XDG_CACHE_HOME = path.join(homeDir, "xdg-cache");
  delete env.MOTTAINAI_CONFIG;
  delete env.MOTTAINAI_TELEMETRY;
  delete env.MOTTAINAI_COMPRESS;
  delete env.MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS;
  delete env.MOTTAINAI_COMPRESS_CODE;
  delete env.MOTTAINAI_LOG;
  return env;
}

function launch(cwd, envOverride) {
  return McpStdioClient.launchPackaged(binPath, { cwd, env: envOverride ?? isolatedEnv(cwd) });
}

async function cleanupWorkspace(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("packaged tarball contains every runtime file the bin needs", () => {
  const required = ["package.json", "dist/index.js", "README.md", "LICENSE", "mottainai.config.json.example"];
  for (const requiredPath of required) {
    assert.ok(packedFiles.includes(requiredPath), `packed tarball is missing ${requiredPath}`);
  }
});

test("server completes MCP handshake, exposes tool contracts, and exits cleanly on EOF", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace();
  const client = launch(workspace);
  try {
    const initializeResponse = await client.request("initialize", INITIALIZE_PARAMS);
    assert.equal(initializeResponse.jsonrpc, "2.0");
    assert.equal(initializeResponse.id, 1);
    assert.equal(initializeResponse.error, undefined);
    assert.equal(initializeResponse.result.serverInfo.name, "mottainai");
    assert.equal(typeof initializeResponse.result.protocolVersion, "string");
    assert.equal(typeof initializeResponse.result.capabilities.tools, "object");

    client.notify("notifications/initialized", {});

    const listResponse = await client.request("tools/list", {});
    assert.equal(listResponse.jsonrpc, "2.0");
    assert.equal(listResponse.error, undefined);
    const tools = listResponse.result.tools;
    assert.ok(Array.isArray(tools) && tools.length > 5, "tools/list should expose a non-trivial tool catalog");

    // 巨大 snapshot を避け、代表 tool 1本の contract 上重要な要素だけを確認する。
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

    assert.deepEqual(client.stdoutPurityViolations(), [], "stdout must carry only JSON-RPC frames");

    const exitInfo = await client.closeGracefully();
    assert.equal(exitInfo.code, 0, "clean EOF disconnect must not be treated as a crash");
    assert.equal(exitInfo.signal, null);
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});

test("tools/call runs mottainai_list end to end against an isolated workspace", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace({ "sample-data/hello.txt": "black-box marker file\n" });
  const client = launch(workspace);
  try {
    await client.request("initialize", INITIALIZE_PARAMS);
    client.notify("notifications/initialized", {});

    const callResponse = await client.request("tools/call", { name: "mottainai_list", arguments: {} });
    assert.equal(callResponse.error, undefined, `unexpected tool error: ${JSON.stringify(callResponse.error)}`);
    const result = callResponse.result;
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");

    const structured = result.structuredContent;
    for (const field of ["operation", "status", "summary", "facts", "diagnostics", "metrics", "result_id", "truncated"]) {
      assert.ok(field in structured, `structuredContent is missing required envelope field: ${field}`);
    }
    assert.equal(structured.status, "success");
    const normalizedEntries = structured.entries.map((entry) => entry.replaceAll("\\", "/"));
    assert.ok(
      normalizedEntries.includes("sample-data/hello.txt"),
      `expected the isolated workspace marker file in entries: ${JSON.stringify(normalizedEntries)}`,
    );

    assert.deepEqual(client.stdoutPurityViolations(), []);

    const exitInfo = await client.closeGracefully();
    assert.equal(exitInfo.code, 0);
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});

test("malformed JSON-RPC input is dropped without crashing or desyncing later responses", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace();
  const client = launch(workspace);
  try {
    await client.request("initialize", INITIALIZE_PARAMS);
    client.notify("notifications/initialized", {});

    client.writeRawLine("{this is not valid json at all");
    assert.equal(client.exited, false, "a malformed line must not crash the server");

    const listResponse = await client.request("tools/list", {});
    assert.equal(listResponse.error, undefined);
    assert.ok(Array.isArray(listResponse.result.tools));

    const exitInfo = await client.closeGracefully();
    assert.equal(exitInfo.code, 0);
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});

test("unknown method, unknown tool, and invalid tool arguments return protocol errors, not a crash", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace();
  const client = launch(workspace);
  try {
    await client.request("initialize", INITIALIZE_PARAMS);
    client.notify("notifications/initialized", {});

    const unknownMethod = await client.request("definitely/not/a/method", {});
    assert.equal(unknownMethod.result, undefined);
    assert.equal(typeof unknownMethod.error.code, "number");
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await client.request("tools/call", { name: "definitely_not_a_real_tool", arguments: {} });
    assert.equal(unknownTool.result, undefined);
    assert.equal(typeof unknownTool.error.code, "number");
    assert.equal(typeof unknownTool.error.message, "string");

    const missingRequiredArg = await client.request("tools/call", { name: "mottainai_exec", arguments: {} });
    assert.equal(missingRequiredArg.result, undefined);
    assert.match(missingRequiredArg.error.message, /command/);

    const escapesWorkspace = await client.request("tools/call", {
      name: "mottainai_list",
      arguments: { path: "../../../../../../etc" },
    });
    assert.equal(escapesWorkspace.result, undefined);
    assert.match(escapesWorkspace.error.message, /workspaceRoot/);

    assert.equal(client.exited, false, "protocol errors must not terminate the process");
    const stillAlive = await client.request("tools/list", {});
    assert.equal(stillAlive.error, undefined);

    assert.deepEqual(client.stdoutPurityViolations(), []);

    const exitInfo = await client.closeGracefully();
    assert.equal(exitInfo.code, 0);
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});

test("SIGTERM triggers the registered graceful-shutdown path, not a signal kill", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace();
  const client = launch(workspace);
  try {
    await client.request("initialize", INITIALIZE_PARAMS);
    client.notify("notifications/initialized", {});

    client.child.kill("SIGTERM");
    const exitInfo = await client.waitForExit();
    assert.equal(exitInfo.code, 0, "SIGTERM should reach the registered handler and shut down cleanly");
    assert.equal(exitInfo.signal, null);
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});

test("startup failure on invalid configuration exits non-zero and never disguises itself as success", { timeout: 20_000 }, async () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(path.join(workspace, "mottainai.config.json"), "{ not valid json");
  const client = launch(workspace);
  try {
    const exitInfo = await client.waitForExit();
    assert.notEqual(exitInfo.code, 0, "startup failure must not exit 0");
    assert.deepEqual(client.stdoutLines, [], "a failed startup must never write to the protocol channel");
    assert.ok(client.stderrText().length > 0, "the failure must be diagnosable on stderr");
  } finally {
    client.forceKill();
    await cleanupWorkspace(workspace);
  }
});
