import assert from "node:assert/strict";

/**
 * このリポジトリ全体で使われる `{ ok: true, ... } | { ok: false, ... }` 判別共用体向けの
 * narrowingアサーション。`assert.equal(result.ok, true); if (!result.ok) return;` の
 * 定型反復を1呼び出しに置き換える。
 */
export function assertOk<T extends { ok: boolean }>(result: T, message?: string): Extract<T, { ok: true }> {
  if (!result.ok) assert.fail(message ?? `expected ok result, got: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

export function assertErr<T extends { ok: boolean }>(result: T, message?: string): Extract<T, { ok: false }> {
  if (result.ok) assert.fail(message ?? `expected error result, got: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: false }>;
}

const REQUIRED_ENVELOPE_FIELDS = [
  "operation",
  "status",
  "summary",
  "facts",
  "diagnostics",
  "metrics",
  "result_id",
  "truncated",
] as const;

/**
 * gateway自前ツールの共通structured output契約（src/envelope.ts の OUTPUT_SCHEMA）を
 * 満たしているかを検証する。boundary/contractテストで、圧縮やproxy越しにフィールドが
 * 欠落していないことを確認する用途。
 */
export function assertEnvelopeShape(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", "expected an envelope object");
  const record = value as Record<string, unknown>;
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    assert.ok(field in record, `envelope is missing required field "${field}": ${JSON.stringify(record)}`);
  }
}
