import assert from "node:assert/strict";
import test from "node:test";
import {
  createReportStatusTool,
  REPORT_STATUS_ACKNOWLEDGEMENT,
  REPORT_STATUS_PARAMETERS,
  validateReportStatus,
} from "./status-tool.js";

const status = {
  lifecycleState: "running" as const,
  phase: "executing" as const,
  activity: { kind: "working" as const, label: "implementing" },
  progress: { completed: 2, current: "step 3", remaining: 4 },
  attention: "none" as const,
  blocker: { code: "awaiting-input", detail: "Waiting for a bounded worker decision" },
  usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
  context: { usedTokens: 160, limitTokens: 1_000 },
};

test("exposes the exact bounded semantic status shape", () => {
  assert.deepEqual(validateReportStatus(status), status);
  assert.deepEqual(REPORT_STATUS_PARAMETERS.required, ["lifecycleState", "phase", "activity", "progress", "attention"]);
  assert.equal(REPORT_STATUS_PARAMETERS.additionalProperties, false);
  assert.equal("reasoning" in REPORT_STATUS_PARAMETERS.properties, false);
  assert.equal("transcript" in REPORT_STATUS_PARAMETERS.properties, false);
});

test("rejects out-of-contract fields and unbounded values", () => {
  assert.throws(() => validateReportStatus({ ...status, reasoning: "private" }), /unsupported field/);
  assert.throws(
    () => validateReportStatus({ ...status, progress: { ...status.progress, completed: 1.5 } }),
    /progress.completed/,
  );
  assert.throws(
    () => validateReportStatus({ ...status, blocker: { code: "x", detail: "x".repeat(513) } }),
    /blocker.detail/,
  );
});

test("records explicit status and acknowledges without control calls", async () => {
  const received: unknown[] = [];
  const tool = createReportStatusTool({ onStatus: (reported) => received.push(reported) });
  const result = await tool.execute("call-1", status, undefined, undefined, undefined as never);

  assert.deepEqual(received, [status]);
  assert.deepEqual(result.content, [{ type: "text", text: REPORT_STATUS_ACKNOWLEDGEMENT }]);
  assert.deepEqual(result.details, { accepted: true });
});
