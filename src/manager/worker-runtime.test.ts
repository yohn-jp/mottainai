import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRuntimeObservationPort } from "./worker-runtime.js";
import {
  WorkerRuntimeBindingSchema,
  WorkerRuntimeControlReceiptSchema,
  WorkerRuntimeObservationEventSchema,
  WorkerRuntimeStatusReportInputSchema,
} from "./worker-runtime.js";

const identity = {
  managerSessionId: "manager-session-1",
  runtimeId: "runtime-1",
  taskId: "task-1",
  executionSessionId: "execution-session-1",
  provider: "provider-a",
} as const;

const binding = {
  identity,
  boundAt: "2026-01-01T00:00:00.000Z",
} as const;
const parsedBinding = WorkerRuntimeBindingSchema.parse(binding);

const status = {
  lifecycleState: "running",
  phase: "executing",
  activity: { kind: "working", label: "processing task" },
  progress: { completed: 2, current: "step 3", remaining: 4 },
  attention: "none",
  usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
  context: { usedTokens: 160, limitTokens: 1_000 },
} as const;

test("worker runtime status is semantic, bounded, and provider-neutral", () => {
  const parsed = WorkerRuntimeStatusReportInputSchema.parse(status);
  assert.equal(parsed.phase, "executing");
  assert.equal(parsed.progress.current, "step 3");
  assert.equal(parsed.context?.limitTokens, 1_000);

  assert.throws(
    () => WorkerRuntimeStatusReportInputSchema.parse({ ...status, transcript: "provider output" }),
    /transcript/u,
  );
  assert.throws(
    () => WorkerRuntimeStatusReportInputSchema.parse({ ...status, reasoning: "private chain of thought" }),
    /reasoning/u,
  );
});

test("worker identity composes existing Manager/task/runtime identities through a binding", () => {
  const parsed = parsedBinding;
  assert.equal(parsed.identity.managerSessionId, "manager-session-1");
  assert.equal(parsed.identity.runtimeId, "runtime-1");
  assert.equal(parsed.identity.taskId, "task-1");
  assert.equal(parsed.identity.executionSessionId, "execution-session-1");
});

test("observation events are bounded semantic projections", () => {
  const started = WorkerRuntimeObservationEventSchema.parse({
    kind: "started",
    binding,
    observedAt: "2026-01-01T00:00:01.000Z",
  });
  const reported = WorkerRuntimeObservationEventSchema.parse({
    kind: "status",
    binding,
    status,
    observedAt: "2026-01-01T00:00:02.000Z",
  });
  const failed = WorkerRuntimeObservationEventSchema.parse({
    kind: "failed",
    binding,
    blocker: { code: "worker-failed", detail: "runtime exited" },
    observedAt: "2026-01-01T00:00:03.000Z",
  });

  assert.equal(started.kind, "started");
  assert.equal(reported.kind, "status");
  assert.equal(failed.kind, "failed");
});

test("control receipts remain explicit and separate from observation", () => {
  const receipt = WorkerRuntimeControlReceiptSchema.parse({
    operation: "stop",
    acceptedAt: "2026-01-01T00:00:04.000Z",
  });
  assert.equal(receipt.operation, "stop");

  const observationPort: WorkerRuntimeObservationPort = {
    observe: async (input) => ({ binding: input, status, observedAt: "2026-01-01T00:00:05.000Z" }),
    events: async function* () {
      yield { kind: "status", binding: parsedBinding, status, observedAt: "2026-01-01T00:00:05.000Z" };
    },
  };
  assert.equal("stop" in observationPort, false);
  assert.equal("sendInput" in observationPort, false);
});
