import assert from "node:assert/strict";
import test from "node:test";
import { compressCodeText, detectCodeLanguage, skeletonizeCode } from "./code.js";

test("skeletonizeCode retains TypeScript signatures and removes function bodies", () => {
  const input = [
    "export class Service {",
    "  run(value: string): number {",
    "    const parsed = value.trim();",
    "    return parsed.length;",
    "  }",
    "}",
    "export function build(name: string): string { return `hello ${name}`; }",
  ].join("\n");
  const output = skeletonizeCode(input, "typescript");
  assert.match(output, /run\(value: string\): number \{ \/\* mottainai: body omitted \*\/ \}/);
  assert.match(output, /function build\(name: string\): string \{ \/\* mottainai: body omitted \*\/ \}/);
  assert.doesNotMatch(output, /value\.trim|hello/);
});

test("skeletonizeCode leaves syntactically invalid code unchanged", () => {
  const input = "function broken( { return 1;";
  assert.equal(skeletonizeCode(input, "javascript"), input);
});

test("skeletonizeCode handles nested functions without overlapping replacements", () => {
  const input = "function outer() { function inner() { return 1; } return inner(); }";
  assert.equal(skeletonizeCode(input, "javascript"), "function outer() { /* mottainai: body omitted */ }");
});

test("compressCodeText handles language-tagged fenced code only", () => {
  const input = "before\n```ts\nfunction f(): void { console.log('x'); }\n```\nafter";
  const output = compressCodeText(input);
  assert.match(output, /function f\(\): void \{ \/\* mottainai: body omitted \*\/ \}/);
  assert.match(output, /before/);
  assert.match(output, /after/);
});

test("detectCodeLanguage accepts explicit language and common file paths", () => {
  assert.equal(detectCodeLanguage({ language: "TSX" }), "tsx");
  assert.equal(detectCodeLanguage({ filePath: "/repo/src/proxy.ts" }), "typescript");
  assert.equal(detectCodeLanguage({ path: "/repo/README.md" }), undefined);
});
