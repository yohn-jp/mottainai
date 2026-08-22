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

const pullRequestBody = `## Summary
Align repository governance with the compiled Inari pull-request contract so a PR created by the supported Mottainai and gh-inari path can pass its own repository gate without manual section stuffing. The body intentionally contains only fields that Inari declares.

## Linked issue
Closes #486

## Changes
The PR validator uses the Inari-declared five-section body shape. Existing title, branch, minimum body length, linked-Issue, validation checklist, package check, compression test, and CLI evidence rules remain independent non-shape governance checks.

## Validation
- [x] Typecheck
- [x] Tests
- [x] Build
- [ ] Package check

## Review focus
Confirm that no Scope, Implementation, Behavioral changes, Test contract, Regression proof, Validation evidence, Release impact, Risks, Breaking changes, Migration / compatibility, or Security impact section is needed for this body to pass.`;

function validatePullRequestContract(overrides = {}) {
  return validatePullRequest({
    title: "fix(workflow): align pull request governance",
    body: pullRequestBody,
    ...overrides,
  });
}

function blankSection(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`(## ${escaped}\\n)[\\s\\S]*?(?=\\n## |$)`), "$1");
}

test("valid issue contract passes", () => {
  assert.deepEqual(validateIssue(issueBody), []);
});

test("issue acceptance criteria requires a checklist", () => {
  const result = validateIssue(issueBody.replace("- [ ] A verifiable condition is met", "A verifiable condition is met"));
  assert.ok(result.includes("Acceptance criteria must contain a checklist item"));
});

test("compiled Inari five-section pull request passes without legacy section stuffing", () => {
  const result = validatePullRequestContract();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.closingIssues, [486]);
});

test("governance-rules PR headings stay synchronized with compiled Inari labels", () => {
  const rules = JSON.parse(fs.readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));
  const inari = JSON.parse(
    fs.readFileSync(new URL("../.github/inari/pull-requests/default.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    rules.pullRequest.requiredSections,
    inari.sections.map((section) => section.label),
  );
});

test("each Inari-declared PR section is required and no retired section is required", () => {
  for (const heading of ["Summary", "Linked issue", "Changes", "Validation", "Review focus"]) {
    const body = blankSection(pullRequestBody, heading);
    assert.ok(validatePullRequestContract({ body }).errors.includes(`required section is empty: ${heading}`), heading);
  }
  const result = validatePullRequestContract();
  for (const retired of [
    "Scope",
    "Included",
    "Excluded",
    "Implementation",
    "Behavioral changes",
    "Test contract",
    "Regression proof",
    "Validation evidence",
    "Release impact",
    "Risks",
    "Breaking changes",
    "Migration / compatibility",
    "Security impact",
  ]) {
    assert.ok(!result.errors.some((error) => error.includes(retired)), retired);
  }
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

test("Typecheck Tests and Build checkboxes remain required for non-draft PRs", () => {
  for (const item of ["Typecheck", "Tests", "Build"]) {
    const body = pullRequestBody.replace(`- [x] ${item}`, `- [ ] ${item}`);
    assert.ok(validatePullRequestContract({ body }).errors.includes(`Validation must be completed: ${item}`), item);
  }
});

test("canonical Inari-escaped validation checkboxes remain accepted", () => {
  const body = pullRequestBody.replaceAll("- [x]", "\\- [x]");
  assert.deepEqual(validatePullRequestContract({ body }).errors, []);
});

test("Draft PRs may leave validation checks incomplete", () => {
  const body = pullRequestBody.replaceAll("[x]", "[ ]");
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
