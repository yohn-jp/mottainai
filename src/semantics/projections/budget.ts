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
  groups: ProjectionFieldGroup[],
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
  groups: ProjectionFieldGroup[],
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
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactEnvelopeValue(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") {
    if (["id", "path", "symbol", "sourceRevision", "revision", "modelDigest"].includes(key)) return value;
    return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactEnvelopeValue(item, key, depth + 1));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const selected = depth > 2 ? entries.slice(0, 5) : entries;
    return Object.fromEntries(
      selected.map(([entryKey, entryValue]) => [entryKey, compactEnvelopeValue(entryValue, entryKey, depth + 1)]),
    );
  }
  return undefined;
}

function minimalEnvelope(base: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["apiVersion", "kind", "canonicalLanguage", "locale", "reviewLevel", "reviewReasons"]) {
    if (base[key] !== undefined) result[key] = compactEnvelopeValue(base[key], key);
  }
  const target = base.target as Record<string, unknown> | undefined;
  if (target !== undefined) {
    result.target = Object.fromEntries(
      ["id", "kind", "name", "scope", "authority", "authoritative"]
        .filter((key) => target[key] !== undefined)
        .map((key) => [key, compactEnvelopeValue(target[key], key)]),
    );
  }
  const model = base.model as Record<string, unknown> | undefined;
  if (model !== undefined) {
    result.model = Object.fromEntries(
      ["status", "integrity", "authoritative", "revision", "reason"]
        .filter((key) => model[key] !== undefined)
        .map((key) => [key, compactEnvelopeValue(model[key], key)]),
    );
  }
  const source = base.source as Record<string, unknown> | undefined;
  if (source !== undefined)
    result.source = { available: false, reason: "raw source bodies excluded; use explicit escalation targets" };
  const provenance = base.provenance as Record<string, unknown> | undefined;
  if (provenance !== undefined) {
    result.provenance = Object.fromEntries(
      ["provider", "authority", "status", "authoritative"]
        .filter((key) => provenance[key] !== undefined)
        .map((key) => [key, compactEnvelopeValue(provenance[key], key)]),
    );
  }
  return result;
}

function compactOmissions(omissions: readonly ProjectionOmission[]): ProjectionOmission[] {
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
      reason: item.reason.length > 96 ? `${item.reason.slice(0, 93)}…` : item.reason,
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

/**
 * Applies the shared #70 response budget to structured semantic fields.
 * Fields are removed as whole values; JSON is never cut at an arbitrary byte.
 */
export function budgetStructuredProjection<T extends Record<string, unknown>>(
  base: T,
  groups: ProjectionFieldGroup[],
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

  const current = (): T => {
    const provisional = materialize(base, groups, selected, omissions, budgetMetadata(resolved, base, true));
    const metadata = budgetMetadata(resolved, provisional, omissions.length > 0);
    return materialize(base, groups, selected, omissions, metadata);
  };

  let value = current();
  const hardBytes = Math.min(resolved.hardBytes, resolved.hardTokens * 4);
  if (bytes(value) > hardBytes) {
    const removable = groups.filter((group) => !mandatory.has(group.field)).reverse();
    for (const group of removable) {
      if (!selected.delete(group.field)) continue;
      if (!omissions.some((item) => item.field === group.field)) omissions.push(omission(group));
      value = current();
      if (bytes(value) <= hardBytes) break;
    }
  }

  // Keep the required envelope and explicit omission metadata even when a
  // caller supplied a pathological amount of required prose.
  if (bytes(value) > hardBytes) {
    for (const group of groups) selected.delete(group.field);
    omissions = compactOmissions([
      {
        field: "optional_projection_data",
        reason: "fields omitted under hard response budget; expand by requesting a larger budget",
        count: groups.length + omissions.length,
        priority: "verbose",
      },
    ]);
    for (const group of groups) group.emptyValue = undefined;
    const compactedBase = minimalEnvelope(base);
    const compactedUnknowns = groups.find((group) => group.field === "unknowns");
    if (compactedUnknowns !== undefined) {
      selected.add("unknowns");
      const index = groups.indexOf(compactedUnknowns);
      groups[index] = { ...compactedUnknowns, value: compactEnvelopeValue(compactedUnknowns.value, "unknowns") };
    }
    for (const key of Object.keys(base)) delete base[key];
    Object.assign(base, compactedBase);
    value = current();
  }

  const finalMetadata = budgetMetadata(resolved, value, omissions.length > 0 || selected.size < all.size);
  value = materialize(base, groups, selected, omissions, finalMetadata);
  return { value, omissions, budget: finalMetadata };
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
