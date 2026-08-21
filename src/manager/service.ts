import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProgram } from "../subprocess.js";
import { NawabariExecutionClient, NawabariExecutionError } from "../workflow/nawabari.js";
import { buildWorktreeNaming } from "../workflow/git/worktree.js";
import { validateBranchNameAgainstGovernance } from "../workflow/governance/branch.js";
import { resolveRepoState } from "../workflow/domain/repo-state.js";
import {
  createSemanticExecutionPlan,
  projectNawabariDeclaration,
  type ClaimGenerationProvenance,
  type ExecutionClaim,
  type NawabariDeclaration,
  type SemanticExecutionPlan,
} from "../semantics/execution-plan.js";
import type {
  CommitReconciliationRecord,
  CommitReconciliationState,
  ManagerAgentKind,
  ManagerReconciliationState,
  ManagerRuntimeState,
  ManagerSessionId,
  ManagerSessionRecord,
  ManagerSessionReceipt,
  PullRequestRecord,
  PushReconciliationRecord,
  PushReconciliationState,
  TaskId,
  WorkflowStateStore,
} from "../workflow/state/store.js";
import type { PullRequestLifecycleState } from "../workflow/providers/model.js";
import type { LifecycleState } from "../workflow/domain/lifecycle.js";
import { validateIssueRef, validateTaskSlug } from "../workflow/commands/validate.js";
import { PI_GUARD_ASSET_MARKER } from "./pi-guard.js";
import {
  createNawabariManagerExecutionAuthority,
  createManagerFallbackSemanticExecutionPlan,
  type ManagerExecutionAuthority,
  type ManagerExecutionContext,
} from "../workflow/domain/manager-execution.js";
import {
  createClaimPreflight,
  failedClaimPreflight,
  notApplicableClaimPreflight,
  type ManagerClaimPreflight,
} from "./claim-preflight.js";
import { deriveZellijSessionName, ZellijRuntimeError, type ZellijObservedState, type ZellijRuntime } from "./zellij.js";

const MAX_INSTRUCTION_LENGTH = 64 * 1024;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 128;
const MAX_STATUS_LENGTH = 512;
const MAX_LIST_LIMIT = 500;
const MAX_SCOPE_PATHS = 128;
const MAX_SCOPE_CLAIMS = 128;
const MAX_SCOPE_RESOURCE_LENGTH = 512;
const ACTIVE_RUNTIME_STATES = ["starting", "running", "detached"] as const satisfies readonly ManagerRuntimeState[];
const RECENT_RUNTIME_STATES = [
  "exited",
  "failed",
  "stopped",
  "stale",
] as const satisfies readonly ManagerRuntimeState[];

function boundedStatus(value: string): string {
  return value.slice(0, MAX_STATUS_LENGTH);
}

export interface NewManagerSessionInput {
  instruction: string;
  agentKind?: string;
  /** Alias accepted by the API for clients that call the profile explicitly. */
  launchProfile?: string;
  provider?: string;
  model?: string;
  taskSlug?: string;
  issueRef?: string;
  branchType?: string;
  /** Stable operation identity used by the public task-run orchestration. */
  idempotencyKey?: string;
  /** Explicit repository-relative execution scope. */
  scope?: ManagerResourceScope;
  /** Compatibility transport alias for scope.paths. */
  paths?: readonly string[];
  /** Compatibility transport alias for scope.claims. */
  claims?: readonly ManagerResourceClaim[];
}

export type ManagerClaimMode = ExecutionClaim["mode"];

export interface ManagerResourceClaim {
  resource: string;
  mode: ManagerClaimMode;
}

export interface ManagerResourceScope {
  paths?: readonly string[];
  claims?: readonly ManagerResourceClaim[];
}

export interface ManagerExecutionPreview {
  identity: {
    executionMode: "task-bound" | "workspace";
    task: {
      taskId?: string;
      taskSlug?: string;
      issueRef?: string;
      branchType?: string;
    };
    branch: {
      name: string;
      base: string;
      baseCommit?: string;
    };
  };
  claims: readonly ExecutionClaim[];
  claimGeneration: ClaimGenerationProvenance;
  warnings: readonly string[];
  semanticExecutionPlan: SemanticExecutionPlan;
  nawabariDeclaration: NawabariDeclaration;
  claimPreflight: ManagerClaimPreflight;
}

export interface ManagerLaunchInvocation {
  agentKind: ManagerAgentKind;
  command: string;
  args: string[];
}

export interface ManagerSessionFilter {
  runtimeState?: ManagerRuntimeState;
  agentKind?: ManagerAgentKind;
  semanticLifecycleState?: ManagerSessionRecord["semanticLifecycleState"];
  taskId?: TaskId;
  issueRef?: string;
  search?: string;
  limit?: number;
}

export interface ManagerHealth {
  manager: "ready";
  workspaceRoot: string;
  zellij: { available: true; version: string };
  sessions: { active: number; recent: number };
}

export type ManagerOperationalState = "healthy" | "attention" | "stopped" | "blocked" | "stale";
export type ManagerPhaseState = "complete" | "current" | "pending" | "attention";

export interface ManagerOperationalProjection {
  state: ManagerOperationalState;
  statusLabel: string;
  attention:
    | {
        priority: "P1" | "P2";
        reason: string;
        authority: string;
        safeAction: "inspect" | "open-terminal" | "restart" | "inspect-nawabari";
        actionLabel: string;
      }
    | null;
  phaseRail: readonly { id: string; label: string; state: ManagerPhaseState }[];
  authorities: readonly { name: string; responsibility: string; status: "current" | "unavailable" }[];
  identities: {
    managerSessionId: string;
    taskId: string | null;
    executionSessionId: string | null;
    runtimeName: string;
  };
  repository: {
    name: string;
    root: string;
    worktree: string;
    branch: string | null;
  };
  task: {
    slug: string | null;
    issueRef: string | null;
    lifecycleState: LifecycleState | "unbound";
    baseBranch: string | null;
    baseCommit: string | null;
  };
  validation: {
    state: "passed" | "failed" | "unavailable";
    summary: string;
    recordedAt: number | null;
  };
  commit: {
    state: CommitReconciliationState | "unavailable";
    sha: string | null;
    detail: string | null;
    authority: "Nawabari";
  };
  push: {
    state: PushReconciliationState | "unavailable";
    target: string | null;
    remoteSha: string | null;
    detail: string | null;
    authority: "Nawabari";
  };
  pullRequest: {
    state: PullRequestLifecycleState | "unavailable";
    number: number | null;
    url: string | null;
    headSha: string | null;
    mergeRevision: string | null;
    authority: "gh-inari";
  };
}

export interface ManagerSessionProjection extends ManagerSessionRecord {
  operational: ManagerOperationalProjection;
}

export class ManagerError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "pi_guard_unavailable"
      | "zellij_unavailable"
      | "zellij_incompatible"
      | "runtime_name_collision"
      | "task_start_failed"
      | "claim_conflict"
      | "claim_preflight_unavailable"
      | "claim_preflight_stale"
      | "session_not_found"
      | "session_not_running"
      | "session_not_attachable"
      | "session_restart_rejected"
      | "runtime_error"
      | "worktree_missing"
      | "execution_unresolved"
      | "idempotency_conflict",
    message: string,
    readonly statusCode = code === "session_not_found"
      ? 404
      : code === "claim_preflight_unavailable" || code === "claim_preflight_stale"
        ? 503
        : code === "claim_conflict"
          ? 409
          : code === "runtime_name_collision" ||
              code === "worktree_missing" ||
              code === "session_restart_rejected" ||
              code === "idempotency_conflict"
            ? 409
            : code === "pi_guard_unavailable" || code === "zellij_unavailable" || code === "zellij_incompatible"
              ? 503
              : 400,
    readonly details?: unknown,
  ) {
    super(boundedStatus(message));
    this.name = "ManagerError";
  }
}

function invalid(message: string): ManagerError {
  return new ManagerError("invalid_request", message, 400);
}

function idempotencyConflict(message: string): ManagerError {
  return new ManagerError("idempotency_conflict", message, 409);
}

function validatePiGuardAsset(candidate: string): string {
  try {
    if (!fs.statSync(candidate).isFile()) throw new Error("path is not a file");
    const source = fs.readFileSync(candidate, "utf8");
    if (!source.includes(PI_GUARD_ASSET_MARKER)) throw new Error("asset marker is missing");
    if (!source.includes("export default function mottainaiManagedPiGuard"))
      throw new Error("extension entry point is missing");
    return path.resolve(candidate);
  } catch (error) {
    throw new ManagerError(
      "pi_guard_unavailable",
      `managed Pi guard is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }
}

export function resolvePiGuardPath(moduleUrl: string = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidate = [path.join(moduleDirectory, "pi-guard.js"), path.join(moduleDirectory, "pi-guard.ts")].find(
    (filePath) => fs.existsSync(filePath),
  );
  if (candidate === undefined)
    throw new ManagerError(
      "pi_guard_unavailable",
      "managed Pi guard asset is missing; refusing unguarded Pi launch",
      503,
    );
  return validatePiGuardAsset(candidate);
}

function configuredPiGuardPath(candidate: string | undefined): string | undefined {
  return candidate === undefined ? resolvePiGuardPath() : validatePiGuardAsset(candidate);
}

function validateStoredPiGuardInvocation(args: readonly string[]): void {
  const extensionIndex = args.indexOf("--extension");
  const extensionPath = extensionIndex < 0 ? undefined : args[extensionIndex + 1];
  if (extensionPath === undefined)
    throw new ManagerError("pi_guard_unavailable", "managed Pi launch has no guard extension; refusing restart", 503);
  validatePiGuardAsset(extensionPath);
}

function validateInstruction(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid("instruction is required");
  if (value.length > MAX_INSTRUCTION_LENGTH)
    throw invalid(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
  if (value.includes("\u0000")) throw invalid("instruction contains an unsupported NUL character");
  return value;
}

function validateOptionalArg(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000\u0001-\u001f\u007f]/u.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function normalizeAgentKind(input: unknown): ManagerAgentKind {
  if (input === undefined || input === null || input === "" || input === "codex") return "codex";
  if (input === "claude" || input === "claude-code") return "claude";
  if (input === "pi") return "pi";
  throw invalid("agentKind must be codex, claude, or pi");
}

interface ValidatedManagerSessionInput {
  agentKind: ManagerAgentKind;
  instruction: string;
  provider: string | undefined;
  model: string | undefined;
  taskSlug: string | undefined;
  issueRef: string | undefined;
  branchType: string;
  idempotencyKey: string | undefined;
  scope: ManagerResourceScope | undefined;
  scopeProvided: boolean;
  semanticPlan: SemanticExecutionPlan;
}

function validateScopeResource(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be a repository-relative path`);
  if (value.length > MAX_SCOPE_RESOURCE_LENGTH)
    throw invalid(`${label} must be at most ${MAX_SCOPE_RESOURCE_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw invalid(`${label} contains an unsupported control character`);
  const resource = value.trim().replaceAll("\\", "/");
  if (resource.length === 0) throw invalid(`${label} must not be empty`);
  if (
    path.isAbsolute(resource) ||
    resource.startsWith("/") ||
    resource.startsWith("//") ||
    /^[A-Za-z]:/u.test(resource)
  ) {
    throw invalid(`${label} must be repository-relative`);
  }
  const segments = resource.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalid(`${label} must not contain empty, current-directory, or traversal segments`);
  }
  // Keep the caller's representation intact. The semantic execution-plan
  // authority owns trimming, separator normalization, and deduplication.
  return value;
}

function arrayInput(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeScope(input: NewManagerSessionInput): {
  scope: ManagerResourceScope | undefined;
  provided: boolean;
} {
  const raw: Record<string, unknown> = { ...input };
  const rawScope = raw.scope;
  if (rawScope !== undefined && !isRecord(rawScope)) throw invalid("scope must be an object");
  const scopeRecord = isRecord(rawScope) ? rawScope : undefined;
  const rawPaths = [scopeRecord?.paths, raw.paths].filter((value) => value !== undefined);
  const rawClaims = [scopeRecord?.claims, raw.claims].filter((value) => value !== undefined);
  const provided = rawScope !== undefined || raw.paths !== undefined || raw.claims !== undefined;
  if (!provided) return { scope: undefined, provided: false };

  const pathValues = rawPaths.flatMap((value, index) => arrayInput(value, index === 0 ? "scope.paths" : "paths") ?? []);
  const claimValues = rawClaims.flatMap(
    (value, index) => arrayInput(value, index === 0 ? "scope.claims" : "claims") ?? [],
  );
  if (pathValues.length === 0 && claimValues.length === 0)
    throw invalid("scope must contain at least one path or claim");
  if (pathValues.length > MAX_SCOPE_PATHS) throw invalid(`scope.paths must contain at most ${MAX_SCOPE_PATHS} entries`);
  if (claimValues.length > MAX_SCOPE_CLAIMS)
    throw invalid(`scope.claims must contain at most ${MAX_SCOPE_CLAIMS} entries`);

  const paths = pathValues.map((value, index) => validateScopeResource(value, `scope.paths[${index}]`));
  const claims = claimValues.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw invalid(`scope.claims[${index}] must be an object`);
    const claim = value as Record<string, unknown>;
    const resource = validateScopeResource(claim.resource, `scope.claims[${index}].resource`);
    if (claim.mode !== "read" && claim.mode !== "write" && claim.mode !== "exclusive-write")
      throw invalid(`scope.claims[${index}].mode must be read, write, or exclusive-write`);
    return { resource, mode: claim.mode } as ManagerResourceClaim;
  });
  return {
    provided: true,
    scope: {
      ...(paths.length === 0 ? {} : { paths }),
      ...(claims.length === 0 ? {} : { claims }),
    },
  };
}

function normalizeManagerSessionInput(input: NewManagerSessionInput): ValidatedManagerSessionInput {
  const agentKind = normalizeAgentKind(input.launchProfile ?? input.agentKind);
  const instruction = validateInstruction(input.instruction);
  const provider = validateOptionalArg(input.provider, "provider", MAX_PROVIDER_LENGTH);
  const model = validateOptionalArg(input.model, "model", MAX_MODEL_LENGTH);
  const taskSlug = validateOptionalArg(input.taskSlug, "taskSlug", 96);
  const issueRef = validateOptionalArg(input.issueRef, "issueRef", 96);
  const branchType = validateOptionalArg(input.branchType, "branchType", 32) ?? "feat";
  const idempotencyKey = validateOptionalArg(input.idempotencyKey, "idempotencyKey", 128);
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(idempotencyKey))
    throw invalid("idempotencyKey must be a bounded branch-safe token");
  try {
    if (taskSlug !== undefined) validateTaskSlug(taskSlug);
    validateIssueRef(issueRef);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (issueRef !== undefined && taskSlug === undefined) throw invalid("taskSlug is required when issueRef is provided");
  if (provider !== undefined && agentKind !== "pi") throw invalid("provider is only supported by the pi profile");

  const normalizedScope = normalizeScope(input);
  if (normalizedScope.provided && taskSlug === undefined)
    throw invalid("taskSlug is required when an explicit scope is provided");
  const semanticPlan = normalizedScope.provided
    ? createSemanticExecutionPlan({
        explicitPaths: normalizedScope.scope?.paths,
        claims: normalizedScope.scope?.claims,
        verification: { rationale: "Manager scope is explicitly declared by the caller" },
      })
    : createManagerFallbackSemanticExecutionPlan();
  return {
    agentKind,
    instruction,
    provider,
    model,
    taskSlug,
    issueRef,
    branchType,
    idempotencyKey,
    scope: normalizedScope.scope,
    scopeProvided: normalizedScope.provided,
    semanticPlan,
  };
}

function managerError(error: unknown): ManagerError {
  if (error instanceof ManagerError) return error;
  if (error instanceof ZellijRuntimeError) {
    const status =
      error.code === "zellij_unavailable" || error.code === "zellij_incompatible"
        ? 503
        : error.code === "zellij_launch_failed"
          ? 502
          : 500;
    return new ManagerError(
      error.code === "zellij_unavailable"
        ? "zellij_unavailable"
        : error.code === "zellij_incompatible"
          ? "zellij_incompatible"
          : "runtime_error",
      error.message,
      status,
    );
  }
  return new ManagerError("runtime_error", boundedStatus(error instanceof Error ? error.message : String(error)), 500);
}

function claimPreflightFailureStatus(error: NawabariExecutionError): "unavailable" | "ambiguous" | "stale" {
  if (error.code === "nawabari-evidence-ambiguous") {
    return error.nawabariCode === "STALE_REGISTRY" ? "stale" : "ambiguous";
  }
  if (error.nawabariCode === "STALE_REGISTRY") return "stale";
  if (
    error.nawabariCode === "GIT_STATE_AMBIGUOUS" ||
    error.nawabariCode === "PHYSICAL_OBSERVATION_UNAVAILABLE" ||
    error.code === "nawabari-contract-invalid"
  ) {
    return "ambiguous";
  }
  return "unavailable";
}

function isClaimConflict(error: unknown): boolean {
  return (
    (error instanceof NawabariExecutionError && error.nawabariCode === "RESOURCE_CLAIM_CONFLICT") ||
    (error instanceof Error && error.message.includes("RESOURCE_CLAIM_CONFLICT"))
  );
}

async function readGitValue(workspaceRoot: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runProgram("git", [...args], workspaceRoot, 5_000, 64 * 1024);
  if (result.spawnError !== undefined || result.timedOut || result.outputLimit || result.exitCode !== 0)
    return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

async function prepareManagerExecutionPreview(
  workspaceRoot: string,
  input: ValidatedManagerSessionInput,
): Promise<ManagerExecutionPreview> {
  const repoState = await resolveRepoState(workspaceRoot);
  const taskBound = input.taskSlug !== undefined;
  if (taskBound && (!repoState.ok || !repoState.state.supported)) {
    throw new ManagerError("task_start_failed", !repoState.ok ? repoState.reason : repoState.state.reason, 409);
  }
  const base = repoState.ok && repoState.state.branch !== undefined ? repoState.state.branch : "HEAD";
  const baseCommit = await readGitValue(workspaceRoot, ["rev-parse", "--verify", "-q", base]);
  if (taskBound && baseCommit === undefined)
    throw new ManagerError("task_start_failed", `cannot resolve tip commit of ${base}`, 409);

  let branchName = repoState.ok && repoState.state.branch !== undefined ? repoState.state.branch : "HEAD";
  if (taskBound) {
    branchName = buildWorktreeNaming({
      branchType: input.branchType,
      issueRef: input.issueRef ?? "unlinked",
      taskSlug: input.taskSlug!,
    }).branchName;
    const repositoryRoot = await readGitValue(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    if (repositoryRoot === undefined)
      throw new ManagerError("task_start_failed", "cannot resolve the repository root for branch governance", 409);
    const branchValidation = await validateBranchNameAgainstGovernance(branchName, repositoryRoot);
    if (!branchValidation.ok) {
      throw new ManagerError(
        "task_start_failed",
        `generated branch ${branchName} was rejected before Nawabari mutation: ${branchValidation.detail}`,
        409,
      );
    }
  }

  const nawabariDeclaration = projectNawabariDeclaration({
    plan: input.semanticPlan,
    branch: branchName,
    base,
  });
  return {
    identity: {
      executionMode: taskBound ? "task-bound" : "workspace",
      task: {
        ...(input.taskSlug === undefined ? {} : { taskSlug: input.taskSlug }),
        ...(input.issueRef === undefined ? {} : { issueRef: input.issueRef }),
        ...(taskBound ? { branchType: input.branchType } : {}),
      },
      branch: {
        name: branchName,
        base,
        ...(baseCommit === undefined ? {} : { baseCommit }),
      },
    },
    claims: input.semanticPlan.claims,
    claimGeneration: input.semanticPlan.claimGeneration,
    warnings: input.semanticPlan.claimGeneration.warnings,
    semanticExecutionPlan: input.semanticPlan,
    nawabariDeclaration,
    claimPreflight: notApplicableClaimPreflight(),
  };
}

function receipt(code: string, message: string, source: ManagerSessionReceipt["source"]): ManagerSessionReceipt {
  return { code, message: message.slice(0, MAX_STATUS_LENGTH), source, recordedAt: Date.now() };
}

/**
 * Deterministic profile construction. Every user-controlled value remains an
 * argv element; no shell string is built or evaluated.
 */
export function buildManagerLaunchInvocation(input: {
  agentKind: ManagerAgentKind;
  provider?: string;
  model?: string;
  instruction: string;
  piGuardPath?: string;
  commands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
}): ManagerLaunchInvocation {
  const configured = input.commands?.[input.agentKind];
  const defaultProfile =
    input.agentKind === "claude"
      ? { command: "claude", baseArgs: [] }
      : input.agentKind === "pi"
        ? { command: "pi", baseArgs: [] }
        : { command: "codex", baseArgs: [] };
  const profileArgs =
    input.agentKind === "pi"
      ? [
          ...(input.provider === undefined ? [] : ["--provider", input.provider]),
          ...(input.model === undefined ? [] : ["--model", input.model]),
          "--extension",
          input.piGuardPath ?? resolvePiGuardPath(),
        ]
      : input.model === undefined
        ? []
        : ["--model", input.model];
  const profile = configured ?? defaultProfile;
  const args = [...(profile.baseArgs ?? []), ...profileArgs, "--", input.instruction];
  return { agentKind: input.agentKind, command: profile.command, args };
}

function runtimeStateForObservation(observed: ZellijObservedState): ManagerRuntimeState {
  if (observed === "absent" || observed === "unresolved") return "stale";
  return observed;
}

function lifecycleForRuntime(
  runtimeState: ManagerRuntimeState,
  current: ManagerSessionRecord["lifecycleState"],
): ManagerSessionRecord["lifecycleState"] {
  if (runtimeState === "running" || runtimeState === "detached") return "running";
  if (runtimeState === "starting") return "starting";
  if (runtimeState === "stopped") return "stopped";
  if (runtimeState === "failed") return "failed";
  // Keep the legacy lifecycle projection compatible while exposing stale as a
  // separate runtime state. A missing process is never semantic completion.
  if (runtimeState === "stale" || runtimeState === "exited") {
    if (current === "stopped" || current === "failed") return current;
    return "exited";
  }
  return current;
}

function isTerminalSemanticState(state: ManagerSessionRecord["semanticLifecycleState"]): boolean {
  return (
    state === "committed" ||
    state === "pushed" ||
    state === "pull-request-open" ||
    state === "merged" ||
    state === "abandoned" ||
    state === "cleaned"
  );
}

const OPERATIONAL_PHASES = [
  ["planned", "TASK CREATED"],
  ["active", "IMPLEMENT"],
  ["committed", "COMMIT"],
  ["pushed", "PUSH"],
  ["pull-request-open", "PR OPEN"],
] as const;

function phaseRailFor(
  state: ManagerSessionRecord["semanticLifecycleState"],
  runtimeState: ManagerRuntimeState,
): { id: string; label: string; state: ManagerPhaseState }[] {
  const index = OPERATIONAL_PHASES.findIndex(([id]) => id === state);
  const terminallyComplete = state === "merged" || state === "cleaned";
  const phases: { id: string; label: string; state: ManagerPhaseState }[] = OPERATIONAL_PHASES.map(([id, label], phaseIndex) => ({
    id,
    label,
    state: (terminallyComplete
      ? "complete"
      : index < 0
      ? "pending"
      : phaseIndex < index
        ? "complete"
        : phaseIndex === index
          ? runtimeState === "stale" || runtimeState === "failed"
            ? "attention"
            : "current"
          : "pending") as ManagerPhaseState,
  }));
  if (state === "merged" || state === "abandoned" || state === "cleaned" || state === "orphaned") {
    phases.push({
      id: "terminal",
      label: state === "merged" ? "MERGED" : state.toUpperCase(),
      state: "current" as ManagerPhaseState,
    });
  }
  if (state === "unbound" && runtimeState !== "stopped") {
    phases[1] = {
      id: "active",
      label: "RUNTIME",
      state: runtimeState === "stale" || runtimeState === "failed" ? "attention" : "current",
    };
  }
  return phases;
}

const BLOCKED_RECEIPT_CODES = new Set(["claim_conflict", "claim_preflight_stale", "claim_preflight_unavailable"]);

function operationalStateFor(session: ManagerSessionRecord): ManagerOperationalState {
  if (session.runtimeState === "stale") return "stale";
  if (session.latestReceipt !== undefined && BLOCKED_RECEIPT_CODES.has(session.latestReceipt.code)) return "blocked";
  if (
    session.runtimeState === "failed" ||
    session.reconciliationState === "unresolved" ||
    session.semanticLifecycleState === "orphaned" ||
    (session.runtimeState === "exited" &&
      (session.semanticLifecycleState === "planned" || session.semanticLifecycleState === "active"))
  )
    return "attention";
  if (session.runtimeState === "stopped" || session.semanticLifecycleState === "abandoned") return "stopped";
  return "healthy";
}

function operationalStatusLabel(state: ManagerOperationalState): string {
  return {
    healthy: "HEALTHY",
    attention: "NEEDS ATTENTION",
    stopped: "STOPPED",
    blocked: "BLOCKED / CONFLICT",
    stale: "STALE",
  }[state];
}

function validationProjection(
  store: WorkflowStateStore,
  task: ReturnType<WorkflowStateStore["getTask"]>,
  worktreeId: string,
  commitSha: string | undefined,
  hasCommittedWork: boolean,
): ManagerOperationalProjection["validation"] {
  if (task === undefined) {
    return { state: "unavailable", summary: "No task-bound validation receipt", recordedAt: null };
  }
  const checkRuns = store.listCheckRuns({ instanceId: task.instanceId, worktreeId, limit: 8 });
  const latestRun = [...checkRuns].sort((left, right) => right.recordedAt - left.recordedAt)[0];
  if (latestRun !== undefined) {
    return {
      state: latestRun.status,
      summary: latestRun.summary,
      recordedAt: latestRun.recordedAt,
    };
  }
  // Validation evidence is keyed by the head commit it validated. Once the
  // session has committed work, baseCommit no longer represents that head;
  // showing evidence recorded at baseCommit would misrepresent it as
  // covering the changed work, so prefer unavailable over a stale reading.
  const validatedCommit = commitSha ?? (hasCommittedWork ? undefined : task.baseCommit);
  if (validatedCommit === undefined) {
    return { state: "unavailable", summary: "No authoritative validated head commit recorded", recordedAt: null };
  }
  const evidence = store.listValidationEvidence(task.instanceId, validatedCommit);
  const latestEvidence = [...evidence].sort((left, right) => right.recordedAt - left.recordedAt)[0];
  if (latestEvidence === undefined) {
    return { state: "unavailable", summary: "No authoritative validation receipt recorded", recordedAt: null };
  }
  const normalizedState = latestEvidence.status === "passed" || latestEvidence.status === "failed" ? latestEvidence.status : "unavailable";
  return {
    state: normalizedState,
    summary: `${latestEvidence.name}: ${latestEvidence.status}`,
    recordedAt: latestEvidence.recordedAt,
  };
}

function commitProjection(
  record: CommitReconciliationRecord | undefined,
): ManagerOperationalProjection["commit"] {
  return {
    state: record?.state ?? "unavailable",
    sha: record?.commitSha ?? null,
    detail: record?.detail ?? null,
    authority: "Nawabari",
  };
}

function pushProjection(record: PushReconciliationRecord | undefined): ManagerOperationalProjection["push"] {
  return {
    state: record?.state ?? "unavailable",
    target: record === undefined ? null : `${record.remote}/${record.targetBranch}`,
    remoteSha: record?.resultRemoteSha ?? record?.observedRemoteSha ?? null,
    detail: record?.detail ?? null,
    authority: "Nawabari",
  };
}

function pullRequestProjection(
  record: PullRequestRecord | undefined,
): ManagerOperationalProjection["pullRequest"] {
  return {
    state: record?.lifecycleState ?? "unavailable",
    number: record?.prNumber ?? null,
    url: record?.url ?? null,
    headSha: record?.headSha ?? null,
    mergeRevision: record?.mergeRevision ?? null,
    authority: "gh-inari",
  };
}

function hasCommittedSemanticProgress(session: ManagerSessionRecord): boolean {
  return ["committed", "pushed", "pull-request-open", "merged", "cleaned"].includes(session.semanticLifecycleState);
}

/**
 * Shared, store-cheap projection core: operational state/attention, phase
 * rail, and identity/repository/task status. Both the bounded list summary
 * and the full detail projection are built on top of this so the two never
 * drift on what "attention" or "phase" means.
 */
function operationalCoreProjection(
  session: ManagerSessionRecord,
  task: ReturnType<WorkflowStateStore["getTask"]>,
): Pick<
  ManagerOperationalProjection,
  "state" | "statusLabel" | "attention" | "phaseRail" | "identities" | "repository" | "task"
> {
  const state = operationalStateFor(session);
  const semanticProgressed = hasCommittedSemanticProgress(session);
  const attention =
    state === "healthy" || (state === "stopped" && semanticProgressed)
      ? null
      : {
          priority: state === "attention" && session.runtimeState === "exited" ? ("P1" as const) : ("P2" as const),
          reason:
            state === "stale"
              ? "Managed execution identity is unavailable; no unrelated runtime was adopted."
              : state === "blocked"
                ? "A resource claim or lifecycle operation is blocked."
                : session.runtimeState === "exited" && !semanticProgressed
                  ? "Agent process exited before semantic lifecycle completion; process exit is not semantic completion."
                  : "The managed session requires operator inspection.",
          authority:
            state === "stale" || state === "blocked" || session.reconciliationState === "unresolved"
              ? "Nawabari"
              : session.runtimeState === "failed" || session.runtimeState === "exited"
                ? "Zellij / Manager"
                : "Mottainai",
          safeAction:
            state === "stale" || state === "blocked" || session.reconciliationState === "unresolved"
              ? ("inspect-nawabari" as const)
              : session.runtimeState === "failed" || session.runtimeState === "exited"
                ? ("restart" as const)
                : session.attachable
                  ? ("open-terminal" as const)
                  : ("inspect" as const),
          actionLabel:
            state === "stale" || state === "blocked" || session.reconciliationState === "unresolved"
              ? "Inspect Nawabari"
              : session.runtimeState === "failed" || session.runtimeState === "exited"
                ? "Restart managed runtime"
                : session.attachable
                  ? "Open managed terminal"
                  : "Inspect session",
        };
  return {
    state,
    statusLabel: operationalStatusLabel(state),
    attention,
    phaseRail: phaseRailFor(session.semanticLifecycleState, session.runtimeState),
    identities: {
      managerSessionId: session.sessionId,
      taskId: session.taskId ?? null,
      executionSessionId: session.executionSessionId ?? null,
      runtimeName: session.runtimeName,
    },
    repository: {
      name: path.basename(session.workspaceRoot) || session.workspaceRoot,
      root: session.workspaceRoot,
      worktree: session.worktreePath,
      branch: session.branchName ?? null,
    },
    task: {
      slug: session.taskSlug ?? task?.taskSlug ?? null,
      issueRef: session.issueRef ?? task?.issueRef ?? null,
      lifecycleState: session.semanticLifecycleState,
      baseBranch: task?.baseBranch ?? null,
      baseCommit: task?.baseCommit ?? null,
    },
  };
}

/**
 * Bounded projection for list views (e.g. the polled `GET /sessions`).
 * Reads only `getTask` per session and never touches worktree, check-run,
 * validation-evidence, commit/push reconciliation, or pull-request store
 * lookups, so N sessions cost N reads instead of the ~8x fan-out that full
 * detail projection performs. Callers needing validation/commit/push/PR
 * detail must project the single session of interest instead.
 */
function projectOperationalSummary(
  store: WorkflowStateStore,
  session: ManagerSessionRecord,
): ManagerOperationalProjection {
  const task = session.taskId === undefined ? undefined : store.getTask(session.taskId);
  return {
    ...operationalCoreProjection(session, task),
    authorities: [
      { name: "Mottainai", responsibility: "lifecycle intent", status: "current" },
      { name: "Nawabari", responsibility: "Git / worktree / branch authority", status: "current" },
      { name: "Zellij", responsibility: "Manager runtime transport", status: "current" },
      { name: "gh-inari", responsibility: "governed GitHub mutation", status: "unavailable" },
    ],
    validation: { state: "unavailable", summary: "Not loaded in list projection", recordedAt: null },
    commit: commitProjection(undefined),
    push: pushProjection(undefined),
    pullRequest: pullRequestProjection(undefined),
  };
}

function projectOperationalSession(
  store: WorkflowStateStore,
  session: ManagerSessionRecord,
): ManagerOperationalProjection {
  const task = session.taskId === undefined ? undefined : store.getTask(session.taskId);
  const worktrees = task === undefined ? [] : store.listWorktreesForTask(task.taskId);
  const worktree = worktrees.find((candidate) => candidate.status === "active") ?? worktrees[0];
  const worktreeId = worktree?.worktreeId ?? session.worktreeId ?? "";
  const commitReconciliation = task === undefined ? undefined : store.getCommitReconciliation(task.taskId);
  const validation = validationProjection(
    store,
    task,
    worktreeId,
    commitReconciliation?.commitSha,
    hasCommittedSemanticProgress(session),
  );
  const commit = commitProjection(commitReconciliation);
  const push = pushProjection(task === undefined ? undefined : store.getPushReconciliation(task.taskId));
  const pullRequest = pullRequestProjection(
    task === undefined ? undefined : store.listPullRequestRecordsForTask(task.taskId).at(-1),
  );
  return {
    ...operationalCoreProjection(session, task),
    authorities: [
      { name: "Mottainai", responsibility: "lifecycle intent", status: "current" },
      { name: "Nawabari", responsibility: "Git / worktree / branch authority", status: "current" },
      { name: "Zellij", responsibility: "Manager runtime transport", status: "current" },
      {
        name: "gh-inari",
        responsibility: "governed GitHub mutation",
        status: pullRequest.state === "unavailable" ? "unavailable" : "current",
      },
    ],
    validation,
    commit,
    push,
    pullRequest,
  };
}

export class ManagerSessionService {
  private zellijVersion: string | undefined;
  private readonly execution: ManagerExecutionAuthority;
  private readonly sessionOperations = new Map<ManagerSessionId, Promise<void>>();

  private readonly options: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    runtime: ZellijRuntime;
    /** The sole local execution boundary used by task-bound Manager sessions. */
    nawabari: NawabariExecutionClient;
    /** Hermetic process-test seam; production defaults to the Codex/Claude CLIs. */
    agentCommand?: { command: string; baseArgs?: readonly string[] };
    agentCommands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
    /** Hermetic test seam; production resolves the packaged Mottainai asset. */
    piGuardPath?: string;
  };

  constructor(options: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    runtime: ZellijRuntime;
    /** Optional injection seam; production and tests default to the installed contract client. */
    nawabari?: NawabariExecutionClient;
    /** Hermetic process-test seam; production defaults to the Codex/Claude CLIs. */
    agentCommand?: { command: string; baseArgs?: readonly string[] };
    agentCommands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
    /** Hermetic test seam; production resolves the packaged Mottainai asset. */
    piGuardPath?: string;
    /** Optional injection seam; production defaults to the Nawabari-backed adapter. */
    executionAuthority?: ManagerExecutionAuthority;
  }) {
    const nawabari = options.nawabari ?? new NawabariExecutionClient();
    this.options = { ...options, nawabari };
    this.execution =
      options.executionAuthority ??
      createNawabariManagerExecutionAuthority(options.store, options.workspaceRoot, nawabari);
  }

  async initialize(): Promise<ManagerHealth> {
    try {
      const available = await this.options.runtime.checkAvailability();
      this.zellijVersion = available.version;
      await this.reconcile();
      return this.health();
    } catch (error) {
      throw managerError(error);
    }
  }

  health(): ManagerHealth {
    if (this.zellijVersion === undefined)
      throw new ManagerError("zellij_unavailable", "Zellij availability has not been established", 503);
    const sessions = this.loadControlPlaneSessions();
    const active = sessions.filter(
      (session) =>
        session.runtimeState === "starting" ||
        session.runtimeState === "running" ||
        session.runtimeState === "detached",
    ).length;
    return {
      manager: "ready",
      workspaceRoot: this.options.workspaceRoot,
      zellij: { available: true, version: this.zellijVersion },
      sessions: { active, recent: sessions.length },
    };
  }

  async list(filter: ManagerSessionFilter = {}): Promise<ManagerSessionRecord[]> {
    await this.reconcile();
    return this.projectSessions(this.loadControlPlaneSessions(), filter);
  }

  projectSession(session: ManagerSessionRecord): ManagerSessionProjection {
    return { ...session, operational: projectOperationalSession(this.options.store, session) };
  }

  /** Bounded projection for list views; see {@link projectOperationalSummary}. */
  projectSessionSummary(session: ManagerSessionRecord): ManagerSessionProjection {
    return { ...session, operational: projectOperationalSummary(this.options.store, session) };
  }

  private projectSessions(sessions: ManagerSessionRecord[], filter: ManagerSessionFilter): ManagerSessionRecord[] {
    const projected = sessions
      .filter((session) => filter.runtimeState === undefined || session.runtimeState === filter.runtimeState)
      .filter((session) => filter.agentKind === undefined || session.agentKind === filter.agentKind)
      .filter(
        (session) =>
          filter.semanticLifecycleState === undefined ||
          session.semanticLifecycleState === filter.semanticLifecycleState,
      )
      .filter((session) => filter.taskId === undefined || session.taskId === filter.taskId)
      .filter((session) => filter.issueRef === undefined || session.issueRef === filter.issueRef)
      .filter((session) => {
        if (filter.search === undefined || filter.search.trim().length === 0) return true;
        const needle = filter.search.trim().toLowerCase();
        return [
          session.sessionId,
          session.taskId,
          session.issueRef,
          session.branchName,
          session.runtimeName,
          session.latestStatus,
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle));
      });
    projected.sort((left, right) => {
      const leftActive =
        left.runtimeState === "starting" || left.runtimeState === "running" || left.runtimeState === "detached";
      const rightActive =
        right.runtimeState === "starting" || right.runtimeState === "running" || right.runtimeState === "detached";
      return (
        Number(rightActive) - Number(leftActive) ||
        right.startedAt - left.startedAt ||
        left.sessionId.localeCompare(right.sessionId)
      );
    });
    return projected.slice(0, Math.min(Math.max(Math.trunc(filter.limit ?? MAX_LIST_LIMIT), 1), MAX_LIST_LIMIT));
  }

  private loadControlPlaneSessions(): ManagerSessionRecord[] {
    const active = this.options.store.listManagerSessions(this.options.workspaceRoot, {
      limit: MAX_LIST_LIMIT,
      runtimeStates: ACTIVE_RUNTIME_STATES,
    });
    const recent = this.options.store.listManagerSessions(this.options.workspaceRoot, {
      limit: MAX_LIST_LIMIT,
      runtimeStates: RECENT_RUNTIME_STATES,
    });
    return [...active, ...recent];
  }

  async get(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, () => this.reconcileOneUnlocked(this.requireSession(sessionId)));
  }

  /** Read-only inspection of a Nawabari owner surfaced by claim preflight. */
  async inspectNawabariSession(sessionId: string): Promise<{
    sessionId: string;
    repository: string;
    worktree: string;
    branch: string;
    state: string;
    label?: string;
  }> {
    try {
      const evidence = await this.options.nawabari.listClaimEvidence(this.options.workspaceRoot);
      const owner = evidence.sessions.find((session) => session.sessionId === sessionId);
      if (owner === undefined)
        throw new ManagerError("session_not_found", `Nawabari session was not found: ${sessionId}`);
      const inspected = await this.options.nawabari.inspectSession({ cwd: owner.worktree, sessionId });
      return {
        sessionId: inspected.sessionId,
        repository: inspected.repository,
        worktree: inspected.worktree,
        branch: inspected.branch,
        state: inspected.state,
        ...(inspected.label === undefined ? {} : { label: inspected.label }),
      };
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      if (error instanceof NawabariExecutionError) {
        const status = claimPreflightFailureStatus(error);
        throw new ManagerError(
          status === "stale" ? "claim_preflight_stale" : "claim_preflight_unavailable",
          error.message,
          503,
          { nawabariCode: error.nawabariCode },
        );
      }
      throw new ManagerError(
        "claim_preflight_unavailable",
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
  }

  /**
   * Read-only Manager preflight. This intentionally does not initialize
   * Zellij or touch the workflow store. Nawabari is queried only through its
   * read-only session/claim evidence surface.
   */
  async preview(input: NewManagerSessionInput): Promise<ManagerExecutionPreview> {
    const normalized = normalizeManagerSessionInput(input);
    return this.preparePreviewWithClaimPreflight(normalized);
  }

  /** Explicit name for callers that want to distinguish plan preview from the
   * read-only Nawabari claim preflight. It returns the same bounded projection
   * as `preview` for transport compatibility.
   */
  async preflight(input: NewManagerSessionInput): Promise<ManagerExecutionPreview> {
    return this.preview(input);
  }

  private async preparePreviewWithClaimPreflight(
    normalized: ValidatedManagerSessionInput,
  ): Promise<ManagerExecutionPreview> {
    const preview = await prepareManagerExecutionPreview(this.options.workspaceRoot, normalized);
    if (normalized.taskSlug === undefined) return preview;
    try {
      const evidence = await this.options.nawabari.listClaimEvidence(this.options.workspaceRoot);
      return {
        ...preview,
        claimPreflight: createClaimPreflight(normalized.semanticPlan.claims, evidence),
      };
    } catch (error) {
      if (error instanceof NawabariExecutionError) {
        return {
          ...preview,
          claimPreflight: failedClaimPreflight(claimPreflightFailureStatus(error), error.message, error.nawabariCode),
        };
      }
      return {
        ...preview,
        claimPreflight: failedClaimPreflight("unavailable", error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private assertClaimPreflightReady(preview: ManagerExecutionPreview): void {
    if (preview.claimPreflight.status === "clear" || preview.claimPreflight.status === "not-applicable") return;
    if (preview.claimPreflight.status === "conflict") {
      throw new ManagerError(
        "claim_conflict",
        preview.claimPreflight.message ?? "Nawabari reports an active conflicting claim",
        409,
        { claimPreflight: preview.claimPreflight },
      );
    }
    const code = preview.claimPreflight.status === "stale" ? "claim_preflight_stale" : "claim_preflight_unavailable";
    throw new ManagerError(
      code,
      preview.claimPreflight.message ?? "Nawabari claim evidence is not safe to interpret as conflict-free",
      undefined,
      { claimPreflight: preview.claimPreflight },
    );
  }

  async start(input: NewManagerSessionInput): Promise<ManagerSessionRecord> {
    const normalized = normalizeManagerSessionInput(input);
    const { agentKind, instruction, provider, model, taskSlug, issueRef, branchType, idempotencyKey, semanticPlan } =
      normalized;

    if (this.zellijVersion === undefined) await this.initialize();

    // An idempotent retry resolves to its own already-owning Nawabari session
    // (or is still starting/terminal), so it must short-circuit before claim
    // preflight: the retry's own prior claims would otherwise read back as a
    // self-conflict against the exact session the retry is entitled to reuse.
    // A genuinely new session (no bound idempotency key, or no prior record)
    // always falls through to preflight and Nawabari's authoritative check.
    if (idempotencyKey !== undefined) {
      const existing = this.options.store
        .listManagerSessions(this.options.workspaceRoot)
        .find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.agentKind !== agentKind ||
          existing.provider !== provider ||
          existing.model !== model ||
          existing.instruction !== instruction ||
          existing.taskSlug !== taskSlug ||
          existing.issueRef !== issueRef ||
          (existing.branchType ?? "feat") !== branchType
        ) {
          throw idempotencyConflict(`idempotency key is already bound to manager session ${existing.sessionId}`);
        }
        return this.resumeIdempotentSession(existing.sessionId);
      }
    }

    // Resolve branch/base identity and the exact claim declaration before any
    // task, Nawabari session, Manager record, or Zellij mutation.
    const initialPreview = await this.preparePreviewWithClaimPreflight(normalized);
    this.assertClaimPreflightReady(initialPreview);

    // Resolve and validate the guard before task/worktree creation. A managed
    // Pi launch must never fall back to an unguarded process.
    const piGuardPath = agentKind === "pi" ? configuredPiGuardPath(this.options.piGuardPath) : undefined;

    const sessionId = crypto.randomUUID() as ManagerSessionId;
    const runtimeName = deriveZellijSessionName(sessionId);
    return this.withSessionOperation(sessionId, async () => {
      let existingRuntime: ZellijObservedState;
      try {
        existingRuntime = await this.options.runtime.inspect(runtimeName);
      } catch (error) {
        throw managerError(error);
      }
      if (existingRuntime !== "absent")
        throw new ManagerError("runtime_name_collision", `Zellij session name is already in use: ${runtimeName}`, 409);
      if (
        this.options.store
          .listManagerSessions(this.options.workspaceRoot)
          .some((candidate) => candidate.runtimeName === runtimeName)
      )
        throw new ManagerError(
          "runtime_name_collision",
          `Mottainai runtime name is already recorded: ${runtimeName}`,
          409,
        );

      let executionContext: ManagerExecutionContext;
      let executionReceipt: ManagerSessionReceipt | undefined;
      try {
        // This is deliberately a fresh read immediately before Nawabari's
        // authoritative create/claim mutation. The earlier preview is never a
        // lease and cannot be trusted across this TOCTOU boundary.
        const freshPreview = await this.preparePreviewWithClaimPreflight(normalized);
        this.assertClaimPreflightReady(freshPreview);
        const execution = await this.execution.start({
          workspaceRoot: this.options.workspaceRoot,
          store: this.options.store,
          taskSlug,
          issueRef,
          branchType,
          idempotencyKey: idempotencyKey ?? sessionId,
          semanticPlan,
        });
        executionContext = execution.context;
        executionReceipt = execution.receipt;
      } catch (error) {
        if (isClaimConflict(error)) {
          let refreshed = await this.preparePreviewWithClaimPreflight(normalized).catch(() => undefined);
          if (refreshed?.claimPreflight.status === "clear") {
            refreshed = {
              ...refreshed,
              claimPreflight: failedClaimPreflight(
                "stale",
                "Nawabari rejected the final mutation after preflight; the fresh evidence no longer reproduces the conflict",
                "RESOURCE_CLAIM_CONFLICT",
              ),
            };
          }
          throw new ManagerError(
            "claim_conflict",
            "Nawabari rejected the final session mutation with RESOURCE_CLAIM_CONFLICT; refreshed evidence is authoritative",
            409,
            {
              finalNawabariCode: "RESOURCE_CLAIM_CONFLICT",
              claimPreflight: refreshed?.claimPreflight,
            },
          );
        }
        if (error instanceof ManagerError) throw error;
        throw new ManagerError("task_start_failed", error instanceof Error ? error.message : String(error), 409);
      }

      const invocation = buildManagerLaunchInvocation({
        agentKind,
        provider,
        model,
        instruction,
        piGuardPath,
        commands: {
          ...(this.options.agentCommands ?? {}),
          ...(this.options.agentCommand === undefined ? {} : { codex: this.options.agentCommand }),
        },
      });
      try {
        this.options.store.createManagerSession({
          sessionId,
          workspaceRoot: this.options.workspaceRoot,
          idempotencyKey,
          taskId: executionContext.taskId,
          executionSessionId: executionContext.executionSessionId,
          executionMode: executionContext.taskId === undefined ? "workspace" : "task-bound",
          worktreeId: executionContext.worktreeId,
          worktreePath: executionContext.worktreePath,
          branchName: executionContext.branchName,
          taskSlug: executionContext.taskSlug,
          issueRef: executionContext.issueRef,
          branchType: executionContext.branchType,
          agentKind,
          launchProfile: agentKind,
          instruction,
          provider,
          model,
          launchCommand: invocation.command,
          launchArgs: invocation.args,
          runtimeName,
          semanticLifecycleState: executionContext.semanticLifecycleState,
          latestStatus: "execution context acquired; launching agent runtime",
          latestReceipt: executionReceipt,
        });
      } catch (error) {
        // A concurrent retry may have persisted the same Manager record while
        // this process was acquiring the execution context. Reconcile that
        // record instead of creating a second runtime or surfacing a duplicate
        // operation as an unrelated database failure.
        if (idempotencyKey !== undefined) {
          const existing = this.options.store
            .listManagerSessions(this.options.workspaceRoot)
            .find((candidate) => candidate.idempotencyKey === idempotencyKey);
          if (existing !== undefined) return this.resumeIdempotentSession(existing.sessionId);
        }
        throw error;
      }
      const validation = await this.execution.validate(executionContext);
      if (!validation.ok) {
        const detail = validation.detail.slice(0, MAX_STATUS_LENGTH);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          reconciliationState: "unresolved",
          reconciliationMessage: detail,
          latestStatus: detail,
          latestReceipt: receipt("execution_unavailable", detail, "workflow"),
          terminationState: "failed",
          errorMessage: detail,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw new ManagerError("worktree_missing", detail, 409);
      }
      try {
        await this.options.runtime.start({
          sessionName: runtimeName,
          cwd: executionContext.worktreePath,
          command: invocation.command,
          args: invocation.args,
        });
        return this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "running",
          runtimeState: "running",
          attachable: true,
          reconciliationState: "synced",
          latestStatus: `${agentKind} runtime started in managed execution context`,
          latestReceipt: receipt("runtime_started", `${agentKind} runtime started`, "runtime"),
          terminationState: "running",
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        const failure = managerError(error);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          attachable: false,
          reconciliationState: "drifted",
          reconciliationMessage: failure.message,
          latestStatus: failure.message,
          latestReceipt: receipt("runtime_start_failed", failure.message, "zellij"),
          terminationState: "failed",
          errorMessage: failure.message,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw failure;
      }
    });
  }

  async openTerminal(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const session = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (session.runtimeState !== "running" && session.runtimeState !== "detached")
        throw new ManagerError("session_not_running", `session is not running: ${sessionId}`, 409);
      if (!session.attachable)
        throw new ManagerError("session_not_attachable", `session is not attachable: ${sessionId}`, 409);
      try {
        await this.options.runtime.attach(session.runtimeName, session.worktreePath);
        return this.options.store.updateManagerSession(sessionId, {
          latestStatus: "selected Zellij session opened",
          latestReceipt: receipt("runtime_attached", "selected Zellij session opened", "zellij"),
          reconciliationState: "synced",
          reconciliationMessage: null,
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        throw managerError(error);
      }
    });
  }

  async stop(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const session = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (
        session.runtimeState !== "running" &&
        session.runtimeState !== "detached" &&
        session.runtimeState !== "starting"
      )
        return session;
      try {
        const observed = await this.options.runtime.inspect(session.runtimeName, session.worktreePath);
        if (observed !== "running" && observed !== "detached" && observed !== "exited") {
          return this.options.store.updateManagerSession(session.sessionId, {
            runtimeState: "stale",
            attachable: false,
            reconciliationState: "unresolved",
            reconciliationMessage: `refusing to stop selected runtime because its identity is ${observed}`,
            latestStatus: `refusing to stop selected runtime because its identity is ${observed}`,
            latestReceipt: receipt(
              "runtime_stop_rejected",
              `refusing to stop selected runtime because its identity is ${observed}`,
              "zellij",
            ),
            runtimeObservedAt: Date.now(),
          });
        }
        await this.options.runtime.terminate(session.runtimeName, session.worktreePath);
        const now = Date.now();
        return this.options.store.updateManagerSession(session.sessionId, {
          lifecycleState: "stopped",
          runtimeState: "stopped",
          attachable: false,
          terminationState: "stopped",
          finishedAt: now,
          runtimeObservedAt: now,
          latestStatus: "selected managed runtime stopped",
          latestReceipt: receipt("runtime_stopped", "selected managed runtime stopped", "zellij"),
          reconciliationState: "synced",
          reconciliationMessage: null,
        });
      } catch (error) {
        throw managerError(error);
      }
    });
  }

  async restart(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const current = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (isTerminalSemanticState(current.semanticLifecycleState)) {
        throw new ManagerError(
          "session_restart_rejected",
          `cannot restart a session whose semantic task lifecycle is ${current.semanticLifecycleState}`,
          409,
        );
      }
      if (
        current.runtimeState === "running" ||
        current.runtimeState === "detached" ||
        current.runtimeState === "starting"
      ) {
        throw new ManagerError(
          "session_restart_rejected",
          "restart is only valid for a non-running managed runtime",
          409,
        );
      }
      if (current.runtimeState === "stale") {
        const observed = await this.options.runtime.inspect(current.runtimeName, current.worktreePath);
        if (observed !== "absent") {
          throw new ManagerError(
            "session_restart_rejected",
            `cannot restart because the managed Zellij identity is ${observed}; no unrelated session will be adopted`,
            409,
          );
        }
      }
      const context = this.contextFromRecord(current);
      const validation = await this.execution.validate(context);
      if (!validation.ok) throw new ManagerError("execution_unresolved", validation.detail, 409);
      if (current.agentKind === "pi") validateStoredPiGuardInvocation(current.launchArgs);
      const restartCount = current.restartCount + 1;
      const started = this.options.store.updateManagerSession(current.sessionId, {
        lifecycleState: "starting",
        runtimeState: "starting",
        attachable: false,
        reconciliationState: "drifted",
        reconciliationMessage: "restart requested for the selected managed runtime",
        latestStatus: "relaunching selected agent runtime",
        latestReceipt: receipt("runtime_restart_requested", "relaunching selected agent runtime", "manager"),
        restartCount,
        terminationState: "running",
        errorMessage: null,
        finishedAt: null,
        exitCode: null,
        runtimeObservedAt: Date.now(),
      });
      try {
        if (current.runtimeState === "exited")
          await this.options.runtime.terminate(current.runtimeName, current.worktreePath).catch(() => undefined);
        await this.options.runtime.start({
          sessionName: started.runtimeName,
          cwd: started.worktreePath,
          command: started.launchCommand,
          args: started.launchArgs,
        });
        return this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "running",
          runtimeState: "running",
          attachable: true,
          reconciliationState: "synced",
          reconciliationMessage: null,
          latestStatus: "agent runtime relaunched in the existing execution context",
          latestReceipt: receipt("runtime_restarted", "agent runtime relaunched", "runtime"),
          terminationState: "running",
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        const failure = managerError(error);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          attachable: false,
          reconciliationState: "drifted",
          reconciliationMessage: failure.message,
          latestStatus: failure.message,
          latestReceipt: receipt("runtime_restart_failed", failure.message, "zellij"),
          terminationState: "failed",
          errorMessage: failure.message,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw failure;
      }
    });
  }

  async reconcileNow(): Promise<ManagerSessionRecord[]> {
    await this.reconcile();
    return this.projectSessions(this.loadControlPlaneSessions(), {});
  }

  private requireSession(sessionId: ManagerSessionId): ManagerSessionRecord {
    const session = this.options.store.getManagerSession(sessionId);
    if (session === undefined || session.workspaceRoot !== this.options.workspaceRoot)
      throw new ManagerError("session_not_found", `manager session not found: ${sessionId}`);
    return session;
  }

  /** Reconcile and, when safe, resume one previously persisted task-run. */
  private async resumeIdempotentSession(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    const current = await this.get(sessionId);
    if (
      current.runtimeState === "starting" ||
      current.runtimeState === "running" ||
      current.runtimeState === "detached"
    ) {
      return current;
    }
    if (isTerminalSemanticState(current.semanticLifecycleState)) return current;
    return this.restart(sessionId);
  }

  private contextFromRecord(session: ManagerSessionRecord): ManagerExecutionContext {
    return {
      taskId: session.taskId,
      executionSessionId: session.executionSessionId,
      worktreeId: session.worktreeId,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      taskSlug: session.taskSlug,
      issueRef: session.issueRef,
      branchType: session.branchType,
      semanticLifecycleState: session.semanticLifecycleState,
    };
  }

  private async reconcileOneUnlocked(session: ManagerSessionRecord): Promise<ManagerSessionRecord> {
    let semantic = session.semanticLifecycleState;
    let status = session.latestStatus;
    let semanticReceipt = session.latestReceipt;
    try {
      const observed = await this.execution.observe(this.contextFromRecord(session));
      semantic = observed.semanticLifecycleState;
      status = observed.status === undefined ? status : boundedStatus(observed.status);
      semanticReceipt = observed.receipt ?? semanticReceipt;
    } catch (error) {
      status = `workflow observation failed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        MAX_STATUS_LENGTH,
      );
      semanticReceipt = receipt("workflow_observation_failed", status, "workflow");
    }

    // Runtime-terminal records still observe workflow semantics so restart
    // decisions cannot use a stale pre-completion task lifecycle.
    if (session.lifecycleState === "failed" || session.lifecycleState === "stopped") {
      return this.options.store.updateManagerSession(session.sessionId, {
        semanticLifecycleState: semantic,
        latestStatus: status,
        ...(semanticReceipt === undefined ? {} : { latestReceipt: semanticReceipt }),
        runtimeObservedAt: Date.now(),
      });
    }

    const validation = await this.execution.validate(
      this.contextFromRecord({ ...session, semanticLifecycleState: semantic }),
    );
    if (!validation.ok) {
      const now = Date.now();
      const detail = boundedStatus(validation.detail);
      const observed = await this.options.runtime
        .inspect(session.runtimeName, session.worktreePath)
        .catch(() => "unresolved" as const);
      if (observed === "running" || observed === "detached") {
        await this.options.runtime.terminate(session.runtimeName, session.worktreePath).catch(() => undefined);
      }
      return this.options.store.updateManagerSession(session.sessionId, {
        lifecycleState: "failed",
        runtimeState: "stale",
        semanticLifecycleState: semantic,
        attachable: false,
        reconciliationState: "unresolved",
        reconciliationMessage: detail,
        latestStatus: detail,
        latestReceipt: receipt("execution_unresolved", detail, "workflow"),
        finishedAt: session.finishedAt ?? now,
        runtimeObservedAt: now,
        terminationState: "failed",
        errorMessage: session.errorMessage ?? detail,
      });
    }

    let observed: ZellijObservedState;
    try {
      observed = await this.options.runtime.inspect(session.runtimeName, session.worktreePath);
    } catch (error) {
      const detail = boundedStatus(error instanceof Error ? error.message : String(error));
      return this.options.store.updateManagerSession(session.sessionId, {
        runtimeState: "stale",
        semanticLifecycleState: semantic,
        attachable: false,
        reconciliationState: "unresolved",
        reconciliationMessage: detail,
        latestStatus: detail,
        latestReceipt: receipt("runtime_inspection_failed", detail, "zellij"),
        runtimeObservedAt: Date.now(),
      });
    }
    const runtimeState =
      observed === "absent" && session.runtimeState === "exited" ? "exited" : runtimeStateForObservation(observed);
    const now = Date.now();
    const attachable = runtimeState === "running" || runtimeState === "detached";
    const stale = runtimeState === "stale";
    const nextLifecycle = lifecycleForRuntime(runtimeState, session.lifecycleState);
    const detail =
      stale && observed === "unresolved"
        ? "managed Zellij runtime identity is unresolved; no unrelated session was adopted"
        : stale
          ? "managed Zellij session is missing; no unrelated session was adopted"
          : runtimeState === "exited"
            ? "managed Zellij agent pane exited; semantic task completion was not inferred"
            : runtimeState === "detached"
              ? "managed Zellij session is detached and attachable"
              : `managed Zellij session is ${runtimeState}`;
    const nextReceipt =
      stale || runtimeState === "exited" || runtimeState === "detached"
        ? receipt(
            stale ? "runtime_stale" : runtimeState === "exited" ? "runtime_exited" : "runtime_detached",
            detail,
            "zellij",
          )
        : semanticReceipt;
    return this.options.store.updateManagerSession(session.sessionId, {
      lifecycleState: nextLifecycle,
      runtimeState,
      semanticLifecycleState: semantic,
      attachable,
      reconciliationState: stale ? "unresolved" : runtimeState === "exited" ? "drifted" : "synced",
      reconciliationMessage: stale ? detail : null,
      latestStatus: status ?? detail,
      latestReceipt: nextReceipt,
      finishedAt: runtimeState === "exited" || runtimeState === "stale" ? (session.finishedAt ?? now) : null,
      runtimeObservedAt: now,
      terminationState:
        runtimeState === "running" || runtimeState === "detached"
          ? "running"
          : runtimeState === "stopped"
            ? "stopped"
            : runtimeState === "failed"
              ? "failed"
              : "exited",
      errorMessage: stale ? (session.errorMessage ?? detail) : runtimeState === "exited" ? session.errorMessage : null,
    });
  }

  private async reconcile(): Promise<void> {
    const sessions = this.loadControlPlaneSessions();
    for (const session of sessions) {
      await this.withSessionOperation(session.sessionId, () =>
        this.reconcileOneUnlocked(this.requireSession(session.sessionId)),
      );
    }
  }

  private async withSessionOperation<T>(sessionId: ManagerSessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.sessionOperations.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(sessionId) === tail) this.sessionOperations.delete(sessionId);
    }
  }
}
