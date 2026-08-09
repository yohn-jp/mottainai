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
  evaluateReviewRequest,
  isSameRepositoryPullRequest,
  isTrustedCommenter,
  normalizePrAgentManualEvent,
  routeManualReview,
  runPreflight,
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

test("a normal small PR is eligible only when the provider bound is explicit", async () => {
  const result = await runPreflight({
    REVIEWER: "PR-Agent",
    REVIEW_MODEL: "openai/moonshotai/Kimi-K3",
    REVIEW_INPUT_TEXT: "small diff",
    REVIEW_PROVIDER_REQUEST_BOUND: "true",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.providerRequestBound, true);
  assert.equal(result.providerInvocationAllowed, true);
  assert.deepEqual(
    { chunking: result.chunking, passes: result.passCount, chunks: result.chunkCount },
    { chunking: false, passes: 0, chunks: 0 },
  );
});

test("an oversized PR is fail-closed before provider invocation", () => {
  const decision = evaluateReviewRequest({
    maximumInputTokens: 100,
    estimatedInputTokens: 101,
    providerRequestBound: true,
    reviewer: "PR-Agent",
  });

  assert.equal(decision.status, "review_not_generated");
  assert.equal(decision.providerInvocationAllowed, false);
  assert.match(decision.reason, /exceeds effective input budget/u);
  assert.equal(decision.chunking, false);
  assert.equal(decision.passCount, 0);
  assert.equal(decision.chunkCount, 0);
});

test("a fitting estimate cannot authorize OpenCodeReview without an enforceable upstream bound", () => {
  const decision = evaluateReviewRequest({
    maximumInputTokens: 22_528,
    estimatedInputTokens: 100,
    providerRequestBound: false,
    reviewer: "OpenCodeReview",
  });

  assert.equal(decision.status, "review_not_generated");
  assert.equal(decision.providerInvocationAllowed, false);
  assert.match(decision.reason, /provider request bound is not proven/u);
});

test("invalid configuration produces no provider authorization", async () => {
  const result = await runPreflight({
    REVIEWER: "PR-Agent",
    REVIEW_MODEL: "provider/unknown-model",
    REVIEW_INPUT_TEXT: "small diff",
    REVIEW_PROVIDER_REQUEST_BOUND: "true",
  });

  assert.equal(result.status, "review_not_generated");
  assert.equal(result.providerInvocationAllowed, false);
  assert.match(result.reason, /no defensible context profile/u);
});

test("manual routing is exact for both engines and preserves the normalization boundary", () => {
  assert.equal(routeManualReview({ reviewer: "PR-Agent", body: "/qodo-review", authorAssociation: "MEMBER" }), true);
  assert.equal(
    routeManualReview({ reviewer: "OpenCodeReview", body: "/open-code-review", authorAssociation: "COLLABORATOR" }),
    true,
  );
  assert.equal(routeManualReview({ reviewer: "PR-Agent", body: "/review", authorAssociation: "MEMBER" }), false);
  assert.equal(
    routeManualReview({ reviewer: "OpenCodeReview", body: "please /open-code-review", authorAssociation: "OWNER" }),
    false,
  );

  const normalized = normalizePrAgentManualEvent({ comment: { body: "/qodo-review" }, issue: { number: 12 } });
  assert.equal(normalized.comment.body, "/review");
});

test("untrusted commenters and fork pull requests never pass eligibility", () => {
  assert.equal(isTrustedCommenter({ authorAssociation: "CONTRIBUTOR" }), false);
  assert.equal(isTrustedCommenter({ authorAssociation: "MEMBER", userType: "Bot" }), false);
  assert.equal(
    routeManualReview({ reviewer: "PR-Agent", body: "/qodo-review", authorAssociation: "CONTRIBUTOR" }),
    false,
  );
  assert.equal(
    isSameRepositoryPullRequest({ headRepository: "external/fork", baseRepository: "yohn-jp/mottainai" }),
    false,
  );
  assert.equal(
    isSameRepositoryPullRequest({ headRepository: "yohn-jp/mottainai", baseRepository: "yohn-jp/mottainai" }),
    true,
  );
});

test("preflight blocks a provider when the collected input overflows the configured context", async () => {
  const result = await runPreflight({
    REVIEWER: "PR-Agent",
    REVIEW_MODEL: "moonshotai/Kimi-K3",
    REVIEW_CONTEXT_TOKENS: "100",
    REVIEW_OUTPUT_RESERVE_TOKENS: "10",
    REVIEW_SAFETY_MARGIN_TOKENS: "10",
    REVIEW_PROVIDER_REQUEST_BOUND: "true",
    REVIEW_INPUT_TEXT: "x".repeat(81),
  });

  assert.equal(result.status, "review_not_generated");
  assert.equal(result.providerInvocationAllowed, false);
  assert.match(result.reason, /exceeds effective input budget/u);
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
  assert.match(prAgent, /REVIEW_PROVIDER_REQUEST_BOUND: "true"/u);
  assert.match(prAgent, /github\.event\.comment\.user\.type != 'Bot'/u);
  assert.match(openCodeReview, /issue_comment:\s+types: \[created\]/u);
  assert.match(openCodeReview, /body\.trim\(\) !== '\/open-code-review'/u);
  assert.match(openCodeReview, /OPEN_CODE_REVIEW_MODEL/u);
  assert.match(openCodeReview, /base_ref:/u);
  assert.match(openCodeReview, /OPENCODEREVIEW_32K_CONFIRMED/u);
  assert.match(openCodeReview, /provider_invocation_allowed/u);
  assert.match(openCodeReview, /Passes:/u);
  assert.match(openCodeReview, /Chunks:/u);
  assert.match(openCodeReview, /github\.event\.comment\.user\.type != 'Bot'/u);
});
