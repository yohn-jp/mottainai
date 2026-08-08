import type {
  Omission,
  ProjectedField,
  ProjectedResult,
  ProjectionInput,
  ProjectionMetadata,
  SerializedProjection,
} from "./types.js";

const REQUIRED_FIELDS = new Set([
  "operation",
  "status",
  "summary",
  "facts",
  "diagnostics",
  "metrics",
  "result_id",
  "truncated",
  "test_results",
  "projection",
]);

const ACTIONABLE_FIELDS = new Set([
  "failure_classification",
  "exit_code",
  "signal",
  "timed_out",
  "output_limited",
  "branch",
  "worktree_dir",
]);

const RETRIEVAL_FIELDS = new Set([
  "next_command",
  "request_id",
  "path",
  "query",
  "mode",
  "stream",
  "totalLines",
  "returnedStartLine",
  "returnedEndLine",
  "omittedLines",
  "matchLine",
  "raw_artifact",
]);

const EXCERPT_FIELDS = new Set(["output", "text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function fieldPriority(key: string, status: string, operation: string): ProjectedField["priority"] {
  if (ACTIONABLE_FIELDS.has(key)) return "actionable";
  if (key === "test_results") return "test";
  if (RETRIEVAL_FIELDS.has(key)) return "retrieval";
  if (key === "metrics") return "metric";
  if (EXCERPT_FIELDS.has(key)) {
    if (operation === "result_get") return "retrieval";
    return status === "failed" ? "excerpt" : "verbose";
  }
  if (key === "groups" || key === "entries" || key === "results" || key === "issue" || key === "providers")
    return "verbose";
  return "verbose";
}

function parseOmissions(value: unknown): Omission[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.field !== "string" || typeof entry.reason !== "string") return [];
    return [
      {
        field: entry.field,
        reason: entry.reason,
        retrievalAvailable: entry.retrievalAvailable === true,
      },
    ];
  });
}

export function projectResult(input: ProjectionInput): ProjectedResult {
  const raw = input.structuredContent;
  const operation = stringValue(raw.operation, "local");
  const status = stringValue(raw.status, "partial");
  const resultId = stringValue(raw.result_id, "");
  const fields: ProjectedField[] = [];
  const omissions = parseOmissions(isRecord(raw.projection) ? raw.projection.omissions : undefined);

  for (const [key, value] of Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))) {
    if (REQUIRED_FIELDS.has(key)) continue;
    if (key === "output" && status === "success") {
      omissions.push({
        field: key,
        reason: "verbose successful output omitted by default",
        retrievalAvailable: resultId.length > 0,
      });
      continue;
    }
    fields.push({ key, value, priority: fieldPriority(key, status, operation) });
  }

  return {
    operation,
    status,
    summary: stringValue(raw.summary, "local result"),
    facts: arrayValue(raw.facts),
    diagnostics: arrayValue(raw.diagnostics),
    metrics: recordValue(raw.metrics),
    ...(isRecord(raw.test_results) ? { testResults: raw.test_results } : {}),
    resultId,
    truncated: raw.truncated === true || omissions.length > 0,
    fields,
    omissions,
    content: input.content,
    ...(input.isError === undefined ? {} : { isError: input.isError }),
    ...(input.meta === undefined ? {} : { meta: input.meta }),
  };
}

function projectionMetadata(omissions: Omission[]): ProjectionMetadata {
  return { version: 1, omissions };
}

function serializedStructuredContent(result: ProjectedResult): Record<string, unknown> {
  const fields = [...result.fields].sort((left, right) => {
    const priority = ["actionable", "test", "retrieval", "metric", "excerpt", "verbose"];
    const priorityDifference = priority.indexOf(left.priority) - priority.indexOf(right.priority);
    return priorityDifference === 0 ? left.key.localeCompare(right.key) : priorityDifference;
  });
  const structuredContent: Record<string, unknown> = {
    operation: result.operation,
    status: result.status,
    summary: result.summary,
    facts: result.facts,
    diagnostics: result.diagnostics,
    metrics: result.metrics,
    result_id: result.resultId,
    truncated: result.truncated || result.omissions.length > 0,
    ...(result.testResults === undefined ? {} : { test_results: result.testResults }),
  };
  for (const field of fields) structuredContent[field.key] = field.value;
  structuredContent.projection = projectionMetadata(result.omissions);
  return structuredContent;
}

export function serializeProjectedResult(result: ProjectedResult): SerializedProjection {
  return {
    content: result.content,
    structuredContent: serializedStructuredContent(result),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  };
}

export function addOmission(result: ProjectedResult, omission: Omission): ProjectedResult {
  if (result.omissions.some((entry) => entry.field === omission.field && entry.reason === omission.reason))
    return result;
  return { ...result, omissions: [...result.omissions, omission], truncated: true };
}

export function markOmissionsRetrievable(result: ProjectedResult): ProjectedResult {
  if (result.resultId.length === 0) return result;
  return {
    ...result,
    omissions: result.omissions.map((omission) => ({ ...omission, retrievalAvailable: true })),
  };
}

export function hasStructuredEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.operation === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.facts) &&
    Array.isArray(value.diagnostics) &&
    isRecord(value.metrics) &&
    typeof value.result_id === "string" &&
    typeof value.truncated === "boolean"
  );
}
