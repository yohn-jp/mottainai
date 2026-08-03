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
  },
  required: ["operation", "status", "summary", "facts", "diagnostics", "metrics", "result_id", "truncated"],
};

export type EnvelopeStatus = "success" | "failed" | "partial";

export function output(
  operation: string,
  status: EnvelopeStatus,
  summary: string,
  resultId: string,
  details: Record<string, unknown>,
  isError = false,
): CallToolResult {
  const structuredContent = {
    operation, status, summary, facts: [], diagnostics: [], metrics: {}, result_id: resultId, truncated: false, ...details,
  };
  return { content: [{ type: "text", text: summary }], structuredContent, ...(isError ? { isError: true } : {}) };
}
