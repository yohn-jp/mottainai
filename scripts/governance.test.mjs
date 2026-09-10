import test from "node:test";
import assert from "node:assert/strict";
import { extractClosingIssues, validateBranchName } from "./governance-lib.mjs";

/**
 * Branch-name governance is the one piece of organization-level PR/branch
 * governance Mottainai still owns locally (see scripts/governance-lib.mjs).
 * PR-title and PR/Issue body contract semantics are owned by the canonical
 * yohn-jp/.github reusable governance workflow instead
 * (.github/workflows/governance.yml); see scripts/product-pr-checks.test.mjs
 * for the remaining Mottainai-specific conditional product gates.
 */
test("branch contract is unchanged", () => {
  assert.deepEqual(validateBranchName("chore/487-golden-path-bringup"), []);
  assert.deepEqual(validateBranchName("fix/486-inari-governance"), []);
  for (const branch of ["chore/governance-contract", "build/486-governance", "Chore/486-governance", "fix/486-governance-"]) {
    assert.equal(validateBranchName(branch).length, 1, branch);
  }
});

/**
 * extractClosingIssues backs the merge-boundary linked-Issue governance job
 * (.github/workflows/governance.yml `linked-issue-check`), which reads the
 * status:invalid / needs:specification label state the canonical
 * issue-governance.yml workflow applies. It is plain closing-keyword text
 * extraction, not a reimplementation of PR-body contract semantics.
 */
test("extractClosingIssues finds exactly one Issue for a well-formed closing reference", () => {
  assert.deepEqual(extractClosingIssues("Closes #486"), [486]);
  assert.deepEqual(extractClosingIssues("Fixes #486"), [486]);
  assert.deepEqual(extractClosingIssues("Resolves #486"), [486]);
});

test("extractClosingIssues finds no Issue when there is no closing reference", () => {
  assert.deepEqual(extractClosingIssues("No closing reference"), []);
});

test("extractClosingIssues finds every distinct closing reference", () => {
  assert.deepEqual(extractClosingIssues("Closes #486 and Resolves #487"), [486, 487]);
  assert.deepEqual(extractClosingIssues("Closes #486 and Closes #486"), [486]);
});
