import { runProgram, type RunResult } from "../subprocess.js";
import type { ExecutionClaim, NawabariDeclaration, SemanticExecutionPlan } from "../semantics/execution-plan.js";
import { projectNawabariDeclaration } from "../semantics/execution-plan.js";

export const NAWABARI_CONTRACT_ID = "nawabari.standalone-execution.v1" as const;
export const NAWABARI_CONTRACT_SCHEMA_VERSION = 1 as const;
export const MINIMUM_NAWABARI_VERSION = "0.4.1" as const;
/** Expected shape of the resource-claims capability's `claim_set_replacement` boundary (Nawabari #101 / PR #106). */
const REQUIRED_CLAIM_SET_REPLACEMENT_PAIRING = "adjacent-resource-mode" as const;

const COMMAND_TIMEOUT_MS = 12_000;
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
const REQUIRED_NAWABARI_COMMANDS = [
  "session create",
  "session id",
  "session show",
  "session list",
  "session claim",
  "session update",
  "session claims",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
] as const;

export type NawabariFailureCode =
  | "nawabari-unavailable"
  | "nawabari-incompatible"
  | "nawabari-contract-invalid"
  | "nawabari-rejected"
  | "nawabari-command-failed"
  | "nawabari-claim-authority-unrecognized";

export class NawabariExecutionError extends Error {
  constructor(
    readonly code: NawabariFailureCode,
    message: string,
    readonly nawabariCode?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "NawabariExecutionError";
  }
}

export interface NawabariCommandResult {
  readonly ok: boolean;
  readonly command: string;
  readonly [key: string]: unknown;
}

export type NawabariPushRelation = "no-upstream" | "up-to-date" | "ahead" | "behind" | "diverged";

/** Stable push.v1 evidence returned by Nawabari #61. */
export interface NawabariPushResult extends NawabariCommandResult {
  readonly source_sha: string;
  readonly remote: string;
  readonly branch: string;
  readonly target: string;
  readonly target_ref: string;
  readonly observed_remote_sha: string | null;
  readonly relation: NawabariPushRelation;
}

export interface NawabariCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<RunResult>;
}

const defaultRunner: NawabariCommandRunner = {
  run: (command, args, cwd) => runProgram(command, [...args], cwd, COMMAND_TIMEOUT_MS, COMMAND_MAX_OUTPUT_BYTES),
};

export interface NawabariCapabilities {
  contractId: typeof NAWABARI_CONTRACT_ID;
  schemaVersion: typeof NAWABARI_CONTRACT_SCHEMA_VERSION;
  packageVersion: string;
  capabilities: readonly Record<string, unknown>[];
}

export interface NawabariSession {
  sessionId: string;
  repository: string;
  worktree: string;
  branch: string;
  state: string;
  label?: string;
  raw: NawabariCommandResult;
}

export interface NawabariExecutionClientOptions {
  command?: string;
  runner?: NawabariCommandRunner;
  minimumVersion?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new NawabariExecutionError("nawabari-contract-invalid", `Nawabari result is missing ${field}`);
  return value;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
    return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function errorMessage(result: NawabariCommandResult): string {
  const code = typeof result.code === "string" ? result.code : "UNKNOWN";
  const message = typeof result.message === "string" ? result.message : "Nawabari rejected the operation";
  return `${code}: ${message}`;
}

function requireResultString(result: NawabariCommandResult, fields: readonly string[], label: string): string {
  for (const field of fields) {
    if (typeof result[field] === "string" && result[field].length > 0) return result[field] as string;
  }
  throw new NawabariExecutionError(
    "nawabari-contract-invalid",
    `Nawabari result is missing ${label}`,
    undefined,
    result,
  );
}

function requireNullableResultString(result: NawabariCommandResult, fields: readonly string[], label: string): void {
  const field = fields.find((candidate) => candidate in result);
  if (field === undefined)
    throw new NawabariExecutionError(
      "nawabari-contract-invalid",
      `Nawabari result is missing ${label}`,
      undefined,
      result,
    );
  if (result[field] === null) return;
  if (typeof result[field] === "string" && (result[field] as string).length > 0) return;
  throw new NawabariExecutionError(
    "nawabari-contract-invalid",
    `Nawabari result has invalid ${label}`,
    undefined,
    result,
  );
}

function requirePushResult(result: NawabariCommandResult): NawabariPushResult {
  requireResultString(result, ["source_sha", "sourceSha"], "source_sha");
  requireResultString(result, ["remote"], "remote");
  requireResultString(result, ["branch"], "branch");
  requireResultString(result, ["target"], "target");
  requireResultString(result, ["target_ref", "targetRef"], "target_ref");
  requireNullableResultString(result, ["observed_remote_sha", "observedRemoteSha"], "observed_remote_sha");
  if (!["no-upstream", "up-to-date", "ahead", "behind", "diverged"].includes(result.relation as string))
    throw new NawabariExecutionError(
      "nawabari-contract-invalid",
      "Nawabari result has invalid relation",
      undefined,
      result,
    );
  return result as NawabariPushResult;
}

export function claimKey(claim: ExecutionClaim): string {
  return `${claim.resource} ${claim.mode}`;
}

function parseClaimsArray(result: NawabariCommandResult, field: string): ExecutionClaim[] {
  if (!Array.isArray(result[field]))
    throw new NawabariExecutionError(
      "nawabari-contract-invalid",
      `Nawabari result is missing ${field}`,
      undefined,
      result,
    );
  return (result[field] as unknown[]).map((value) => {
    const claim = object(value);
    if (claim === undefined)
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        `Nawabari result contains a malformed claim in ${field}`,
        undefined,
        value,
      );
    const resource = requiredString(claim.resource, `${field}[].resource`);
    const mode = claim.mode;
    if (mode !== "read" && mode !== "write" && mode !== "exclusive-write")
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        `Nawabari result contains an invalid mode in ${field}`,
        undefined,
        claim,
      );
    return { resource, mode };
  });
}

function requireDecision(result: NawabariCommandResult): NawabariCommandResult {
  if (typeof result.allowed !== "boolean")
    throw new NawabariExecutionError(
      "nawabari-contract-invalid",
      "Nawabari authorization result is missing allowed",
      undefined,
      result,
    );
  return result;
}

export class NawabariExecutionClient {
  private readonly command: string;
  private readonly runner: NawabariCommandRunner;
  private readonly minimumVersion: string;
  private discovered: NawabariCapabilities | undefined;

  constructor(options: NawabariExecutionClientOptions = {}) {
    this.command = options.command ?? "nawabari";
    this.runner = options.runner ?? defaultRunner;
    this.minimumVersion = options.minimumVersion ?? MINIMUM_NAWABARI_VERSION;
  }

  async capabilities(cwd: string): Promise<NawabariCapabilities> {
    if (this.discovered !== undefined) return this.discovered;
    let result: NawabariCommandResult;
    try {
      result = await this.invoke(["capabilities"], cwd, false);
    } catch (error) {
      if (error instanceof NawabariExecutionError && error.code === "nawabari-rejected")
        throw new NawabariExecutionError(
          "nawabari-incompatible",
          `Nawabari capability discovery was rejected: ${error.message}`,
          error.nawabariCode,
          error.details,
        );
      throw error;
    }
    const contractId = result.contract_id ?? result.capability_id;
    if (contractId !== NAWABARI_CONTRACT_ID || result.schema_version !== NAWABARI_CONTRACT_SCHEMA_VERSION)
      throw new NawabariExecutionError(
        "nawabari-incompatible",
        `Nawabari contract is incompatible: expected ${NAWABARI_CONTRACT_ID}/schema ${NAWABARI_CONTRACT_SCHEMA_VERSION}`,
      );
    const packageVersion = requiredString(result.package_version, "package_version");
    if (compareVersions(packageVersion, this.minimumVersion) < 0)
      throw new NawabariExecutionError(
        "nawabari-incompatible",
        `Nawabari ${packageVersion} is older than required ${this.minimumVersion}`,
      );
    const capabilities = Array.isArray(result.capabilities)
      ? result.capabilities.filter((item): item is Record<string, unknown> => object(item) !== undefined)
      : [];
    const advertisedCommands = new Set(
      capabilities.flatMap((capability) =>
        Array.isArray(capability.commands)
          ? capability.commands.filter((command): command is string => typeof command === "string")
          : [],
      ),
    );
    const missingCommands = REQUIRED_NAWABARI_COMMANDS.filter((command) => !advertisedCommands.has(command));
    if (missingCommands.length > 0)
      throw new NawabariExecutionError(
        "nawabari-incompatible",
        `Nawabari contract is missing required commands: ${missingCommands.join(", ")}`,
      );
    const resourceClaimsCapability = capabilities.find((capability) => capability.id === "resource-claims");
    const claimSetReplacement = object(resourceClaimsCapability?.claim_set_replacement);
    if (
      claimSetReplacement === undefined ||
      claimSetReplacement.atomic !== true ||
      claimSetReplacement.idempotent_retry !== true ||
      claimSetReplacement.unchanged_on_rejection !== true ||
      claimSetReplacement.pairing !== REQUIRED_CLAIM_SET_REPLACEMENT_PAIRING ||
      !Array.isArray(claimSetReplacement.commands) ||
      !claimSetReplacement.commands.includes("session update")
    )
      throw new NawabariExecutionError(
        "nawabari-incompatible",
        "Nawabari contract is missing the atomic claim_set_replacement boundary on resource-claims",
      );
    this.discovered = { contractId: NAWABARI_CONTRACT_ID, schemaVersion: 1, packageVersion, capabilities };
    return this.discovered;
  }

  async createSession(input: { cwd: string; branch: string; base?: string; label?: string }): Promise<NawabariSession> {
    await this.capabilities(input.cwd);
    const args = ["session", "create", "--branch", input.branch, "--base", input.base ?? "HEAD"];
    if (input.label !== undefined) args.push("--label", input.label);
    const result = await this.invoke(args, input.cwd);
    return this.session(result);
  }

  async claimSession(input: {
    cwd: string;
    sessionId: string;
    claims: readonly ExecutionClaim[];
  }): Promise<NawabariCommandResult[]> {
    const results: NawabariCommandResult[] = [];
    for (const claim of input.claims) {
      results.push(
        await this.invoke(
          ["session", "claim", "--session", input.sessionId, "--resource", claim.resource, "--mode", claim.mode],
          input.cwd,
        ),
      );
    }
    return results;
  }

  async releaseClaims(input: { cwd: string; sessionId: string }): Promise<NawabariCommandResult> {
    return this.invoke(["session", "release", "--session", input.sessionId], input.cwd);
  }

  async listClaims(input: { cwd: string; sessionId: string }): Promise<ExecutionClaim[]> {
    const result = await this.invoke(["session", "claims", "--session", input.sessionId], input.cwd);
    return parseClaimsArray(result, "claims");
  }

  /**
   * Atomically replace the session's complete resource claim set in one
   * `session update` transaction (Nawabari 0.4.1's `claim_set_replacement`
   * boundary): a rejected update leaves the prior set unchanged, so the
   * caller never observes — or needs to compensate for — a partially
   * rebuilt claim set. The returned evidence is checked to prove the
   * resulting set matches exactly the requested one; a mismatch fails
   * closed rather than being trusted silently.
   */
  async updateClaims(input: {
    cwd: string;
    sessionId: string;
    claims: readonly ExecutionClaim[];
  }): Promise<ExecutionClaim[]> {
    const args = [
      "session",
      "update",
      "--session",
      input.sessionId,
      ...input.claims.flatMap((claim) => ["--resource", claim.resource, "--mode", claim.mode]),
    ];
    const result = await this.invoke(args, input.cwd);
    const claims = parseClaimsArray(result, "claims");
    const expected = new Set(input.claims.map(claimKey));
    const observed = new Set(claims.map(claimKey));
    if (expected.size !== observed.size || [...expected].some((key) => !observed.has(key)))
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        "Nawabari session update result does not match the requested claim set",
        undefined,
        result,
      );
    return claims;
  }

  async authorize(input: {
    cwd: string;
    sessionId?: string;
    operation: string;
    resources: readonly string[];
  }): Promise<NawabariCommandResult> {
    const args = ["authorize"];
    if (input.sessionId !== undefined) args.push("--session", input.sessionId);
    args.push("--operation", input.operation, ...input.resources.flatMap((resource) => ["--resource", resource]));
    return requireDecision(await this.invoke(args, input.cwd, true, true));
  }

  async guard(input: {
    cwd: string;
    sessionId?: string;
    operation?: string;
    resources?: readonly string[];
  }): Promise<NawabariCommandResult> {
    const args = ["guard"];
    if (input.sessionId !== undefined) args.push("--session", input.sessionId);
    if (input.operation !== undefined) args.push("--operation", input.operation);
    for (const resource of input.resources ?? []) args.push("--resource", resource);
    return requireDecision(await this.invoke(args, input.cwd, true, true));
  }

  async checkpoint(input: { cwd: string; sessionId: string }): Promise<NawabariCommandResult> {
    const result = await this.invoke(["checkpoint", "--session", input.sessionId], input.cwd);
    requireResultString(result, ["headId", "head_id", "head"], "headId");
    requireResultString(result, ["sessionId", "session_id"], "session_id");
    // The evidence.v1 schema nests changed/staged/unstaged/untracked under
    // `paths`; in_claim/out_of_claim stay top-level.
    const paths = object(result.paths) ?? {};
    for (const field of ["changed", "staged", "unstaged", "untracked"] as const) {
      if (!Array.isArray(paths[field]) || !(paths[field] as unknown[]).every((value) => typeof value === "string"))
        throw new NawabariExecutionError(
          "nawabari-contract-invalid",
          `Nawabari checkpoint result is missing paths.${field}`,
          undefined,
          result,
        );
    }
    for (const field of ["in_claim", "out_of_claim"] as const) {
      if (!Array.isArray(result[field]) || !(result[field] as unknown[]).every((value) => typeof value === "string"))
        throw new NawabariExecutionError(
          "nawabari-contract-invalid",
          `Nawabari checkpoint result is missing ${field}`,
          undefined,
          result,
        );
    }
    return result;
  }

  async commit(input: {
    cwd: string;
    sessionId: string;
    message: string;
    resources: readonly string[];
  }): Promise<NawabariCommandResult> {
    const result = await this.invoke(
      [
        "commit",
        "--session",
        input.sessionId,
        "--message",
        input.message,
        ...input.resources.flatMap((resource) => ["--resource", resource]),
      ],
      input.cwd,
    );
    requireResultString(result, ["commitSha", "commit_sha"], "commitSha");
    return result;
  }

  async push(input: {
    cwd: string;
    sessionId: string;
    remote: string;
    branch: string;
    resources: readonly string[];
    force?: boolean;
    createUpstream?: boolean;
  }): Promise<NawabariPushResult> {
    const args = [
      "push",
      "--session",
      input.sessionId,
      "--remote",
      input.remote,
      "--branch",
      input.branch,
      ...input.resources.flatMap((resource) => ["--resource", resource]),
    ];
    if (input.force === true) args.push("--force");
    if (input.createUpstream === true) args.push("--create-upstream");
    const result = await this.invoke(args, input.cwd);
    return requirePushResult(result);
  }

  async showSession(input: { cwd: string; sessionId: string }): Promise<NawabariSession> {
    await this.capabilities(input.cwd);
    return this.session(await this.invoke(["session", "show", "--session", input.sessionId], input.cwd));
  }

  async listSessions(cwd: string): Promise<NawabariSession[]> {
    await this.capabilities(cwd);
    const result = await this.invoke(["session", "list"], cwd);
    if (!Array.isArray(result.sessions))
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        "Nawabari session list result is missing sessions",
        undefined,
        result,
      );
    return result.sessions.map((value) => {
      const raw = object(value);
      if (raw === undefined)
        throw new NawabariExecutionError(
          "nawabari-contract-invalid",
          "Nawabari session list contains a malformed session",
          undefined,
          value,
        );
      return this.session({ ok: true, command: "session list", ...raw });
    });
  }

  async currentSessionId(cwd: string): Promise<string> {
    await this.capabilities(cwd);
    return requiredString((await this.invoke(["session", "id"], cwd)).session_id, "session_id");
  }

  async closeSession(input: { cwd: string; sessionId: string }): Promise<NawabariCommandResult> {
    return this.invoke(["session", "close", "--session", input.sessionId], input.cwd);
  }

  async doctor(cwd: string): Promise<NawabariCommandResult> {
    await this.capabilities(cwd);
    return this.invoke(["doctor"], cwd, true, true);
  }

  /** Mottainai owns the decision to request cleanup; Nawabari owns the physical decision. */
  async cleanup(input: { cwd: string; sessionId: string; dryRun?: boolean }): Promise<NawabariCommandResult> {
    await this.capabilities(input.cwd);
    if (input.dryRun === true) return this.invoke(["gc", "--dry-run"], input.cwd);
    return this.closeSession(input);
  }

  private session(result: NawabariCommandResult): NawabariSession {
    return {
      sessionId: requiredString(result.session_id, "session_id"),
      repository: requiredString(result.repository, "repository"),
      worktree: requiredString(result.worktree, "worktree"),
      branch: requiredString(result.branch, "branch"),
      state: requiredString(result.state, "state"),
      ...(typeof result.label === "string" ? { label: result.label } : {}),
      raw: result,
    };
  }

  private async invoke(
    args: readonly string[],
    cwd: string,
    requireCapability = true,
    returnRejected = false,
  ): Promise<NawabariCommandResult> {
    if (requireCapability) await this.capabilities(cwd);
    const run = await this.runner.run(this.command, [...args, "--json"], cwd);
    if (run.spawnError !== undefined)
      throw new NawabariExecutionError("nawabari-unavailable", `Nawabari could not be started: ${run.spawnError}`);
    if (run.timedOut || run.outputLimit)
      throw new NawabariExecutionError(
        "nawabari-command-failed",
        "Nawabari command exceeded its bounded execution contract",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout.trim());
    } catch {
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        "Nawabari did not return one JSON document",
        undefined,
        run.stderr.slice(0, 512),
      );
    }
    const result = object(parsed) as NawabariCommandResult | undefined;
    if (result === undefined || typeof result.ok !== "boolean" || typeof result.command !== "string")
      throw new NawabariExecutionError(
        "nawabari-contract-invalid",
        "Nawabari JSON result does not match the v1 envelope",
        undefined,
        parsed,
      );
    if (!result.ok && returnRejected) return result;
    if (!result.ok)
      throw new NawabariExecutionError(
        "nawabari-rejected",
        errorMessage(result),
        typeof result.code === "string" ? result.code : undefined,
        result.details,
      );
    if (run.exitCode !== 0)
      throw new NawabariExecutionError(
        "nawabari-command-failed",
        `Nawabari returned exit code ${String(run.exitCode)}`,
        undefined,
        result,
      );
    return result;
  }
}

export interface NawabariStartResult {
  session: NawabariSession;
  declaration: NawabariDeclaration;
  evidence: { decisions: readonly NawabariCommandResult[]; warnings: readonly string[] };
}

/** Thin orchestration helper used by task start and Manager. */
export async function startNawabariExecution(input: {
  client: NawabariExecutionClient;
  cwd: string;
  branch: string;
  base?: string;
  taskLabel?: string;
  plan: SemanticExecutionPlan;
  /** Called synchronously after create returns, before any claim mutation. */
  onSessionCreated?: (session: NawabariSession) => void;
  /** Task-start compensation must verify ownership before requesting close. */
  closeOnClaimFailure?: boolean;
}): Promise<NawabariStartResult> {
  const declaration = projectNawabariDeclaration({ plan: input.plan, branch: input.branch, base: input.base });
  const session = await input.client.createSession({
    cwd: input.cwd,
    branch: declaration.branch,
    base: declaration.base,
    label: input.taskLabel,
  });
  input.onSessionCreated?.(session);
  try {
    const decisions = await input.client.claimSession({
      cwd: session.worktree,
      sessionId: session.sessionId,
      claims: declaration.claims,
    });
    return { session, declaration, evidence: { decisions, warnings: input.plan.claimGeneration.warnings } };
  } catch (error) {
    if (input.closeOnClaimFailure !== false)
      await input.client.closeSession({ cwd: session.worktree, sessionId: session.sessionId }).catch(() => undefined);
    throw error;
  }
}

/**
 * Recover the bounded create/claim phase after a caller crash. The session is
 * reused only when its immutable branch identity and complete claim boundary
 * match the declaration; unexpected claims fail closed.
 */
export async function resumeNawabariExecution(input: {
  client: NawabariExecutionClient;
  cwd: string;
  session: NawabariSession;
  branch: string;
  base?: string;
  plan: SemanticExecutionPlan;
}): Promise<NawabariStartResult> {
  const declaration = projectNawabariDeclaration({ plan: input.plan, branch: input.branch, base: input.base });
  if (input.session.state !== "active" || input.session.branch !== declaration.branch)
    throw new NawabariExecutionError(
      "nawabari-rejected",
      "Nawabari retry session does not match the active branch declaration",
      "OWNERSHIP_MISMATCH",
      input.session.raw,
    );
  const expected = new Set(declaration.claims.map(claimKey));
  const existingClaims = await input.client.listClaims({ cwd: input.cwd, sessionId: input.session.sessionId });
  const unexpected = existingClaims.filter((claim) => !expected.has(claimKey(claim)));
  if (unexpected.length > 0)
    throw new NawabariExecutionError(
      "nawabari-rejected",
      "Nawabari retry session contains claims outside the semantic execution plan",
      "OWNERSHIP_MISMATCH",
      unexpected,
    );
  const existing = new Set(existingClaims.map(claimKey));
  const missing = declaration.claims.filter((claim) => !existing.has(claimKey(claim)));
  const decisions = await input.client.claimSession({
    cwd: input.cwd,
    sessionId: input.session.sessionId,
    claims: missing,
  });
  return {
    session: input.session,
    declaration,
    evidence: { decisions, warnings: input.plan.claimGeneration.warnings },
  };
}
