import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateProductChecks } from "./product-pr-checks-lib.mjs";

const pullRequestBody = fs
  .readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE/default.md", import.meta.url), "utf8")
  .replace("Closes #", "Closes #486");

test("canonical Inari-generated pull request passes with no product-specific paths touched", () => {
  assert.deepEqual(validateProductChecks({ body: pullRequestBody, files: [] }).errors, []);
});

test("draft PRs skip the conditional Package check gate", () => {
  assert.deepEqual(
    validateProductChecks({ body: pullRequestBody, draft: true, files: ["package.json"] }).errors,
    [],
  );
});

test("Package check remains required for distribution-impacting files", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.build.json",
    "src/index.ts",
    "src/server.ts",
    "src/cli.ts",
    ".github/workflows/publish.yml",
  ]) {
    assert.ok(
      validateProductChecks({ body: pullRequestBody, files: [file] }).errors.includes(
        "Validation must be completed: Package check",
      ),
      file,
    );
  }

  const body = `${pullRequestBody}\n- [x] Package check`;
  assert.deepEqual(validateProductChecks({ body, files: ["package.json"] }).errors, []);
});

test("compression changes require a test change and transformation/preservation evidence", () => {
  assert.ok(
    validateProductChecks({ body: pullRequestBody, files: ["src/compress/code.ts"] }).errors.some((error) =>
      error.includes("test change"),
    ),
  );
  const body = `${pullRequestBody}\nThis transforms the payload and preserves unmodified fields.`;
  assert.deepEqual(
    validateProductChecks({ body, files: ["src/compress/code.ts", "src/compress/code.test.ts"] }).errors,
    [],
  );
});

test("CLI changes require a README or CLI test change", () => {
  assert.ok(
    validateProductChecks({ body: pullRequestBody, files: ["scripts/mcp.ts"] }).errors.includes(
      "CLI changes require a README or CLI test change",
    ),
  );
  assert.deepEqual(
    validateProductChecks({ body: pullRequestBody, files: ["scripts/mcp.ts", "README.md"] }).errors,
    [],
  );
});
