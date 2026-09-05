import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertEnvelopeShape } from "../test-support/assertions.js";
import { writeTestConfig } from "../test-support/config-fixture.js";
import { createTempDir } from "../test-support/tmp-dir.js";
import { startGatewayViaStdio } from "./stdio-client.js";

/**
 * #22がblack-box suiteを積み上げる接続点なので、ここでは接続確認のsmoke 1本に留める。
 * ファイル名が `.test.ts` でなく `.spec.ts` なのは、既定 `pnpm test` のglobから
 * 意図的に外すため（docs/testing/README.md参照）。
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
  await fs.writeFile(path.join(workspace, "large.txt"), "black-box marker\n".repeat(2_000));
  const configPath = writeTestConfig(workspace, {
    gateway: {
      workspaceRoot: ".",
      responseBudget: { softTokens: 200, hardTokens: 400, hardBytes },
    },
  });
  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "mottainai_read",
    arguments: { path: "large.txt" },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= hardBytes);
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.operation, "read");
  assert.equal(result.structuredContent.truncated, true);
  assert.equal("output" in result.structuredContent, false);
  assert.match(String(result.structuredContent.result_id), /^mx_/);
});

test("stdio tools/call cannot bypass read-governor enforce mode with mode raw", { timeout: 15_000 }, async (t) => {
  const workspace = createTempDir(t, "mottainai-e2e-read-governor-");
  await fs.writeFile(path.join(workspace, "large.ts"), Array.from({ length: 600 }, (_, index) => `const secret_${index} = ${index};`).join("\n"));
  const configPath = writeTestConfig(workspace, {
    gateway: {
      workspaceRoot: ".",
      readGovernor: {
        mode: "enforce",
        maxRawLines: 100,
        maxRawBytes: 10_000,
        allowWholeFileBelowLines: 20,
        preferAuto: true,
      },
    },
  });
  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "mottainai_read",
    arguments: { path: "large.ts", mode: "raw" },
  });
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.status, "partial");
  assert.equal("text" in result.structuredContent, false);
  assert.equal((result.structuredContent as Record<string, unknown>).policy_rule, "WHOLE_FILE_RAW_LINE_LIMIT");
  assert.doesNotMatch(JSON.stringify(result), /secret_599/);
});

test("stdio governor diagnostics remain within the final response hard cap", { timeout: 15_000 }, async (t) => {
  const workspace = createTempDir(t, "mottainai-e2e-read-governor-budget-");
  await fs.writeFile(path.join(workspace, "large.ts"), Array.from({ length: 600 }, (_, index) => `const secret_${index} = ${index};`).join("\n"));
  const hardBytes = 1_600;
  const configPath = writeTestConfig(workspace, {
    gateway: {
      workspaceRoot: ".",
      responseBudget: { softTokens: 200, hardTokens: 400, hardBytes },
      readGovernor: {
        mode: "enforce",
        maxRawLines: 100,
        maxRawBytes: 10_000,
        allowWholeFileBelowLines: 20,
        preferAuto: true,
      },
    },
  });
  const connection = await startGatewayViaStdio({ workingDirectory: workspace, configPath });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "mottainai_read",
    arguments: { path: "large.ts", mode: "raw" },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= hardBytes);
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.status, "partial");
  assert.equal(result.isError, undefined);
});
