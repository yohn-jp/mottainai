// Minimal, deterministic Markdown extraction. Only the two shapes Review
// Pages needs: GitHub's closing-keyword issue reference, and the
// checklist items under an "Acceptance criteria" heading. Neither
// invents semantics beyond what the source text already states.

const CLOSING_KEYWORDS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

const CLOSING_ISSUE_PATTERN = new RegExp(`\\b(${CLOSING_KEYWORDS.join("|")})\\s+#(\\d+)`, "iu");

export function findLinkedIssueNumber(prBody) {
  if (!prBody) return null;
  const match = CLOSING_ISSUE_PATTERN.exec(prBody);
  return match ? Number(match[2]) : null;
}

const CHECKBOX_PATTERN = /^[-*]\s+\[([ xX])\]\s+(.*)$/u;

export function extractAcceptanceCriteria(issueBody) {
  if (!issueBody) return [];
  const lines = issueBody.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/iu.test(line.trim()));
  if (headingIndex === -1) return [];

  const items = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+/u.test(line)) break;
    const match = CHECKBOX_PATTERN.exec(line.trim());
    if (!match) continue;
    items.push({ text: match[2].trim(), checked: match[1].toLowerCase() === "x" });
  }
  return items;
}
