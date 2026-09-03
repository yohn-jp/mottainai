import { runProgram, runProgramWithInput, type RunResult } from "./subprocess.js";

export type GhMakamiJsonPrimitive = string | number | boolean | null;
export type GhMakamiJsonValue = GhMakamiJsonPrimitive | GhMakamiJsonObject | readonly GhMakamiJsonValue[];
export interface GhMakamiJsonObject {
  readonly [key: string]: GhMakamiJsonValue;
}

export interface GhMakamiRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export type GhMakamiRepository = string | GhMakamiRepositoryIdentity;

/** 設定ファイルから解決する、外部gh-makami companionの実行境界。 */
export interface GhMakamiConfig {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export interface ResolvedGhMakamiConfig {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
}

export const DEFAULT_GH_MAKAMI_CONFIG: ResolvedGhMakamiConfig = Object.freeze({
  command: "gh-makami",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxInputBytes: 1_048_576,
});

export function resolveGhMakamiConfig(config: GhMakamiConfig | undefined): ResolvedGhMakamiConfig {
  const command = config?.command ?? DEFAULT_GH_MAKAMI_CONFIG.command;
  if (typeof command !== "string" || command.trim().length === 0)
    throw new RangeError("gh-makami command must not be empty");
  return {
    command,
    timeoutMs: positiveInteger(config?.timeoutMs, DEFAULT_GH_MAKAMI_CONFIG.timeoutMs, "timeoutMs"),
    maxOutputBytes: positiveInteger(config?.maxOutputBytes, DEFAULT_GH_MAKAMI_CONFIG.maxOutputBytes, "maxOutputBytes"),
    maxInputBytes: positiveInteger(config?.maxInputBytes, DEFAULT_GH_MAKAMI_CONFIG.maxInputBytes, "maxInputBytes"),
  };
}

/** The released public machine contract consumed by this adapter. */
export const GH_MAKAMI_MACHINE_CONTRACT = "gh-makami/contracts/v0" as const;
export const GH_MAKAMI_MINIMUM_VERSION = "0.1.0" as const;
export const GH_MAKAMI_SUPPORTED_VERSION = ">=0.1.0" as const;
export const GH_MAKAMI_SUPPORTED_OPERATIONS = Object.freeze(["status", "reconcile", "await"] as const);
export type GhMakamiOperation = (typeof GH_MAKAMI_SUPPORTED_OPERATIONS)[number];

export const GH_MAKAMI_REQUIRED_CAPABILITIES = Object.freeze([
  "pr-generation",
  "pr-reconciliation",
  "deterministic-json",
  "bounded-output",
] as const);
export type GhMakamiCapabilityId = (typeof GH_MAKAMI_REQUIRED_CAPABILITIES)[number];

export interface GhMakamiCapability {
  readonly id: string;
  readonly version: number;
  readonly stability: "stable" | "experimental";
  readonly description?: string;
}

export interface GhMakamiContract {
  readonly identifier: typeof GH_MAKAMI_MACHINE_CONTRACT;
  readonly package: {
    readonly name: "gh-makami";
    readonly version: string;
  };
  readonly capabilities: readonly GhMakamiCapability[];
}

export interface GhMakamiCapabilities {
  readonly command: string;
  readonly contract: typeof GH_MAKAMI_MACHINE_CONTRACT;
  readonly version: string;
  readonly capabilities: readonly GhMakamiCapability[];
  readonly operations: readonly GhMakamiOperation[];
}

export interface GhMakamiGeneration {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
}

export interface GhMakamiObservationRequest {
  readonly repository: GhMakamiRepository;
  /** `number` is accepted as an alias for callers using the gh-inari PR shape. */
  readonly prNumber?: number;
  readonly number?: number;
}

export interface GhMakamiReconcileRequest extends GhMakamiObservationRequest {
  /** The prior public Makami snapshot, passed as bounded JSON stdin. */
  readonly previous?: GhMakamiJsonObject;
}

export interface GhMakamiAwaitRequest extends GhMakamiObservationRequest {
  /** The starting public Makami snapshot/generation, required by await. */
  readonly previous?: GhMakamiJsonObject;
  readonly startingSnapshot?: GhMakamiJsonObject;
  readonly snapshot?: GhMakamiJsonObject;
}

/** Makami's detailed snapshot remains opaque to Mottainai. */
export interface GhMakamiStatusResult {
  readonly generation: GhMakamiGeneration;
  readonly snapshot: GhMakamiJsonObject;
}

/** Makami's normalized delta remains opaque to Mottainai. */
export interface GhMakamiReconcileResult {
  readonly generation: GhMakamiGeneration;
  readonly delta: GhMakamiJsonObject;
  readonly snapshot?: GhMakamiJsonObject;
}

/** Await returns the public Makami result without introducing a local state machine. */
export interface GhMakamiAwaitResult {
  readonly generation: GhMakamiGeneration;
  readonly result: GhMakamiJsonObject;
  readonly delta?: GhMakamiJsonObject;
  readonly snapshot?: GhMakamiJsonObject;
}

export type GhMakamiErrorCode =
  | "MAKAMI_INVALID_REQUEST"
  | "MAKAMI_INPUT_LIMIT"
  | "MAKAMI_COMPANION_MISSING"
  | "MAKAMI_COMPANION_INCOMPATIBLE"
  | "MAKAMI_CAPABILITY_UNAVAILABLE"
  | "MAKAMI_TIMEOUT"
  | "MAKAMI_OUTPUT_LIMIT"
  | "MAKAMI_MALFORMED_OUTPUT"
  | "MAKAMI_OPERATION_FAILED"
  | "MAKAMI_IDENTITY_MISMATCH"
  | "MAKAMI_REJECTED";

export interface GhMakamiRemoteError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: GhMakamiJsonValue;
  readonly diagnostics?: readonly GhMakamiJsonValue[];
}

export interface GhMakamiError {
  readonly code: GhMakamiErrorCode;
  readonly phase: "input" | "capability" | "operation";
  readonly operation?: GhMakamiOperation;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly remote?: GhMakamiRemoteError;
}

export type GhMakamiResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: GhMakamiError };

export interface GhMakamiProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input?: string;
}

export type GhMakamiProcess = (request: GhMakamiProcessRequest) => Promise<RunResult>;

export interface GhMakamiClientOptions extends GhMakamiConfig {
  cwd?: string;
  runner?: GhMakamiProcess;
}

/**
 * Narrow, read-only transport boundary for the released gh-makami contract.
 *
 * Repository and PR identity are required by every operation. The client does
 * not inspect process.cwd() to fill identity and never invokes `gh` directly.
 */
export class GhMakamiClient {
  readonly config: ResolvedGhMakamiConfig;
  private readonly cwd: string;
  private readonly runner: GhMakamiProcess;
  private cachedCapabilities: GhMakamiCapabilities | undefined;

  constructor(options: GhMakamiClientOptions = {}) {
    this.config = resolveGhMakamiConfig(options);
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

  async checkCapabilities(): Promise<GhMakamiResult<GhMakamiCapabilities>> {
    if (this.cachedCapabilities !== undefined) return { ok: true, value: this.cachedCapabilities };

    const result = await this.run(["--contract"]);
    const processError = processFailure(result, "capability", undefined, this.config);
    if (processError !== undefined) return { ok: false, error: withContractDetails(processError) };

    const payload = parsePayload(result.stdout);
    const contract = payload === undefined ? undefined : parseContract(payload);
    if (contract === undefined) {
      return {
        ok: false,
        error: capabilityError(
          "MAKAMI_COMPANION_INCOMPATIBLE",
          "gh-makami did not return the released machine contract.",
          { detectedContract: payload?.identifier === undefined ? "unknown" : summarize(String(payload.identifier)) },
        ),
      };
    }
    if (compareVersions(contract.package.version, GH_MAKAMI_MINIMUM_VERSION) < 0) {
      return {
        ok: false,
        error: capabilityError("MAKAMI_COMPANION_INCOMPATIBLE", "gh-makami version is not supported.", {
          detected: contract.package.version,
          required: GH_MAKAMI_SUPPORTED_VERSION,
          contract: GH_MAKAMI_MACHINE_CONTRACT,
        }),
      };
    }

    const missing = GH_MAKAMI_REQUIRED_CAPABILITIES.filter(
      (required) =>
        !contract.capabilities.some(
          (capability) => capability.id === required && capability.version === 0 && capability.stability === "stable",
        ),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        error: capabilityError(
          "MAKAMI_CAPABILITY_UNAVAILABLE",
          "gh-makami does not expose the required released capabilities.",
          {
            detected: contract.package.version,
            contract: GH_MAKAMI_MACHINE_CONTRACT,
            missing: missing.join(","),
            requiredCapabilities: GH_MAKAMI_REQUIRED_CAPABILITIES.join(","),
          },
        ),
      };
    }

    const capabilities: GhMakamiCapabilities = {
      command: this.config.command,
      contract: GH_MAKAMI_MACHINE_CONTRACT,
      version: contract.package.version,
      capabilities: contract.capabilities,
      operations: GH_MAKAMI_SUPPORTED_OPERATIONS,
    };
    this.cachedCapabilities = capabilities;
    return { ok: true, value: capabilities };
  }

  async status(request: GhMakamiObservationRequest): Promise<GhMakamiResult<GhMakamiStatusResult>> {
    const identity = normalizeIdentity(request);
    if (!identity.ok) return identity;
    return this.executeJson("status", operationArgs("status", identity.value), undefined, (payload) =>
      parseStatus(payload, identity.value),
    );
  }

  async getStatus(request: GhMakamiObservationRequest): Promise<GhMakamiResult<GhMakamiStatusResult>> {
    return this.status(request);
  }

  async reconcile(request: GhMakamiReconcileRequest): Promise<GhMakamiResult<GhMakamiReconcileResult>> {
    const identity = normalizeIdentity(request);
    if (!identity.ok) return identity;
    const previous = request.previous;
    const previousError = validatePreviousIdentity(previous, identity.value);
    if (previousError !== undefined) return { ok: false, error: previousError };
    const input = serializeInput(previous, this.config.maxInputBytes);
    if (!input.ok) return input;
    return this.executeJson(
      "reconcile",
      operationArgs("reconcile", identity.value, input.value !== undefined),
      input.value,
      (payload) => parseReconcile(payload, identity.value),
    );
  }

  async await(request: GhMakamiAwaitRequest): Promise<GhMakamiResult<GhMakamiAwaitResult>> {
    const identity = normalizeIdentity(request);
    if (!identity.ok) return identity;
    const previous = request.previous ?? request.startingSnapshot ?? request.snapshot;
    if (previous === undefined) return invalidRequest("gh-makami await requires a starting snapshot.", "previous");
    const previousError = validatePreviousIdentity(previous, identity.value);
    if (previousError !== undefined) return { ok: false, error: previousError };
    const input = serializeInput(previous, this.config.maxInputBytes);
    if (!input.ok) return input;
    return this.executeJson("await", operationArgs("await", identity.value, true), input.value, (payload) =>
      parseAwait(payload, identity.value),
    );
  }

  async awaitObservation(request: GhMakamiAwaitRequest): Promise<GhMakamiResult<GhMakamiAwaitResult>> {
    return this.await(request);
  }

  private async executeJson<Value>(
    operation: GhMakamiOperation,
    args: readonly string[],
    input: string | undefined,
    parse: (payload: GhMakamiJsonObject) => Value | GhMakamiError,
  ): Promise<GhMakamiResult<Value>> {
    const capabilities = await this.checkCapabilities();
    if (!capabilities.ok) return { ok: false, error: capabilities.error };

    const result = await this.run(args, input);
    const processError = processFailure(result, "operation", operation, this.config);
    if (processError !== undefined) {
      const remote = parseRemoteError(result.stdout);
      if (remote !== undefined) return rejectedError(operation, remote);
      if (result.exitCode !== 0 && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
        return { ok: false, error: processError };
      }
      if (result.timedOut || result.outputLimit || result.spawnError !== undefined)
        return { ok: false, error: processError };
      return {
        ok: false,
        error: malformedError(operation, "gh-makami exited without a valid bounded JSON error response.", result),
      };
    }

    const payload = parsePayload(result.stdout);
    if (payload === undefined) {
      return { ok: false, error: malformedError(operation, "gh-makami returned non-JSON or partial output.", result) };
    }
    const remote = parseRemoteError(payload);
    if (remote !== undefined) return rejectedError(operation, remote);
    const parsed = parse(payload);
    if (isGhMakamiError(parsed)) return { ok: false, error: parsed };
    return { ok: true, value: parsed };
  }

  private run(args: readonly string[], input?: string): Promise<RunResult> {
    return this.runner({
      args,
      cwd: this.cwd,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      ...(input === undefined ? {} : { input }),
    });
  }
}

function operationArgs(operation: GhMakamiOperation, identity: NormalizedIdentity, fromStdin = false): string[] {
  return [
    operation,
    "--repository",
    identity.repository,
    "--pr",
    String(identity.prNumber),
    ...(fromStdin ? ["--from", "-"] : []),
    "--json",
  ];
}

function parseStatus(payload: GhMakamiJsonObject, identity: NormalizedIdentity): GhMakamiStatusResult | GhMakamiError {
  const candidate = unwrapResult(payload, "snapshot");
  const generation = readGenerationFromPayload(candidate) ?? readGenerationFromPayload(payload);
  const identityError = validateGeneration(generation, identity);
  if (identityError !== undefined) return identityError;
  if (generation === undefined)
    return malformedError("status", "gh-makami status output is missing generation.", undefined);
  return { generation, snapshot: boundObject(candidate) };
}

function parseReconcile(
  payload: GhMakamiJsonObject,
  identity: NormalizedIdentity,
): GhMakamiReconcileResult | GhMakamiError {
  const delta = unwrapResult(payload, "delta");
  const generation = readGenerationFromPayload(delta) ?? readGenerationFromPayload(payload);
  const identityError = validateGeneration(generation, identity);
  if (identityError !== undefined) return identityError;
  if (generation === undefined)
    return malformedError("reconcile", "gh-makami reconcile output is missing generation.", undefined);
  const snapshot = isRecord(delta.snapshot) ? boundObject(delta.snapshot) : undefined;
  return { generation, delta: boundObject(delta), ...(snapshot === undefined ? {} : { snapshot }) };
}

function parseAwait(payload: GhMakamiJsonObject, identity: NormalizedIdentity): GhMakamiAwaitResult | GhMakamiError {
  const result = unwrapResult(payload, "result");
  const delta = isRecord(result.delta) ? boundObject(result.delta) : undefined;
  const snapshot = isRecord(result.snapshot) ? boundObject(result.snapshot) : undefined;
  const generation = readGenerationFromPayload(result) ?? readGenerationFromPayload(payload);
  const identityError = validateGeneration(generation, identity);
  if (identityError !== undefined) return identityError;
  if (generation === undefined)
    return malformedError("await", "gh-makami await output is missing generation.", undefined);
  return {
    generation,
    result: boundObject(result),
    ...(delta === undefined ? {} : { delta }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

function unwrapResult(payload: GhMakamiJsonObject, key: "snapshot" | "delta" | "result"): GhMakamiJsonObject {
  if (isRecord(payload[key])) return payload[key];
  if (isRecord(payload.value)) {
    if (isRecord(payload.value[key])) return payload.value[key];
    return payload.value;
  }
  if (isRecord(payload.result)) {
    if (isRecord(payload.result[key])) return payload.result[key];
    return payload.result;
  }
  return payload;
}

function readGenerationFromPayload(value: GhMakamiJsonObject | undefined): GhMakamiGeneration | undefined {
  if (value === undefined) return undefined;
  return (
    readGeneration(value) ??
    readGeneration(isRecord(value.snapshot) ? value.snapshot : undefined) ??
    readGeneration(isRecord(value.delta) ? value.delta : undefined) ??
    readGeneration(isRecord(value.result) ? value.result : undefined)
  );
}

function readGeneration(value: GhMakamiJsonObject | undefined): GhMakamiGeneration | undefined {
  if (value === undefined) return undefined;
  const candidate = isRecord(value.generation) ? value.generation : value;
  const repository = typeof candidate.repository === "string" ? repositoryName(candidate.repository) : undefined;
  const prNumber = positiveNumber(candidate.prNumber);
  const headSha = stringValue(candidate.headSha);
  if (repository === undefined || prNumber === undefined || headSha === undefined) return undefined;
  return { repository, prNumber, headSha };
}

function validateGeneration(
  generation: GhMakamiGeneration | undefined,
  identity: NormalizedIdentity,
): GhMakamiError | undefined {
  if (generation === undefined) return undefined;
  if (generation.repository !== identity.repository || generation.prNumber !== identity.prNumber) {
    return {
      code: "MAKAMI_IDENTITY_MISMATCH",
      phase: "operation",
      message: "gh-makami returned a result for a different repository or pull request.",
      retryable: false,
      details: {
        expectedRepository: identity.repository,
        expectedPrNumber: identity.prNumber,
        actualRepository: generation.repository,
        actualPrNumber: generation.prNumber,
      },
    };
  }
  return undefined;
}

function validatePreviousIdentity(
  previous: GhMakamiJsonObject | undefined,
  identity: NormalizedIdentity,
): GhMakamiError | undefined {
  if (previous === undefined) return undefined;
  const generation = readGenerationFromPayload(previous);
  if (generation === undefined) return undefined;
  if (generation.repository !== identity.repository || generation.prNumber !== identity.prNumber) {
    return {
      code: "MAKAMI_IDENTITY_MISMATCH",
      phase: "input",
      message: "the starting Makami snapshot belongs to a different repository or pull request.",
      retryable: false,
      details: {
        expectedRepository: identity.repository,
        expectedPrNumber: identity.prNumber,
        actualRepository: generation.repository,
        actualPrNumber: generation.prNumber,
      },
    };
  }
  return undefined;
}

interface NormalizedIdentity {
  readonly repository: string;
  readonly prNumber: number;
}

function normalizeIdentity(
  request: GhMakamiObservationRequest | undefined,
): { readonly ok: true; readonly value: NormalizedIdentity } | { readonly ok: false; readonly error: GhMakamiError } {
  const repository = normalizeRepository(request?.repository);
  if (repository === undefined) return invalidRequest("gh-makami repository identity is required.", "repository");
  const prNumber = request?.prNumber ?? request?.number;
  if (request?.prNumber !== undefined && request.number !== undefined && request.prNumber !== request.number)
    return invalidRequest("gh-makami pull-request identity is ambiguous.", "prNumber");
  if (prNumber === undefined || !Number.isSafeInteger(prNumber) || prNumber <= 0)
    return invalidRequest("gh-makami pull-request number must be a positive integer.", "prNumber");
  return { ok: true, value: { repository, prNumber } };
}

function normalizeRepository(value: GhMakamiRepository | undefined): string | undefined {
  if (typeof value === "string") return repositoryName(value);
  if (value !== undefined && stringValue(value.owner) !== undefined && stringValue(value.name) !== undefined)
    return repositoryName(`${value.owner}/${value.name}`);
  return undefined;
}

function repositoryName(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[^/\s]+\/[^/\s]+$/u.test(trimmed) ? trimmed : undefined;
}

function serializeInput(
  value: GhMakamiJsonObject | undefined,
  maxBytes: number,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: GhMakamiError } {
  if (value === undefined) return { ok: true, value: undefined };
  let serialized: string;
  try {
    serialized = stableStringify(value);
  } catch (error) {
    return invalidRequest(
      `gh-makami input is not valid JSON: ${summarize(error instanceof Error ? error.message : String(error))}`,
      "previous",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return {
      ok: false,
      error: {
        code: "MAKAMI_INPUT_LIMIT",
        phase: "input",
        message: "gh-makami input exceeded its bounded size.",
        retryable: false,
        details: { limitBytes: maxBytes },
      },
    };
  }
  return { ok: true, value: serialized };
}

function parseContract(payload: GhMakamiJsonObject): GhMakamiContract | undefined {
  if (payload.identifier !== GH_MAKAMI_MACHINE_CONTRACT || !isRecord(payload.package)) return undefined;
  if (payload.package.name !== "gh-makami" || typeof payload.package.version !== "string") return undefined;
  const version = parseVersion(payload.package.version);
  if (version === undefined || !Array.isArray(payload.capabilities)) return undefined;
  const capabilities: GhMakamiCapability[] = [];
  for (const value of payload.capabilities) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0
    )
      return undefined;
    if (value.stability !== "stable" && value.stability !== "experimental") return undefined;
    capabilities.push({
      id: value.id,
      version: value.version,
      stability: value.stability,
      ...(typeof value.description === "string" ? { description: boundText(value.description) } : {}),
    });
  }
  return { identifier: GH_MAKAMI_MACHINE_CONTRACT, package: { name: "gh-makami", version }, capabilities };
}

function parseVersion(value: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value.trim());
  return match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`;
}

function compareVersions(actual: string, minimum: string): number {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function processFailure(
  result: RunResult,
  phase: "capability" | "operation",
  operation: GhMakamiOperation | undefined,
  limits: ResolvedGhMakamiConfig,
): GhMakamiError | undefined {
  if (result.spawnError !== undefined) {
    const missing = /(?:ENOENT|not found|cannot find)/iu.test(result.spawnError);
    return makeError(
      missing ? "MAKAMI_COMPANION_MISSING" : "MAKAMI_OPERATION_FAILED",
      phase,
      missing ? "gh-makami companion executable was not found." : "gh-makami companion could not be started.",
      missing,
      { operation, summary: summarize(result.spawnError) },
    );
  }
  if (result.timedOut) {
    return makeError("MAKAMI_TIMEOUT", phase, "gh-makami companion exceeded its bounded timeout.", true, {
      operation,
      timeoutMs: limits.timeoutMs,
    });
  }
  if (result.outputLimit) {
    return makeError("MAKAMI_OUTPUT_LIMIT", phase, "gh-makami companion exceeded its bounded output limit.", false, {
      operation,
      limitBytes: limits.maxOutputBytes,
    });
  }
  if (result.exitCode !== 0) {
    return makeError(
      phase === "capability" ? "MAKAMI_COMPANION_INCOMPATIBLE" : "MAKAMI_OPERATION_FAILED",
      phase,
      phase === "capability"
        ? "gh-makami companion did not expose a compatible machine contract."
        : "gh-makami companion exited unsuccessfully.",
      false,
      { operation, exitCode: result.exitCode ?? -1, summary: summarize(result.stderr || result.stdout) },
    );
  }
  return undefined;
}

function parseRemoteError(value: string | GhMakamiJsonObject): GhMakamiRemoteError | undefined {
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
    ...(Array.isArray(payload.error.diagnostics)
      ? { diagnostics: payload.error.diagnostics.slice(0, 16).map((entry) => boundValue(entry)) }
      : {}),
  };
}

function parsePayload(output: string): GhMakamiJsonObject | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return isRecord(value) ? (value as GhMakamiJsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function rejectedError(operation: GhMakamiOperation, remote: GhMakamiRemoteError): GhMakamiResult<never> {
  return {
    ok: false,
    error: {
      code: "MAKAMI_REJECTED",
      phase: "operation",
      operation,
      message: remote.message,
      retryable: false,
      details: { upstreamCode: remote.code },
      remote,
    },
  };
}

function invalidRequest(message: string, field: string): GhMakamiResult<never> {
  return {
    ok: false,
    error: { code: "MAKAMI_INVALID_REQUEST", phase: "input", message, retryable: false, details: { field } },
  };
}

function capabilityError(
  code: "MAKAMI_COMPANION_INCOMPATIBLE" | "MAKAMI_CAPABILITY_UNAVAILABLE",
  message: string,
  details: Readonly<Record<string, string | number | boolean>>,
): GhMakamiError {
  return makeError(code, "capability", message, false, details);
}

function withContractDetails(error: GhMakamiError): GhMakamiError {
  return {
    ...error,
    details: {
      ...error.details,
      requiredVersion: GH_MAKAMI_SUPPORTED_VERSION,
      requiredContract: GH_MAKAMI_MACHINE_CONTRACT,
      requiredOperations: GH_MAKAMI_SUPPORTED_OPERATIONS.join(","),
      requiredCapabilities: GH_MAKAMI_REQUIRED_CAPABILITIES.join(","),
    },
  };
}

function malformedError(operation: GhMakamiOperation, message: string, result: RunResult | undefined): GhMakamiError {
  return makeError("MAKAMI_MALFORMED_OUTPUT", "operation", message, false, {
    operation,
    ...(result === undefined ? {} : { summary: summarize(result.stdout || result.stderr) }),
  });
}

function makeError(
  code: GhMakamiErrorCode,
  phase: "input" | "capability" | "operation",
  message: string,
  retryable: boolean,
  details: Readonly<Record<string, string | number | boolean | undefined>>,
): GhMakamiError {
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

function isGhMakamiError(value: unknown): value is GhMakamiError {
  return typeof value === "object" && value !== null && "code" in value && String(value.code).startsWith("MAKAMI_");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`gh-makami ${name} must be a positive integer`);
  return value;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : undefined;
}

function summarize(value: string): string {
  return boundText(value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim());
}

function boundText(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}

function boundObject(value: Record<string, unknown>): GhMakamiJsonObject {
  return boundValue(value) as GhMakamiJsonObject;
}

function boundValue(value: unknown, depth = 0): GhMakamiJsonValue {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundText(value);
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => boundValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, GhMakamiJsonValue> = {};
    for (const [key, child] of Object.entries(value).slice(0, 64)) out[boundText(key)] = boundValue(child, depth + 1);
    return out;
  }
  return "[unsupported]";
}

function stableStringify(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("value is not JSON serializable");
  if (ancestors.has(value)) throw new Error("cyclic values are not JSON serializable");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
    throw new Error("value must be a plain JSON object");
  ancestors.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => stableStringify(entry, ancestors)).join(",")}]`;
  } else {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    serialized = `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry, ancestors)}`)
      .join(",")}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
