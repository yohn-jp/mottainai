import type { WorkflowPolicyDocument } from "../policy/schema.js";
import { runGitCommand, gitCommandFailure } from "./context.js";

const DEFAULT_BRANCH_TEMPLATE = "{taskType}/{slug}";
const BRANCH_NAME_MAX_LENGTH = 255;
const VALID_TASK_TYPE = /^[a-z][a-z0-9._-]*$/;
const VALID_ISSUE_NUMBER = /^[1-9][0-9]*$/;
const VALID_NORMALIZED_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEMPLATE_VARIABLES = new Set(["taskType", "issueNumber", "slug"]);

export interface BranchTemplateInput {
  taskType: string;
  issueNumber?: number | string;
  normalizedSlug: string;
}

export interface BranchNamePolicy {
  template?: string;
  protectedBranches?: readonly string[];
  /** Protected names remain denied unless this is explicitly true. */
  allowProtectedBranch?: boolean;
  maxLength?: number;
}

export type BranchPolicyInput = BranchNamePolicy | WorkflowPolicyDocument;

export type BranchNameErrorCode =
  | "invalid-task-type"
  | "invalid-issue-number"
  | "invalid-slug"
  | "missing-template-input"
  | "invalid-template"
  | "invalid-branch-name"
  | "protected-branch"
  | "branch-collision"
  | "git-spawn-failed"
  | "git-timeout"
  | "git-output-limit"
  | "git-command-failed";

export interface BranchNameFailure {
  ok: false;
  code: BranchNameErrorCode;
  detail: string;
  branchName?: string;
  protectedPattern?: string;
}

export interface BranchNameSuccess {
  ok: true;
  branchName: string;
  protected: false;
  collision: false;
}

export type BranchNameResult = BranchNameSuccess | BranchNameFailure;

export interface BranchValidationInput {
  workspaceRoot?: string;
  branchName: string;
  policy?: BranchPolicyInput;
  existingBranchNames?: readonly string[];
}

export interface GenerateAndValidateBranchInput extends BranchTemplateInput {
  workspaceRoot?: string;
  policy?: BranchPolicyInput;
  existingBranchNames?: readonly string[];
}

function branchPolicy(policy: BranchPolicyInput | undefined): BranchNamePolicy {
  if (policy === undefined) return {};
  if ("schemaVersion" in policy) return { protectedBranches: policy.protectedBranches };
  return policy;
}

export function normalizeBranchSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateTemplateInput(input: BranchTemplateInput): BranchNameFailure | undefined {
  if (!VALID_TASK_TYPE.test(input.taskType))
    return { ok: false, code: "invalid-task-type", detail: "taskType must be a lowercase branch-safe token" };
  if (input.issueNumber !== undefined && !VALID_ISSUE_NUMBER.test(String(input.issueNumber))) {
    return { ok: false, code: "invalid-issue-number", detail: "issueNumber must be a positive decimal number" };
  }
  if (!VALID_NORMALIZED_SLUG.test(input.normalizedSlug)) {
    return { ok: false, code: "invalid-slug", detail: "normalizedSlug must be lowercase hyphen-separated ASCII" };
  }
  return undefined;
}

export function renderBranchName(
  input: BranchTemplateInput,
  policy?: BranchPolicyInput,
): { ok: true; branchName: string } | BranchNameFailure {
  const inputFailure = validateTemplateInput(input);
  if (inputFailure !== undefined) return inputFailure;

  const template = branchPolicy(policy).template ?? DEFAULT_BRANCH_TEMPLATE;
  const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
  if (placeholders.some((placeholder) => !TEMPLATE_VARIABLES.has(placeholder))) {
    return { ok: false, code: "invalid-template", detail: "template contains an unsupported variable" };
  }
  const templateWithoutPlaceholders = template.replace(/\{([^{}]+)\}/g, "");
  if (/[{}]/.test(templateWithoutPlaceholders)) {
    return { ok: false, code: "invalid-template", detail: "template contains an unmatched brace" };
  }
  if (placeholders.includes("issueNumber") && input.issueNumber === undefined) {
    return { ok: false, code: "missing-template-input", detail: "template requires issueNumber" };
  }

  const values: Record<string, string> = {
    taskType: input.taskType,
    issueNumber: input.issueNumber === undefined ? "" : String(input.issueNumber),
    slug: input.normalizedSlug,
  };
  const branchName = template.replace(/\{([^{}]+)\}/g, (_match, variable: string) => values[variable]!);
  if (branchName.length === 0)
    return { ok: false, code: "invalid-branch-name", detail: "rendered branch name is empty" };
  if (branchName.length > (branchPolicy(policy).maxLength ?? BRANCH_NAME_MAX_LENGTH)) {
    return {
      ok: false,
      code: "invalid-branch-name",
      detail: "rendered branch name exceeds the policy length limit",
      branchName,
    };
  }
  return { ok: true, branchName };
}

export function validateBranchNameSyntax(
  branchName: string,
  policy?: BranchPolicyInput,
): BranchNameFailure | undefined {
  const maxLength = branchPolicy(policy).maxLength ?? BRANCH_NAME_MAX_LENGTH;
  if (
    branchName.length === 0 ||
    branchName.length > maxLength ||
    /[\u0000-\u0020\u007f~^:?*\\[\\]/.test(branchName) ||
    branchName === "@" ||
    branchName.startsWith("-") ||
    branchName.startsWith("/") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.includes("..") ||
    branchName.includes("@{") ||
    branchName.split("/").some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"))
  ) {
    return {
      ok: false,
      code: "invalid-branch-name",
      detail: "branch name is empty, too long, or contains whitespace/control characters",
      branchName,
    };
  }
  return undefined;
}

function protectedPattern(branchName: string, policy: BranchPolicyInput | undefined): string | undefined {
  const patterns = branchPolicy(policy).protectedBranches ?? [];
  for (const pattern of patterns) {
    const source = `^${pattern
      .split("*")
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`;
    if (new RegExp(source).test(branchName)) return pattern;
  }
  return undefined;
}

export async function validateBranchName(input: BranchValidationInput): Promise<BranchNameResult> {
  const syntaxFailure = validateBranchNameSyntax(input.branchName, input.policy);
  if (syntaxFailure !== undefined) return syntaxFailure;

  const pattern = protectedPattern(input.branchName, input.policy);
  if (pattern !== undefined && branchPolicy(input.policy).allowProtectedBranch !== true) {
    return {
      ok: false,
      code: "protected-branch",
      detail: "protected branch names require an explicit allowProtectedBranch policy",
      branchName: input.branchName,
      protectedPattern: pattern,
    };
  }

  if (input.existingBranchNames?.includes(input.branchName) === true) {
    return {
      ok: false,
      code: "branch-collision",
      detail: "branch already exists; no alternate name will be generated",
      branchName: input.branchName,
    };
  }

  if (input.workspaceRoot !== undefined) {
    const format = await runGitCommand(input.workspaceRoot, ["check-ref-format", "--branch", input.branchName]);
    if (!format.usable) {
      const failure = gitCommandFailure("check-ref-format", format);
      return { ok: false, code: failure.code, detail: failure.detail, branchName: input.branchName };
    }
    if (format.result.exitCode !== 0)
      return {
        ok: false,
        code: "invalid-branch-name",
        detail: "git rejected the branch name",
        branchName: input.branchName,
      };

    const collision = await runGitCommand(input.workspaceRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branchName}`,
    ]);
    if (!collision.usable) {
      const failure = gitCommandFailure("check-branch-collision", collision);
      return { ok: false, code: failure.code, detail: failure.detail, branchName: input.branchName };
    }
    if (collision.result.exitCode === 0) {
      return {
        ok: false,
        code: "branch-collision",
        detail: "branch already exists; no alternate name will be generated",
        branchName: input.branchName,
      };
    }
    if (collision.result.exitCode !== 1) {
      return {
        ok: false,
        code: "git-command-failed",
        detail: "branch collision check returned an unexpected exit code",
        branchName: input.branchName,
      };
    }
  }

  return { ok: true, branchName: input.branchName, protected: false, collision: false };
}

export async function generateAndValidateBranchName(input: GenerateAndValidateBranchInput): Promise<BranchNameResult> {
  const generated = renderBranchName(input, input.policy);
  if (!generated.ok) return generated;
  return validateBranchName({
    workspaceRoot: input.workspaceRoot,
    branchName: generated.branchName,
    policy: input.policy,
    existingBranchNames: input.existingBranchNames,
  });
}

export function generateBranchName(
  input: BranchTemplateInput,
  policy?: BranchPolicyInput,
): { ok: true; branchName: string } | BranchNameFailure {
  return renderBranchName(input, policy);
}
