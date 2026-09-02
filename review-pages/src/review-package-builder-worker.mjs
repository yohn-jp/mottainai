import { parentPort, workerData } from "node:worker_threads";
import { buildDiff } from "./build-diff.mjs";
import { buildOcr } from "./build-ocr.mjs";

const builders = { diff: buildDiff, ocr: buildOcr };
const builder = builders[workerData?.name];

if (!parentPort || !builder) {
  throw new Error("review package builder worker requires a supported builder name");
}

// The worker only schedules existing synchronous builders; it does not own or
// reproduce their evidence semantics. Keeping their child processes off the
// generator event loop lets the bounded graph overlap them with API builders.
try {
  parentPort.postMessage({ ok: true, value: builder(workerData.args) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { message: error?.message ?? String(error) },
  });
}
