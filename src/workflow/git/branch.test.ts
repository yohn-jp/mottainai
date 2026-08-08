import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempGitRepo, runGit } from "../../test-support/tmp-git-repo.js";
import {
  generateAndValidateBranchName,
  normalizeBranchSlug,
  renderBranchName,
  validateBranchName,
  validateBranchNameSyntax,
} from "./branch.js";

test("branch generation renders task type, Issue number, and normalized slug without fallback", () => {
  const result = renderBranchName(
    { taskType: "feature", issueNumber: 35, normalizedSlug: "policy-git-operations" },
    { template: "{taskType}/issue-{issueNumber}/{slug}" },
  );
  assert.deepEqual(result, { ok: true, branchName: "feature/issue-35/policy-git-operations" });
});

test("normalizeBranchSlug is explicit and generated input rejects an unnormalized slug", () => {
  assert.equal(normalizeBranchSlug(" Policy-driven Git "), "policy-driven-git");
  const result = renderBranchName({ taskType: "feature", normalizedSlug: "Policy Git" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid-slug");
});

test("branch template requires an Issue number only when the template references it", () => {
  const result = renderBranchName(
    { taskType: "feature", normalizedSlug: "without-issue" },
    { template: "issue-{issueNumber}/{slug}" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-template-input");
});

test("invalid branch syntax is a structured validation failure", () => {
  const result = validateBranchNameSyntax("feature/bad name");
  assert.equal(result?.code, "invalid-branch-name");
});

test("protected branch validation fails closed and does not generate an alternate name", async (t) => {
  const root = createTempGitRepo(t);
  const result = await validateBranchName({
    workspaceRoot: root,
    branchName: "main",
    policy: { protectedBranches: ["main"], template: "{taskType}/{slug}" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "protected-branch");
    assert.equal(result.branchName, "main");
  }
});

test("branch collision is reported without an implicit suffix", async (t) => {
  const root = createTempGitRepo(t);
  const result = await generateAndValidateBranchName({
    workspaceRoot: root,
    taskType: "feature",
    normalizedSlug: "collision",
    policy: { template: "{taskType}/{slug}" },
    existingBranchNames: ["feature/collision"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "branch-collision");
    assert.equal(result.branchName, "feature/collision");
  }
});

test("branch collision is detected from Git without branch mutation", async (t) => {
  const root = createTempGitRepo(t);
  runGit(["branch", "feature/existing"], root);
  const result = await generateAndValidateBranchName({
    workspaceRoot: root,
    taskType: "feature",
    normalizedSlug: "new-name",
    policy: { template: "{taskType}/{slug}" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const first = await validateBranchName({ workspaceRoot: root, branchName: result.branchName });
  assert.equal(first.ok, true);
  const collision = await validateBranchName({ workspaceRoot: root, branchName: "feature/existing" });
  assert.equal(collision.ok, false);
  if (!collision.ok) assert.equal(collision.code, "branch-collision");
});
