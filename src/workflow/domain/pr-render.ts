import type { Issue, IssueReference } from "../providers/model.js";
import type { PullRequestRule, WorkflowPolicyDocument } from "../policy/schema.js";

export type IssueRequirement = "required" | "optional";
export type ClosingIssueRequirement = "exactly-one" | "optional" | "none";
export type PullRequestSectionValue = string | readonly string[];

export interface PullRequestRenderPolicy {
  issue?: IssueRequirement;
  closingIssue?: ClosingIssueRequirement;
  requiredSections?: readonly string[];
  acceptanceCriteriaSection?: string;
  acceptanceCriteriaChecklist?: boolean;
  templates?: Readonly<Record<string, string>>;
  /** Alias useful to callers that name the configured values after their role. */
  sectionTemplates?: Readonly<Record<string, string>>;
}

export interface PullRequestBodyDraft {
  issue?: Issue | IssueReference;
  sections: Readonly<Record<string, PullRequestSectionValue | undefined>>;
  acceptanceCriteria?: readonly string[];
}

export interface PullRequestBodyValidation {
  ok: boolean;
  errors: string[];
  closingIssues: string[];
}

export type RenderPullRequestBodyResult =
  | { ok: true; body: string; closingIssues: string[] }
  | { ok: false; errors: string[] };

const DEFAULT_POLICY: Required<
  Pick<
    PullRequestRenderPolicy,
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
  policy: PullRequestRenderPolicy | WorkflowPolicyDocument["pullRequest"],
): policy is WorkflowPolicyDocument["pullRequest"] {
  return policy !== undefined && "templates" in policy && "requiredSections" in policy;
}

export function resolvePullRequestRenderPolicy(
  policy: PullRequestRenderPolicy | WorkflowPolicyDocument["pullRequest"] | undefined,
): PullRequestRenderPolicy {
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

function meaningful(value: string): boolean {
  const normalized = value.replace(/<!--[\s\S]*?-->/g, "").trim();
  return normalized.length > 0 && !/^(?:n\/?a|none|tbd|todo|not applicable)\.?$/i.test(normalized);
}

function renderValue(value: PullRequestSectionValue): string {
  if (typeof value === "string") return value.trim();
  return value
    .filter((item) => meaningful(item))
    .map((item) => `- ${item.trim()}`)
    .join("\n");
}

function applyTemplate(value: string, template: string | undefined): string {
  if (template === undefined) return value;
  return template.includes("{value}") ? template.replaceAll("{value}", value) : `${template}\n${value}`;
}

function sectionBody(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = markdown.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^(#{2,3})\\s+${escaped}\\s*$`, "i").test(line));
  if (index === -1) return "";
  const level = lines[index]?.match(/^#+/)?.[0].length ?? 2;
  const boundary = new RegExp(`^#{2,${level}}\\s+`);
  const body: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (boundary.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

const CLOSING_ISSUE_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/gi;

function closingIssues(markdown: string): string[] {
  return [...markdown.matchAll(CLOSING_ISSUE_REFERENCE)].map((match) => match[1] ?? "").filter(Boolean);
}

export function validatePullRequestBody(
  markdown: string,
  policy: PullRequestRenderPolicy | WorkflowPolicyDocument["pullRequest"] | undefined,
): PullRequestBodyValidation {
  const resolved = resolvePullRequestRenderPolicy(policy);
  const errors: string[] = [];
  const foundClosingIssues = closingIssues(markdown);

  for (const heading of resolved.requiredSections ?? []) {
    if (!meaningful(sectionBody(markdown, heading))) errors.push(`required section is empty: ${heading}`);
  }

  if (resolved.acceptanceCriteriaChecklist) {
    const acceptance = sectionBody(
      markdown,
      resolved.acceptanceCriteriaSection ?? DEFAULT_POLICY.acceptanceCriteriaSection,
    );
    if (!/-\s+\[[ xX]\]\s+\S/.test(acceptance)) {
      errors.push(
        `acceptance criteria must contain a checklist item: ${resolved.acceptanceCriteriaSection ?? DEFAULT_POLICY.acceptanceCriteriaSection}`,
      );
    }
  }

  if (resolved.closingIssue === "exactly-one" && foundClosingIssues.length !== 1) {
    errors.push("exactly one closing Issue is required");
  }
  if (resolved.closingIssue === "none" && foundClosingIssues.length !== 0) {
    errors.push("closing Issue is not allowed");
  }

  return { ok: errors.length === 0, errors, closingIssues: foundClosingIssues };
}

export function renderPullRequestBody(
  draft: PullRequestBodyDraft,
  policy: PullRequestRenderPolicy | WorkflowPolicyDocument["pullRequest"] | undefined,
): RenderPullRequestBodyResult {
  const resolved = resolvePullRequestRenderPolicy(policy);
  const errors: string[] = [];
  const issueReference = draft.issue?.reference.trim();
  if (resolved.issue === "required" && issueReference === undefined) errors.push("Issue is required");
  if (issueReference !== undefined && issueReference.length === 0) errors.push("Issue reference must not be empty");
  if (issueReference?.includes("\n") === true) errors.push("Issue reference must be a single line");
  if (resolved.closingIssue === "exactly-one" && issueReference === undefined) {
    errors.push("exactly one closing Issue is required");
  }

  const requiredSections = [...(resolved.requiredSections ?? [])];
  const extraSections = Object.keys(draft.sections)
    .filter((heading) => !requiredSections.includes(heading))
    .sort((left, right) => left.localeCompare(right));
  const acceptanceHeading = resolved.acceptanceCriteriaSection ?? DEFAULT_POLICY.acceptanceCriteriaSection;
  const includesAcceptanceHeading = [...requiredSections, ...extraSections].some(
    (heading) => heading.toLowerCase() === acceptanceHeading.toLowerCase(),
  );
  const headings =
    includesAcceptanceHeading || (!resolved.acceptanceCriteriaChecklist && draft.acceptanceCriteria === undefined)
      ? [...requiredSections, ...extraSections]
      : [...requiredSections, ...extraSections, acceptanceHeading];
  const renderedSections: string[] = [];

  for (const heading of headings) {
    const value = draft.sections[heading];
    const isAcceptance = heading.toLowerCase() === acceptanceHeading.toLowerCase();
    const structuredAcceptance = draft.acceptanceCriteria;
    const renderedValue =
      isAcceptance && structuredAcceptance !== undefined
        ? structuredAcceptance
            .map((item) => `- [ ] ${item}`)
            .join("\n")
            .trim()
        : value === undefined
          ? ""
          : renderValue(value);
    if (!meaningful(renderedValue)) {
      if (requiredSections.includes(heading)) errors.push(`required section is empty: ${heading}`);
      continue;
    }
    const template = resolved.templates?.[heading] ?? resolved.sectionTemplates?.[heading];
    renderedSections.push(`## ${heading}\n${applyTemplate(renderedValue, template)}`);
  }

  if (resolved.acceptanceCriteriaChecklist && draft.acceptanceCriteria === undefined) {
    const acceptanceHeading = resolved.acceptanceCriteriaSection ?? DEFAULT_POLICY.acceptanceCriteriaSection;
    errors.push(`acceptance criteria must be provided: ${acceptanceHeading}`);
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };

  const bodyParts = [...renderedSections];
  if (
    resolved.closingIssue === "exactly-one" ||
    (resolved.closingIssue === "optional" && issueReference !== undefined)
  ) {
    bodyParts.push(`Closes ${issueReference}`);
  }
  const body = bodyParts.join("\n\n").trim();
  const validation = validatePullRequestBody(body, resolved);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, body, closingIssues: validation.closingIssues };
}

/** Short alias for callers that use the PR abbreviation. */
export const renderPrBody = renderPullRequestBody;
export const validatePrBody = validatePullRequestBody;

/** Convert a parsed workflow policy without embedding repository governance values here. */
export function pullRequestPolicyFromWorkflow(policy: WorkflowPolicyDocument): PullRequestRenderPolicy {
  return resolvePullRequestRenderPolicy(policy.pullRequest as PullRequestRule | undefined);
}
