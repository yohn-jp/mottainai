import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * gateway 自前ツールの共通 structured output。クライアント横断で安定した契約として
 * 固定する（docs/result-envelope.md）。フィールドを削らない。
 */
export const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    operation: { type: "string" }, status: { type: "string" }, summary: { type: "string" },
    facts: { type: "array" }, diagnostics: { type: "array" }, metrics: { type: "object" },
    result_id: { type: "string" }, truncated: { type: "boolean" }, test_results: { type: "object" },
    projection: { type: "object" },
  },
  required: ["operation", "status", "summary", "facts", "diagnostics", "metrics", "result_id", "truncated"],
};

const RESERVED_OUTPUT_FIELDS = new Set([...Object.keys(OUTPUT_SCHEMA.properties), "isError"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type EnvelopeStatus = "success" | "failed" | "partial";

export function output(
  operation: string,
  status: EnvelopeStatus,
  summary: string,
  resultId: string,
  details: Record<string, unknown>,
  isError = false,
): CallToolResult {
  const facts = Array.isArray(details.facts) ? details.facts : [];
  const diagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
  const metrics = isRecord(details.metrics) ? details.metrics : {};
  const truncated = typeof details.truncated === "boolean" ? details.truncated : false;
  const testResults = isRecord(details.test_results) ? details.test_results : undefined;
  const projection = isRecord(details.projection) ? details.projection : undefined;
  const extensions = Object.fromEntries(
    Object.entries(details).filter(([key]) => !RESERVED_OUTPUT_FIELDS.has(key)),
  );
  const structuredContent = {
    operation, status, summary, facts, diagnostics, metrics, result_id: resultId, truncated,
    ...(testResults === undefined ? {} : { test_results: testResults }),
    ...(projection === undefined ? {} : { projection }),
    ...extensions,
  };
  return { content: [{ type: "text", text: summary }], structuredContent, ...(isError ? { isError: true } : {}) };
}
