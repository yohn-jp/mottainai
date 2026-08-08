import assert from "node:assert/strict";
import { OUTPUT_SCHEMA } from "../envelope.js";

// 結果判別の定型反復を避け、各テストが境界契約の検証に集中できるようにする。
export function assertOk<T extends { ok: boolean }>(result: T, message?: string): Extract<T, { ok: true }> {
  if (!result.ok) assert.fail(message ?? `expected ok result, got: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

export function assertError<T extends { ok: boolean }>(result: T, message?: string): Extract<T, { ok: false }> {
  if (result.ok) assert.fail(message ?? `expected error result, got: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: false }>;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

// transport境界でstructured outputの型崩れを見逃さないため。
export function assertEnvelopeShape(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `expected an envelope object, got: ${JSON.stringify(value)}`,
  );
  const record = value as Record<string, unknown>;
  for (const [field, schema] of Object.entries(OUTPUT_SCHEMA.properties)) {
    if (!OUTPUT_SCHEMA.required.includes(field)) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(record, field),
      `envelope is missing required own field "${field}": ${JSON.stringify(record)}`,
    );
    assert.ok(
      matchesJsonSchemaType(record[field], schema.type),
      `envelope field "${field}" must be of type "${schema.type}", got: ${JSON.stringify(record[field])}`,
    );
  }
}
