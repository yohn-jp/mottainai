import assert from "node:assert/strict";
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

  const connection = await startGatewayViaStdio({ cwd: workspace, configPath });
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
