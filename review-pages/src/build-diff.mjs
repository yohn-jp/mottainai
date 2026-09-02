import { collectChangedFiles } from "./lib/git.mjs";

export const DIFF_SCHEMA_VERSION = "mottainai.review-pages.diff/v1";

// Cheap, deterministic diff metadata: per-file status and line counts.
// No hunk content is included here — GitHub remains the canonical source
// for the diff itself; see ocr.json for positioning data.
export function buildDiff({ baseSha, headSha, cwd }) {
  const files = collectChangedFiles(baseSha, headSha, { cwd });
  const stats = files.reduce(
    (totals, file) => ({
      filesChanged: totals.filesChanged + 1,
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { filesChanged: 0, additions: 0, deletions: 0 },
  );

  return {
    schemaVersion: DIFF_SCHEMA_VERSION,
    baseSha,
    headSha,
    files,
    stats,
  };
}
