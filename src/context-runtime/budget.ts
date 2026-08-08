import { addOmission, serializeProjectedResult } from "./project.js";
import type { ProjectedField, ProjectedResult, ProjectionBudget, ProjectionBudgetConfig } from "./types.js";

export const DEFAULT_RESPONSE_BUDGET: ProjectionBudget = {
  softTokens: 1_500,
  hardTokens: 3_000,
  hardBytes: 12_000,
};

export const MIN_RESPONSE_BUDGET = {
  softTokens: 128,
  hardTokens: 256,
  hardBytes: 1_024,
} as const;

const ESSENTIAL_METRIC_KEYS = new Set([
  "calls",
  "errors",
  "retrievals",
  "providers",
  "ready",
  "unhealthy",
  "disabled",
  "duration_ms",
  "exit_code",
  "stdout_bytes",
  "stderr_bytes",
  "returned_bytes",
  "raw_bytes",
  "stored_bytes",
  "omitted_bytes",
  "target_tokens",
  "projected_tokens",
  "budget_target_tokens",
  "omitted_matches",
]);

function positiveInteger(value: number | undefined, fallback: number, field: string, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) throw new Error(`invalid response budget ${field}`);
  return resolved;
}

export function resolveResponseBudget(config?: ProjectionBudgetConfig): ProjectionBudget {
  const hardTokens = positiveInteger(
    config?.hardTokens,
    DEFAULT_RESPONSE_BUDGET.hardTokens,
    "hardTokens",
    MIN_RESPONSE_BUDGET.hardTokens,
  );
  const softTokens = positiveInteger(
    config?.softTokens,
    DEFAULT_RESPONSE_BUDGET.softTokens,
    "softTokens",
    MIN_RESPONSE_BUDGET.softTokens,
  );
  if (softTokens > hardTokens) throw new Error("invalid response budget: softTokens must not exceed hardTokens");
  const hardBytes = positiveInteger(config?.hardBytes, hardTokens * 4, "hardBytes", MIN_RESPONSE_BUDGET.hardBytes);
  return { softTokens, hardTokens, hardBytes };
}

export function projectedBytes(result: ProjectedResult): number {
  const serialized = serializeProjectedResult(result);
  return Buffer.byteLength(
    JSON.stringify({
      content: serialized.content,
      structuredContent: serialized.structuredContent,
      ...(serialized.isError === undefined ? {} : { isError: serialized.isError }),
      ...(serialized.meta === undefined ? {} : { _meta: serialized.meta }),
    }),
    "utf8",
  );
}

export function projectedTokens(result: ProjectedResult): number {
  return Math.ceil(projectedBytes(result) / 4);
}

function fits(result: ProjectedResult, byteLimit: number): boolean {
  return projectedBytes(result) <= byteLimit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactString(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return marker.slice(0, 1);
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = "";
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
  return best || marker;
}

function compactValue(value: unknown, maxBytes = 256): unknown {
  if (typeof value === "string") return compactString(value, maxBytes);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 16).map((entry) => compactValue(entry, Math.max(32, Math.floor(maxBytes / 2))));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().slice(0, 12)) {
      result[key] = compactValue(value[key], Math.max(32, Math.floor(maxBytes / 2)));
    }
    return result;
  }
  return String(value);
}

function isBlockingDiagnostic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const severity = typeof value.severity === "string" ? value.severity.toLowerCase() : "";
  if (["error", "fatal", "blocking"].includes(severity)) return true;
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  return /error|failed|failure|exception|timeout/.test(message);
}

function compactDiagnostics(diagnostics: unknown[]): unknown[] {
  const blocking = diagnostics.filter(isBlockingDiagnostic);
  const selected = (blocking.length > 0 ? blocking : diagnostics).slice(0, 8);
  return selected.map((value) => {
    if (!isRecord(value)) return compactValue(value, 512);
    const result: Record<string, unknown> = {};
    for (const key of ["severity", "code", "message", "path", "line", "column"]) {
      if (value[key] !== undefined) result[key] = compactValue(value[key], key === "message" ? 256 : 128);
    }
    return Object.keys(result).length === 0 ? compactValue(value, 512) : result;
  });
}

function isActionableFact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  return /error|fail|missing|conflict|recovery|artifact|command/.test(kind) || value.severity === "error";
}

function compactFacts(facts: unknown[]): unknown[] {
  const actionable = facts.filter(isActionableFact);
  const selected = [...actionable, ...facts.filter((value) => !actionable.includes(value))].slice(0, 16);
  return selected.map((value) => compactValue(value, 512));
}

function compactMetrics(metrics: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(metrics).sort((left, right) => {
    const leftEssential = ESSENTIAL_METRIC_KEYS.has(left) ? 0 : 1;
    const rightEssential = ESSENTIAL_METRIC_KEYS.has(right) ? 0 : 1;
    return leftEssential - rightEssential || left.localeCompare(right);
  });
  const result: Record<string, unknown> = {};
  let optionalCount = 0;
  for (const key of keys) {
    if (!ESSENTIAL_METRIC_KEYS.has(key)) {
      if (optionalCount >= 4) continue;
      optionalCount += 1;
    }
    result[key] = compactValue(metrics[key], 64);
  }
  return result;
}

function compactTestResults(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "format",
    "total",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
    "output_omitted",
    "result_id",
  ]) {
    if (value[key] !== undefined) result[key] = compactValue(value[key], 128);
  }
  if (Array.isArray(value.failures)) {
    result.failures = value.failures.slice(0, 8).map((failure) => compactValue(failure, 512));
  }
  return result;
}

function compactExcerptFields(result: ProjectedResult): ProjectedResult {
  let changed = false;
  const fields = result.fields.map((field) => {
    if (field.priority !== "excerpt" || typeof field.value !== "string") return field;
    const value = compactString(field.value, 2_048);
    changed ||= value !== field.value;
    return value === field.value ? field : { ...field, value };
  });
  return changed
    ? addOmission(
        { ...result, fields },
        { field: "excerpts", reason: "diagnostic excerpt bounded", retrievalAvailable: result.resultId.length > 0 },
      )
    : result;
}

function compactStructuredParts(result: ProjectedResult): ProjectedResult {
  let current = result;
  const diagnostics = compactDiagnostics(current.diagnostics);
  if (JSON.stringify(diagnostics) !== JSON.stringify(current.diagnostics)) {
    current = addOmission(
      { ...current, diagnostics },
      {
        field: "diagnostics",
        reason: "non-blocking diagnostic detail bounded",
        retrievalAvailable: current.resultId.length > 0,
      },
    );
  }
  const facts = compactFacts(current.facts);
  if (JSON.stringify(facts) !== JSON.stringify(current.facts)) {
    current = addOmission(
      { ...current, facts },
      {
        field: "facts",
        reason: "low-priority facts bounded",
        retrievalAvailable: current.resultId.length > 0,
      },
    );
  }
  const metrics = compactMetrics(current.metrics);
  if (JSON.stringify(metrics) !== JSON.stringify(current.metrics)) {
    current = addOmission(
      { ...current, metrics },
      {
        field: "metrics",
        reason: "non-essential metrics bounded",
        retrievalAvailable: current.resultId.length > 0,
      },
    );
  }
  if (current.testResults !== undefined) {
    const testResults = compactTestResults(current.testResults);
    if (JSON.stringify(testResults) !== JSON.stringify(current.testResults)) {
      current = addOmission(
        { ...current, testResults },
        {
          field: "test_results",
          reason: "structured test detail bounded",
          retrievalAvailable: current.resultId.length > 0,
        },
      );
    }
  }
  return compactExcerptFields(current);
}

function dropFieldsByPriority(result: ProjectedResult, target: ProjectedField["priority"]): ProjectedResult {
  const fields = result.fields.filter((field) => field.priority !== target);
  if (fields.length === result.fields.length) return result;
  const dropped = result.fields.filter((field) => field.priority === target);
  const field = dropped.length === 1 ? dropped[0].key : `${target}_fields`;
  return addOmission(
    { ...result, fields },
    {
      field,
      reason: `${dropped.length} lower-priority ${target} field${dropped.length === 1 ? "" : "s"} omitted`,
      retrievalAvailable: result.resultId.length > 0,
    },
  );
}

function dropTestResults(result: ProjectedResult): ProjectedResult {
  if (result.testResults === undefined) return result;
  return addOmission(
    { ...result, testResults: undefined },
    {
      field: "test_results",
      reason: "structured test detail omitted under response budget",
      retrievalAvailable: result.resultId.length > 0,
    },
  );
}

function dropMetrics(result: ProjectedResult): ProjectedResult {
  if (Object.keys(result.metrics).length === 0) return result;
  return addOmission(
    { ...result, metrics: {} },
    {
      field: "metrics",
      reason: "metrics omitted to preserve structured test and failure data",
      retrievalAvailable: result.resultId.length > 0,
    },
  );
}

function compactContent(result: ProjectedResult): ProjectedResult {
  const text = result.content.find(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  const content = text === undefined ? [] : [{ type: "text", text: compactString(text.text as string, 512) }];
  if (JSON.stringify(content) === JSON.stringify(result.content)) return result;
  return addOmission(
    { ...result, content },
    {
      field: "content",
      reason: "transport content bounded",
      retrievalAvailable: result.resultId.length > 0,
    },
  );
}

function reduceTo(result: ProjectedResult, targetBytes: number, dropProtected: boolean): ProjectedResult {
  let current = result;
  if (fits(current, targetBytes)) return current;

  if (current.meta !== undefined) {
    current = addOmission(
      { ...current, meta: undefined },
      {
        field: "_meta",
        reason: "optional transport metadata omitted",
        retrievalAvailable: current.resultId.length > 0,
      },
    );
  }
  if (fits(current, targetBytes)) return current;

  current = compactContent(current);
  if (fits(current, targetBytes)) return current;

  for (const priority of ["verbose", "excerpt", "metric"] as const) {
    current = dropFieldsByPriority(current, priority);
    if (fits(current, targetBytes)) return current;
  }

  current = compactStructuredParts(current);
  if (fits(current, targetBytes)) return current;

  if (!dropProtected) return current;

  current = dropMetrics(current);
  if (fits(current, targetBytes)) return current;

  current = dropTestResults(current);
  if (fits(current, targetBytes)) return current;

  for (const priority of ["test", "actionable"] as const) {
    current = dropFieldsByPriority(current, priority);
    if (fits(current, targetBytes)) return current;
  }

  const summary = compactString(current.summary, 512);
  if (summary !== current.summary) {
    current = addOmission(
      { ...current, summary },
      {
        field: "summary",
        reason: "summary bounded for response budget",
        retrievalAvailable: current.resultId.length > 0,
      },
    );
  }
  return current;
}

function compactOmissions(result: ProjectedResult): ProjectedResult {
  const omissions = result.omissions.slice(0, 12).map((omission) => ({
    field: compactString(omission.field, 64),
    reason: compactString(omission.reason, 128),
    retrievalAvailable: omission.retrievalAvailable,
  }));
  return { ...result, omissions };
}

function minimalResult(result: ProjectedResult, targetBytes: number): ProjectedResult {
  const base = compactOmissions({
    ...result,
    facts: [],
    diagnostics: compactDiagnostics(result.diagnostics).slice(0, 2),
    metrics: {},
    testResults: undefined,
    fields: [],
    content: [],
    meta: undefined,
    truncated: true,
  });
  const withBudgetOmission = addOmission(base, {
    field: "optional_result_data",
    reason: "hard response budget requires minimal envelope",
    retrievalAvailable: base.resultId.length > 0,
  });
  const omissionSets = [
    withBudgetOmission.omissions,
    withBudgetOmission.omissions.slice(0, 2),
    withBudgetOmission.omissions.slice(0, 1),
    [],
  ];
  for (const omissions of omissionSets) {
    for (const size of [512, 256, 128, 64, 32, 16, 8, 0]) {
      const candidate = {
        ...withBudgetOmission,
        omissions,
        operation: compactString(withBudgetOmission.operation, Math.max(8, size)),
        status: compactString(withBudgetOmission.status, Math.max(8, Math.min(size, 32))),
        summary: compactString(withBudgetOmission.summary, size),
        resultId: compactString(withBudgetOmission.resultId, Math.max(8, size)),
      };
      if (fits(candidate, targetBytes)) return candidate;
    }
  }
  return withBudgetOmission;
}

export function applyResponseBudget(input: ProjectedResult, budget: ProjectionBudget): ProjectedResult {
  const softBytes = Math.min(budget.hardBytes, budget.softTokens * 4);
  const hardBytes = Math.min(budget.hardBytes, budget.hardTokens * 4);
  if (fits(input, softBytes)) return input;
  const softResult = reduceTo(input, softBytes, false);
  if (fits(softResult, softBytes)) return softResult;
  const result = reduceTo(input, hardBytes, true);
  if (fits(result, hardBytes)) return result;
  return minimalResult(result, hardBytes);
}
