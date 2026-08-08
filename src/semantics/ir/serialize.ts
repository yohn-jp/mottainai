import {
  canonicalizeSnapshot,
  computeIntegrityDigestsFromValidated,
  digestCanonicalValue,
  stableStringifyValue,
} from "./canonical.js";
import { validateSemanticTransaction, validateSnapshot } from "./schema.js";
import type {
  ContentDigest,
  RepositorySemanticSnapshot,
  SemanticTransaction,
  SnapshotValidationResult,
} from "./types.js";

export type ParseSnapshotResult = SnapshotValidationResult;
export type ParseSemanticTransactionResult = ReturnType<typeof validateSemanticTransaction>;

export { canonicalizeSnapshot, digestCanonicalValue };

export function serializeSnapshot(snapshot: RepositorySemanticSnapshot): string {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(
      `cannot serialize invalid semantic snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  return `${stableStringifyValue(canonicalizeSnapshot(validation.snapshot))}\n`;
}

export function parseSnapshot(serialized: string): ParseSnapshotResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "invalid_serialized_json",
          severity: "error",
          message: error instanceof Error ? error.message : "serialized semantic snapshot is not valid JSON",
        },
      ],
    };
  }
  const validation = validateSnapshot(value);
  return validation.ok
    ? { ok: true, snapshot: canonicalizeSnapshot(validation.snapshot), diagnostics: [] }
    : validation;
}

export function semanticEqualSnapshots(left: RepositorySemanticSnapshot, right: RepositorySemanticSnapshot): boolean {
  const leftValidation = validateSnapshot(left);
  const rightValidation = validateSnapshot(right);
  if (!leftValidation.ok || !rightValidation.ok) return false;
  return (
    stableStringifyValue(canonicalizeSnapshot(leftValidation.snapshot)) ===
    stableStringifyValue(canonicalizeSnapshot(rightValidation.snapshot))
  );
}

export function serializeSemanticTransaction(transaction: SemanticTransaction): string {
  const validation = validateSemanticTransaction(transaction);
  if (!validation.ok)
    throw new Error(
      `cannot serialize invalid semantic transaction: ${validation.diagnostics.map((item) => item.code).join(",")}`,
    );
  return `${stableStringifyValue(validation.transaction)}\n`;
}

export function parseSemanticTransaction(serialized: string): ParseSemanticTransactionResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "invalid_serialized_json",
          severity: "error",
          message: error instanceof Error ? error.message : "serialized semantic transaction is not valid JSON",
        },
      ],
    };
  }
  return validateSemanticTransaction(value);
}

function requireValidatedSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok)
    throw new Error(
      `cannot digest invalid semantic snapshot: ${validation.diagnostics.map((item) => item.code).join(",")}`,
    );
  return validation.snapshot;
}

export function computeSemanticStateDigest(snapshot: RepositorySemanticSnapshot): ContentDigest {
  return computeIntegrityDigestsFromValidated(requireValidatedSnapshot(snapshot)).semanticStateDigest;
}

export function computeModelDigest(snapshot: RepositorySemanticSnapshot): ContentDigest {
  return computeIntegrityDigestsFromValidated(requireValidatedSnapshot(snapshot)).modelDigest;
}

export function computeSnapshotDigest(snapshot: RepositorySemanticSnapshot): ContentDigest {
  return computeIntegrityDigestsFromValidated(requireValidatedSnapshot(snapshot)).snapshotDigest;
}
