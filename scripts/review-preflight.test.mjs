import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REVIEW_BUDGET,
  calculateMaximumInputTokens,
  estimateReviewInput,
  evaluateReviewBudget,
  normalizePrAgentManualEvent,
  resolveBudgetConfig,
} from "./review-preflight.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function workflow(name) {
  return fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", name), "utf8");
}

test("the default 32K profile reserves output and safety margin", () => {
  assert.equal(calculateMaximumInputTokens(DEFAULT_REVIEW_BUDGET), 22_528);
});

test("invalid budget configurations fail closed", () => {
  assert.throws(
    () => resolveBudgetConfig({ totalContextTokens: 32_768, reservedOutputTokens: 32_000, safetyMarginTokens: 1_024 }),
    /less than totalContextTokens/,
  );
  assert.throws(() => resolveBudgetConfig({ model: "provider/unknown-model" }), /no defensible context profile/);
  assert.throws(
    () =>
      resolveBudgetConfig({
        model: "provider/unknown-model",
        allowUnknownModel: true,
        totalContextTokens: "not-a-number",
      }),
    /totalContextTokens must be a decimal integer/,
  );
});

test("explicit numeric values make a custom model reviewable", () => {
  const budget = resolveBudgetConfig({
    model: "provider/custom-review-model",
    allowUnknownModel: true,
    totalContextTokens: 64_000,
    reservedOutputTokens: 8_000,
    safetyMarginTokens: 2_000,
  });
  assert.equal(budget.maximumInputTokens, 54_000);
  assert.equal(budget.profile, "explicit");
});

test("linked issue and repository instruction expansion is included in the estimate", () => {
  const diff = "diff --git a/src/example.ts b/src/example.ts\n+const changed = true;\n";
  const linkedIssue = "Issue body with the implementation constraints and history.";
  const instructions = "AGENTS.md\n" + "instruction\n".repeat(100);
  const estimate = estimateReviewInput([diff, linkedIssue, instructions]);
  assert.ok(estimate > estimateReviewInput([diff]));
  assert.equal(evaluateReviewBudget({ maximumInputTokens: estimate - 1, estimatedInputTokens: estimate }).ok, false);
  assert.equal(evaluateReviewBudget({ maximumInputTokens: estimate, estimatedInputTokens: estimate }).ok, true);
});

test("manual PR-Agent command is normalized to its upstream command only after exact routing", () => {
  const event = { comment: { body: "/qodo-review" }, issue: { number: 12 } };
  const normalized = normalizePrAgentManualEvent(event);
  assert.equal(normalized.comment.body, "/review");
  assert.strictEqual(
    normalizePrAgentManualEvent({ comment: { body: "please /qodo-review" } }).comment.body,
    "please /qodo-review",
  );
});

test("review workflows expose distinct manual commands and preserve the credential boundary", () => {
  const prAgent = workflow("pr-agent.yml");
  const openCodeReview = workflow("open-code-review.yml");

  assert.match(prAgent, /issue_comment:\s+types: \[created\]/u);
  assert.match(prAgent, /body\.trim\(\) !== '\/qodo-review'/u);
  assert.match(prAgent, /PR_AGENT_MODEL/u);
  assert.match(prAgent, /REVIEW_CONTEXT_TOKENS/u);
  assert.match(prAgent, /github\.event\.comment\.user\.type != 'Bot'/u);
  assert.match(openCodeReview, /issue_comment:\s+types: \[created\]/u);
  assert.match(openCodeReview, /body\.trim\(\) !== '\/open-code-review'/u);
  assert.match(openCodeReview, /OPEN_CODE_REVIEW_MODEL/u);
  assert.match(openCodeReview, /base_ref:/u);
  assert.match(openCodeReview, /github\.event\.comment\.user\.type != 'Bot'/u);
  assert.doesNotMatch(openCodeReview, /OPENCODEREVIEW_32K_CONFIRMED/u);
});
