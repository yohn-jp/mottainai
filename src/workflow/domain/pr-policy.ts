import type { PullRequestRule, WorkflowPolicyDocument } from "../policy/schema.js";

export type IssueRequirement = "required" | "optional";
export type ClosingIssueRequirement = "exactly-one" | "optional" | "none";

/** Read-only projection used by policy diagnostics; gh-inari owns PR governance. */
export interface PullRequestPolicy {
  issue?: IssueRequirement;
  closingIssue?: ClosingIssueRequirement;
  requiredSections?: readonly string[];
  acceptanceCriteriaSection?: string;
  acceptanceCriteriaChecklist?: boolean;
  templates?: Readonly<Record<string, string>>;
  sectionTemplates?: Readonly<Record<string, string>>;
}

const DEFAULT_POLICY: Required<
  Pick<
    PullRequestPolicy,
    "issue" | "closingIssue" | "requiredSections" | "acceptanceCriteriaSection" | "acceptanceCriteriaChecklist"
  >
> = {
  issue: "optional",
  closingIssue: "optional",
  requiredSections: [],
  acceptanceCriteriaSection: "Acceptance criteria",
  acceptanceCriteriaChecklist: false,
};

function isWorkflowPolicy(
  policy: PullRequestPolicy | WorkflowPolicyDocument["pullRequest"],
): policy is WorkflowPolicyDocument["pullRequest"] {
  return policy !== undefined && "templates" in policy && "requiredSections" in policy;
}

export function resolvePullRequestPolicy(
  policy: PullRequestPolicy | WorkflowPolicyDocument["pullRequest"] | undefined,
): PullRequestPolicy {
  const source = policy ?? {};
  const workflowPolicy = isWorkflowPolicy(source) ? source : undefined;
  const aliasedTemplates = "sectionTemplates" in source ? source.sectionTemplates : undefined;
  const templates = workflowPolicy?.templates ?? source.templates ?? aliasedTemplates;
  return {
    issue: source.issue ?? DEFAULT_POLICY.issue,
    closingIssue: source.closingIssue ?? DEFAULT_POLICY.closingIssue,
    requiredSections: [...(source.requiredSections ?? DEFAULT_POLICY.requiredSections)],
    acceptanceCriteriaSection: source.acceptanceCriteriaSection ?? DEFAULT_POLICY.acceptanceCriteriaSection,
    acceptanceCriteriaChecklist: source.acceptanceCriteriaChecklist ?? DEFAULT_POLICY.acceptanceCriteriaChecklist,
    templates,
  };
}

export function pullRequestPolicyFromWorkflow(policy: WorkflowPolicyDocument): PullRequestPolicy {
  return resolvePullRequestPolicy(policy.pullRequest as PullRequestRule | undefined);
}
