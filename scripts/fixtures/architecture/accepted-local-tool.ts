const OUTPUT_SCHEMA = {};
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
