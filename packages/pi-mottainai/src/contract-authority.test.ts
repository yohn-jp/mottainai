import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA,
  WorkerRuntimeStatusReportInputSchema,
} from "mottainai/worker-runtime";
import { REPORT_STATUS_PARAMETERS, validateReportStatus } from "./status-tool.js";

test("pi-mottainai consumes the canonical Mottainai worker status authority", () => {
  assert.equal(REPORT_STATUS_PARAMETERS, WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA);

  const status = {
    lifecycleState: "running",
    phase: "executing",
    activity: { kind: "working", label: "canonical" },
    progress: { completed: 1, current: "step", remaining: 2 },
    attention: "none",
  };

  assert.deepEqual(validateReportStatus(status), WorkerRuntimeStatusReportInputSchema.parse(status));
  assert.throws(
    () => validateReportStatus({ ...status, transcript: "must not be admitted" }),
    /transcript|unrecognized/iu,
  );
});
