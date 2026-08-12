import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesScope } from "./scope.js";

test("exact literal path matches only itself", () => {
  assert.equal(matchesScope("src/index.ts", ["src/index.ts"]), true);
  assert.equal(matchesScope("src/other.ts", ["src/index.ts"]), false);
});

test("* matches within a single path segment but not across /", () => {
  assert.equal(matchesScope("src/index.ts", ["src/*.ts"]), true);
  assert.equal(matchesScope("src/nested/index.ts", ["src/*.ts"]), false);
});

test("** matches across zero or more segments", () => {
  assert.equal(matchesScope("src/a/b/c.ts", ["src/**/*.ts"]), true);
  assert.equal(matchesScope("src/c.ts", ["src/**/*.ts"]), true);
  assert.equal(matchesScope("other/c.ts", ["src/**/*.ts"]), false);
});

test("a trailing ** matches any depth under the preceding segment", () => {
  assert.equal(matchesScope("src/index.ts", ["src/**"]), true);
  assert.equal(matchesScope("src/nested/deep/index.ts", ["src/**"]), true);
  assert.equal(matchesScope("docs/index.ts", ["src/**"]), false);
});

test("no pattern matches means false, and an empty pattern list matches nothing", () => {
  assert.equal(matchesScope("src/index.ts", []), false);
  assert.equal(matchesScope("src/index.ts", ["docs/*.md"]), false);
});

test("multiple candidate patterns: match if any pattern matches", () => {
  assert.equal(matchesScope("package.json", ["src/**", "package.json", "tsconfig.json"]), true);
});
