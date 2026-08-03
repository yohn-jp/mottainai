import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeStaticInformation,
  containsProtectedInformation,
  staticSelfInformation,
  tokenizeEnglishPhrase,
} from "./static-information.js";

test("common development-log boilerplate receives lower information than an unknown identifier", () => {
  assert.ok(staticSelfInformation("finished") < staticSelfInformation("BuildGraphResolver"));
});

test("analyzer marks only known low-information phrases as candidates", () => {
  const result = analyzeStaticInformation("the tests passed");
  assert.equal(result.lowInformation, true);
  assert.equal(result.protected, false);
});

test("analyzer protects diagnostics, identifiers, paths, URLs, and numbers", () => {
  for (const input of [
    "permission denied",
    "BuildGraphResolver failed",
    "see /repo/src/proxy.ts",
    "https://example.test/docs",
    "14 tests passed",
  ]) assert.equal(analyzeStaticInformation(input).lowInformation, false, input);
  assert.equal(containsProtectedInformation("error"), true);
});

test("tokenizer retains English lexical tokens", () => {
  assert.deepEqual(tokenizeEnglishPhrase("Finished: the tests passed."), ["Finished", "the", "tests", "passed"]);
});
