import assert from "node:assert/strict";
import test from "node:test";
import {
  CERTIFICATION_BASE_SHA,
  CERTIFICATION_BRANCH,
  CertificationExternalBlocker,
  CertificationProductDefect,
  assertBodyFreeEvidence,
  assertObservationReadOnly,
  classifyProviderFailure,
  compactWorkerProjection,
} from "./pi-runtime-certification.mjs";

test("certification is pinned to the governed immutable base and branch", () => {
  assert.equal(CERTIFICATION_BASE_SHA, "f5e9268a5a40fcfaafc4bb8c4087a18917bfaeaf");
  assert.equal(CERTIFICATION_BRANCH, "test/956-pi-runtime-certification");
});

test("provider credential failures are external blockers, not certification success", () => {
  const blocker = classifyProviderFailure(new Error("No API key found for the selected model"));
  assert.deepEqual(blocker, {
    code: "external-provider-unavailable",
    detail: "No API key found for the selected model",
  });
  assert.equal(classifyProviderFailure(new Error("Pi Mottainai runtime binding is not active")), undefined);
  assert.ok(new CertificationExternalBlocker("provider unavailable") instanceof Error);
});

test("compact worker evidence contains only bounded supervision fields", () => {
  const projection = compactWorkerProjection({
    identity: {
      managerSessionId: "manager",
      runtimeId: "runtime",
      taskId: "task",
      executionSessionId: "execution",
      provider: "pi",
      agentKind: "pi",
      runtimeName: "mottainai-manager-x",
    },
    observationState: "current",
    observedAt: "2026-09-22T00:00:00.000Z",
    runtimeState: "running",
    semanticLifecycleState: "active",
    lifecycleState: "running",
    phase: "executing",
    activity: { kind: "working", label: "fixture" },
    progress: { completed: 1, current: "step", remaining: 1 },
    attention: "none",
    blockerCode: null,
    usage: null,
    context: null,
    diagnosticEvents: [{ kind: "status" }],
  });
  assert.deepEqual(projection.identity.provider, "pi");
  assert.deepEqual(projection.progress, { completed: 1, current: "step", remaining: 1 });
  assert.equal(projection.diagnosticEventCount, 1);
  assertBodyFreeEvidence(projection);
  assert.throws(
    () => assertBodyFreeEvidence({ status: "running", transcript: "provider body" }),
    CertificationProductDefect,
  );
});

test("repeated status reads cannot deliver implicit Pi input or control", () => {
  const before = ["subscribe", "prompt"];
  const after = [...before, "observe", "observe"];
  assert.deepEqual(assertObservationReadOnly(before, after), ["observe", "observe"]);
  assert.throws(() => assertObservationReadOnly(before, [...before, "abort"]), CertificationProductDefect);
  assert.throws(() => assertObservationReadOnly(before, [...before, "steer"]), CertificationProductDefect);
});
