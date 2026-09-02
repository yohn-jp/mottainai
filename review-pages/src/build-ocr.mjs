export const OCR_STATUS_SCHEMA_VERSION = "mottainai.review-pages.ocr-status/v1";

// Open Code Review ("OpenCodeReview") integration boundary.
//
// Investigated surface (scripts/review-preflight.mjs, .github/workflows/):
// OpenCodeReview is a manual, comment-triggered third-party GitHub Action
// (MANUAL_REVIEW_COMMANDS.OpenCodeReview = "/open-code-review"). Its pinned
// action exposes no repository-enforceable request-token bound, so it is
// listed in UNBOUNDED_REVIEWERS and stays disabled; no workflow in this
// repository currently invokes it or review-preflight.mjs, and none of
// OCR's own deterministic review-preparation logic (changed-file
// selection, bundling, rule resolution, positioning) exists as
// repository-owned code that could be re-exported. There is therefore no
// structured OCR output for Review Pages to consume, and none of that
// logic is reimplemented here.
//
// ocr.json instead records this integration state as an honest,
// versioned status so a future PR — one that gives OpenCodeReview an
// enforceable request bound and a structured export, or wires one up
// deterministically — can populate a real `available` record without a
// breaking schema change. Diff-positioning data Review Pages does own
// (changed files, line/column hunk anchors) lives in diff.json, not
// here; see build-diff.mjs.
export function buildOcrStatus() {
  return {
    schemaVersion: OCR_STATUS_SCHEMA_VERSION,
    status: "unavailable",
    reason:
      "OpenCodeReview has no repository-enforceable request-token bound and stays disabled " +
      "(scripts/review-preflight.mjs UNBOUNDED_REVIEWERS); no workflow in this repository " +
      "invokes it, and it exposes no structured export surface to consume.",
    provider: null,
  };
}
