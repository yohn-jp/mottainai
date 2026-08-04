import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compressCallToolResult, compressText } from "./index.js";

const ESC = "\x1b";

test("compressText strips ANSI and compresses JSON payloads", () => {
  const input = `${ESC}[31m${JSON.stringify({ items: [1, 2, 3] })}${ESC}[0m`;
  const out = compressText(input, { json: { maxArrayItems: 1 } });
  assert.deepEqual(JSON.parse(out), {
    items: [1, { __truncated__: true, omittedCount: 2, totalCount: 3, omittedSha256: "18b058689d010062a25cd7fb949b2abfea1757d2de45ca3abdda17db956e506b" }],
  });
});

test("compressText applies line filtering to non-JSON text", () => {
  const input = ["dup", "dup", "dup"].join("\n");
  const out = compressText(input, { lines: { maxConsecutiveDuplicates: 1 } });
  assert.equal(out, ["dup", "⋯ 2 duplicate lines omitted ⋯"].join("\n"));
});

test("compressText skips line filtering when JSON compression applied", () => {
  const input = JSON.stringify({ a: "x".repeat(1000) });
  const out = compressText(input, { json: {}, lines: { maxLineLength: 10 } });
  const parsed = JSON.parse(out) as { a: string };
  assert.ok(parsed.a.includes("…(+"));
});

test("compressText can disable individual stages via options", () => {
  const input = `${ESC}[31mplain${ESC}[0m`;
  const out = compressText(input, { ansi: false });
  assert.equal(out, input);
});

test("compressText applies known CLI compression before generic line filtering", () => {
  const input = ["test one ... ok", "test result: ok. 1 passed"].join("\n");
  const out = compressText(input, { cli: { command: "cargo test" } });
  assert.equal(out, ["⋯ 1 successful test lines omitted ⋯", "test result: ok. 1 passed"].join("\n"));
});

test("compressText skeletonizes fenced TypeScript while preserving surrounding prose", () => {
  const input = "See implementation:\n```ts\nfunction f(): void { console.log('x'); }\n```";
  const out = compressText(input, { code: {} });
  assert.match(out, /See implementation/);
  assert.match(out, /function f\(\): void \{ \/\* mottainai: body omitted \*\/ \}/);
});

test("compressCallToolResult compresses only text content blocks", () => {
  const result: CallToolResult = {
    content: [
      { type: "text", text: JSON.stringify({ items: [1, 2, 3] }) },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ],
  };
  const out = compressCallToolResult(result, { json: { maxArrayItems: 1 } });
  assert.equal(out.content.length, 2);
  assert.deepEqual(JSON.parse((out.content[0] as { text: string }).text), {
    items: [1, { __truncated__: true, omittedCount: 2, totalCount: 3, omittedSha256: "18b058689d010062a25cd7fb949b2abfea1757d2de45ca3abdda17db956e506b" }],
  });
  assert.deepEqual(out.content[1], { type: "image", data: "base64data", mimeType: "image/png" });
});

test("compressCallToolResult is a no-op when content is missing", () => {
  const result = { isError: false } as unknown as CallToolResult;
  assert.deepEqual(compressCallToolResult(result), result);
});

test("compressCallToolResult does not mutate the input", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify({ items: [1, 2, 3] }) }],
  };
  const original = JSON.parse(JSON.stringify(result));
  compressCallToolResult(result, { json: { maxArrayItems: 1 } });
  assert.deepEqual(result, original);
});
