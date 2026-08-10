import {
  applyResponseBudget,
  projectedBytes,
  projectedTokens,
  resolveResponseBudget,
} from "../../context-runtime/budget.js";
import type { ProjectedField, ProjectedResult } from "../../context-runtime/types.js";
import type {
  ProjectionBudgetMetadata,
  ProjectionOmission,
  SemanticProjectionBudget,
  SemanticProjectionBudgetOptions,
  SemanticProjectionPriority,
} from "./types.js";

const DEFAULT_STRUCTURAL_LIMITS = {
  maxChanges: 32,
  maxEvidence: 24,
  maxFacts: 48,
  maxGuidance: 8,
  maxImpactPaths: 24,
  maxRationales: 8,
  maxRelations: 64,
  maxSourceReads: 24,
  maxSymbols: 48,
} as const;

export interface ProjectionFieldGroup {
  field: string;
  value: unknown;
  priority: SemanticProjectionPriority;
  emptyValue: unknown;
  omissionReason: string;
  count?: number;
}

export interface BudgetedProjection<T> {
  value: T;
  omissions: readonly ProjectionOmission[];
  budget: ProjectionBudgetMetadata;
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`invalid semantic projection ${field}`);
  return resolved;
}

export function resolveSemanticProjectionBudget(
  options: SemanticProjectionBudgetOptions = {},
): SemanticProjectionBudget {
  return {
    ...resolveResponseBudget(options),
    maxChanges: positiveLimit(options.maxChanges, DEFAULT_STRUCTURAL_LIMITS.maxChanges, "maxChanges"),
    maxEvidence: positiveLimit(options.maxEvidence, DEFAULT_STRUCTURAL_LIMITS.maxEvidence, "maxEvidence"),
    maxFacts: positiveLimit(options.maxFacts, DEFAULT_STRUCTURAL_LIMITS.maxFacts, "maxFacts"),
    maxGuidance: positiveLimit(options.maxGuidance, DEFAULT_STRUCTURAL_LIMITS.maxGuidance, "maxGuidance"),
    maxImpactPaths: positiveLimit(options.maxImpactPaths, DEFAULT_STRUCTURAL_LIMITS.maxImpactPaths, "maxImpactPaths"),
    maxRationales: positiveLimit(options.maxRationales, DEFAULT_STRUCTURAL_LIMITS.maxRationales, "maxRationales"),
    maxRelations: positiveLimit(options.maxRelations, DEFAULT_STRUCTURAL_LIMITS.maxRelations, "maxRelations"),
    maxSourceReads: positiveLimit(options.maxSourceReads, DEFAULT_STRUCTURAL_LIMITS.maxSourceReads, "maxSourceReads"),
    maxSymbols: positiveLimit(options.maxSymbols, DEFAULT_STRUCTURAL_LIMITS.maxSymbols, "maxSymbols"),
  };
}

function priorityForRuntime(priority: SemanticProjectionPriority): ProjectedField["priority"] {
  switch (priority) {
    case "required":
    case "semantic":
      return "actionable";
    case "navigation":
      return "retrieval";
    case "evidence":
      return "test";
    case "verbose":
      return "verbose";
  }
}

function omission(group: ProjectionFieldGroup): ProjectionOmission {
  return {
    field: group.field,
    reason: group.omissionReason,
    ...(group.count === undefined ? {} : { count: group.count }),
    priority: group.priority,
  };
}

function makeRuntimeResult(
  base: Record<string, unknown>,
  groups: readonly ProjectionFieldGroup[],
  selected: ReadonlySet<string>,
  omissions: readonly ProjectionOmission[],
): ProjectedResult {
  const fields: ProjectedField[] = groups
    .filter((group) => selected.has(group.field))
    .map((group) => ({ key: group.field, value: group.value, priority: priorityForRuntime(group.priority) }));
  const runtimeOmissions = omissions.map((item) => ({
    field: item.field,
    reason: item.reason,
    retrievalAvailable: false,
  }));
  return {
    operation: typeof base.kind === "string" ? `semantic_${base.kind}` : "semantic_projection",
    status: typeof base.status === "string" ? base.status : "success",
    summary: typeof base.summary === "string" ? base.summary : "semantic projection",
    facts: [],
    diagnostics: [],
    metrics: {},
    resultId: "",
    truncated: runtimeOmissions.length > 0,
    fields,
    omissions: runtimeOmissions,
    content: [],
  };
}

function materialize<T extends Record<string, unknown>>(
  base: T,
  groups: readonly ProjectionFieldGroup[],
  selected: ReadonlySet<string>,
  omissions: readonly ProjectionOmission[],
  budget: ProjectionBudgetMetadata,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const group of groups) result[group.field] = selected.has(group.field) ? group.value : group.emptyValue;
  result.omissions = omissions;
  result.budget = budget;
  return result as T;
}

function bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface CompactLimits {
  maxArrayItems: number;
  maxObjectEntries: number;
  maxStringBytes: number;
}

const DEFAULT_COMPACT_LIMITS: CompactLimits = {
  maxArrayItems: 3,
  maxObjectEntries: 8,
  maxStringBytes: 160,
};

function compactString(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > maxBytes) return "";
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = marker;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${marker}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function compactEnvelopeValue(
  value: unknown,
  key = "",
  depth = 0,
  limits: CompactLimits = DEFAULT_COMPACT_LIMITS,
  preserveObjectKeys = false,
): unknown {
  if (typeof value === "string") return compactString(value, limits.maxStringBytes);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value
      .slice(0, limits.maxArrayItems)
      .map((item) => compactEnvelopeValue(item, key, depth + 1, limits, preserveObjectKeys));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const selected = preserveObjectKeys
      ? entries
      : entries.slice(0, depth > 2 ? Math.min(5, limits.maxObjectEntries) : limits.maxObjectEntries);
    return Object.fromEntries(
      selected.map(([entryKey, entryValue]) => [
        entryKey,
        compactEnvelopeValue(entryValue, entryKey, depth + 1, limits, preserveObjectKeys),
      ]),
    );
  }
  return undefined;
}

function compactContractValue(value: unknown, key: string, limits: CompactLimits): unknown {
  // Keep known discriminator/status values valid while compacting malformed text.
  const knownContractValues = new Set([
    "agent",
    "review",
    "jsdoc",
    "project",
    "component",
    "symbol",
    "file",
    "entity",
    "declared",
    "derived",
    "observed",
    "analysis",
    "integrity",
    "fresh",
    "stale",
    "invalid",
    "unavailable",
    "unknown",
    "partial",
    "fixture",
    "success",
    "en",
    "L0",
    "L1",
    "L2",
    "L3",
  ]);
  if (
    typeof value === "string" &&
    ["canonicalLanguage", "kind", "scope", "authority", "status", "integrity", "reviewLevel"].includes(key) &&
    knownContractValues.has(value)
  )
    return value;
  return compactEnvelopeValue(value, key, 0, limits);
}

function compactEntityProvenance(value: unknown, limits: CompactLimits): Record<string, unknown> {
  const provenance = value as Record<string, unknown> | undefined;
  const producer = provenance?.producer as Record<string, unknown> | undefined;
  const sourceRevision = provenance?.sourceRevision as Record<string, unknown> | undefined;
  return {
    kind: typeof provenance?.kind === "string" ? provenance.kind : "inferred",
    producer: {
      name: compactString(typeof producer?.name === "string" ? producer.name : "", limits.maxStringBytes),
      version: compactString(typeof producer?.version === "string" ? producer.version : "", limits.maxStringBytes),
    },
    sourceRevision: {
      repositoryId: compactString(
        typeof sourceRevision?.repositoryId === "string" ? sourceRevision.repositoryId : "",
        limits.maxStringBytes,
      ),
    },
  };
}

function minimalEnvelope(
  base: Record<string, unknown>,
  limits: CompactLimits = DEFAULT_COMPACT_LIMITS,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["apiVersion", "kind", "canonicalLanguage", "locale", "reviewLevel", "reviewReasons"]) {
    if (base[key] !== undefined) result[key] = compactContractValue(base[key], key, limits);
  }
  const target = base.target as Record<string, unknown> | undefined;
  if (target !== undefined) {
    result.target = Object.fromEntries(
      ["id", "kind", "name", "scope", "authority", "provenance", "authoritative"]
        .filter((key) => target[key] !== undefined)
        .map((key) => [
          key,
          key === "provenance"
            ? compactEntityProvenance(target[key], limits)
            : compactContractValue(target[key], key, limits),
        ]),
    );
  }
  const model = base.model as Record<string, unknown> | undefined;
  if (model !== undefined) {
    result.model = Object.fromEntries(
      ["status", "integrity", "authoritative"]
        .filter((key) => model[key] !== undefined)
        .map((key) => [key, compactContractValue(model[key], key, limits)]),
    );
  }
  const source = base.source as Record<string, unknown> | undefined;
  if (source !== undefined)
    result.source = {
      available: false,
      reason: compactString("raw source bodies excluded; use explicit escalation targets", limits.maxStringBytes),
    };
  const provenance = base.provenance as Record<string, unknown> | undefined;
  if (provenance !== undefined) {
    result.provenance = Object.fromEntries(
      ["provider", "authority", "status", "authoritative", "note"]
        .filter((key) => provenance[key] !== undefined)
        .map((key) => [key, compactContractValue(provenance[key], key, limits)]),
    );
  }
  return result;
}

function compactOmissions(omissions: readonly ProjectionOmission[], maxStringBytes = 96): ProjectionOmission[] {
  const seen = new Set<string>();
  return omissions
    .filter((item) => {
      if (seen.has(item.field)) return false;
      seen.add(item.field);
      return true;
    })
    .slice(0, 8)
    .map((item) => ({
      ...item,
      field: compactString(item.field, maxStringBytes),
      reason: compactString(item.reason, maxStringBytes),
    }));
}

function budgetMetadata(
  resolved: SemanticProjectionBudget,
  value: unknown,
  truncated: boolean,
): ProjectionBudgetMetadata {
  const projectedBytesValue = bytes(value);
  return {
    softTokens: resolved.softTokens,
    hardTokens: resolved.hardTokens,
    hardBytes: resolved.hardBytes,
    projectedBytes: projectedBytesValue,
    projectedTokens: Math.ceil(projectedBytesValue / 4),
    truncated,
  };
}

function materializeWithBudget<T extends Record<string, unknown>>(
  base: T,
  groups: readonly ProjectionFieldGroup[],
  selected: ReadonlySet<string>,
  omissions: readonly ProjectionOmission[],
  resolved: SemanticProjectionBudget,
  truncated: boolean,
): { value: T; budget: ProjectionBudgetMetadata } {
  const initialMetadata: ProjectionBudgetMetadata = {
    softTokens: resolved.softTokens,
    hardTokens: resolved.hardTokens,
    hardBytes: resolved.hardBytes,
    projectedBytes: 0,
    projectedTokens: 0,
    truncated,
  };
  let value = materialize(base, groups, selected, omissions, initialMetadata);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const nextMetadata = budgetMetadata(resolved, value, truncated);
    const nextValue = materialize(base, groups, selected, omissions, nextMetadata);
    if (
      nextMetadata.projectedBytes === bytes(nextValue) &&
      nextMetadata.projectedTokens === Math.ceil(nextMetadata.projectedBytes / 4)
    ) {
      return { value: nextValue, budget: nextMetadata };
    }
    value = nextValue;
  }
  const finalMetadata = budgetMetadata(resolved, value, truncated);
  const finalValue = materialize(base, groups, selected, omissions, finalMetadata);
  return { value: finalValue, budget: budgetMetadata(resolved, finalValue, truncated) };
}

function compactFallbackGroups(
  groups: readonly ProjectionFieldGroup[],
  selected: ReadonlySet<string>,
  limits: CompactLimits,
): ProjectionFieldGroup[] {
  return groups.map((group) => ({
    ...group,
    value: selected.has(group.field) ? compactEnvelopeValue(group.value, group.field, 0, limits) : undefined,
    // Every declared projection field is materialized on the fallback path.
    // Preserve empty object keys as well as the top-level field itself so a
    // compact envelope remains a valid projection contract.
    emptyValue: compactEnvelopeValue(group.emptyValue, group.field, 0, limits, true),
  }));
}

function lastResortEnvelope(
  base: Record<string, unknown>,
  groups: readonly ProjectionFieldGroup[],
  resolved: SemanticProjectionBudget,
  omissions: readonly ProjectionOmission[],
): { value: Record<string, unknown>; budget: ProjectionBudgetMetadata } {
  const omissionMetadata = compactOmissions(omissions, 64).slice(0, 1);
  let fallback: { value: Record<string, unknown>; budget: ProjectionBudgetMetadata } | undefined;
  for (const maxStringBytes of [64, 32, 16, 8, 4, 3, 2, 1]) {
    const limits: CompactLimits = { maxArrayItems: 0, maxObjectEntries: 8, maxStringBytes };
    fallback = materializeWithBudget(
      minimalEnvelope(base, limits),
      compactFallbackGroups(groups, new Set(), limits),
      new Set(),
      omissionMetadata,
      resolved,
      true,
    );
    if (bytes(fallback.value) <= Math.min(resolved.hardBytes, resolved.hardTokens * 4)) return fallback;
  }
  return fallback!;
}

/**
 * Applies the shared #70 response budget to structured semantic fields.
 * Fields are removed as whole values; JSON is never cut at an arbitrary byte.
 */
export function budgetStructuredProjection<T extends Record<string, unknown>>(
  base: T,
  groups: readonly ProjectionFieldGroup[],
  options: SemanticProjectionBudgetOptions = {},
  initialOmissions: readonly ProjectionOmission[] = [],
): BudgetedProjection<T> {
  const resolved = resolveSemanticProjectionBudget(options);
  const all = new Set(groups.map((group) => group.field));
  const mandatory = new Set(groups.filter((group) => group.priority === "required").map((group) => group.field));
  const runtime = applyResponseBudget(makeRuntimeResult(base, groups, all, initialOmissions), resolved);
  const runtimeFields = new Set(runtime.fields.map((field) => field.key));
  const selected = new Set([
    ...mandatory,
    ...groups.filter((group) => runtimeFields.has(group.field)).map((group) => group.field),
  ]);
  let omissions = [...initialOmissions];
  for (const group of groups) {
    if (!selected.has(group.field) && !omissions.some((item) => item.field === group.field))
      omissions.push(omission(group));
  }

  const current = (): { value: T; budget: ProjectionBudgetMetadata } =>
    materializeWithBudget(
      base,
      groups,
      selected,
      omissions,
      resolved,
      omissions.length > 0 || selected.size < all.size,
    );

  let bounded = current();
  let value = bounded.value;
  const hardBytes = Math.min(resolved.hardBytes, resolved.hardTokens * 4);
  if (bytes(value) > hardBytes) {
    const removable = groups.filter((group) => !mandatory.has(group.field)).reverse();
    for (const group of removable) {
      if (!selected.delete(group.field)) continue;
      if (!omissions.some((item) => item.field === group.field)) omissions.push(omission(group));
      bounded = current();
      value = bounded.value;
      if (bytes(value) <= hardBytes) break;
    }
  }

  // Keep required uncertainty and exact source-read fields in a compact,
  // explicit envelope when required values themselves are too large.  This
  // path is intentionally copy-on-write: callers retain their original base
  // and field groups unchanged.
  if (bytes(value) > hardBytes) {
    const fallbackSelected = new Set(mandatory);
    const fallbackOmissions = compactOmissions([
      ...omissions,
      {
        field: "optional_projection_data",
        reason: "fields omitted under hard response budget; expand by requesting a larger budget",
        count: groups.length + omissions.length,
        priority: "verbose",
      },
    ]);
    const compactLimits: CompactLimits[] = [
      { maxArrayItems: 3, maxObjectEntries: 8, maxStringBytes: 160 },
      { maxArrayItems: 2, maxObjectEntries: 6, maxStringBytes: 96 },
      { maxArrayItems: 1, maxObjectEntries: 5, maxStringBytes: 64 },
      { maxArrayItems: 1, maxObjectEntries: 4, maxStringBytes: 32 },
      { maxArrayItems: 0, maxObjectEntries: 3, maxStringBytes: 24 },
    ];
    for (const limits of compactLimits) {
      const fallback = materializeWithBudget(
        minimalEnvelope(base, limits),
        compactFallbackGroups(groups, fallbackSelected, limits),
        fallbackSelected,
        fallbackOmissions,
        resolved,
        true,
      );
      if (bytes(fallback.value) <= hardBytes) {
        return { value: fallback.value as T, omissions: fallbackOmissions, budget: fallback.budget };
      }
    }

    const explicitFallback = lastResortEnvelope(base, groups, resolved, [
      ...fallbackOmissions,
      {
        field: "required_projection_data",
        reason: "required uncertainty/source-read data could not fit; request a larger hard budget",
        priority: "required",
      },
    ]);
    return {
      value: explicitFallback.value as T,
      omissions: (explicitFallback.value.omissions as ProjectionOmission[] | undefined) ?? [],
      budget: explicitFallback.budget,
    };
  }

  return { value, omissions, budget: bounded.budget };
}

export function capItems<T>(
  items: readonly T[],
  limit: number,
  field: string,
  reason: string,
  priority: SemanticProjectionPriority,
): { items: readonly T[]; omission?: ProjectionOmission } {
  if (items.length <= limit) return { items: [...items] };
  return {
    items: items.slice(0, limit),
    omission: { field, reason, count: items.length - limit, priority },
  };
}

export function projectionSize(value: unknown): { bytes: number; tokens: number } {
  return { bytes: projectedBytes(value as ProjectedResult), tokens: projectedTokens(value as ProjectedResult) };
}
