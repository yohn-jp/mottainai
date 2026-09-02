import fs from "node:fs";
import path from "node:path";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validatedHeadSha(prIndex) {
  const headSha = prIndex?.latest?.headSha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("Review Pages navigation requires latest.headSha to be a 40-character lowercase hex SHA");
  }
  return headSha;
}

function readPrIndex(prDir) {
  const indexPath = path.join(prDir, "index.json");
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    validatedHeadSha(index);
    return index;
  } catch {
    return null;
  }
}

export function renderPrNavigation(prNumber, prIndex) {
  const headSha = validatedHeadSha(prIndex);
  const shortId = prIndex.latest.shortId ?? headSha.slice(0, 12);
  const target = `${headSha}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${target}">
  <title>Review Pages · PR #${prNumber}</title>
</head>
<body>
  <main>
    <h1>PR #${prNumber}</h1>
    <p>Current review revision: <a href="${target}">${escapeHtml(shortId)}</a></p>
    <p><a href="../../../">All Review Pages</a></p>
  </main>
</body>
</html>
`;
}

export function renderRootNavigation(entries) {
  const rows = entries
    .map(({ prNumber, headSha, shortId }) => `    <li><a href="reviews/pr/${prNumber}/">PR #${prNumber}</a> · ${escapeHtml(shortId ?? headSha.slice(0, 12))}</li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mottainai Review Pages</title>
</head>
<body>
  <main>
    <h1>Mottainai Review Pages</h1>
    <p>Stable links to the latest published review revision for each PR.</p>
    <ul>
${rows}
    </ul>
  </main>
</body>
</html>
`;
}

export function refreshNavigationPages(siteDir, prNumber, prIndex) {
  validatedHeadSha(prIndex);
  const prRoot = path.join(siteDir, "reviews", "pr");
  const prDir = path.join(prRoot, String(prNumber));
  fs.writeFileSync(path.join(prDir, "index.html"), renderPrNavigation(prNumber, prIndex));

  const entries = fs.existsSync(prRoot)
    ? fs.readdirSync(prRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
        .map((entry) => {
          const index = readPrIndex(path.join(prRoot, entry.name));
          if (!index) return null;
          return {
            prNumber: Number(entry.name),
            headSha: index.latest.headSha,
            shortId: index.latest.shortId,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.prNumber - a.prNumber)
    : [];

  fs.writeFileSync(path.join(siteDir, "index.html"), renderRootNavigation(entries));
}
