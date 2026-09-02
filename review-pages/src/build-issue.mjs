import { findLinkedIssueNumber, extractAcceptanceCriteria } from "./lib/markdown.mjs";
import { fetchIssue } from "./lib/github-api.mjs";

export const ISSUE_SCHEMA_VERSION = "mottainai.review-pages.issue/v1";

// Structured Issue intent, established only from what the PR body and
// linked Issue actually state (GitHub's own closing-keyword convention
// and an "Acceptance criteria" checklist). No semantics are invented
// when a PR has no linked Issue or an Issue has no such section.
export async function buildIssue({ owner, repo, prBody, token, fetchIssueFn = fetchIssue }) {
  const linkedNumber = findLinkedIssueNumber(prBody);
  if (linkedNumber === null) {
    return {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      linked: null,
      issue: null,
      acceptanceCriteria: [],
    };
  }

  const issue = await fetchIssueFn({ owner, repo, number: linkedNumber, token });
  if (!issue) {
    return {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      linked: { number: linkedNumber },
      issue: null,
      acceptanceCriteria: [],
    };
  }

  return {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    linked: { number: linkedNumber },
    issue: {
      number: issue.number,
      title: issue.title ?? null,
      url: issue.html_url ?? null,
      state: issue.state ?? null,
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)).sort(),
    },
    acceptanceCriteria: extractAcceptanceCriteria(issue.body ?? ""),
  };
}
