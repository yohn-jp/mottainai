import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutonomousReviewResult,
  isReviewResultForRevision,
  validateAutonomousReviewResult,
} from "../review/autonomous-review-result.mjs";

const identity = {
  repository: "yohn-jp/mottainai",
  pullRequest: 716,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

const validResult = {
  schemaVersion: "mottainai.autonomous-review.result/v1",
  identity,
  status: "complete",
  verdict: "CHANGES_REQUIRED",
  findings: [
    {
      id: "security.sql-injection",
      severity: "high",
      blocking: true,
      title: "Untrusted value reaches the query",
      rationale: "The value is interpolated without a parameter binding.",
      evidence: [{ resource: "diff.json", reference: "$.files[0].hunks[0]" }],
      location: {
        path: "src/query.mjs",
        start: { line: 12, column: 3 },
        end: { line: 12, column: 30 },
      },
      status: "open",
    },
  ],
  confidence: 0.92,
  inputs: {
    inspected: [
      { resource: "manifest.json", references: ["$"] },
      { resource: "diff.json", references: ["$.files[0].hunks[0]"] },
    ],
    omitted: [{ resource: "checks.json", reason: "The check snapshot was unavailable." }],
  },
  unknowns: [{ id: "runtime-behavior", reason: "The integration environment was not included in the bounded input." }],
};

test("a complete structured result validates", () => {
  const result = validateAutonomousReviewResult(validResult);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("verdict vocabulary is closed and status is separate", () => {
  for (const verdict of ["APPROVE", "CHANGES_REQUIRED", "INCONCLUSIVE"]) {
    assert.equal(validateAutonomousReviewResult({ ...validResult, verdict }).valid, true);
  }
  assert.equal(validateAutonomousReviewResult({ ...validResult, verdict: "WAITING" }).valid, false);
  assert.equal(validateAutonomousReviewResult({ ...validResult, status: "waiting" }).valid, false);
  assert.equal(validateAutonomousReviewResult({ ...validResult, status: "pending", verdict: "APPROVE" }).valid, false);
  assert.equal(
    validateAutonomousReviewResult({ ...validResult, status: "failed", verdict: "CHANGES_REQUIRED" }).valid,
    false,
  );
});

test("inspected, omitted, and unknown inputs remain distinct", () => {
  const result = validateAutonomousReviewResult({
    ...validResult,
    verdict: "INCONCLUSIVE",
    status: "pending",
    inputs: {
      inspected: [{ resource: "issue.json" }],
      omitted: [{ resource: "ocr.json", reason: "OCR output was not published." }],
    },
    unknowns: [{ id: "checks", reason: "The current check state is not known." }],
  });
  assert.equal(result.valid, true);
});

test("exact repository, PR, base, and full head identity is mandatory", () => {
  const { headSha: _headSha, ...missingHead } = identity;
  const withoutHead = { ...validResult, identity: missingHead };
  assert.equal(validateAutonomousReviewResult(withoutHead).valid, false);

  const ambiguousIdentity = { ...validResult, identity: { ...identity, baseSha: identity.headSha } };
  const ambiguous = validateAutonomousReviewResult(ambiguousIdentity);
  assert.equal(ambiguous.valid, false);
  assert.ok(ambiguous.errors.some((error) => error.includes("different commits")));
});

test("stale head results are rejected when a current identity is supplied", () => {
  const currentIdentity = { ...identity, headSha: "c".repeat(40) };
  assert.equal(isReviewResultForRevision(validResult, identity), true);
  assert.equal(isReviewResultForRevision(validResult, currentIdentity), false);
  const stale = validateAutonomousReviewResult(validResult, { expectedIdentity: currentIdentity });
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((error) => error.includes("stale")));
  assert.throws(() => assertAutonomousReviewResult(validResult, currentIdentity), /stale/u);
});

test("malformed and ambiguous findings are rejected", () => {
  const duplicateIds = {
    ...validResult,
    findings: [validResult.findings[0], { ...validResult.findings[0], title: "same stable id" }],
  };
  assert.equal(validateAutonomousReviewResult(duplicateIds).valid, false);

  const unbounded = {
    ...validResult,
    findings: [{ ...validResult.findings[0], rationale: "x".repeat(4001) }],
  };
  assert.equal(validateAutonomousReviewResult(unbounded).valid, false);

  const reversedLocation = {
    ...validResult,
    findings: [
      {
        ...validResult.findings[0],
        location: { path: "src/query.mjs", start: { line: 20 }, end: { line: 10 } },
      },
    ],
  };
  assert.equal(validateAutonomousReviewResult(reversedLocation).valid, false);
});

test("unknown top-level fields cannot become an alternate authority", () => {
  const result = validateAutonomousReviewResult({ ...validResult, summary: "approve" });
  assert.equal(result.valid, false);
});

test("non-object input returns a validation result instead of throwing", () => {
  const result = validateAutonomousReviewResult(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
