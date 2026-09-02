import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../src/render-html.mjs";
import { buildReviewCheck, ReviewProjectionError, reviewPagesRevisionUrl } from "../src/review-projection.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEW_HEAD_SHA = "c".repeat(40);

const manifest = {
  repository: { fullName: "yohn-jp/mottainai" },
  pullRequest: { number: 720, baseSha: BASE_SHA, headSha: HEAD_SHA },
  revision: { id: HEAD_SHA, shortId: HEAD_SHA.slice(0, 12) },
};

function result(verdict = "CHANGES_REQUIRED", overrides = {}) {
  return {
    schemaVersion: "mottainai.autonomous-review.result/v1",
    identity: {
      repository: "yohn-jp/mottainai",
      pullRequest: 720,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    },
    status: "completed",
    verdict,
    confidence: 0.875,
    findings: [
      {
        id: "finding-unsafe-output",
        severity: "high",
        blocking: true,
        title: "Unescaped output",
        rationale: "A bounded rationale shown to the operator.",
        evidence: [{ resource: "diff.json", reference: "$.files[0].hunks[0]" }],
        location: {
          path: "src/render.js",
          start: { line: 12, column: 1 },
          end: { line: 12, column: 20 },
        },
        status: "open",
      },
    ],
    inputs: {
      inspected: [
        { resource: "manifest.json" },
        { resource: "issue.json" },
        { resource: "diff.json" },
        { resource: "ocr.json" },
        { resource: "checks.json" },
      ],
      omitted: [{ resource: "repository source bodies", reason: "not bounded input" }],
    },
    unknowns: [{ id: "runtime-behavior", reason: "runtime behavior not represented in static evidence" }],
    ...overrides,
  };
}

test("Review Pages HTML projects the bounded result fields", () => {
  const html = renderHtml({
    manifest,
    diff: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    issue: { issue: null, acceptanceCriteria: [] },
    reviewResult: result(),
  });

  assert.match(html, /Autonomous review/);
  assert.match(html, /CHANGES_REQUIRED/);
  assert.match(html, /88%/);
  assert.match(html, /Unescaped output/);
  assert.match(html, /src\/render\.js:12-12/);
  assert.match(html, /diff\.json#\$\.files\[0\]\.hunks\[0\]/);
  assert.match(html, /manifest\.json/);
  assert.match(html, /repository source bodies: not bounded input/);
  assert.match(html, /runtime-behavior: runtime behavior not represented/);
  assert.match(html, /CURRENT REVISION/);
});

test("HTML marks a result stale when the PR index points at a newer head", () => {
  const html = renderHtml({
    manifest,
    diff: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    issue: { issue: null, acceptanceCriteria: [] },
    reviewResult: result(),
    latestHeadSha: NEW_HEAD_SHA,
  });

  assert.match(html, /STALE \/ SUPERSEDED/);
  assert.match(html, new RegExp(NEW_HEAD_SHA));
});

test("HTML does not publish raw transcript or private reasoning fields", () => {
  const html = renderHtml({
    manifest,
    diff: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    issue: { issue: null, acceptanceCriteria: [] },
    reviewResult: result("APPROVE", {
      transcript: "PRIVATE_TRANSCRIPT_MUST_NOT_APPEAR",
      privateReasoning: "PRIVATE_REASONING_MUST_NOT_APPEAR",
      findings: [],
    }),
  });

  assert.doesNotMatch(html, /PRIVATE_TRANSCRIPT_MUST_NOT_APPEAR/);
  assert.doesNotMatch(html, /PRIVATE_REASONING_MUST_NOT_APPEAR/);
  assert.match(html, /No blocking findings/);
});

test("GitHub Check projection maps every verdict and anchors exact head", () => {
  const expected = {
    APPROVE: "success",
    CHANGES_REQUIRED: "failure",
    INCONCLUSIVE: "neutral",
  };

  for (const [verdict, conclusion] of Object.entries(expected)) {
    const check = buildReviewCheck({
      reviewResult: result(verdict),
      manifest,
      reviewPagesBaseUrl: "https://yohn-jp.github.io/mottainai/",
    });
    assert.equal(check.head_sha, HEAD_SHA);
    assert.equal(check.conclusion, conclusion);
    assert.equal(check.status, "completed");
    assert.equal(check.details_url, `https://yohn-jp.github.io/mottainai/reviews/pr/720/${HEAD_SHA}/index.html`);
    assert.match(check.external_id, new RegExp(`${BASE_SHA}:${HEAD_SHA}$`));
    assert.match(check.output.summary, new RegExp(verdict));
    assert.doesNotMatch(check.output.text, /PRIVATE_REASONING/);
  }
});

test("GitHub Check projection rejects a result for another head", () => {
  assert.throws(
    () =>
      buildReviewCheck({
        reviewResult: result("APPROVE", { identity: { ...result().identity, headSha: NEW_HEAD_SHA } }),
        manifest,
        reviewPagesBaseUrl: "https://pages.example",
      }),
    (error) => error instanceof ReviewProjectionError && /identity|expected head/u.test(error.message),
  );
});

test("pending review state remains a GitHub in-progress check", () => {
  const check = buildReviewCheck({
    reviewResult: result("INCONCLUSIVE", { status: "pending" }),
    manifest,
    reviewPagesBaseUrl: "https://pages.example",
  });
  assert.equal(check.status, "in_progress");
  assert.equal(check.conclusion, null);
});

test("revision URL requires the full reviewed head SHA", () => {
  assert.equal(
    reviewPagesRevisionUrl({
      reviewPagesBaseUrl: "https://pages.example///",
      repository: { owner: "yohn-jp", name: "mottainai" },
      pullRequestNumber: 720,
      headSha: HEAD_SHA,
    }),
    `https://pages.example/reviews/pr/720/${HEAD_SHA}/index.html`,
  );
  assert.throws(
    () =>
      reviewPagesRevisionUrl({
        reviewPagesBaseUrl: "https://pages.example",
        repository: "yohn-jp/mottainai",
        pullRequestNumber: 720,
        headSha: HEAD_SHA.slice(0, 12),
      }),
    ReviewProjectionError,
  );
});
