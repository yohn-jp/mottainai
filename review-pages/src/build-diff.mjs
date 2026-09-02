import { collectChangedFiles, collectHunkPositions } from "./lib/git.mjs";

export const DIFF_SCHEMA_VERSION = "mottainai.review-pages.diff/v1";

// Cheap, deterministic diff metadata: per-file status, line counts, and
// zero-context hunk positions (line/column anchors only — no diff
// content). This is Review Pages' own "other cheap deterministic diff
// metadata" per Issue #704's Change Information category; it is plain
// Git plumbing, not derived from or a stand-in for Open Code Review's
// review-preparation pipeline (see build-ocr.mjs).
export function buildDiff({ baseSha, headSha, cwd }) {
  const files = collectChangedFiles(baseSha, headSha, { cwd }).map((file) => ({
    ...file,
    hunks: collectHunkPositions(baseSha, headSha, file.path, { cwd }),
  }));
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
