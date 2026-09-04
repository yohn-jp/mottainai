import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateActionText, validateRepositoryActions } from "./validate-actions.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40);

test("accepts immutable external actions and repository-local actions", () => {
  const result = validateActionText(
    [
      "      uses: actions/checkout@" + sha + " # v4.4.0",
      "      - uses: github/codeql-action/init@" + sha,
      "      uses: ./.github/actions/local-action",
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.references.length, 3);
  assert.equal(result.references.filter((reference) => reference.local).length, 1);
});

test("rejects mutable, incomplete, and missing external action refs", () => {
  const result = validateActionText(
    ["      uses: actions/checkout@v4", "      uses: actions/setup-node@1234", "      uses:"].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
  assert.match(result.errors[2], /same line/u);
});

test("all repository-owned workflow and composite-action refs are pinned", () => {
  const result = validateRepositoryActions(repositoryRoot);

  assert.deepEqual(result.errors, []);
  assert.ok(result.files.length > 0);
  assert.ok(result.references.some((reference) => !reference.local));
});

test("accepts yohn-jp/.github's own reusable-workflow reference on @main", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/pr-governance.yml@main",
    ".github/workflows/governance.yml",
  );

  assert.deepEqual(result.errors, []);
});

test("accepts the shared TypeScript CI workflow only at an immutable commit", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/typescript-cli-ci.yml@" + sha,
    ".github/workflows/ci.yml",
  );

  assert.deepEqual(result.errors, []);
});

test("rejects a mutable shared TypeScript CI workflow reference", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/typescript-cli-ci.yml@main",
    ".github/workflows/ci.yml",
  );

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
});

test("the CI caller pins the proven TypeScript foundation and retains product lanes", () => {
  const ciWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(
    ciWorkflow,
    /uses:\s*yohn-jp\/\.github\/\.github\/workflows\/typescript-cli-ci\.yml@[0-9a-f]{40}(?:\s+#.*)?$/mu,
  );
  assert.match(ciWorkflow, /conformance-script:\s*["']architecture:check["']/u);
  assert.match(ciWorkflow, /run-governance:\s*false/u);
  for (const localJob of ["test-integration:", "build-and-package-e2e:", "runtime-contract:"]) {
    assert.match(ciWorkflow, new RegExp(`^  ${localJob}`, "mu"), `missing retained local lane: ${localJob}`);
  }
});

test("rejects @main for every other external reference, including other yohn-jp/.github paths", () => {
  const result = validateActionText(
    [
      "      uses: actions/checkout@main",
      "      uses: yohn-jp/.github@main",
      "      uses: yohn-jp/.github/.github/actions/example@main",
      "      uses: yohn-jp/other-repo/.github/workflows/pr-governance.yml@main",
      "      uses: yohn-jp/.github/.github/workflows/pr-governance.yml@v1",
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 5);
  for (const error of result.errors) assert.match(error, /full 40-character commit SHA/u);
});
