import assert from "node:assert/strict";
import { OUTPUT_SCHEMA } from "../envelope.js";

/**
 * このリポジトリ全体で使われる `{ ok: true, ... } | { ok: false, ... }` 判別共用体向けの
 * narrowingアサーション。`assert.equal(result.ok, true); if (!result.ok) return;` の
 * 定型反復を1呼び出しに置き換える。
 */
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

/**
 * gateway自前ツールの共通structured output契約（src/envelope.ts の OUTPUT_SCHEMA）を
 * 満たしているかを検証する。フィールドの有無だけでなく型も見るのは、圧縮やproxy越しに
 * フィールドの中身が壊れる回帰（配列がオブジェクトになる等）を素通りさせないため。
 */
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
