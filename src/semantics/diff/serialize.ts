import { stableStringifyValue } from "../ir/canonical.js";
import { SEMANTIC_DELTA_KINDS, REVIEW_LEVELS } from "../ir/types.js";
import type { SemanticChangeSet } from "./types.js";
import { SEMANTIC_CHANGE_SET_VERSION } from "./types.js";

export interface SemanticChangeSetDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export type SemanticChangeSetValidationResult =
  | { ok: true; changeSet: SemanticChangeSet; diagnostics: readonly [] }
  | { ok: false; diagnostics: readonly SemanticChangeSetDiagnostic[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(code: string, message: string, path?: string): SemanticChangeSetDiagnostic {
  return { code, message, ...(path === undefined ? {} : { path }) };
}

/** Validate the versioned serialized contract without reclassifying its contents. */
export function validateSemanticChangeSet(input: unknown): SemanticChangeSetValidationResult {
  const errors: SemanticChangeSetDiagnostic[] = [];
  if (!isRecord(input))
    return { ok: false, diagnostics: [diagnostic("invalid_change_set", "semantic change set must be an object")] };
  if (input.version !== SEMANTIC_CHANGE_SET_VERSION)
    errors.push(diagnostic("unsupported_change_set_version", "unsupported semantic change set version", "version"));
  if (input.apiVersion !== "v1")
    errors.push(diagnostic("unsupported_change_set_api", "unsupported semantic change set API version", "apiVersion"));
  for (const field of ["baseSnapshotId", "headSnapshotId", "baseRevision", "headRevision", "reviewLevel"] as const) {
    if (typeof input[field] !== "string" || (field === "reviewLevel" && !REVIEW_LEVELS.includes(input[field] as never)))
      errors.push(diagnostic("invalid_change_set_field", `${field} is invalid`, field));
  }
  for (const field of [
    "changedFiles",
    "changedSymbols",
    "changedComponents",
    "derivedChanges",
    "semanticDeltas",
    "affectedEntities",
    "impactPaths",
    "propagationStopPoints",
    "evidenceRefreshNeeds",
    "unknownRegions",
    "recommendedSourceReads",
  ] as const) {
    if (!Array.isArray(input[field]))
      errors.push(diagnostic("invalid_change_set_field", `${field} must be an array`, field));
  }
  if (Array.isArray(input.semanticDeltas)) {
    for (const [index, delta] of input.semanticDeltas.entries()) {
      if (
        !isRecord(delta) ||
        !SEMANTIC_DELTA_KINDS.includes(delta.kind as never) ||
        !REVIEW_LEVELS.includes(delta.reviewLevel as never)
      )
        errors.push(
          diagnostic(
            "invalid_semantic_delta",
            "semantic delta kind/review level is invalid",
            `semanticDeltas.${index}`,
          ),
        );
    }
  }
  if (errors.length > 0) return { ok: false, diagnostics: errors };
  const field = <K extends keyof SemanticChangeSet>(key: K): SemanticChangeSet[K] => input[key] as SemanticChangeSet[K];
  const changeSet: SemanticChangeSet = {
    version: field("version"),
    apiVersion: field("apiVersion"),
    baseSnapshotId: field("baseSnapshotId"),
    headSnapshotId: field("headSnapshotId"),
    baseSnapshotDigest: field("baseSnapshotDigest"),
    headSnapshotDigest: field("headSnapshotDigest"),
    baseRevision: field("baseRevision"),
    headRevision: field("headRevision"),
    changedFiles: field("changedFiles"),
    changedSymbols: field("changedSymbols"),
    symbolChanges: field("symbolChanges"),
    changedComponents: field("changedComponents"),
    derivedChanges: field("derivedChanges"),
    semanticDeltas: field("semanticDeltas"),
    contractChanges: field("contractChanges"),
    effectChanges: field("effectChanges"),
    invariantChanges: field("invariantChanges"),
    dependencyPolicyChanges: field("dependencyPolicyChanges"),
    publicSurfaceChanges: field("publicSurfaceChanges"),
    responsibilityChanges: field("responsibilityChanges"),
    capabilityChanges: field("capabilityChanges"),
    authorizedVsActual: field("authorizedVsActual"),
    affectedEntities: field("affectedEntities"),
    impactPaths: field("impactPaths"),
    propagationStopPoints: field("propagationStopPoints"),
    evidenceRefreshNeeds: field("evidenceRefreshNeeds"),
    unknownRegions: field("unknownRegions"),
    reviewLevel: field("reviewLevel"),
    reviewReasons: field("reviewReasons"),
    recommendedSourceReads: field("recommendedSourceReads"),
    effectViolations: field("effectViolations"),
    provenance: field("provenance"),
  };
  return { ok: true, changeSet, diagnostics: [] };
}

export function serializeSemanticChangeSet(changeSet: SemanticChangeSet): string {
  const validation = validateSemanticChangeSet(changeSet);
  if (!validation.ok)
    throw new Error(
      `cannot serialize invalid semantic change set: ${validation.diagnostics.map((item) => item.code).join(",")}`,
    );
  return `${stableStringifyValue(validation.changeSet)}\n`;
}

export function parseSemanticChangeSet(serialized: string): SemanticChangeSetValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic("invalid_serialized_json", error instanceof Error ? error.message : "invalid JSON")],
    };
  }
  return validateSemanticChangeSet(value);
}
