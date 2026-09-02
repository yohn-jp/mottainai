import { runOcrPreview, runOcrRule, ocrPackageVersion } from "./lib/ocr-cli.mjs";

export const OCR_SCHEMA_VERSION = "mottainai.review-pages.ocr/v1";

const OCR_PACKAGE_NAME = "@alibaba-group/open-code-review";

// Open Code Review integration boundary.
//
// OCR ships a documented, LLM-free "delegate" mode built exactly for
// this: `ocr delegate preview` performs OCR's own deterministic
// changed-file selection/exclusion, and `ocr delegate rule` resolves
// OCR's own review rules for the files preview selected. Review Pages
// consumes both verbatim as the canonical source for review-oriented
// deterministic analysis; it does not reimplement file selection,
// exclusion, or rule resolution itself. No LLM credentials are used —
// delegate mode never calls a model.
//
// `preview.repository` is stripped: it is an absolute local filesystem
// path from the `--repo` argument, not portable/meaningful evidence,
// and duplicates `manifest.repository`.
export function buildOcr({ cwd, baseSha, headSha }) {
  const preview = runOcrPreview({ cwd, baseSha, headSha });
  const { repository: _repository, ...normalizedPreview } = preview;

  const reviewableFiles = (preview.reviewable_files ?? []).map((file) => file.path);
  const rule = runOcrRule({ cwd, baseSha, headSha, files: reviewableFiles });

  return {
    schemaVersion: OCR_SCHEMA_VERSION,
    provider: {
      package: OCR_PACKAGE_NAME,
      version: ocrPackageVersion(),
      cli: "ocr delegate",
    },
    baseSha,
    headSha,
    preview: normalizedPreview,
    rule,
  };
}
