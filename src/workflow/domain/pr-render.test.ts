import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPullRequestBody, validatePullRequestBody } from "./pr-render.js";

const issue = { reference: "#36", number: 36, title: "workflow provider" };

test("required Issue and exactly one closing Issue render from structured fields", () => {
  const result = renderPullRequestBody(
    { issue, sections: { Summary: "Structured summary" } },
    {
      issue: "required",
      closingIssue: "exactly-one",
      requiredSections: ["Summary"],
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.body, /## Summary\nStructured summary/);
    assert.match(result.body, /Closes #36/);
    assert.deepEqual(result.closingIssues, ["#36"]);
  }
});

test("optional Issue permits a body without a closing Issue", () => {
  const result = renderPullRequestBody(
    { sections: { Summary: "No linked issue" } },
    {
      issue: "optional",
      closingIssue: "optional",
      requiredSections: ["Summary"],
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.doesNotMatch(result.body, /\b(?:close|fix|resolve)[sd]?\s+#/i);
});

test("zero and multiple closing Issues are rejected", () => {
  const policy = { closingIssue: "exactly-one" as const };
  assert.equal(validatePullRequestBody("## Summary\ntext", policy).ok, false);
  const multiple = validatePullRequestBody("Closes #1\nFixes #2", policy);
  assert.equal(multiple.ok, false);
  assert.deepEqual(multiple.closingIssues, ["#1", "#2"]);
});

test("closing Issue parser requires a real GitHub reference, not ordinary prose", () => {
  const prose = validatePullRequestBody("## Implementation\nFix parser behavior for edge cases.", {
    closingIssue: "exactly-one",
  });
  assert.deepEqual(prose.closingIssues, []);

  const reference = validatePullRequestBody("Fixes #123", { closingIssue: "exactly-one" });
  assert.deepEqual(reference.closingIssues, ["#123"]);

  const crossRepo = validatePullRequestBody("Closes owner/repo#7", { closingIssue: "exactly-one" });
  assert.deepEqual(crossRepo.closingIssues, ["owner/repo#7"]);
});

test("required sections and acceptance checklist are enforced", () => {
  const policy = {
    requiredSections: ["Summary", "Risks"],
    acceptanceCriteriaChecklist: true,
    acceptanceCriteriaSection: "Acceptance criteria",
  };
  const missing = validatePullRequestBody("## Summary\ntext\n\n## Acceptance criteria\n- text", policy);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("Risks")));
  assert.ok(missing.errors.some((error) => error.includes("checklist")));

  const valid = renderPullRequestBody(
    {
      sections: { Summary: "text", Risks: "No known risks" },
      acceptanceCriteria: ["tests pass"],
    },
    policy,
  );
  assert.equal(valid.ok, true);
  if (valid.ok) assert.match(valid.body, /- \[ \] tests pass/);
});

test("repository-specific section template is applied without accepting free-form body input", () => {
  const result = renderPullRequestBody(
    { sections: { Overview: "structured value" } },
    {
      requiredSections: ["Overview"],
      templates: { Overview: "Context:\n{value}" },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.body, /## Overview\nContext:\nstructured value/);
});
