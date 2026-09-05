import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateDocumentationTree } from "./documentation-check.mjs";

function temporaryDocs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-documentation-check-"));
  const docsRoot = path.join(root, "docs");
  fs.mkdirSync(docsRoot);
  return { docsRoot, root };
}

test("the repository documentation tree passes placement and link checks", () => {
  assert.deepEqual(validateDocumentationTree(), []);
});

test("direct documentation files other than README are rejected", () => {
  const { docsRoot, root } = temporaryDocs();
  fs.writeFileSync(path.join(docsRoot, "README.md"), "# Docs\n");
  fs.writeFileSync(path.join(docsRoot, "unclassified.md"), "# Not classified\n");
  assert.deepEqual(validateDocumentationTree({ docsRoot, root }), [
    "ordinary files are not allowed directly under docs/: docs/unclassified.md",
  ]);
});

test("links to missing repository paths are rejected", () => {
  const { docsRoot, root } = temporaryDocs();
  fs.mkdirSync(path.join(docsRoot, "testing"));
  fs.writeFileSync(path.join(docsRoot, "README.md"), "[missing](testing/nope.md)\n");
  assert.deepEqual(validateDocumentationTree({ docsRoot, root }), [
    "docs/README.md links to a missing path: testing/nope.md",
  ]);
});

test("external links and rendered-code examples are ignored", () => {
  const { docsRoot, root } = temporaryDocs();
  fs.writeFileSync(path.join(docsRoot, "README.md"), "[external](https://example.com/nope)\n`[example](missing.md)`\n");
  assert.deepEqual(validateDocumentationTree({ docsRoot, root }), []);
});
