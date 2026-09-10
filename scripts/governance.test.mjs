import test from "node:test";
import assert from "node:assert/strict";
import { validateBranchName } from "./governance-lib.mjs";

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
