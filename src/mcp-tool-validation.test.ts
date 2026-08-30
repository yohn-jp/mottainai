import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { brokerTools, dispatchBrokerTool } from "./broker.js";
import { codeSearchTools, dispatchCodeSearchTool } from "./code-search.js";
import { allLocalTools, callLocalTool } from "./local-tools.js";
import {
  assertValidToolArguments,
  MAX_TOOL_VALIDATION_ISSUES,
  ToolInputValidationError,
  validateToolArguments,
} from "./mcp-tool-validation.js";

const conformanceTool = {
  name: "fixture_schema_authority",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["safe", "full"] },
      count: { type: "integer", minimum: 1, maximum: 3 },
      nested: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          values: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "object",
              properties: { label: { type: "string", minLength: 1 } },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["enabled", "values"],
        additionalProperties: false,
      },
      forwarded: { type: "object", additionalProperties: true },
    },
    required: ["mode", "count", "nested"],
    additionalProperties: false,
  },
} as unknown as Tool;

const validArguments = {
  mode: "safe",
  count: 2,
  nested: { enabled: true, values: [{ label: "one" }, { label: "two" }] },
  forwarded: { providerSpecific: "opaque", secret: "do-not-echo" },
};

function assertInvalid(arguments_: unknown, path: string, keyword: string): void {
  const result = validateToolArguments(conformanceTool, arguments_);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.path, path);
  assert.equal(result.issues[0]?.keyword, keyword);
}

test("runtime validation consumes the advertised schema and preserves valid nested/open data", () => {
  const result = validateToolArguments(conformanceTool, validArguments);
  assert.deepEqual(result, { ok: true, code: "ok", issues: [], truncated: false });

  const forwarded = validateToolArguments(conformanceTool, {
    ...validArguments,
    forwarded: { arbitrary: { upstream: true }, anotherKey: 42 },
  });
  assert.equal(forwarded.ok, true);
});

test("schema-derived validation enforces required, enum, integer/range, type, nested, array, and closed-object constraints", () => {
  assertInvalid({}, "arguments.mode", "required");
  assertInvalid({ ...validArguments, mode: "unsafe" }, "arguments.mode", "enum");
  assertInvalid({ ...validArguments, count: 1.5 }, "arguments.count", "type");
  assertInvalid({ ...validArguments, count: 0 }, "arguments.count", "minimum");
  assertInvalid({ ...validArguments, count: 4 }, "arguments.count", "maximum");
  assertInvalid({ ...validArguments, count: "two" }, "arguments.count", "type");
  assertInvalid({ ...validArguments, nested: "not-an-object" }, "arguments.nested", "type");
  assertInvalid(
    { ...validArguments, nested: { enabled: true, values: "not-an-array" } },
    "arguments.nested.values",
    "type",
  );
  assertInvalid({ ...validArguments, nested: { enabled: true, values: [] } }, "arguments.nested.values", "minItems");
  assertInvalid(
    { ...validArguments, nested: { enabled: "yes", values: [{ label: "one" }] } },
    "arguments.nested.enabled",
    "type",
  );
  assertInvalid(
    { ...validArguments, nested: { enabled: true, values: [{ label: 7 }] } },
    "arguments.nested.values[0].label",
    "type",
  );
  assertInvalid({ ...validArguments, unexpected: true }, "arguments.unexpected", "additionalProperties");
  assertInvalid(
    { ...validArguments, nested: { ...validArguments.nested, unexpected: true } },
    "arguments.nested.unexpected",
    "additionalProperties",
  );
});

test("unsupported schema assertions fail closed instead of being silently ignored", () => {
  const unsupported = {
    name: "fixture_unsupported_schema",
    inputSchema: { type: "string", format: "uuid" },
  } as unknown as Tool;
  const result = validateToolArguments(unsupported, "not-a-uuid");
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.path, "schema");
  assert.equal(result.issues[0]?.keyword, "unsupportedSchema");
  assert.doesNotMatch(JSON.stringify(result), /not-a-uuid/);

  const unknownType = {
    name: "fixture_unknown_type",
    inputSchema: { type: "future-type" },
  } as unknown as Tool;
  assert.equal(validateToolArguments(unknownType, "anything").ok, false);
});

test("validation errors are stable, bounded, and do not echo argument values", () => {
  const secret = "super-secret-argument-value";
  const secretProperties = Object.fromEntries(
    Array.from({ length: MAX_TOOL_VALIDATION_ISSUES + 4 }, (_, index) => [`secretProperty${index}`, secret]),
  );
  const result = validateToolArguments(conformanceTool, {
    ...validArguments,
    ...secretProperties,
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, MAX_TOOL_VALIDATION_ISSUES);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  assert.throws(
    () => assertValidToolArguments(conformanceTool, { ...validArguments, unexpected: secret }),
    (error: unknown) => {
      assert.ok(error instanceof ToolInputValidationError);
      assert.equal(error.code, "invalid_tool_arguments");
      assert.equal(error.issues[0]?.path, "arguments.unexpected");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("explicit open forwarded arguments do not make the enclosing broker tool open", () => {
  const brokerCall = brokerTools.find((tool) => tool.name === "mottainai_tool_call");
  assert.ok(brokerCall);
  const schema = brokerCall.inputSchema as unknown as {
    additionalProperties?: boolean;
    properties: { arguments: { additionalProperties?: boolean } };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.arguments.additionalProperties, true);
  assert.equal(
    validateToolArguments(brokerCall, {
      id: "catalog-id",
      arguments: { providerSpecific: "opaque", arbitrary: 1 },
    }).ok,
    true,
  );
  assert.equal(
    validateToolArguments(brokerCall, { id: "catalog-id", unexpected: true }).issues[0]?.keyword,
    "additionalProperties",
  );
});

test("local, broker, and code-search dispatches validate through their advertised schemas", async () => {
  const assertInvalid = (path: string, keyword: string) => (error: unknown): boolean => {
    assert.ok(error instanceof ToolInputValidationError);
    assert.equal(error.issues[0]?.path, path);
    assert.equal(error.issues[0]?.keyword, keyword);
    return true;
  };

  await assert.rejects(
    () => callLocalTool("mottainai_exec", { command: "printf unused", timeoutMS: 1 }, undefined as never, undefined as never),
    assertInvalid("arguments.timeoutMS", "additionalProperties"),
  );
  await assert.rejects(
    () => callLocalTool("mottainai_search", { query: "needle", contextLines: 21 }, undefined as never, undefined as never),
    assertInvalid("arguments.contextLines", "maximum"),
  );

  await assert.rejects(
    () => dispatchBrokerTool("mottainai_tool_search", { limit: 0 }, undefined as never),
    assertInvalid("arguments.limit", "minimum"),
  );
  await assert.rejects(
    () => dispatchBrokerTool("mottainai_tool_search", { query: "tools", unexpected: true }, undefined as never),
    assertInvalid("arguments.unexpected", "additionalProperties"),
  );

  await assert.rejects(
    () => dispatchCodeSearchTool("mottainai_code_search", { pattern: "needle", limit: 0 }, undefined as never),
    assertInvalid("arguments.limit", "minimum"),
  );
  await assert.rejects(
    () => dispatchCodeSearchTool("mottainai_code_search", { pattern: "needle", unexpected: true }, undefined as never),
    assertInvalid("arguments.unexpected", "additionalProperties"),
  );
});

test("owned local, broker, and code-search wrapper objects are closed while broker forwarding stays open", () => {
  for (const tool of [...allLocalTools, ...brokerTools, ...codeSearchTools]) {
    const schema = tool.inputSchema as unknown as { additionalProperties?: boolean };
    assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown properties`);
  }
  const brokerCall = brokerTools.find((tool) => tool.name === "mottainai_tool_call");
  assert.ok(brokerCall);
  const properties = brokerCall.inputSchema as unknown as {
    properties: { arguments: { additionalProperties?: boolean } };
  };
  assert.equal(properties.properties.arguments.additionalProperties, true);
});

function assertConformance(
  tool: Tool,
  cases: readonly { readonly arguments: unknown; readonly valid: boolean }[],
): void {
  for (const fixture of cases) {
    const result = validateToolArguments(tool, fixture.arguments);
    assert.equal(result.ok, fixture.valid, `${tool.name} conformance drift at ${JSON.stringify(fixture.arguments)}`);
  }
}

test("a deliberately drifted schema fixture fails conformance deterministically", () => {
  const driftedTool = {
    ...conformanceTool,
    inputSchema: {
      ...(conformanceTool.inputSchema as object),
      properties: {
        ...((conformanceTool.inputSchema as { properties: object }).properties as object),
        count: { type: "integer", minimum: 0, maximum: 3 },
      },
    },
  } as unknown as Tool;

  assert.throws(
    () => assertConformance(driftedTool, [{ arguments: { ...validArguments, count: 0 }, valid: false }]),
    /conformance drift/,
  );
});
