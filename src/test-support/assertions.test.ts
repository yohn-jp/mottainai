import assert from "node:assert/strict";
import test from "node:test";
import { assertEnvelopeShape, assertError, assertOk } from "./assertions.js";

function validEnvelope(): Record<string, unknown> {
  return { operation: "list", status: "success", summary: "ok", facts: [], diagnostics: [], metrics: {}, result_id: "r1", truncated: false };
}

test("assertOk returns the value on an ok result and throws on a failure result", () => {
  assert.deepEqual(assertOk({ ok: true, value: 1 }), { ok: true, value: 1 });
  assert.throws(() => assertOk({ ok: false, reason: "nope" }));
});

test("assertError returns the value on a failure result and throws on an ok result", () => {
  assert.deepEqual(assertError({ ok: false, reason: "nope" }), { ok: false, reason: "nope" });
  assert.throws(() => assertError({ ok: true, value: 1 }));
});

test("assertEnvelopeShape accepts a well-formed envelope", () => {
  assert.doesNotThrow(() => assertEnvelopeShape(validEnvelope()));
});

test("assertEnvelopeShape rejects a wrong primitive type on a required field", () => {
  assert.throws(() => assertEnvelopeShape({ ...validEnvelope(), operation: 42 }));
});

test("assertEnvelopeShape rejects a wrong container type on a required field", () => {
  assert.throws(() => assertEnvelopeShape({ ...validEnvelope(), facts: {} }));
});

test("assertEnvelopeShape rejects a top-level array even if it carries the required keys", () => {
  const arrayEnvelope = Object.assign([], validEnvelope());
  assert.throws(() => assertEnvelopeShape(arrayEnvelope));
});

test("assertEnvelopeShape rejects required fields that are only inherited, not own properties", () => {
  const { operation, ...rest } = validEnvelope();
  const inherited = Object.create({ operation }) as Record<string, unknown>;
  Object.assign(inherited, rest);
  assert.throws(() => assertEnvelopeShape(inherited));
});
