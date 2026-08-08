/**
 * Provider-independent records used by workflow integrations.
 *
 * The adapter owns the mapping from a provider's wire format to these shapes.
 * Keeping that mapping outside this module prevents provider fields from
 * becoming workflow-domain contracts.
 */

export interface ProviderEntityIdentity {
  provider: string;
  id: string;
}

export interface RepositoryIdentity extends ProviderEntityIdentity {
  namespace?: string;
  name?: string;
  url?: string;
}

export type StructuredMetadataValue = string | number | boolean | null;

export interface IssueMetadata {
  labels: readonly string[];
  assignees: readonly string[];
  milestone?: string;
  values: Readonly<Record<string, StructuredMetadataValue>>;
}

export interface IssueReference {
  reference: string;
  number?: number;
  title?: string;
  url?: string;
}

export const ISSUE_STATES = ["open", "closed", "unknown"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export interface Issue extends IssueReference {
  identity: ProviderEntityIdentity;
  title: string;
  state: IssueState;
  repository: RepositoryIdentity;
  metadata: IssueMetadata;
}

export interface RevisionIdentity {
  name: string;
  revision?: string;
}

export const PULL_REQUEST_STATES = ["open", "closed", "merged", "unknown"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export const PULL_REQUEST_LIFECYCLE_STATES = ["draft", "open", "closed", "merged", "unknown"] as const;
export type PullRequestLifecycleState = (typeof PULL_REQUEST_LIFECYCLE_STATES)[number];

export interface PullRequest extends IssueReference {
  identity: ProviderEntityIdentity;
  number: number;
  url: string;
  state: PullRequestState;
  lifecycleState: PullRequestLifecycleState;
  repository: RepositoryIdentity;
  head: RevisionIdentity;
  base: RevisionIdentity;
}
