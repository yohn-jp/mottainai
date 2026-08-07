const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string" },
    status: { type: "string" },
    summary: { type: "string" },
    facts: { type: "array" },
    diagnostics: { type: "array" },
    metrics: { type: "object" },
    result_id: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["operation", "status", "summary", "facts", "diagnostics", "metrics", "result_id", "truncated"],
};
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const localTools = [{
  name: "fixture_read",
  inputSchema: { type: "object" },
  outputSchema: OUTPUT_SCHEMA,
  annotations: readOnly,
}];
