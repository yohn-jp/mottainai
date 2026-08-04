import test from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, validateIssue, validatePullRequest } from "./governance-lib.mjs";

const issueBody = `## Summary\nA concrete summary of the proposed change.\n## Problem\nThe reproducible problem and supporting evidence.\n## Goal\nA specific state that defines completion.\n## Non-goals\nExplicitly excluded work.\n## Acceptance criteria\n- [ ] A verifiable condition is met\n## Affected areas\nAffected components and users.\n## Risks / compatibility\nCompatibility considerations and risks.\n## Dependencies\nNo dependencies; this rationale is explicit.\n## Implementation notes\nImplementation constraints and the proposed approach.`;

const pullRequestBody = `## Summary\nAdd contract validation to standardize LLM-created pull requests.\n## Linked issue\nCloses #123\n## Scope\nGovernance contracts.\n### Included\nIssue Forms and validation scripts.\n### Excluded\nApplying the GitHub Ruleset.\n## Implementation\nShare dependency-free Node scripts between CI and local validation.\n## Behavioral changes\nInvalid pull request formats fail CI.\n## Validation\n- [x] Typecheck\n- [x] Tests\n- [x] Build\n- [ ] Package check, not applicable\n## Risks\nExisting Issues require migration.\n## Breaking changes\nNo. This adds governance only.\n## Migration / compatibility\nExisting Issues will be updated when referenced.\n## Security impact\nPermissions remain minimal.\n## Review focus\nHeading parsing and changed-file rules.`;

test("valid issue contract passes", () => {
  assert.deepEqual(validateIssue(issueBody), []);
});

test("empty issue sections fail", () => {
  assert.ok(validateIssue(issueBody.replace("Affected components and users.", "none")).includes("required section is empty: Affected areas"));
});

test("valid pull request contract passes", () => {
  const result = validatePullRequest({ title: "chore(ci): add governance contract", body: pullRequestBody });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.closingIssues, [123]);
});

test("compression changes require tests and preservation evidence", () => {
  const result = validatePullRequest({ title: "fix(compression): preserve code fences", body: pullRequestBody, files: ["src/compress/code.ts"] });
  assert.ok(result.errors.some((error) => error.includes("test change")));
  assert.ok(result.errors.some((error) => error.includes("preservation")));
});

test("branch contract accepts one issue and rejects missing issue", () => {
  assert.deepEqual(validateBranchName("chore/123-governance-contract"), []);
  assert.equal(validateBranchName("chore/governance-contract").length, 1);
});
