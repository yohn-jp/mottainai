import test from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, validateIssue, validatePullRequest } from "./governance-lib.mjs";

const issueBody = `## Summary
A concrete summary of the proposed change.
## Problem
The reproducible problem and supporting evidence.
## Goal
A specific state that defines completion.
## Non-goals
Explicitly excluded work.
## Acceptance criteria
- [ ] A verifiable condition is met
## Affected areas
Affected components and users.
## Risks / compatibility
Compatibility considerations and risks.
## Dependencies
No dependencies; this rationale is explicit.
## Implementation notes
Implementation constraints and the proposed approach.`;

const pullRequestBody = `## Summary
Add contract validation to standardize pull requests.
## Linked issue
Closes #123
## Scope
Governance contracts.
### Included
Issue Forms and validation scripts.
### Excluded
Applying the GitHub Ruleset.
## Implementation
Share dependency-free Node scripts between CI and local validation.
## Behavioral changes
Compression transforms output and preserves protected text.
## Validation
- [x] Typecheck
- [x] Tests
- [x] Build
- [ ] Package check
## Risks
Existing Issues require migration.
## Breaking changes
No. This adds governance only.
## Migration / compatibility
Existing Issues will be updated when referenced.
## Security impact
Permissions remain minimal.
## Review focus
Heading parsing and changed-file rules.`;

function validatePullRequestContract(overrides = {}) {
  return validatePullRequest({
    title: "chore(ci): enforce governance contracts",
    body: pullRequestBody,
    ...overrides,
  });
}

test("valid issue contract passes", () => {
  assert.deepEqual(validateIssue(issueBody), []);
});

test("each required issue section must contain meaningful content", () => {
  for (const heading of [
    "Summary",
    "Problem",
    "Goal",
    "Non-goals",
    "Acceptance criteria",
    "Affected areas",
    "Risks / compatibility",
    "Dependencies",
    "Implementation notes",
  ]) {
    const body = issueBody.replace(new RegExp(`(${heading === "Risks / compatibility" ? "Risks \\/ compatibility" : heading})`), "none");
    assert.ok(validateIssue(body).some((error) => error === `required section is empty: ${heading}`), heading);
  }
});

test("issue acceptance criteria requires a checklist", () => {
  const result = validateIssue(issueBody.replace("- [ ] A verifiable condition is met", "A verifiable condition is met"));
  assert.ok(result.includes("Acceptance criteria must contain a checklist item"));
});

test("placeholder-only issue sections fail", () => {
  for (const placeholder of ["none", "N/A", "TBD", "TODO"]) {
    const result = validateIssue(issueBody.replace("Affected components and users.", placeholder));
    assert.ok(result.includes("required section is empty: Affected areas"), placeholder);
  }
});

test("short issue bodies fail", () => {
  assert.ok(validateIssue("x".repeat(199)).includes("body must be at least 200 characters"));
});

test("valid pull request contract passes", () => {
  const result = validatePullRequestContract();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.closingIssues, [123]);
});

test("title accepts the supported format", () => {
  assert.deepEqual(validatePullRequestContract({ title: "fix(proxy): repair routing" }).errors, []);
});

test("title rejects invalid type, unknown scope, missing scope, and short summary", () => {
  for (const title of [
    "build(ci): repair routing",
    "fix(unknown): repair routing",
    "fix: repair routing",
    "fix(proxy): tiny",
  ]) {
    assert.ok(validatePullRequestContract({ title }).errors.includes("PR title format or scope is invalid"), title);
  }
});

test("closing Issue count accepts zero, one, or two distinct Issues only when exactly one is linked", () => {
  assert.ok(validatePullRequestContract({ body: pullRequestBody.replace("Closes #123", "No closing reference") }).errors.includes("exactly one closing Issue is required"));
  assert.deepEqual(validatePullRequestContract({ body: pullRequestBody.replace("Closes #123", "Fixes #123") }).closingIssues, [123]);
  assert.ok(validatePullRequestContract({ body: pullRequestBody.replace("Closes #123", "Closes #123 and Resolves #456") }).errors.includes("exactly one closing Issue is required"));
});

test("Closes, Fixes, and Resolves forms are case-insensitive and duplicate Issues count once", () => {
  const body = pullRequestBody.replace("Closes #123", "Closes #123 Fixes #123 RESOLVES #123");
  assert.deepEqual(validatePullRequestContract({ body }).closingIssues, [123]);
  assert.deepEqual(validatePullRequestContract({ body }).errors, []);
});

test("required validation checks must be completed for non-Draft PRs", () => {
  for (const item of ["Typecheck", "Tests", "Build"]) {
    const body = pullRequestBody.replace(`- [x] ${item}`, `- [ ] ${item}`);
    assert.ok(validatePullRequestContract({ body }).errors.includes(`Validation must be completed: ${item}`), item);
  }
});

test("Draft PRs may leave validation checks incomplete", () => {
  const body = pullRequestBody.replaceAll("[x]", "[ ]");
  assert.deepEqual(validatePullRequestContract({ body, draft: true, files: ["package.json"] }).errors, []);
});

test("Package check is required for distribution-impacting files", () => {
  for (const file of ["package.json", "pnpm-lock.yaml", "tsconfig.build.json", "src/index.ts", "src/server.ts", "src/cli.ts", ".github/workflows/publish.yml"]) {
    const result = validatePullRequestContract({ files: [file] });
    assert.ok(result.errors.includes("Validation must be completed: Package check"), file);
  }
});

test("Package check may remain unchecked when distribution files are unchanged", () => {
  assert.deepEqual(validatePullRequestContract({ files: ["src/proxy.ts"] }).errors, []);
});

test("required PR sections and Breaking changes contract are enforced", () => {
  const missing = validatePullRequestContract({ body: pullRequestBody.replace("## Risks\nExisting Issues require migration.\n", "") });
  assert.ok(missing.errors.includes("required section is empty: Risks"));

  const empty = validatePullRequestContract({ body: pullRequestBody.replace("## Risks\nExisting Issues require migration.", "## Risks") });
  assert.ok(empty.errors.includes("required section is empty: Risks"));

  const breaking = validatePullRequestContract({ body: pullRequestBody.replace("No. This adds governance only.", "Maybe. This adds governance only.") });
  assert.ok(breaking.errors.includes("Breaking changes must explicitly start with Yes or No"));
});

test("non-Draft placeholders fail while Draft placeholders pass", () => {
  const body = `${pullRequestBody}\nTBD\nTODO`;
  assert.ok(validatePullRequestContract({ body }).errors.includes("non-draft PR contains an unfinished placeholder"));
  assert.deepEqual(validatePullRequestContract({ body, draft: true }).errors, []);
});

test("changed-file rules require configuration compatibility, compression evidence, CLI evidence, security impact, and Package check", () => {
  assert.ok(validatePullRequestContract({ files: ["src/config.ts"], body: pullRequestBody.replace("Existing Issues will be updated when referenced.", "none") }).errors.includes("configuration changes require Migration / compatibility"));

  const compressionFiles = ["src/compress/code.ts", "src/compress/code.test.ts"];
  assert.ok(validatePullRequestContract({ files: ["src/compress/code.ts"] }).errors.some((error) => error.includes("test change")));
  assert.ok(validatePullRequestContract({ files: compressionFiles, body: pullRequestBody.replace("transforms", "changes") }).errors.some((error) => error.includes("transformation and preservation")));
  assert.ok(validatePullRequestContract({ files: compressionFiles, body: pullRequestBody.replace("preserves", "returns") }).errors.some((error) => error.includes("transformation and preservation")));

  assert.ok(validatePullRequestContract({ files: ["src/cli.ts"] }).errors.includes("CLI changes require a README or CLI test change"));
  assert.ok(validatePullRequestContract({ files: ["src/auth.ts"], body: pullRequestBody.replace("Permissions remain minimal.", "none") }).errors.includes("security-related changes require Security impact"));
  assert.ok(validatePullRequestContract({ files: [".github/workflows/publish.yml"] }).errors.includes("Validation must be completed: Package check"));
});

test("branch contract covers valid and invalid public formats", () => {
  assert.deepEqual(validateBranchName("chore/123-governance-contract"), []);
  for (const branch of [
    "chore/governance-contract",
    "build/123-governance-contract",
    "Chore/123-governance-contract",
    "chore/123-governance-contract-",
    "chore/123-governance--contract",
  ]) {
    assert.equal(validateBranchName(branch).length, 1, branch);
  }
});
