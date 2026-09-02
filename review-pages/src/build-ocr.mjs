import { collectHunkPositions } from "./lib/git.mjs";

export const OCR_SCHEMA_VERSION = "mottainai.review-pages.ocr-export/v1";

// Open Code Review ("OpenCodeReview") is a manual, comment-triggered
// external review action (see scripts/review-preflight.mjs). Its pinned
// action does not expose a repository-enforceable request-token bound,
// so it is listed in UNBOUNDED_REVIEWERS and stays disabled; Review
// Pages never invokes it. There is currently no stable structured export
// surface to consume from OCR itself, so this module reproduces the
// narrow, deterministic slice of OCR's review-preparation contract that
// Review Pages needs — changed-file selection and hunk positioning —
// directly from Git. It intentionally does not reimplement bundling,
// rule resolution, or any other OCR-owned behavior.
export function buildOcrExport({ baseSha, headSha, cwd, files }) {
  const reviewUnits = files.map((file) => ({
    path: file.path,
    status: file.status,
    hunks: collectHunkPositions(baseSha, headSha, file.path, { cwd }),
  }));

  return {
    schemaVersion: OCR_SCHEMA_VERSION,
    provider: {
      id: "review-pages-deterministic",
      name: "Review Pages deterministic review-unit export",
      version: "1.0.0",
      ocrIntegration: "none-live",
      note:
        "Open Code Review remains disabled (see scripts/review-preflight.mjs UNBOUNDED_REVIEWERS); " +
        "this export is generated directly from Git rather than from a live OCR run, and will be " +
        "replaced by OCR's own structured export once one is published.",
    },
    reviewUnits,
  };
}
