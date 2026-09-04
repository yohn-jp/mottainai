import { runProgram, runProgramWithInput, type RunResult } from "./subprocess.js";

export type GhInariJsonPrimitive = string | number | boolean | null;
export type GhInariJsonValue = GhInariJsonPrimitive | GhInariJsonObject | GhInariJsonValue[];
export interface GhInariJsonObject {
  readonly [key: string]: GhInariJsonValue;
}

export interface GhInariRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export type GhInariRepository = string | GhInariRepositoryIdentity;

/** 設定ファイルから解決する、外部gh-inari companionの実行境界。 */
export interface GhInariConfig {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export interface ResolvedGhInariConfig {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
}

export const DEFAULT_GH_INARI_CONFIG: ResolvedGhInariConfig = Object.freeze({
  command: "gh-inari",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxInputBytes: 1_048_576,
});

export function resolveGhInariConfig(config: GhInariConfig | undefined): ResolvedGhInariConfig {
  const command = config?.command ?? DEFAULT_GH_INARI_CONFIG.command;
  if (typeof command !== "string" || command.trim().length === 0)
    throw new RangeError("gh-inari command must not be empty");
  return {
    command,
    timeoutMs: positiveInteger(config?.timeoutMs, DEFAULT_GH_INARI_CONFIG.timeoutMs, "timeoutMs"),
    maxOutputBytes: positiveInteger(config?.maxOutputBytes, DEFAULT_GH_INARI_CONFIG.maxOutputBytes, "maxOutputBytes"),
    maxInputBytes: positiveInteger(config?.maxInputBytes, DEFAULT_GH_INARI_CONFIG.maxInputBytes, "maxInputBytes"),
  };
}

/** Minimum companion release for the versioned machine contract consumed here. */
export const GH_INARI_MINIMUM_VERSION = "0.7.0" as const;
export const GH_INARI_SUPPORTED_VERSION = ">=0.7.0" as const;
export const GH_INARI_SUPPORTED_OPERATIONS = Object.freeze(["issue.get", "pr.create", "pr.get"] as const);
export type GhInariOperation = (typeof GH_INARI_SUPPORTED_OPERATIONS)[number];
export const GH_INARI_REQUIRED_OPTIONS = Object.freeze(["--from", "--json", "--repository", "--template"] as const);
export type GhInariOption = (typeof GH_INARI_REQUIRED_OPTIONS)[number];

export interface GhInariCapabilities {
  readonly command: string;
  readonly version: string;
  readonly operations: readonly GhInariOperation[];
  readonly options: readonly GhInariOption[];
}

export interface GhInariPullRequestInput {
  readonly fields: GhInariJsonObject;
  readonly title?: string;
  readonly head: string;
  readonly base: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export interface GhInariCreatePullRequestRequest {
  readonly repository: GhInariRepository;
  readonly input: GhInariPullRequestInput;
  readonly template?: string;
}

export interface GhInariGetPullRequestRequest {
  readonly repository: GhInariRepository;
  readonly number: number;
  readonly template?: string;
}

export interface GhInariGetIssueRequest {
  readonly repository: GhInariRepository;
  readonly number: number;
  readonly template?: string;
}

export type GhInariArtifactClassification = "valid" | "semantic" | "wrong-template" | "unparseable" | "ambiguous";
export type GhInariArtifactProjection = "canonical" | "unavailable";

/** Stable template identity returned by gh-inari's governed read contract. */
export interface GhInariTemplateIdentity {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "issue_form" | "pull_request_template";
}

export interface GhInariIssueReadMetadata {
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface GhInariPullRequestReadMetadata {
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly head: string;
  readonly base: string;
  readonly maintainerCanModify?: boolean;
}

interface GhInariGovernedReadBase {
  readonly valid: boolean;
  readonly projection: GhInariArtifactProjection;
  readonly classification: GhInariArtifactClassification;
  /** Normalized request identity; never inferred from the companion cwd. */
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly template?: GhInariTemplateIdentity;
  readonly fields?: GhInariJsonObject;
  readonly dependencies?: GhInariJsonObject;
  readonly diagnostics: readonly GhInariJsonValue[];
  readonly violations?: readonly GhInariJsonValue[];
  readonly attemptedTemplates?: readonly string[];
  /** Optional future provenance fields are retained only when gh-inari supplies them. */
  readonly provenance?: GhInariJsonObject;
}

export interface GhInariIssueReadResult extends GhInariGovernedReadBase {
  readonly kind: "issue";
  readonly metadata: GhInariIssueReadMetadata;
}

export interface GhInariPullRequestReadResult extends GhInariGovernedReadBase {
  readonly kind: "pull_request";
  readonly metadata: GhInariPullRequestReadMetadata;
}

/** Provider identity and canonical semantic projection; native Markdown is never returned. */
/** @deprecated Use GhInariPullRequestReadResult. */
export interface GhInariPullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly title?: string;
  readonly state?: string;
  readonly draft?: boolean;
  readonly head?: string;
  readonly base?: string;
}

export type GhInariErrorCode =
  | "INARI_INVALID_REQUEST"
  | "INARI_INPUT_LIMIT"
  | "INARI_COMPANION_MISSING"
  | "INARI_COMPANION_INCOMPATIBLE"
  | "INARI_CAPABILITY_UNAVAILABLE"
  | "INARI_TIMEOUT"
  | "INARI_OUTPUT_LIMIT"
  | "INARI_MALFORMED_OUTPUT"
  | "INARI_OPERATION_FAILED"
  | "INARI_REJECTED";

export interface GhInariRemoteError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: GhInariJsonValue;
  readonly violations?: readonly GhInariJsonValue[];
}

export interface GhInariError {
  readonly code: GhInariErrorCode;
  readonly phase: "input" | "capability" | "operation";
  readonly operation?: GhInariOperation;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly remote?: GhInariRemoteError;
}

export type GhInariResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: GhInariError };

export interface GhInariProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input?: string;
}

export type GhInariProcess = (request: GhInariProcessRequest) => Promise<RunResult>;

export interface GhInariClientOptions extends GhInariConfig {
  cwd?: string;
  runner?: GhInariProcess;
}

/**
 * Narrow transport boundary for the gh-inari companion.
 *
 * Repository identity is required by every operation. The client never invokes
 * the direct `gh` CLI and never retries through another mutation authority.
 */
export class GhInariClient {
  readonly config: ResolvedGhInariConfig;
  private readonly cwd: string;
  private readonly runner: GhInariProcess;
  private cachedCapabilities: GhInariCapabilities | undefined;

  constructor(options: GhInariClientOptions = {}) {
    this.config = resolveGhInariConfig(options);
    this.cwd = options.cwd ?? process.cwd();
    this.runner =
      options.runner ??
      ((request) => {
        if (request.input === undefined) {
          return runProgram(
            this.config.command,
            [...request.args],
            request.cwd,
            request.timeoutMs,
            request.maxOutputBytes,
          );
        }
        return runProgramWithInput(
          this.config.command,
          [...request.args],
          request.cwd,
          request.timeoutMs,
          request.maxOutputBytes,
          request.input,
        );
      });
  }

  async checkCapabilities(): Promise<GhInariResult<GhInariCapabilities>> {
    if (this.cachedCapabilities !== undefined) return { ok: true, value: this.cachedCapabilities };

    const versionResult = await this.run(["--version"]);
    const versionFailure = processFailure(versionResult, "capability", undefined, this.config);
    if (versionFailure !== undefined) return { ok: false, error: withContractDetails(versionFailure) };

    const version = parseVersion(versionResult.stdout);
    if (version === undefined) {
      return {
        ok: false,
        error: capabilityError(
          "INARI_COMPANION_INCOMPATIBLE",
          "gh-inari did not return a compatible machine-readable version.",
          { detected: "unknown", output: summarize(versionResult.stdout || versionResult.stderr) },
        ),
      };
    }
    if (!isSupportedVersion(version)) {
      return {
        ok: false,
        error: capabilityError("INARI_COMPANION_INCOMPATIBLE", "gh-inari version is not supported.", {
          detected: version,
          required: GH_INARI_SUPPORTED_VERSION,
          minimumVersion: GH_INARI_MINIMUM_VERSION,
        }),
      };
    }

    const helpResult = await this.run(["--help=full"]);
    const helpFailure = processFailure(helpResult, "capability", undefined, this.config);
    if (helpFailure !== undefined) return { ok: false, error: withContractDetails(helpFailure) };

    const operations = GH_INARI_SUPPORTED_OPERATIONS.filter((operation) =>
      hasHelpOperation(helpResult.stdout, operation),
    );
    const options = GH_INARI_REQUIRED_OPTIONS.filter((option) => hasHelpOption(helpResult.stdout, option));
    const missingOptions = GH_INARI_REQUIRED_OPTIONS.filter((option) => !options.includes(option));
    if (missingOptions.length > 0) {
      return {
        ok: false,
        error: capabilityError(
          "INARI_CAPABILITY_UNAVAILABLE",
          "gh-inari does not expose the required machine contract options.",
          {
            detected: version,
            missing: missingOptions.join(","),
            requiredOptions: GH_INARI_REQUIRED_OPTIONS.join(","),
          },
        ),
      };
    }

    const capabilities: GhInariCapabilities = {
      command: this.config.command,
      version,
      operations,
      options,
    };
    this.cachedCapabilities = capabilities;
    return { ok: true, value: capabilities };
  }

  async createPullRequest(request: GhInariCreatePullRequestRequest): Promise<GhInariResult<GhInariPullRequestResult>> {
    const normalized = normalizeCreateRequest(request);
    if (!normalized.ok) return normalized;
    const input = serializeInput(normalized.value.input, this.config.maxInputBytes);
    if (!input.ok) return input;
    return this.executeJson(
      "pr.create",
      [
        "pr",
        "create",
        "--repository",
        normalized.value.repository,
        "--from",
        "-",
        "--json",
        ...templateArgs(normalized.value.template),
      ],
      input.value,
      parseCreatedPullRequest,
    );
  }

  async getPullRequest(request: GhInariGetPullRequestRequest): Promise<GhInariResult<GhInariPullRequestReadResult>> {
    const normalized = normalizeGetRequest(request);
    if (!normalized.ok) return normalized;
    const result = await this.executeJson(
      "pr.get",
      [
        "pr",
        "get",
        String(normalized.value.number),
        "--repository",
        normalized.value.repository,
        "--json",
        ...templateArgs(normalized.value.template),
      ],
      undefined,
      parsePullRequestRead,
      { acceptValidationResult: true },
    );
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, repository: normalized.value.repository } };
  }

  async getIssue(request: GhInariGetIssueRequest): Promise<GhInariResult<GhInariIssueReadResult>> {
    const normalized = normalizeGetRequest(request);
    if (!normalized.ok) return normalized;
    const result = await this.executeJson(
      "issue.get",
      [
        "issue",
        "get",
        String(normalized.value.number),
        "--repository",
        normalized.value.repository,
        "--json",
        ...templateArgs(normalized.value.template),
      ],
      undefined,
      parseIssueRead,
      { acceptValidationResult: true },
    );
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, repository: normalized.value.repository } };
  }

  private async executeJson<Value>(
    operation: GhInariOperation,
    args: readonly string[],
    input: string | undefined,
    parse: (payload: GhInariJsonObject) => Value | GhInariError,
    options: { readonly acceptValidationResult?: boolean } = {},
  ): Promise<GhInariResult<Value>> {
    const capabilities = await this.checkCapabilities();
    if (!capabilities.ok) return { ok: false, error: capabilities.error };
    if (!capabilities.value.operations.includes(operation)) {
      return {
        ok: false,
        error: capabilityError(
          "INARI_CAPABILITY_UNAVAILABLE",
          `gh-inari does not support ${operation}.`,
          {
            version: capabilities.value.version,
            operation,
          },
          operation,
        ),
      };
    }

    const result = await this.run(args, input);
    const processError = processFailure(result, "operation", operation, this.config);
    if (processError !== undefined) {
      const remote = parseRemoteError(result.stdout);
      if (remote !== undefined) return rejectedError(operation, remote);
      if (options.acceptValidationResult === true && result.exitCode === 2) {
        const payload = parsePayload(result.stdout);
        if (payload !== undefined) {
          const parsed = parse(payload);
          if (!isGhInariError(parsed) && isUnavailableReadResult(parsed)) return { ok: true, value: parsed };
        }
      }
      if (result.exitCode !== 0 && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
        return { ok: false, error: processError };
      }
      if (result.timedOut || result.outputLimit || result.spawnError !== undefined)
        return { ok: false, error: processError };
      return {
        ok: false,
        error: malformedError(operation, "gh-inari exited without a valid bounded JSON error response.", result),
      };
    }

    const payload = parsePayload(result.stdout);
    if (payload === undefined) {
      return { ok: false, error: malformedError(operation, "gh-inari returned non-JSON or partial output.", result) };
    }
    const remote = parseRemoteError(payload);
    if (remote !== undefined) return rejectedError(operation, remote);
    const parsed = parse(payload);
    if (isGhInariError(parsed)) return { ok: false, error: parsed };
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: operationError(operation, "gh-inari rejected the operation without a structured error.", result),
      };
    }
    return { ok: true, value: parsed };
  }

  private run(args: readonly string[], input?: string): Promise<RunResult> {
    return this.runner({
      args,
      cwd: this.cwd,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      input,
    });
  }
}

function normalizeCreateRequest(
  request: GhInariCreatePullRequestRequest,
): GhInariResult<{ repository: string; input: GhInariPullRequestInput; template?: string }> {
  if (!isRecord(request)) return invalidRequest("create requires a request object.", "request");
  const repository = normalizeRepository(request?.repository);
  if (repository === undefined)
    return invalidRequest("create requires an explicit repository owner/name.", "repository");
  if (!isRecord(request.input) || !isRecord(request.input.fields)) {
    return invalidRequest("create requires a JSON object in input.fields.", "input.fields");
  }
  if (!nonEmptyString(request.input.head) || !nonEmptyString(request.input.base)) {
    return invalidRequest("create requires non-empty input.head and input.base.", "input");
  }
  if (request.template !== undefined && !nonEmptyString(request.template)) {
    return invalidRequest("template must be a non-empty string when provided.", "template");
  }
  return {
    ok: true,
    value: {
      repository,
      input: request.input,
      ...(request.template === undefined ? {} : { template: request.template }),
    },
  };
}

function normalizeGetRequest(
  request: GhInariGetPullRequestRequest,
): GhInariResult<{ repository: string; number: number; template?: string }> {
  if (!isRecord(request)) return invalidRequest("get requires a request object.", "request");
  const repository = normalizeRepository(request?.repository);
  if (repository === undefined) return invalidRequest("get requires an explicit repository owner/name.", "repository");
  if (!Number.isSafeInteger(request.number) || request.number <= 0) {
    return invalidRequest("get requires a positive Issue/Pull Request number.", "number");
  }
  if (request.template !== undefined && !nonEmptyString(request.template)) {
    return invalidRequest("template must be a non-empty string when provided.", "template");
  }
  return {
    ok: true,
    value: {
      repository,
      number: request.number,
      ...(request.template === undefined ? {} : { template: request.template }),
    },
  };
}

function serializeInput(input: GhInariPullRequestInput, maxInputBytes: number): GhInariResult<string> {
  try {
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, "utf8") > maxInputBytes) {
      return {
        ok: false,
        error: {
          code: "INARI_INPUT_LIMIT",
          phase: "input",
          message: "gh-inari JSON input exceeded the configured byte limit.",
          retryable: false,
          details: { limitBytes: maxInputBytes },
        },
      };
    }
    return { ok: true, value: serialized };
  } catch {
    return invalidRequest("create input is not JSON serializable.", "input");
  }
}

function parseCreatedPullRequest(payload: GhInariJsonObject): GhInariPullRequestResult | GhInariError {
  if (payload.ok !== true || !isRecord(payload.artifact)) {
    return malformedError("pr.create", "gh-inari success output did not contain artifact.", undefined);
  }
  const artifact = payload.artifact;
  const number = positiveNumber(artifact.number);
  const url = stringValue(artifact.url);
  if (number === undefined || url === undefined) {
    return malformedError("pr.create", "gh-inari artifact is missing a valid number or url.", undefined);
  }
  return {
    number,
    url: boundText(url),
    ...(typeof artifact.title === "string" ? { title: boundText(artifact.title) } : {}),
    ...(typeof artifact.state === "string" ? { state: boundText(artifact.state) } : {}),
    ...(typeof artifact.draft === "boolean" ? { draft: artifact.draft } : {}),
    ...(typeof artifact.head === "string" ? { head: boundText(artifact.head) } : {}),
    ...(typeof artifact.base === "string" ? { base: boundText(artifact.base) } : {}),
  };
}

type GhInariIssueReadPayload = Omit<GhInariIssueReadResult, "repository">;
type GhInariPullRequestReadPayload = Omit<GhInariPullRequestReadResult, "repository">;

function parseIssueRead(payload: GhInariJsonObject): GhInariIssueReadPayload | GhInariError {
  const common = parseGovernedRead(payload, "issue", "issue.get");
  if (!common.ok) return common.error;
  const metadata = parseIssueReadMetadata(payload.metadata);
  if (metadata === undefined)
    return malformedError("issue.get", "gh-inari Issue result has invalid metadata.", undefined);
  return { ...common.value, kind: "issue", metadata };
}

function parsePullRequestRead(payload: GhInariJsonObject): GhInariPullRequestReadPayload | GhInariError {
  const common = parseGovernedRead(payload, "pull_request", "pr.get");
  if (!common.ok) return common.error;
  const metadata = parsePullRequestReadMetadata(payload.metadata);
  if (metadata === undefined)
    return malformedError("pr.get", "gh-inari pull-request result has invalid metadata.", undefined);
  return { ...common.value, kind: "pull_request", metadata };
}

function parseGovernedRead(
  payload: GhInariJsonObject,
  kind: "issue" | "pull_request",
  operation: "issue.get" | "pr.get",
):
  | {
      ok: true;
      value:
        | Omit<GhInariIssueReadResult, "kind" | "metadata" | "repository">
        | Omit<GhInariPullRequestReadResult, "kind" | "metadata" | "repository">;
    }
  | { ok: false; error: GhInariError } {
  if (typeof payload.valid !== "boolean")
    return { ok: false, error: malformedError(operation, "gh-inari read output is missing valid.", undefined) };
  if (payload.kind !== kind)
    return { ok: false, error: malformedError(operation, `gh-inari read output is not a ${kind} result.`, undefined) };
  if (payload.projection !== "canonical" && payload.projection !== "unavailable")
    return { ok: false, error: malformedError(operation, "gh-inari read output has invalid projection.", undefined) };
  const classification = artifactClassification(payload.classification);
  if (classification === undefined)
    return {
      ok: false,
      error: malformedError(operation, "gh-inari read output has invalid classification.", undefined),
    };
  if (payload.valid !== (classification === "valid" && payload.projection === "canonical")) {
    return {
      ok: false,
      error: malformedError(operation, "gh-inari read output has inconsistent validity.", undefined),
    };
  }
  const number = positiveNumber(payload.number);
  const url = stringValue(payload.url);
  if (number === undefined || url === undefined)
    return {
      ok: false,
      error: malformedError(operation, "gh-inari read output is missing artifact identity.", undefined),
    };
  const template = parseTemplateIdentity(payload.template, kind);
  if (payload.template !== undefined && template === undefined)
    return {
      ok: false,
      error: malformedError(operation, "gh-inari read output has invalid template identity.", undefined),
    };
  if (payload.valid && template === undefined)
    return {
      ok: false,
      error: malformedError(operation, "gh-inari canonical read output is missing template identity.", undefined),
    };
  if (!Array.isArray(payload.diagnostics))
    return { ok: false, error: malformedError(operation, "gh-inari read output is missing diagnostics.", undefined) };
  const fields =
    payload.fields === undefined ? undefined : isRecord(payload.fields) ? boundObject(payload.fields) : null;
  if (fields === null || (payload.valid && fields === undefined))
    return { ok: false, error: malformedError(operation, "gh-inari read output has invalid fields.", undefined) };
  const dependencies =
    payload.dependencies === undefined
      ? undefined
      : isRecord(payload.dependencies)
        ? boundObject(payload.dependencies)
        : null;
  if (dependencies === null)
    return { ok: false, error: malformedError(operation, "gh-inari read output has invalid dependencies.", undefined) };
  const violations =
    payload.violations === undefined
      ? undefined
      : Array.isArray(payload.violations)
        ? payload.violations.slice(0, 16).map((value) => boundValue(value))
        : null;
  if (violations === null)
    return { ok: false, error: malformedError(operation, "gh-inari read output has invalid violations.", undefined) };
  const attemptedTemplates =
    payload.attemptedTemplates === undefined ? undefined : parseStringArray(payload.attemptedTemplates);
  if (payload.attemptedTemplates !== undefined && attemptedTemplates === undefined)
    return {
      ok: false,
      error: malformedError(operation, "gh-inari read output has invalid attempted templates.", undefined),
    };
  const provenance =
    payload.provenance === undefined
      ? undefined
      : isRecord(payload.provenance)
        ? boundObject(payload.provenance)
        : null;
  if (provenance === null)
    return { ok: false, error: malformedError(operation, "gh-inari read output has invalid provenance.", undefined) };
  return {
    ok: true,
    value: {
      valid: payload.valid,
      projection: payload.projection,
      classification,
      number,
      url: boundText(url),
      ...(template === undefined ? {} : { template }),
      ...(payload.valid && fields !== undefined ? { fields } : {}),
      ...(payload.valid && dependencies !== undefined ? { dependencies } : {}),
      diagnostics: payload.diagnostics.slice(0, 16).map((value) => boundValue(value)),
      ...(violations === undefined ? {} : { violations }),
      ...(attemptedTemplates === undefined ? {} : { attemptedTemplates }),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
}

function artifactClassification(value: unknown): GhInariArtifactClassification | undefined {
  return value === "valid" ||
    value === "semantic" ||
    value === "wrong-template" ||
    value === "unparseable" ||
    value === "ambiguous"
    ? value
    : undefined;
}

function parseTemplateIdentity(value: unknown, kind: "issue" | "pull_request"): GhInariTemplateIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const path = stringValue(value.path);
  const source = value.source;
  if (id === undefined || name === undefined || path === undefined) return undefined;
  if (kind === "issue" && source !== "issue_form") return undefined;
  if (kind === "pull_request" && source !== "pull_request_template") return undefined;
  return {
    id: boundText(id),
    name: boundText(name),
    path: boundText(path),
    source: source as "issue_form" | "pull_request_template",
  };
}

function parseIssueReadMetadata(value: unknown): GhInariIssueReadMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const title = stringValue(value.title);
  const state = stringValue(value.state);
  const labels = parseStringArray(value.labels);
  const assignees = parseStringArray(value.assignees);
  if (title === undefined || state === undefined || labels === undefined || assignees === undefined) return undefined;
  return { title: boundText(title), state: boundText(state), labels, assignees };
}

function parsePullRequestReadMetadata(value: unknown): GhInariPullRequestReadMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const title = stringValue(value.title);
  const state = stringValue(value.state);
  const head = stringValue(value.head);
  const base = stringValue(value.base);
  if (
    title === undefined ||
    state === undefined ||
    head === undefined ||
    base === undefined ||
    typeof value.draft !== "boolean"
  )
    return undefined;
  if (value.maintainerCanModify !== undefined && typeof value.maintainerCanModify !== "boolean") return undefined;
  return {
    title: boundText(title),
    state: boundText(state),
    draft: value.draft,
    head: boundText(head),
    base: boundText(base),
    ...(value.maintainerCanModify === undefined ? {} : { maintainerCanModify: value.maintainerCanModify }),
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0))
    return undefined;
  return value.slice(0, 32).map((item) => boundText(item));
}

function isUnavailableReadResult(
  value: unknown,
): value is { readonly valid: false; readonly projection: "unavailable" } {
  return isRecord(value) && value.valid === false && value.projection === "unavailable";
}

function processFailure(
  result: RunResult,
  phase: "capability" | "operation",
  operation?: GhInariOperation,
  limits?: Pick<ResolvedGhInariConfig, "timeoutMs" | "maxOutputBytes">,
): GhInariError | undefined {
  if (result.spawnError !== undefined) {
    const missing = /(?:ENOENT|not found|cannot find)/iu.test(result.spawnError);
    return makeError(
      missing ? "INARI_COMPANION_MISSING" : "INARI_OPERATION_FAILED",
      phase,
      missing ? "gh-inari companion executable was not found." : "gh-inari companion could not be started.",
      missing,
      { operation, summary: summarize(result.spawnError) },
    );
  }
  if (result.timedOut) {
    return makeError("INARI_TIMEOUT", phase, "gh-inari companion exceeded its bounded timeout.", true, {
      operation,
      timeoutMs: limits?.timeoutMs ?? 0,
    });
  }
  if (result.outputLimit) {
    return makeError("INARI_OUTPUT_LIMIT", phase, "gh-inari companion exceeded its bounded output limit.", false, {
      operation,
      limitBytes: limits?.maxOutputBytes ?? 0,
    });
  }
  if (result.exitCode !== 0) {
    return makeError(
      phase === "capability" ? "INARI_COMPANION_INCOMPATIBLE" : "INARI_OPERATION_FAILED",
      phase,
      phase === "capability"
        ? "gh-inari companion did not expose a compatible capability contract."
        : "gh-inari companion exited unsuccessfully.",
      false,
      {
        operation,
        exitCode: result.exitCode ?? -1,
        summary: summarize(result.stderr || result.stdout),
      },
    );
  }
  return undefined;
}

function parseRemoteError(value: string | GhInariJsonObject): GhInariRemoteError | undefined {
  const payload = typeof value === "string" ? parsePayload(value) : value;
  if (payload === undefined || payload.ok !== false || !isRecord(payload.error)) return undefined;
  const code = stringValue(payload.error.code);
  const message = stringValue(payload.error.message);
  if (code === undefined || message === undefined) return undefined;
  return {
    code: boundText(code),
    message: boundText(message),
    ...(stringValue(payload.error.path) === undefined ? {} : { path: boundText(stringValue(payload.error.path)!) }),
    ...(payload.error.details === undefined ? {} : { details: boundValue(payload.error.details) }),
    ...(Array.isArray(payload.error.violations)
      ? { violations: payload.error.violations.slice(0, 16).map((value) => boundValue(value)) }
      : {}),
  };
}

function parsePayload(output: string): GhInariJsonObject | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return isRecord(value) ? (value as GhInariJsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function rejectedError(operation: GhInariOperation, remote: GhInariRemoteError): GhInariResult<never> {
  return {
    ok: false,
    error: {
      code: "INARI_REJECTED",
      phase: "operation",
      operation,
      message: remote.message,
      retryable: false,
      details: { upstreamCode: remote.code },
      remote,
    },
  };
}

function invalidRequest(message: string, field: string): GhInariResult<never> {
  return {
    ok: false,
    error: { code: "INARI_INVALID_REQUEST", phase: "input", message, retryable: false, details: { field } },
  };
}

function capabilityError(
  code: "INARI_COMPANION_INCOMPATIBLE" | "INARI_CAPABILITY_UNAVAILABLE",
  message: string,
  details: Readonly<Record<string, string | number | boolean>>,
  operation?: GhInariOperation,
): GhInariError {
  return makeError(code, "capability", message, false, { ...details, operation });
}

function withContractDetails(error: GhInariError): GhInariError {
  return {
    ...error,
    details: {
      ...error.details,
      requiredVersion: GH_INARI_SUPPORTED_VERSION,
      requiredOperations: GH_INARI_SUPPORTED_OPERATIONS.join(","),
      requiredOptions: GH_INARI_REQUIRED_OPTIONS.join(","),
    },
  };
}

function operationError(operation: GhInariOperation, message: string, result: RunResult): GhInariError {
  return makeError("INARI_OPERATION_FAILED", "operation", message, false, {
    operation,
    exitCode: result.exitCode ?? -1,
    summary: summarize(result.stderr || result.stdout),
  });
}

function malformedError(operation: GhInariOperation, message: string, result: RunResult | undefined): GhInariError {
  return makeError("INARI_MALFORMED_OUTPUT", "operation", message, false, {
    operation,
    ...(result === undefined ? {} : { summary: summarize(result.stdout || result.stderr) }),
  });
}

function makeError(
  code: GhInariErrorCode,
  phase: "input" | "capability" | "operation",
  message: string,
  retryable: boolean,
  details: Readonly<Record<string, string | number | boolean | undefined>>,
): GhInariError {
  return {
    code,
    phase,
    message,
    retryable,
    details: Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as Readonly<
      Record<string, string | number | boolean>
    >,
  };
}

function isGhInariError(value: unknown): value is GhInariError {
  return typeof value === "object" && value !== null && "code" in value && String(value.code).startsWith("INARI_");
}

function normalizeRepository(value: GhInariRepository | undefined): string | undefined {
  if (typeof value === "string") return repositoryName(value);
  if (value !== undefined && nonEmptyString(value.owner) && nonEmptyString(value.name)) {
    return repositoryName(`${value.owner}/${value.name}`);
  }
  return undefined;
}

function repositoryName(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[^/\s]+\/[^/\s]+$/u.test(trimmed) ? trimmed : undefined;
}

function templateArgs(template: string | undefined): string[] {
  return template === undefined ? [] : ["--template", template];
}

function parseVersion(output: string): string | undefined {
  const match = /^\s*gh-inari\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\s*$/u.exec(output);
  return match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`;
}

function isSupportedVersion(version: string): boolean {
  return compareVersions(version, GH_INARI_MINIMUM_VERSION) >= 0;
}

function hasHelpOperation(output: string, operation: GhInariOperation): boolean {
  const [domain, command] = operation.split(".");
  return new RegExp(`^\\s*${domain}\\s+${command}(?:\\s|$)`, "mu").test(output);
}

function hasHelpOption(output: string, option: GhInariOption): boolean {
  return new RegExp(`(?:^|\\s)${option}(?:\\s|$)`, "mu").test(output);
}

function compareVersions(actual: string, minimum: string): number {
  const actualParts = actual.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`gh-inari ${name} must be a positive integer`);
  return value;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

function summarize(value: string): string {
  return boundText(value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim());
}

function boundText(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}

function boundObject(value: Record<string, unknown>): GhInariJsonObject {
  return boundValue(value) as GhInariJsonObject;
}

function boundValue(value: unknown, depth = 0): GhInariJsonValue {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundText(value);
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => boundValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, GhInariJsonValue> = {};
    for (const [key, child] of Object.entries(value).slice(0, 32)) out[boundText(key)] = boundValue(child, depth + 1);
    return out;
  }
  return "[unsupported]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
