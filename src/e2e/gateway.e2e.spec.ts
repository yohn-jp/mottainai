import assert from "node:assert/strict";
import test from "node:test";
import { assertEnvelopeShape } from "../test-support/assertions.js";
import { writeTestConfig } from "../test-support/config-fixture.js";
import { createTempDir } from "../test-support/tmp-dir.js";
import { startGatewayViaStdio } from "./stdio-client.js";

/**
 * E2E / black-box tier: 実プロセスをstdioで起動し、実MCPプロトコルで話す。
 * #22のstdio black-box suiteが積み上がる場所。ここでは接続点が生きていることだけを
 * 検証する最小smokeにとどめ、網羅的なblack-boxケースは追加しない
 * （このファイル名の `.spec.ts` は意図的: `pnpm test` の既定glob `src/**\/*.test.ts`
 * から除外され、`pnpm test:e2e` からだけ実行される。docs/testing.md参照）。
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
    assert.equal(typeof tool.inputSchema, "object");
  }

  const result = await connection.client.callTool({ name: "mottainai_list", arguments: {} });
  assertEnvelopeShape(result.structuredContent);
  assert.equal(result.structuredContent.operation, "list");
  assert.equal(result.structuredContent.status, "success");
});
