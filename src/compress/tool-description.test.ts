import assert from "node:assert/strict";
import { test } from "node:test";
import { compressToolDefinition, compressToolDescription } from "./tool-description.js";

test("compressToolDescription removes English articles and filler phrases", () => {
  assert.equal(
    compressToolDescription("Please use the tool in order to find a file. Note that it is very fast."),
    "use tool to find file. fast.",
  );
});

test("compressToolDescription shortens common MCP instruction phrases", () => {
  assert.equal(
    compressToolDescription("IMPORTANT: Use it when you need to search for a file. See server instructions for syntax."),
    "use to search file. server instructions: syntax.",
  );
});

test("compressToolDescription preserves code fences, literals, URLs, and Japanese", () => {
  const input = [
    "Use `the value` from https://example.com/the/path.",
    "Use constraint 'name **/src/* !test/'.",
    "```text",
    "Please use the exact example.",
    "```",
    "日本語の説明はそのまま。",
  ].join("\n");
  assert.equal(
    compressToolDescription(input),
    [
      "Use `the value` from https://example.com/the/path.",
      "Use constraint 'name **/src/* !test/'.",
      "```text",
      "Please use the exact example.",
      "```",
      "日本語の説明はそのまま。",
    ].join("\n"),
  );
});

test("compressToolDescription does not treat apostrophes in contractions as literals", () => {
  assert.equal(
    compressToolDescription("Don't say it's important: use the tool."),
    "Don't say it's use tool.",
  );
});

test("compressToolDefinition changes only description fields and does not mutate its input", () => {
  const tool = {
    name: "grep",
    description: "Search the file contents. Please use a term.",
    inputSchema: {
      type: "object",
      title: "GrepParams",
      properties: {
        query: {
          type: "string",
          description: "The search query. You can use a literal.",
          examples: ["the exact text"],
          default: "the default",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
  const original = structuredClone(tool);

  const out = compressToolDefinition(tool);

  assert.equal(out.description, "Search file contents. use term.");
  assert.equal(
    (out.inputSchema as { properties: { query: { description: string } } }).properties.query.description,
    "search query. use literal.",
  );
  assert.deepEqual((out.inputSchema as { properties: { query: { examples: string[]; default: string } } }).properties.query, {
    type: "string",
    description: "search query. use literal.",
    examples: ["the exact text"],
    default: "the default",
  });
  assert.deepEqual(tool, original);
});
