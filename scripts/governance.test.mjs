import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, validateIssue, validatePullRequest } from "./governance-lib.mjs";

const issueBody = `## Summary
A concrete summary of the reproducible defect.
## Reproduction
Minimal steps, input, and environment needed to reproduce the defect.
## Expected behavior
The expected observable behavior or invariant.
## Actual behavior
The observed behavior or error.
## Acceptance criteria
- [ ] A verifiable condition is met
## Context
Logs, workaround, related Issues, or environment details.`;

const pullRequestBody = fs
  .readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE/default.md", import.meta.url), "utf8")
  .replace("Closes #", "Closes #486");

function validatePullRequestContract(overrides = {}) {
  return validatePullRequest({
    title: "fix(workflow): align pull request governance",
    body: pullRequestBody,
    ...overrides,
  });
}

test("valid issue contract passes", () => {
  assert.deepEqual(validateIssue(issueBody), []);
});

test("issue acceptance criteria requires a checklist", () => {
  const result = validateIssue(issueBody.replace("- [ ] A verifiable condition is met", "A verifiable condition is met"));
  assert.ok(result.includes("Acceptance criteria must contain a checklist item"));
});

test("canonical Inari-generated pull request passes without manual shape repair", () => {
  const result = validatePullRequestContract();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.closingIssues, [486]);
});

test("Inari owns PR presentation and fixed checklist semantics", () => {
  const rules = JSON.parse(fs.readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));
  assert.equal("requiredSections" in rules.pullRequest, false);
  assert.equal("validationItems" in rules.pullRequest, false);

  const body = `Closes #486\n${"repository evidence ".repeat(20)}`;
  assert.deepEqual(validatePullRequestContract({ body }).errors, []);
});

test("title rules remain enforced", () => {
  assert.deepEqual(validatePullRequestContract({ title: "fix(runtime): repair runtime" }).errors, []);
  for (const title of ["deploy(ci): repair routing", "fix(unknown): repair routing", "fix: repair routing", "fix(proxy): tiny"]) {
    assert.ok(validatePullRequestContract({ title }).errors.includes("PR title format or scope is invalid"), title);
  }
});

test("exactly one closing Issue remains required", () => {
  assert.ok(
    validatePullRequestContract({ body: pullRequestBody.replace("Closes #486", "No closing reference") }).errors.includes(
      "exactly one closing Issue is required",
    ),
  );
  assert.deepEqual(
    validatePullRequestContract({ body: pullRequestBody.replace("Closes #486", "Fixes #486") }).closingIssues,
    [486],
  );
  assert.ok(
    validatePullRequestContract({ body: pullRequestBody.replace("Closes #486", "Closes #486 and Resolves #487") }).errors.includes(
      "exactly one closing Issue is required",
    ),
  );
});

test("draft PRs skip the conditional Package check gate", () => {
  const body = pullRequestBody;
  assert.deepEqual(validatePullRequestContract({ body, draft: true, files: ["package.json"] }).errors, []);
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
    assert.ok(validatePullRequestContract({ files: [file] }).errors.includes("Validation must be completed: Package check"), file);
  }

  const body = `${pullRequestBody}\n- [x] Package check`;
  assert.deepEqual(validatePullRequestContract({ body, files: ["package.json"] }).errors, []);
});

test("compression and CLI changed-file checks remain independent of PR section shape", () => {
  assert.ok(
    validatePullRequestContract({ files: ["src/compress/code.ts"] }).errors.some((error) => error.includes("test change")),
  );
  assert.ok(
    validatePullRequestContract({ files: ["src/cli.ts"] }).errors.includes("CLI changes require a README or CLI test change"),
  );
});

test("branch contract is unchanged", () => {
  assert.deepEqual(validateBranchName("chore/487-golden-path-bringup"), []);
  assert.deepEqual(validateBranchName("fix/486-inari-governance"), []);
  for (const branch of ["chore/governance-contract", "build/486-governance", "Chore/486-governance", "fix/486-governance-"]) {
    assert.equal(validateBranchName(branch).length, 1, branch);
  }
});

test("Issue validation matches whichever Inari issue template the body's headings correspond to", () => {
  const featureBody = `## Problem
${"x".repeat(160)}
## Capability
Add the capability.
## Contract
The new CLI flag.
## Acceptance criteria
- [ ] It works
## Non-goals
Not doing something else.`;
  assert.deepEqual(validateIssue(featureBody), []);

  const maintenanceBody = `## Task
${"x".repeat(160)}
## Reason
Security patch.
## Acceptance criteria
- [ ] CI is green`;
  assert.deepEqual(validateIssue(maintenanceBody), []);
});

test("Issue validation rejects a body matching no Inari issue template", () => {
  const bogusBody = `## Something
${"x".repeat(160)}`;
  const errors = validateIssue(bogusBody);
  assert.ok(errors.some((error) => error.includes("does not match any Inari issue template")));
});

test("Issue validation reports empty required sections for the matched template only", () => {
  const body = issueBody.replace("Minimal steps, input, and environment needed to reproduce the defect.", "");
  assert.deepEqual(validateIssue(body), ["required section is empty: Reproduction"]);
});
