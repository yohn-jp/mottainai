import path from "node:path";
import { decideProtectedBranchOperation } from "../policy/protected-branch.js";
import type { StagingMode, WorkflowPolicyDocument } from "../policy/schema.js";
import {
  boundPaths,
  gitCommandFailure,
  isPathInsideWorkspace,
  readGitStatus,
  runGitCommand,
  type BoundedPathList,
  type GitStatusSnapshot,
  type WorkflowContextFailureCode,
  type WorkflowContextInput,
  type VerifiedWorkflowContext,
  verifyWorkflowContext,
} from "./context.js";

export type { StagingMode } from "../policy/schema.js";

export interface StructuredCommitMessage {
  /** Conventional Commit type when the message policy enables that format. */
  type?: string;
  scope?: string;
  subject: string;
  body?: string;
  footer?: string;
  breaking?: boolean;
}

export interface CommitMessagePolicy {
  conventionalCommits?: boolean;
  allowedTypes?: readonly string[];
  requireScope?: boolean;
  allowBreaking?: boolean;
  maxSubjectLength?: number;
}

export interface CommitPolicy {
  /** Explicit override. If omitted, workflow policy is used; strict-worktree defaults to explicit. */
  stagingMode?: StagingMode;
  strictWorktree?: boolean;
  message?: CommitMessagePolicy;
  unexpectedPathLimit?: number;
}

export interface CommitOperationInput extends WorkflowContextInput {
  policy: WorkflowPolicyDocument;
  message: StructuredCommitMessage;
  commitPolicy?: CommitPolicy;
  messagePolicy?: CommitMessagePolicy;
  includePaths?: readonly string[];
  /** Short alias for includePaths. */
  include?: readonly string[];
}

export type CommitErrorCode =
  | WorkflowContextFailureCode
  | "protected-branch"
  | "invalid-message"
  | "empty-diff"
  | "no-staged-diff"
  | "explicit-include-required"
  | "include-path-not-changed"
  | "invalid-path"
  | "unexpected-changed-paths"
  | "staging-failed"
  | "commit-failed"
  | "commit-result-unavailable";

export interface CommitFailure {
  ok: false;
  code: CommitErrorCode;
  detail: string;
  unexpectedPaths?: BoundedPathList;
  gitCode?: string;
}

export interface CommitVerificationSuccess {
  ok: true;
  context: VerifiedWorkflowContext;
  stagingMode: StagingMode;
  finalMessage: string;
  includePaths: string[] | undefined;
  status: GitStatusSnapshot;
  /** Planned add arguments. Undefined for already-staged-only. */
  stagingArguments: string[] | undefined;
}

export type CommitVerificationResult = CommitVerificationSuccess | CommitFailure;

export interface CommitSuccess {
  ok: true;
  commitId: string;
  message: string;
  stagingMode: StagingMode;
}

export type CommitResult = CommitSuccess | CommitFailure;

const VALID_CONVENTIONAL_TYPE = /^[a-z][a-z0-9-]*$/;
const VALID_CONVENTIONAL_SCOPE = /^[a-z0-9][a-z0-9._/-]*$/;
const DEFAULT_SUBJECT_LIMIT = 200;

function messageFailure(detail: string): CommitFailure {
  return { ok: false, code: "invalid-message", detail };
}

function validateMessagePart(value: string | undefined, fieldName: string): CommitFailure | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\u0000") || value.includes("\r"))
    return messageFailure(`${fieldName} contains a forbidden control character`);
  return undefined;
}

export function renderCommitMessage(
  message: StructuredCommitMessage,
  policy: CommitMessagePolicy = {},
): { ok: true; message: string } | CommitFailure {
  if (
    message.subject.length === 0 ||
    message.subject.trim() !== message.subject ||
    /[\u0000-\u001f\u007f]/.test(message.subject)
  ) {
    return messageFailure("subject must be a non-empty single line without surrounding whitespace");
  }
  if (message.subject.length > (policy.maxSubjectLength ?? DEFAULT_SUBJECT_LIMIT)) {
    return messageFailure("subject exceeds the message policy length limit");
  }
  for (const [value, fieldName] of [
    [message.body, "body"],
    [message.footer, "footer"],
  ] as const) {
    const failure = validateMessagePart(value, fieldName);
    if (failure !== undefined) return failure;
  }

  let header = message.subject;
  if (policy.conventionalCommits === true) {
    if (message.type === undefined || !VALID_CONVENTIONAL_TYPE.test(message.type)) {
      return messageFailure("conventional commits require a lowercase type");
    }
    if (policy.allowedTypes !== undefined && !policy.allowedTypes.includes(message.type)) {
      return messageFailure("commit type is not allowed by the message policy");
    }
    if (policy.requireScope === true && (message.scope === undefined || message.scope.length === 0)) {
      return messageFailure("conventional commit scope is required by the message policy");
    }
    if (message.scope !== undefined && !VALID_CONVENTIONAL_SCOPE.test(message.scope)) {
      return messageFailure("conventional commit scope is invalid");
    }
    if (message.breaking === true && policy.allowBreaking === false)
      return messageFailure("breaking commits are disabled by the message policy");
    header = `${message.type}${message.scope === undefined ? "" : `(${message.scope})`}${message.breaking === true ? "!" : ""}: ${message.subject}`;
  } else if (message.breaking === true) {
    return messageFailure("breaking is only valid when conventional commits are enabled");
  }

  const sections = [header];
  if (message.body !== undefined && message.body.length > 0) sections.push(message.body);
  if (message.footer !== undefined && message.footer.length > 0) sections.push(message.footer);
  return { ok: true, message: sections.join("\n\n") };
}

function resolveMessagePolicy(input: CommitOperationInput): CommitMessagePolicy {
  return input.messagePolicy ?? input.commitPolicy?.message ?? {};
}

function resolveStagingMode(input: CommitOperationInput): StagingMode {
  if (input.commitPolicy?.strictWorktree === true) return "explicit";
  if (input.commitPolicy?.stagingMode !== undefined) return input.commitPolicy.stagingMode;
  if (input.policy.preset === "strict-worktree") return "explicit";
  return input.policy.stagingMode ?? "explicit";
}

function includePaths(input: CommitOperationInput): readonly string[] | undefined {
  return input.includePaths ?? input.include;
}

function invalidIncludePath(workspaceRoot: string, candidate: string): CommitFailure | undefined {
  if (candidate.length === 0 || candidate.includes("\u0000") || !isPathInsideWorkspace(workspaceRoot, candidate)) {
    return {
      ok: false,
      code: "invalid-path",
      detail: "include path must be a non-empty relative path inside the worktree",
    };
  }
  const normalized = path.normalize(candidate);
  if (normalized !== candidate && normalized !== candidate.replaceAll("/", path.sep)) {
    return {
      ok: false,
      code: "invalid-path",
      detail: "include path must not contain path traversal or ambiguous separators",
    };
  }
  return undefined;
}

function changedPathSet(status: GitStatusSnapshot): Set<string> {
  return new Set(status.entries.map((entry) => entry.path));
}

function boundedUnexpectedPaths(status: GitStatusSnapshot, include: readonly string[], limit: number): BoundedPathList {
  const included = new Set(include);
  return boundPaths(
    status.entries.filter((entry) => !included.has(entry.path)).map((entry) => entry.path),
    limit,
  );
}

function stageArguments(mode: StagingMode, include: readonly string[] | undefined): string[] | undefined {
  if (mode === "already-staged-only") return undefined;
  if (mode === "explicit") return ["add", "--", ...(include ?? [])];
  if (mode === "tracked") return include === undefined ? ["add", "--update"] : ["add", "--update", "--", ...include];
  return include === undefined ? ["add", "--all", "--"] : ["add", "--all", "--", ...include];
}

function protectedBranchFailure(
  operation: "stage" | "commit",
  context: VerifiedWorkflowContext,
  policy: WorkflowPolicyDocument,
): CommitFailure | undefined {
  const decision = decideProtectedBranchOperation({
    policy,
    branch: context.branch,
    operation,
    repository: { isPrimaryCheckout: context.isPrimaryCheckout },
  });
  if (decision.allowed) return undefined;
  return {
    ok: false,
    code: "protected-branch",
    detail: `${operation} denied for protected/control-plane branch ${context.branch}: ${decision.reason}`,
  };
}

function verifyIncludePaths(
  input: CommitOperationInput,
  status: GitStatusSnapshot,
  mode: StagingMode,
): { ok: true; paths: string[] | undefined } | CommitFailure {
  const requested = includePaths(input);
  if (requested === undefined) {
    if (mode === "explicit")
      return { ok: false, code: "explicit-include-required", detail: "explicit staging requires includePaths" };
    return { ok: true, paths: undefined };
  }

  const paths = [...new Set(requested)];
  for (const candidate of paths) {
    const failure = invalidIncludePath(input.workspaceRoot, candidate);
    if (failure !== undefined) return failure;
  }
  const changed = changedPathSet(status);
  if (!paths.some((candidate) => changed.has(candidate))) {
    return { ok: false, code: "include-path-not-changed", detail: "none of the requested include paths is changed" };
  }
  const unexpected = boundedUnexpectedPaths(status, paths, input.commitPolicy?.unexpectedPathLimit ?? 32);
  if (unexpected.paths.length > 0 || unexpected.truncated) {
    return {
      ok: false,
      code: "unexpected-changed-paths",
      detail: "changed or untracked paths exist outside the explicit include list",
      unexpectedPaths: unexpected,
    };
  }
  return { ok: true, paths };
}

export async function verifyCommit(input: CommitOperationInput): Promise<CommitVerificationResult> {
  const rendered = renderCommitMessage(input.message, resolveMessagePolicy(input));
  if (!rendered.ok) return rendered;

  const context = await verifyWorkflowContext(input);
  if (!context.ok) return context;

  const stageFailure = protectedBranchFailure("stage", context, input.policy);
  if (stageFailure !== undefined) return stageFailure;
  const commitFailure = protectedBranchFailure("commit", context, input.policy);
  if (commitFailure !== undefined) return commitFailure;

  const statusResult = await readGitStatus(context.workspaceRoot);
  if (!statusResult.ok) return { ok: false, code: statusResult.failure.code, detail: statusResult.failure.detail };
  const status = statusResult.status;
  const mode = resolveStagingMode(input);
  const includeResult = verifyIncludePaths(input, status, mode);
  if (!includeResult.ok) return includeResult;

  if (mode === "already-staged-only") {
    if (status.stagedPaths.paths.length === 0)
      return { ok: false, code: "no-staged-diff", detail: "already-staged-only requires a non-empty staged diff" };
  } else if (mode === "tracked") {
    const trackedChanges = status.entries.some((entry) => !(entry.indexStatus === "?" && entry.worktreeStatus === "?"));
    if (!trackedChanges) return { ok: false, code: "empty-diff", detail: "tracked staging found no tracked changes" };
  } else if (status.entries.length === 0) {
    return { ok: false, code: "empty-diff", detail: "worktree has no changed or untracked paths" };
  }

  return {
    ok: true,
    context,
    stagingMode: mode,
    finalMessage: rendered.message,
    includePaths: includeResult.paths,
    status,
    stagingArguments: stageArguments(mode, includeResult.paths),
  };
}

export async function commitTask(input: CommitOperationInput): Promise<CommitResult> {
  const verification = await verifyCommit(input);
  if (!verification.ok) return verification;

  if (verification.stagingArguments !== undefined) {
    const staging = await runGitCommand(verification.context.workspaceRoot, verification.stagingArguments);
    if (!staging.usable || staging.result.exitCode !== 0) {
      const failure = gitCommandFailure("stage", staging);
      return { ok: false, code: "staging-failed", detail: failure.detail, gitCode: failure.code };
    }
  }

  const commit = await runGitCommand(verification.context.workspaceRoot, ["commit", "-m", verification.finalMessage]);
  if (!commit.usable || commit.result.exitCode !== 0) {
    const failure = gitCommandFailure("commit", commit);
    return { ok: false, code: "commit-failed", detail: failure.detail, gitCode: failure.code };
  }

  const head = await runGitCommand(verification.context.workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!head.usable || head.result.exitCode !== 0 || head.result.stdout.trim().length === 0) {
    const failure = gitCommandFailure("resolve-commit-result", head);
    return { ok: false, code: "commit-result-unavailable", detail: failure.detail, gitCode: failure.code };
  }
  return {
    ok: true,
    commitId: head.result.stdout.trim(),
    message: verification.finalMessage,
    stagingMode: verification.stagingMode,
  };
}
