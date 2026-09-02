import { renderReviewResult } from "./review-projection.mjs";

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

// A small static human view over the manifest. The JSON resources are
// the canonical contract; this page exists only to make them legible
// without downloading each file.
export function renderHtml({
  manifest,
  diff,
  issue,
  reviewResult,
  latestHeadSha,
  latestRevision,
  prIndex,
  reviewResultHref,
}) {
  const pr = manifest.pullRequest;
  const fileRows = diff.files
    .map(
      (file) =>
        `<tr><td>${escapeHtml(file.path)}</td><td>${escapeHtml(file.status)}</td>` +
        `<td>+${file.additions ?? "?"}</td><td>-${file.deletions ?? "?"}</td></tr>`,
    )
    .join("\n");

  const acceptanceRows = issue.acceptanceCriteria
    .map((item) => `<li>${item.checked ? "[x]" : "[ ]"} ${escapeHtml(item.text)}</li>`)
    .join("\n");
  const reviewSection = reviewResult
    ? renderReviewResult({
        reviewResult,
        manifest,
        latestHeadSha: latestHeadSha ?? latestRevision?.headSha ?? prIndex?.latest?.headSha ?? manifest.revision.id,
        ...(reviewResultHref !== undefined ? { reviewResultHref } : {}),
      })
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Review — ${escapeHtml(manifest.repository.fullName)} #${pr.number} @ ${escapeHtml(manifest.revision.shortId)}</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: 13px; }
code { background: #f0f0f0; padding: 1px 4px; }
a { color: #0a58ca; }
</style>
</head>
<body>
<h1>${escapeHtml(manifest.repository.fullName)} #${pr.number}: ${escapeHtml(pr.title ?? "")}</h1>
<p>Base <code>${escapeHtml(pr.baseRef)}</code> @ <code>${escapeHtml(pr.baseSha)}</code> &rarr;
Head <code>${escapeHtml(pr.headRef)}</code> @ <code>${escapeHtml(pr.headSha)}</code></p>
<p>Revision <code>${escapeHtml(manifest.revision.shortId)}</code> is immutable. Machine-readable entry point:
<a href="manifest.json">manifest.json</a></p>

<h2>Linked issue</h2>
${issue.issue ? `<p><a href="${escapeHtml(issue.issue.url ?? "#")}">#${issue.issue.number}</a> ${escapeHtml(issue.issue.title ?? "")} (${escapeHtml(issue.issue.state ?? "")})</p>` : "<p>none</p>"}
${acceptanceRows ? `<h3>Acceptance criteria</h3><ul>${acceptanceRows}</ul>` : ""}

${reviewSection}

<h2>Changed files (${diff.stats.filesChanged}, +${diff.stats.additions}/-${diff.stats.deletions})</h2>
<table>
<tr><th>Path</th><th>Status</th><th>Additions</th><th>Deletions</th></tr>
${fileRows}
</table>

<h2>Resources</h2>
<ul>
<li><a href="manifest.json">manifest.json</a></li>
<li><a href="issue.json">issue.json</a></li>
<li><a href="diff.json">diff.json</a></li>
<li><a href="ocr.json">ocr.json</a></li>
<li><a href="checks.json">checks.json</a></li>
</ul>
</body>
</html>
`;
}
