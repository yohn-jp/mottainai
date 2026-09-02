import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION,
  AutonomousReviewError,
  REVIEW_ERROR_CODES,
  createReviewProviderAdapter,
  executeAutonomousReview,
} from "../src/autonomous-review.mjs";

const repository = { owner: "yohn-jp", name: "mottainai", fullName: "yohn-jp/mottainai" };
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function reviewInput(overrides = {}) {
  return {
    schemaVersion: "mottainai.review-input/v1",
    identity: {
      repository,
      pullRequest: { number: 718, baseSha, headSha },
    },
    resources: {
      manifest: "manifest.json",
      issue: "issue.json",
      diff: "diff.json",
      ocr: "ocr.json",
      checks: "checks.json",
    },
    ...overrides,
  };
}

function providerOutput(overrides = {}) {
  return {
    verdict: "APPROVE",
    findings: [],
    confidence: 0.96,
    ...overrides,
  };
}

async function assertError(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AutonomousReviewError);
    assert.equal(error.code, code);
    return true;
  });
}

test("reviews one exact revision from bounded structured input", async () => {
  let request;
  const adapter = createReviewProviderAdapter({
    provider: "fixture-provider",
    model: "fixture-model",
    complete: async (value) => {
      request = value;
      return providerOutput();
    },
  });

  const result = await executeAutonomousReview({ input: reviewInput(), provider: adapter });

  assert.deepEqual(Object.keys(request), ["input"]);
  assert.equal(Object.isFrozen(request.input), true);
  assert.equal(Object.isFrozen(request.input.identity), true);
  assert.equal(result.schemaVersion, AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION);
  assert.deepEqual(result.identity, {
    repository: "yohn-jp/mottainai",
    pullRequest: 718,
    baseSha,
    headSha,
  });
  assert.equal(result.verdict, "APPROVE");
  assert.equal(result.status, "complete");
  assert.deepEqual(result.inputs.inspected, [
    { resource: "manifest.json" },
    { resource: "issue.json" },
    { resource: "diff.json" },
    { resource: "ocr.json" },
    { resource: "checks.json" },
  ]);
});

test("preserves a blocking finding with bounded evidence and source location", async () => {
  const result = await executeAutonomousReview({
    input: reviewInput(),
    provider: {
      complete: async () =>
        providerOutput({
          verdict: "CHANGES_REQUIRED",
          confidence: 0.88,
          findings: [
            {
              id: "finding-1",
              severity: "high",
              blocking: true,
              title: "Missing error handling",
              rationale: "The changed path can reject without a bounded failure response.",
              evidence: [{ resource: "diff.json", path: "src/review.mjs", startLine: 42 }],
              location: { path: "src/review.mjs", startLine: 42, endLine: 43 },
              status: "open",
            },
          ],
        }),
    },
  });

  assert.equal(result.verdict, "CHANGES_REQUIRED");
  assert.equal(result.findings[0].blocking, true);
  assert.deepEqual(result.findings[0].evidence, [{ resource: "diff.json", reference: "src/review.mjs" }]);
  assert.deepEqual(result.findings[0].location, {
    path: "src/review.mjs",
    start: { line: 42 },
    end: { line: 43 },
  });
});

test("returns INCONCLUSIVE for an explicitly incomplete revision", async () => {
  const result = await executeAutonomousReview({
    input: reviewInput({ complete: false, unknowns: [{ reason: "checks.json was unavailable", required: true }] }),
    provider: { complete: async () => providerOutput() },
  });

  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.status, "complete");
});

test("returns INCONCLUSIVE for contradictory model evidence", async () => {
  const result = await executeAutonomousReview({
    input: reviewInput(),
    provider: {
      complete: async () =>
        providerOutput({
          verdict: "APPROVE",
          findings: [
            {
              id: "blocking-but-approved",
              severity: "critical",
              blocking: true,
              title: "Contradiction",
              rationale: "A blocking issue is present while the verdict says approve.",
              evidence: ["diff.json"],
            },
          ],
        }),
    },
  });

  assert.equal(result.verdict, "INCONCLUSIVE");
});

test("accepts an explicit INCONCLUSIVE model verdict", async () => {
  const result = await executeAutonomousReview({
    input: reviewInput(),
    provider: {
      complete: async () =>
        providerOutput({
          verdict: "INCONCLUSIVE",
          confidence: 0.2,
          unknowns: ["The requested check snapshot is pending"],
        }),
    },
  });

  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.deepEqual(result.unknowns, [
    { id: "The-requested-check-snapshot-is-pending-1", reason: "The requested check snapshot is pending" },
  ]);
});

test("malformed model output has a bounded typed diagnostic", async () => {
  await assertError(
    () =>
      executeAutonomousReview({
        input: reviewInput(),
        provider: { complete: async () => ({ verdict: "maybe", findings: [], confidence: 1 }) },
      }),
    REVIEW_ERROR_CODES.MALFORMED_MODEL_OUTPUT,
  );
});

test("provider failure has a bounded typed diagnostic and no fallback review", async () => {
  await assertError(
    () =>
      executeAutonomousReview({
        input: reviewInput(),
        provider: {
          complete: async () => {
            throw new Error("fixture provider unavailable");
          },
        },
      }),
    REVIEW_ERROR_CODES.PROVIDER_FAILURE,
  );
});

test("provider timeout is bounded", async () => {
  await assertError(
    () =>
      executeAutonomousReview({
        input: reviewInput(),
        timeoutMs: 10,
        provider: { complete: () => new Promise(() => {}) },
      }),
    REVIEW_ERROR_CODES.PROVIDER_TIMEOUT,
  );
});

test("a model cannot move the result to another revision", async () => {
  await assertError(
    () =>
      executeAutonomousReview({
        input: reviewInput(),
        provider: {
          complete: async () =>
            providerOutput({
              identity: { repository, pullRequest: 718, baseSha, headSha: "c".repeat(40) },
            }),
        },
      }),
    REVIEW_ERROR_CODES.MALFORMED_MODEL_OUTPUT,
  );
});
