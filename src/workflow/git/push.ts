import { decideProtectedBranchOperation, matchesProtectedBranch } from "../policy/protected-branch.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import {
  boundPaths,
  gitCommandFailure,
  readGitStatus,
  runGitCommand,
  type BoundedPathList,
  type WorkflowContextFailureCode,
  type WorkflowContextInput,
  type VerifiedWorkflowContext,
  verifyWorkflowContext,
} from "./context.js";

export interface PushPolicyControls {
  allowDirtyWorktree?: boolean;
  allowUpstreamCreation?: boolean;
  allowRemoteBehind?: boolean;
  allowDiverged?: boolean;
  allowForcePush?: boolean;
  allowProtectedBranch?: boolean;
  requiredValidationEvidence?: readonly string[];
}

export interface ValidationEvidence {
  name: string;
  status: "passed" | "failed";
  /** The exact commit the validation ran against; must equal the current HEAD to count. */
  headCommit: string;
  /** Metadata only; never copied to Git command output or audit state. */
  digest?: string;
  recordedAt?: number;
}

export interface PushOperationInput extends WorkflowContextInput {
  policy: WorkflowPolicyDocument;
  pushPolicy?: PushPolicyControls;
  remote?: string;
  remoteBranch?: string;
  force?: boolean;
  createUpstream?: boolean;
  validationEvidence?: readonly ValidationEvidence[];
}

export type PushErrorCode =
  | WorkflowContextFailureCode
  | "invalid-remote"
  | "invalid-remote-branch"
  | "protected-branch"
  | "dirty-worktree"
  | "upstream-missing"
  | "upstream-creation-disabled"
  | "upstream-target-mismatch"
  | "remote-inspection-failed"
  | "remote-behind"
  | "remote-diverged"
  | "force-required-for-diverged"
  | "force-disabled"
  | "missing-validation-evidence"
  | "push-failed";

export interface PushFailure {
  ok: false;
  code: PushErrorCode;
  detail: string;
  dirtyPaths?: BoundedPathList;
  missingEvidence?: string[];
  gitCode?: string;
}

export type RemoteRelation = "no-upstream" | "up-to-date" | "ahead" | "behind" | "diverged";

export interface PushVerificationSuccess {
  ok: true;
  context: VerifiedWorkflowContext;
  remote: string;
  remoteBranch: string;
  relation: RemoteRelation;
  dirtyPaths: BoundedPathList;
  force: boolean;
  createUpstream: boolean;
  /** The exact safe operation planned after all read-only checks. */
  pushArguments: string[];
}

export type PushVerificationResult = PushVerificationSuccess | PushFailure;

export interface PushSuccess {
  ok: true;
  remote: string;
  remoteBranch: string;
  relation: RemoteRelation;
  force: boolean;
  upstreamCreated: boolean;
}

export type PushResult = PushSuccess | PushFailure;

const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function controls(input: PushOperationInput): PushPolicyControls {
  return input.pushPolicy ?? {};
}

function failureFromContext(
  context: Exclude<Awaited<ReturnType<typeof verifyWorkflowContext>>, VerifiedWorkflowContext>,
): PushFailure {
  return context;
}

function isUsableSuccessful(observation: Awaited<ReturnType<typeof runGitCommand>>): boolean {
  return observation.usable && observation.result.exitCode === 0;
}

async function resolveUpstream(cwd: string): Promise<{ ok: true; upstream: string | undefined } | PushFailure> {
  const observation = await runGitCommand(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!observation.usable) {
    const failure = gitCommandFailure("resolve-upstream", observation);
    return { ok: false, code: "remote-inspection-failed", detail: failure.detail, gitCode: failure.code };
  }
  if (observation.result.exitCode !== 0) return { ok: true, upstream: undefined };
  const upstream = observation.result.stdout.trim();
  if (upstream.length === 0 || !upstream.includes("/")) {
    return { ok: false, code: "remote-inspection-failed", detail: "upstream reference has an unexpected format" };
  }
  return { ok: true, upstream };
}

function splitUpstream(upstream: string): { remote: string; branch: string } | undefined {
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1) return undefined;
  return { remote: upstream.slice(0, separator), branch: upstream.slice(separator + 1) };
}

async function validateRemoteBranch(cwd: string, branch: string): Promise<PushFailure | undefined> {
  const observation = await runGitCommand(cwd, ["check-ref-format", "--branch", branch]);
  if (!observation.usable) {
    const failure = gitCommandFailure("validate-remote-branch", observation);
    return { ok: false, code: "remote-inspection-failed", detail: failure.detail, gitCode: failure.code };
  }
  if (observation.result.exitCode !== 0)
    return { ok: false, code: "invalid-remote-branch", detail: "git rejected the remote branch name" };
  return undefined;
}

async function readRemoteRelation(
  cwd: string,
): Promise<{ ok: true; relation: RemoteRelation; ahead: number; behind: number } | PushFailure> {
  const upstream = await resolveUpstream(cwd);
  if (!upstream.ok) return upstream;
  if (upstream.upstream === undefined) return { ok: true, relation: "no-upstream", ahead: 0, behind: 0 };

  const observation = await runGitCommand(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  if (!isUsableSuccessful(observation)) {
    const failure = gitCommandFailure("inspect-remote-relation", observation);
    return { ok: false, code: "remote-inspection-failed", detail: failure.detail, gitCode: failure.code };
  }
  const counts = observation.result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  if (counts.length !== 2 || counts.some((value) => !Number.isInteger(value) || value < 0)) {
    return { ok: false, code: "remote-inspection-failed", detail: "remote ancestry counts were not numeric" };
  }
  const [ahead, behind] = counts as [number, number];
  const relation: RemoteRelation =
    ahead > 0 && behind > 0 ? "diverged" : behind > 0 ? "behind" : ahead > 0 ? "ahead" : "up-to-date";
  return { ok: true, relation, ahead, behind };
}

function requiredEvidenceFailure(input: PushOperationInput, context: VerifiedWorkflowContext): PushFailure | undefined {
  const required = input.pushPolicy?.requiredValidationEvidence ?? [];
  if (required.length === 0) return undefined;
  const passed = new Set(
    (input.validationEvidence ?? [])
      .filter((evidence) => evidence.status === "passed" && evidence.headCommit === context.headCommit)
      .map((evidence) => evidence.name),
  );
  const missing = [...new Set(required)].filter((name) => !passed.has(name));
  if (missing.length === 0) return undefined;
  return {
    ok: false,
    code: "missing-validation-evidence",
    detail: "required validation evidence is missing, failed, or was not recorded against the current HEAD commit",
    missingEvidence: missing,
  };
}

function protectedBranchFailure(
  input: PushOperationInput,
  context: VerifiedWorkflowContext,
  remoteBranch: string,
  force: boolean,
): PushFailure | undefined {
  const branchMatch = matchesProtectedBranch(remoteBranch, input.policy.protectedBranches);
  if (!branchMatch.matched) return undefined;
  if (input.pushPolicy?.allowProtectedBranch !== true) {
    return {
      ok: false,
      code: "protected-branch",
      detail: `push to protected branch ${remoteBranch} requires explicit allowProtectedBranch policy`,
    };
  }
  const operation = force ? "forcePush" : "directPush";
  const decision = decideProtectedBranchOperation({
    policy: input.policy,
    branch: remoteBranch,
    operation,
    repository: { isPrimaryCheckout: context.isPrimaryCheckout },
  });
  if (!decision.allowed)
    return {
      ok: false,
      code: "protected-branch",
      detail: `push to protected branch ${remoteBranch} denied: ${decision.reason}`,
    };
  return undefined;
}

function relationFailure(input: PushOperationInput, relation: RemoteRelation, force: boolean): PushFailure | undefined {
  if (relation === "behind" && input.pushPolicy?.allowRemoteBehind !== true) {
    return { ok: false, code: "remote-behind", detail: "remote contains commits not present locally" };
  }
  if (relation === "diverged") {
    if (input.pushPolicy?.allowDiverged !== true)
      return { ok: false, code: "remote-diverged", detail: "local and remote histories have diverged" };
    if (!force)
      return {
        ok: false,
        code: "force-required-for-diverged",
        detail: "diverged history requires an explicitly requested force push",
      };
  }
  return undefined;
}

export async function verifyPush(input: PushOperationInput): Promise<PushVerificationResult> {
  const context = await verifyWorkflowContext(input);
  if (!context.ok) return failureFromContext(context);

  const requestedRemote = input.remote ?? "origin";
  if (!SAFE_REMOTE_NAME.test(requestedRemote))
    return {
      ok: false,
      code: "invalid-remote",
      detail: "remote must be a local Git remote name without URL or credential syntax",
    };

  const upstreamResult = await resolveUpstream(context.workspaceRoot);
  if (!upstreamResult.ok) return upstreamResult;
  const upstreamTarget = upstreamResult.upstream === undefined ? undefined : splitUpstream(upstreamResult.upstream);
  if (upstreamResult.upstream !== undefined && upstreamTarget === undefined) {
    return {
      ok: false,
      code: "remote-inspection-failed",
      detail: "upstream reference could not be split into remote and branch",
    };
  }
  if (
    upstreamTarget !== undefined &&
    ((input.remote !== undefined && input.remote !== upstreamTarget.remote) ||
      (input.remoteBranch !== undefined && input.remoteBranch !== upstreamTarget.branch))
  ) {
    return {
      ok: false,
      code: "upstream-target-mismatch",
      detail: "requested push target differs from the tracked upstream",
    };
  }

  const remoteBranch = input.remoteBranch ?? upstreamTarget?.branch ?? context.branch;
  const remoteBranchFailure = await validateRemoteBranch(context.workspaceRoot, remoteBranch);
  if (remoteBranchFailure !== undefined) return remoteBranchFailure;

  const force = input.force === true;
  const protectedFailure = protectedBranchFailure(input, context, remoteBranch, force);
  if (protectedFailure !== undefined) return protectedFailure;

  const statusResult = await readGitStatus(context.workspaceRoot);
  if (!statusResult.ok) return { ok: false, code: statusResult.failure.code, detail: statusResult.failure.detail };
  const dirtyPaths = statusResult.status.changedPaths;
  if (statusResult.status.entries.length > 0 && input.pushPolicy?.allowDirtyWorktree !== true) {
    return {
      ok: false,
      code: "dirty-worktree",
      detail: "push requires a clean worktree under the current policy",
      dirtyPaths,
    };
  }

  const evidenceFailure = requiredEvidenceFailure(input, context);
  if (evidenceFailure !== undefined) return evidenceFailure;

  if (force && input.pushPolicy?.allowForcePush !== true)
    return {
      ok: false,
      code: "force-disabled",
      detail: "force push was requested but the push policy does not permit it",
    };

  const relationResult = await readRemoteRelation(context.workspaceRoot);
  if (!relationResult.ok) return relationResult;
  if (relationResult.relation === "no-upstream") {
    if (input.createUpstream !== true)
      return {
        ok: false,
        code: "upstream-missing",
        detail: "branch has no upstream; upstream creation must be requested explicitly",
      };
    if (input.pushPolicy?.allowUpstreamCreation !== true)
      return { ok: false, code: "upstream-creation-disabled", detail: "upstream creation is disabled by push policy" };
  } else if (input.createUpstream === true) {
    return {
      ok: false,
      code: "upstream-target-mismatch",
      detail: "upstream already exists; creation request is not applicable",
    };
  }

  const relationFailureResult = relationFailure(input, relationResult.relation, force);
  if (relationFailureResult !== undefined) return relationFailureResult;

  const pushArguments = ["push"];
  if (force) pushArguments.push("--force-with-lease");
  if (relationResult.relation === "no-upstream") pushArguments.push("--set-upstream");
  pushArguments.push(requestedRemote, `HEAD:refs/heads/${remoteBranch}`);
  return {
    ok: true,
    context,
    remote: requestedRemote,
    remoteBranch,
    relation: relationResult.relation,
    dirtyPaths,
    force,
    createUpstream: relationResult.relation === "no-upstream",
    pushArguments,
  };
}

export async function pushTask(input: PushOperationInput): Promise<PushResult> {
  const verification = await verifyPush(input);
  if (!verification.ok) return verification;

  const push = await runGitCommand(verification.context.workspaceRoot, verification.pushArguments);
  if (!push.usable || push.result.exitCode !== 0) {
    const failure = gitCommandFailure("push", push);
    return { ok: false, code: "push-failed", detail: failure.detail, gitCode: failure.code };
  }
  return {
    ok: true,
    remote: verification.remote,
    remoteBranch: verification.remoteBranch,
    relation: verification.relation,
    force: verification.force,
    upstreamCreated: verification.createUpstream,
  };
}
