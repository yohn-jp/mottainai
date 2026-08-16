import type { Issue, IssueReference } from "../providers/model.js";

/** Provider-neutral PR fields. The companion owns validation and rendering. */
export type PullRequestSectionValue = string | readonly string[];

export interface PullRequestBodyDraft {
  issue?: Issue | IssueReference;
  sections: Readonly<Record<string, PullRequestSectionValue | undefined>>;
  acceptanceCriteria?: readonly string[];
}
