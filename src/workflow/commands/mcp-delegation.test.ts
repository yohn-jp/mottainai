import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HARNESS_DELEGATION_SCHEMA_VERSION,
  HarnessDelegationService,
  type HarnessOperationResult,
  type HarnessWorkSnapshot,
} from "../domain/harness-delegation.js";
import {
  HARNESS_CAPABILITIES_TOOL_NAME,
  HARNESS_DELEGATION_TOOL_NAMES,
  callHarnessDelegationTool,
  harnessDelegationTools,
} from "./mcp-delegation.js";

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

const work = {
  schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
  workId: "work-548",
  status: "running",
  summary: "work running",
  lifecycle: {
    taskState: "active",
    managerState: "running",
    runtimeState: "running",
    allowedActions: ["continue", "cancel"],
  },
  evidence: {},
  artifacts: [],
  truncated: false,
} as const satisfies HarnessWorkSnapshot;

function success(status: HarnessOperationResult["status"] = "running"): HarnessOperationResult {
  return { ok: true, status, work: { ...work, status, summary: `work ${status}` } };
}

test("native MCP advertises only the versioned harness surface", async () => {
  assert.deepEqual(harnessDelegationTools().map((tool) => tool.name), [
    ...HARNESS_DELEGATION_TOOL_NAMES,
    HARNESS_CAPABILITIES_TOOL_NAME,
  ]);
  for (const tool of harnessDelegationTools()) {
    assert.equal(tool.outputSchema?.required?.includes("schemaVersion"), true);
    assert.equal(tool.outputSchema?.required?.includes("workId"), true);
    assert.equal(tool.outputSchema?.additionalProperties, false);
  }

  const result = structured(await callHarnessDelegationTool(HARNESS_CAPABILITIES_TOOL_NAME, {}, undefined));
  const capabilities = result.capabilities as Record<string, unknown>;
  assert.equal(result.schemaVersion, HARNESS_DELEGATION_SCHEMA_VERSION);
  assert.equal(capabilities.executable, "mottainai-mcp");
  assert.deepEqual(capabilities.tools, [...HARNESS_DELEGATION_TOOL_NAMES]);
});

test("MCP handlers dispatch directly to the harness service", async () => {
  const calls: string[] = [];
  const service = {
    async delegate() {
      calls.push("delegate");
      return success();
    },
    async inspect() {
      calls.push("inspect");
      return success();
    },
    async continueWork() {
      calls.push("continue");
      return success();
    },
    async cancelWork() {
      calls.push("cancel");
      return success("cancelled");
    },
  } as unknown as HarnessDelegationService;

  const delegated = structured(await callHarnessDelegationTool("mottainai_delegate_work", { goal: "goal" }, service));
  const inspected = structured(
    await callHarnessDelegationTool("mottainai_inspect_work", { workId: work.workId }, service),
  );
  const continued = structured(
    await callHarnessDelegationTool(
      "mottainai_continue_work",
      { workId: work.workId, followUp: "follow up" },
      service,
    ),
  );
  const cancelled = structured(
    await callHarnessDelegationTool("mottainai_cancel_work", { workId: work.workId }, service),
  );

  assert.deepEqual(calls, ["delegate", "inspect", "continue", "cancel"]);
  assert.equal(delegated.workId, work.workId);
  assert.equal(inspected.workId, work.workId);
  assert.equal(continued.workId, work.workId);
  assert.equal(cancelled.status, "cancelled");
});

test("MCP adapter rejects unknown input before invoking the domain", async () => {
  let invoked = false;
  const service = {
    async delegate(): Promise<HarnessOperationResult> {
      invoked = true;
      return success();
    },
  } as unknown as HarnessDelegationService;

  const result = await callHarnessDelegationTool(
    "mottainai_delegate_work",
    { goal: "goal", unexpected: true },
    service,
  );
  const content = structured(result);
  assert.equal(result.isError, true);
  assert.equal((content.error as Record<string, unknown>).class, "invalid_input");
  assert.equal(invoked, false);
});
