import fs from "node:fs";
import { validateAgainstSchema } from "../src/lib/schema-validator.mjs";

export const AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION = "mottainai.autonomous-review.result/v1";
export const REVIEW_RESULT_SCHEMA_VERSION = AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION;
export const AUTONOMOUS_REVIEW_VERDICTS = Object.freeze(["APPROVE", "CHANGES_REQUIRED", "INCONCLUSIVE"]);
export const REVIEW_VERDICTS = AUTONOMOUS_REVIEW_VERDICTS;
export const AUTONOMOUS_REVIEW_STATUSES = Object.freeze(["pending", "complete", "failed"]);
export const REVIEW_FINDING_SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
export const REVIEW_FINDING_STATUSES = Object.freeze([
  "new",
  "open",
  "resolved",
  "accepted",
  "dismissed",
  "superseded",
]);

export const AUTONOMOUS_REVIEW_RESULT_SCHEMA = JSON.parse(
  fs.readFileSync(new URL("./autonomous-review-result.schema.json", import.meta.url), "utf8"),
);
export const REVIEW_RESULT_SCHEMA = AUTONOMOUS_REVIEW_RESULT_SCHEMA;

/**
 * @typedef {import("./autonomous-review-result.d.ts").AutonomousReviewIdentity} AutonomousReviewIdentity
 * @typedef {import("./autonomous-review-result.d.ts").AutonomousReviewResult} AutonomousReviewResult
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function isValidReviewIdentityShape(identity) {
  return (
    isRecord(identity) &&
    typeof identity.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/u.test(identity.repository) &&
    Number.isInteger(identity.pullRequest) &&
    identity.pullRequest >= 1 &&
    typeof identity.baseSha === "string" &&
    FULL_SHA_PATTERN.test(identity.baseSha) &&
    typeof identity.headSha === "string" &&
    FULL_SHA_PATTERN.test(identity.headSha) &&
    identity.baseSha !== identity.headSha
  );
}

/**
 * Compare every component of a review identity. In particular, the full
 * head SHA is compared; a short SHA or PR number alone is never sufficient.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 */
export function isExactReviewIdentity(actual, expected) {
  if (!isValidReviewIdentityShape(actual) || !isValidReviewIdentityShape(expected)) return false;
  return (
    typeof actual.repository === "string" &&
    typeof expected.repository === "string" &&
    actual.repository === expected.repository &&
    Number.isInteger(actual.pullRequest) &&
    Number.isInteger(expected.pullRequest) &&
    actual.pullRequest === expected.pullRequest &&
    typeof actual.baseSha === "string" &&
    typeof expected.baseSha === "string" &&
    actual.baseSha === expected.baseSha &&
    typeof actual.headSha === "string" &&
    typeof expected.headSha === "string" &&
    actual.headSha === expected.headSha
  );
}

function semanticErrors(result) {
  const errors = [];
  if (!isRecord(result) || !isRecord(result.identity)) return errors;

  if (result.identity.baseSha === result.identity.headSha) {
    errors.push("$.identity: baseSha and headSha must identify different commits");
  }

  if ((result.status === "pending" || result.status === "failed") && result.verdict !== "INCONCLUSIVE") {
    errors.push("$.verdict: pending or failed reviews must use INCONCLUSIVE");
  }

  if (!Array.isArray(result.findings)) return errors;
  const findingIds = new Set();
  result.findings.forEach((finding, index) => {
    if (!isRecord(finding) || typeof finding.id !== "string") return;
    if (findingIds.has(finding.id)) {
      errors.push(`$.findings[${index}].id: duplicate finding id ${JSON.stringify(finding.id)}`);
    }
    findingIds.add(finding.id);

    if (!finding.location || !isRecord(finding.location)) return;
    const { start, end } = finding.location;
    if (!isRecord(start) || !isRecord(end)) return;
    if (
      start.line > end.line ||
      (start.line === end.line && start.column !== undefined && end.column !== undefined && start.column > end.column)
    ) {
      errors.push(`$.findings[${index}].location: start must not follow end`);
    }
  });
  return errors;
}

/**
 * Validate one autonomous review result and, when supplied, its exact
 * revision identity. The optional identity check is what prevents a valid
 * result from being reused after a PR head rollover.
 *
 * @param {unknown} value
 * @param {{ expectedIdentity?: AutonomousReviewIdentity }} [options]
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAutonomousReviewResult(value, { expectedIdentity } = {}) {
  const schemaResult = validateAgainstSchema(AUTONOMOUS_REVIEW_RESULT_SCHEMA, value);
  const errors = [...schemaResult.errors, ...semanticErrors(value)];

  if (expectedIdentity !== undefined && !isExactReviewIdentity(value?.identity, expectedIdentity)) {
    errors.push("$.identity: result is stale or does not match the expected repository/PR/base/head revision");
  }

  return { valid: errors.length === 0, errors };
}

export const validateReviewResult = validateAutonomousReviewResult;

/**
 * Check whether a result can be used for exactly one current revision.
 * Invalid result data and any identity mismatch both return false.
 *
 * @param {unknown} value
 * @param {AutonomousReviewIdentity} expectedIdentity
 */
export function isReviewResultForRevision(value, expectedIdentity) {
  return validateAutonomousReviewResult(value, { expectedIdentity }).valid;
}

/**
 * Validate a result and throw a bounded diagnostic if it is malformed or
 * anchored to a stale/mismatched revision.
 *
 * @param {unknown} value
 * @param {AutonomousReviewIdentity} [expectedIdentity]
 * @returns {AutonomousReviewResult}
 */
export function assertAutonomousReviewResult(value, expectedIdentity) {
  const validation =
    expectedIdentity === undefined
      ? validateAutonomousReviewResult(value)
      : validateAutonomousReviewResult(value, { expectedIdentity });
  if (!validation.valid) {
    throw new TypeError(`invalid autonomous review result: ${validation.errors.join("; ")}`);
  }
  return value;
}

export const assertReviewResult = assertAutonomousReviewResult;
