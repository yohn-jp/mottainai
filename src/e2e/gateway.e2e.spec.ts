import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assertEnvelopeShape } from "../test-support/assertions.js";
import { writeTestConfig } from "../test-support/config-fixture.js";
import { createTempDir } from "../test-support/tmp-dir.js";
import { startGatewayViaStdio } from "./stdio-client.js";

/**
 * #22がblack-box suiteを積み上げる接続点なので、ここでは接続確認のsmoke 1本に留める。
 * ファイル名が `.test.ts` でなく `.spec.ts` なのは、既定 `pnpm test` のglobから
 * 意図的に外すため（docs/testing.md参照）。
 */

test("gateway starts over stdio and serves local tools with a valid structured envelope", { timeout: 15_000 }, async (t) => {
  const workspace = createTempDir(t, "mottainai-e2e-gateway-");
  const configPath = writeTestConfig(workspace, {});

  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const { tools } = await connection.client.listTools();
  const toolNames = tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("mottainai_list"), `expected mottainai_list among: ${toolNames.join(", ")}`);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(
      tool.inputSchema !== null && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema),
      `tool ${tool.name} has an invalid inputSchema`,
    );
  }

  const result = await connection.client.callTool({ name: "mottainai_list", arguments: {} });
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.operation, "list");
  assert.equal(result.structuredContent.status, "success");
});

test("stdio tools/call enforces the configured final response byte bound", { timeout: 15_000 }, async (t) => {
  const workspace = createTempDir(t, "mottainai-e2e-context-runtime-");
  const hardBytes = 1_600;
  const configPath = writeTestConfig(workspace, {
    gateway: {
      workspaceRoot: ".",
      responseBudget: { softTokens: 200, hardTokens: 400, hardBytes },
    },
  });
  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "mottainai_exec",
    arguments: { command: "yes black-box | head -n 2000" },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= hardBytes);
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.operation, "exec");
  assert.equal(result.structuredContent.truncated, true);
  assert.equal("output" in result.structuredContent, false);
  assert.match(String(result.structuredContent.result_id), /^mx_/);
});

test("stdio tools/call cannot bypass enforce with an unrestricted raw read", { timeout: 15_000 }, async (t) => {
  const workspace = createTempDir(t, "mottainai-e2e-read-governor-");
  fs.mkdirSync(`${workspace}/src`);
  fs.writeFileSync(`${workspace}/src/large.ts`, Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
  const configPath = writeTestConfig(workspace, {
    gateway: {
      workspaceRoot: ".",
      readGovernor: {
        mode: "enforce",
        maxRawLines: 10,
        maxRawBytes: 200,
        allowWholeFileBelowLines: 5,
        preferAuto: true,
      },
    },
  });
  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "mottainai_read",
    arguments: { path: "src/large.ts", mode: "raw" },
  });
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.operation, "read");
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.result_id, "");
  assert.equal("text" in result.structuredContent, false);
  assert.match(String(result.structuredContent.summary), /denied/);
  assert.ok((result.structuredContent.diagnostics as Array<unknown>).length > 0);
});
