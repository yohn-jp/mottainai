import { runProgram, runProgramWithInput, type RunResult } from "./subprocess.js";

export type SuzukuriJsonPrimitive = string | number | boolean | null;
export type SuzukuriJsonValue = SuzukuriJsonPrimitive | SuzukuriJsonObject | SuzukuriJsonValue[];
export interface SuzukuriJsonObject {
  readonly [key: string]: SuzukuriJsonValue;
}

/** Configuration for the managed Suzukuri companion process. */
export interface SuzukuriConfig {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export interface ResolvedSuzukuriConfig {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
}

export const DEFAULT_SUZUKURI_CONFIG: ResolvedSuzukuriConfig = Object.freeze({
  command: "suzukuri",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxInputBytes: 1_048_576,
});

export function resolveSuzukuriConfig(config: SuzukuriConfig | undefined): ResolvedSuzukuriConfig {
  const command = config?.command ?? DEFAULT_SUZUKURI_CONFIG.command;
  if (typeof command !== "string" || command.trim().length === 0)
    throw new RangeError("suzukuri command must not be empty");
  return {
    command,
    timeoutMs: positiveInteger(config?.timeoutMs, DEFAULT_SUZUKURI_CONFIG.timeoutMs, "timeoutMs"),
    maxOutputBytes: positiveInteger(config?.maxOutputBytes, DEFAULT_SUZUKURI_CONFIG.maxOutputBytes, "maxOutputBytes"),
    maxInputBytes: positiveInteger(config?.maxInputBytes, DEFAULT_SUZUKURI_CONFIG.maxInputBytes, "maxInputBytes"),
  };
}

/** The released CLI contract consumed by this boundary. */
export const SUZUKURI_MINIMUM_VERSION = "0.2.2" as const;
export const SUZUKURI_SUPPORTED_VERSION = ">=0.2.2" as const;
export const SUZUKURI_SUPPORTED_OPERATIONS = Object.freeze(["project"] as const);
export type SuzukuriOperation = (typeof SUZUKURI_SUPPORTED_OPERATIONS)[number];
export const SUZUKURI_COMPONENT_KINDS = Object.freeze([
  "adapters",
  "views",
  "semantic-contracts",
  "renderers",
] as const);
export type SuzukuriComponentKind = (typeof SUZUKURI_COMPONENT_KINDS)[number];

export interface SuzukuriComponentIdentity {
  readonly id: string;
  readonly version: string;
}

export interface SuzukuriComponentDescriptor extends SuzukuriComponentIdentity {
  readonly semanticType?: string;
  readonly format?: string;
}

export interface SuzukuriCapabilities {
  readonly command: string;
  readonly version: string;
  readonly operations: readonly SuzukuriOperation[];
  readonly adapters: readonly SuzukuriComponentDescriptor[];
  readonly views: readonly SuzukuriComponentDescriptor[];
  readonly contracts: readonly SuzukuriComponentDescriptor[];
  readonly renderers: readonly SuzukuriComponentDescriptor[];
}

export interface SuzukuriSourceIdentity {
  /** Stable caller-owned identity; it is never inferred from cwd or the input contents. */
  readonly id: string;
  readonly path?: string;
  readonly revision?: string;
  readonly digest?: string;
}

export interface SuzukuriSource {
  readonly content: string | Uint8Array;
  readonly identity: SuzukuriSourceIdentity | string;
  readonly mediaType?: string;
}

/**
 * A projection request has no implicit profile, adapter, renderer, or budget.
 * `profile` is retained as caller intent for integrations that already resolve
 * a Suzukuri profile; the public v0.2.2 project command still requires the
 * explicit low-level component references below.
 */
export interface SuzukuriProjectionRequest {
  readonly source: SuzukuriSource | string | Uint8Array;
  readonly sourceIdentity?: SuzukuriSourceIdentity | string;
  readonly adapter: string;
  readonly view: string;
  readonly budget: number;
  readonly renderer: string;
  readonly contract?: string;
  readonly profile?: string;
}

export type SuzukuriCompleteness = "complete" | "partial";
export type SuzukuriLossState = "none" | "partial" | "total";

export interface SuzukuriLossReduction {
  readonly kind: string;
  readonly path?: string;
  readonly count?: number;
  readonly details?: SuzukuriJsonObject;
}

export interface SuzukuriLossMetadata {
  readonly state: SuzukuriLossState;
  readonly discarded: readonly string[];
  readonly reductions?: readonly SuzukuriLossReduction[];
  readonly discardedCounts?: Readonly<Record<string, number>>;
}

export interface SuzukuriProjectionResult {
  readonly source: SuzukuriSourceIdentity;
  readonly sourceIdentity: SuzukuriSourceIdentity;
  readonly profile?: string;
  readonly budget: number;
  readonly suzukuriVersion: string;
  readonly output: string;
  readonly outputSize: number;
  readonly byteLength: number;
  readonly coreVersion: string;
  readonly adapter: SuzukuriComponentIdentity;
  readonly contract: SuzukuriComponentIdentity;
  readonly semanticContract: SuzukuriComponentIdentity;
  readonly view: SuzukuriComponentIdentity;
  readonly renderer: SuzukuriComponentIdentity;
  readonly components: SuzukuriProjectionComponents;
  readonly provenance: SuzukuriProjectionProvenance;
  readonly projectionDigest: string;
  readonly completeness: SuzukuriCompleteness;
  readonly loss: SuzukuriLossMetadata;
  readonly diagnostics: readonly SuzukuriJsonValue[];
}

export interface SuzukuriProjectionComponents {
  readonly adapter: SuzukuriComponentIdentity;
  readonly semanticContract: SuzukuriComponentIdentity;
  readonly view: SuzukuriComponentIdentity;
  readonly renderer: SuzukuriComponentIdentity;
}

export interface SuzukuriProjectionProvenance {
  readonly core: SuzukuriComponentIdentity;
  readonly adapter: SuzukuriComponentIdentity;
  readonly semanticContract: SuzukuriComponentIdentity;
  readonly view: SuzukuriComponentIdentity;
  readonly renderer: SuzukuriComponentIdentity;
  readonly source?: {
    readonly identity?: string;
    readonly hash?: string;
    readonly mediaType?: string;
  };
}

export type SuzukuriErrorCode =
  | "SUZUKURI_INVALID_REQUEST"
  | "SUZUKURI_INPUT_LIMIT"
  | "SUZUKURI_COMPANION_MISSING"
  | "SUZUKURI_COMPANION_INCOMPATIBLE"
  | "SUZUKURI_CAPABILITY_UNAVAILABLE"
  | "SUZUKURI_TIMEOUT"
  | "SUZUKURI_OUTPUT_LIMIT"
  | "SUZUKURI_MALFORMED_OUTPUT"
  | "SUZUKURI_REJECTED"
  | "SUZUKURI_PROJECTION_FAILED";

export interface SuzukuriRemoteError {
  readonly code: string;
  readonly message: string;
  readonly details?: SuzukuriJsonValue;
}

export interface SuzukuriError {
  readonly code: SuzukuriErrorCode;
  readonly phase: "input" | "capability" | "operation";
  readonly operation?: SuzukuriOperation;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly remote?: SuzukuriRemoteError;
}

export type SuzukuriResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SuzukuriError };

export interface SuzukuriProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input?: string;
}

export type SuzukuriProcess = (request: SuzukuriProcessRequest) => Promise<RunResult>;

export interface SuzukuriClientOptions extends SuzukuriConfig {
  cwd?: string;
  runner?: SuzukuriProcess;
}

/**
 * The only Mottainai-owned Suzukuri boundary. It invokes the packaged CLI
 * with argv arrays and bounded stdin/stdout; semantic transformation stays in
 * Suzukuri.
 */
export class SuzukuriClient {
  readonly config: ResolvedSuzukuriConfig;
  private readonly cwd: string;
  private readonly runner: SuzukuriProcess;
  private capabilityProbe: Promise<SuzukuriResult<SuzukuriCapabilities>> | undefined;

  constructor(options: SuzukuriClientOptions = {}) {
    this.config = resolveSuzukuriConfig(options);
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

  checkCapabilities(): Promise<SuzukuriResult<SuzukuriCapabilities>> {
    this.capabilityProbe ??= this.probeCapabilities();
    return this.capabilityProbe;
  }

  async project(request: SuzukuriProjectionRequest): Promise<SuzukuriResult<SuzukuriProjectionResult>> {
    const normalized = normalizeProjectionRequest(request);
    if (!normalized.ok) return normalized;
    const input = serializeSource(normalized.value.source.content, this.config.maxInputBytes);
    if (!input.ok) return input;

    const capabilities = await this.checkCapabilities();
    if (!capabilities.ok) return capabilities;
    const missing = missingComponents(capabilities.value, normalized.value);
    if (missing.length > 0) {
      return {
        ok: false,
        error: capabilityError(
          "SUZUKURI_CAPABILITY_UNAVAILABLE",
          "suzukuri does not expose the requested projection components.",
          { version: capabilities.value.version, missing: missing.join(",") },
          "project",
        ),
      };
    }

    const args = [
      "project",
      "--adapter",
      normalized.value.adapter,
      "--view",
      normalized.value.view,
      "--budget",
      String(normalized.value.budget),
      "--renderer",
      normalized.value.renderer,
      "--input",
      "-",
      ...(normalized.value.contract === undefined ? [] : ["--contract", normalized.value.contract]),
    ];
    const result = await this.run(args, input.value);
    const processError = processFailure(result, "operation", "project", this.config);
    if (processError !== undefined) {
      const remote = parseRemoteError(result.stderr) ?? parseRemoteError(result.stdout);
      if (remote !== undefined) return classifyRemoteError("project", remote);
      return { ok: false, error: processError };
    }
    const payload = parsePayload(result.stdout);
    if (payload === undefined) {
      return {
        ok: false,
        error: malformedError("project", "suzukuri returned non-JSON or partial projection output.", result),
      };
    }
    const parsed = parseProjectionResult(payload, normalized.value, capabilities.value.version);
    if (!parsed.ok) return parsed;
    return parsed;
  }

  /** Alias used by callers that name the operation after its public CLI verb. */
  projectSource(request: SuzukuriProjectionRequest): Promise<SuzukuriResult<SuzukuriProjectionResult>> {
    return this.project(request);
  }

  private async probeCapabilities(): Promise<SuzukuriResult<SuzukuriCapabilities>> {
    const versionResult = await this.run(["--version"]);
    const versionFailure = processFailure(versionResult, "capability", undefined, this.config);
    if (versionFailure !== undefined) return { ok: false, error: withCapabilityContract(versionFailure) };
    const version = parseVersion(versionResult.stdout);
    if (version === undefined) {
      return {
        ok: false,
        error: capabilityError(
          "SUZUKURI_COMPANION_INCOMPATIBLE",
          "suzukuri did not return a compatible machine-readable version.",
          { detected: "unknown" },
        ),
      };
    }
    if (compareVersions(version, SUZUKURI_MINIMUM_VERSION) < 0) {
      return {
        ok: false,
        error: capabilityError("SUZUKURI_COMPANION_INCOMPATIBLE", "suzukuri version is not supported.", {
          detected: version,
          required: SUZUKURI_SUPPORTED_VERSION,
        }),
      };
    }

    const inspected: Partial<Record<SuzukuriComponentKind, readonly SuzukuriComponentDescriptor[]>> = {};
    for (const kind of SUZUKURI_COMPONENT_KINDS) {
      const result = await this.run(["inspect", kind, "--format", "json"]);
      const failure = processFailure(result, "capability", undefined, this.config);
      if (failure !== undefined) return { ok: false, error: withCapabilityContract(failure) };
      const payload = parsePayload(result.stdout);
      const components = payload === undefined ? undefined : parseInspection(payload, kind);
      if (components === undefined) {
        return {
          ok: false,
          error: capabilityError(
            "SUZUKURI_COMPANION_INCOMPATIBLE",
            "suzukuri did not return a valid component inspection result.",
            { version, surface: kind },
          ),
        };
      }
      inspected[kind] = components;
    }
    return {
      ok: true,
      value: {
        command: this.config.command,
        version,
        operations: SUZUKURI_SUPPORTED_OPERATIONS,
        adapters: inspected.adapters ?? [],
        views: inspected.views ?? [],
        contracts: inspected["semantic-contracts"] ?? [],
        renderers: inspected.renderers ?? [],
      },
    };
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

interface NormalizedProjectionRequest {
  readonly source: SuzukuriSource;
  readonly sourceIdentity: SuzukuriSourceIdentity;
  readonly adapter: string;
  readonly view: string;
  readonly budget: number;
  readonly renderer: string;
  readonly contract?: string;
  readonly profile?: string;
}

function normalizeProjectionRequest(request: SuzukuriProjectionRequest): SuzukuriResult<NormalizedProjectionRequest> {
  if (!isRecord(request)) return invalidRequest("project requires a request object.", "request");
  const adapter = nonEmptyString(request.adapter);
  const view = nonEmptyString(request.view);
  const renderer = nonEmptyString(request.renderer);
  if (adapter === undefined || view === undefined || renderer === undefined) {
    return invalidRequest("project requires explicit adapter, view, and renderer references.", "intent");
  }
  if (!Number.isSafeInteger(request.budget) || request.budget <= 0) {
    return invalidRequest("project requires a positive byte budget.", "budget");
  }
  if (request.contract !== undefined && nonEmptyString(request.contract) === undefined) {
    return invalidRequest("contract must be a non-empty component reference when provided.", "contract");
  }
  if (request.profile !== undefined && nonEmptyString(request.profile) === undefined) {
    return invalidRequest("profile must be a non-empty name when provided.", "profile");
  }

  const source = normalizeSource(request.source, request.sourceIdentity);
  if (!source.ok) return source;
  return {
    ok: true,
    value: {
      source: source.value.source,
      sourceIdentity: source.value.identity,
      adapter,
      view,
      budget: request.budget,
      renderer,
      ...(request.contract === undefined ? {} : { contract: request.contract }),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    },
  };
}

function normalizeSource(
  value: SuzukuriProjectionRequest["source"],
  explicitIdentity: SuzukuriProjectionRequest["sourceIdentity"],
): SuzukuriResult<{ readonly source: SuzukuriSource; readonly identity: SuzukuriSourceIdentity }> {
  if (isRecord(value)) {
    const content = value.content;
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      return invalidRequest("source content must be a string or byte array.", "source.content");
    }
    const identityValue = value.identity ?? value.id ?? explicitIdentity;
    const identity = normalizeSourceIdentity(identityValue);
    if (identity === undefined) return invalidRequest("source identity must be explicit.", "source.identity");
    if (explicitIdentity !== undefined && value.identity !== undefined) {
      const explicit = normalizeSourceIdentity(explicitIdentity);
      if (explicit === undefined || stableIdentity(explicit) !== stableIdentity(identity)) {
        return invalidRequest("source identity was provided more than once with different values.", "sourceIdentity");
      }
    }
    const source: SuzukuriSource = {
      content,
      identity,
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    };
    return { ok: true, value: { source, identity } };
  }
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    return invalidRequest("source content must be a string, byte array, or source object.", "source");
  }
  const identity = normalizeSourceIdentity(explicitIdentity);
  if (identity === undefined) return invalidRequest("source identity must be explicit.", "sourceIdentity");
  return { ok: true, value: { source: { content: value, identity }, identity } };
}

function normalizeSourceIdentity(value: unknown): SuzukuriSourceIdentity | undefined {
  if (typeof value === "string") {
    const id = nonEmptyString(value);
    return id === undefined ? undefined : { id };
  }
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  if (id === undefined) return undefined;
  const optional: Record<string, string> = {};
  for (const key of ["path", "revision", "digest"] as const) {
    if (value[key] !== undefined) {
      const item = nonEmptyString(value[key]);
      if (item === undefined) return undefined;
      optional[key] = item;
    }
  }
  return { id, ...optional };
}

function serializeSource(value: string | Uint8Array, maxBytes: number): SuzukuriResult<string> {
  const input = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    return {
      ok: false,
      error: {
        code: "SUZUKURI_INPUT_LIMIT",
        phase: "input",
        message: "suzukuri source exceeded the configured byte limit.",
        retryable: false,
        details: { limitBytes: maxBytes },
      },
    };
  }
  return { ok: true, value: input };
}

function missingComponents(capabilities: SuzukuriCapabilities, request: NormalizedProjectionRequest): string[] {
  const missing: string[] = [];
  if (!hasComponent(capabilities.adapters, request.adapter)) missing.push(`adapter:${request.adapter}`);
  if (!hasComponent(capabilities.views, request.view)) missing.push(`view:${request.view}`);
  if (!hasComponent(capabilities.renderers, request.renderer)) missing.push(`renderer:${request.renderer}`);
  if (request.contract !== undefined && !hasComponent(capabilities.contracts, request.contract)) {
    missing.push(`contract:${request.contract}`);
  }
  return missing;
}

function hasComponent(components: readonly SuzukuriComponentIdentity[], reference: string): boolean {
  const at = reference.lastIndexOf("@");
  const id = at > 0 ? reference.slice(0, at) : reference;
  const version = at > 0 ? reference.slice(at + 1) : undefined;
  return components.some(
    (component) => component.id === id && (version === undefined || component.version === version),
  );
}

function parseInspection(
  payload: SuzukuriJsonObject,
  kind: SuzukuriComponentKind,
): readonly SuzukuriComponentDescriptor[] | undefined {
  if (payload.kind !== kind || !Array.isArray(payload.components)) return undefined;
  const components: SuzukuriComponentDescriptor[] = [];
  for (const value of payload.components) {
    if (!isRecord(value)) {
      return undefined;
    }
    const component = value as Record<string, unknown>;
    if (nonEmptyString(component.id) === undefined || nonEmptyString(component.version) === undefined) {
      return undefined;
    }
    const descriptor: SuzukuriComponentDescriptor = {
      id: component.id as string,
      version: component.version as string,
      ...(typeof component.semanticType === "string" ? { semanticType: boundText(component.semanticType) } : {}),
      ...(typeof component.format === "string" ? { format: boundText(component.format) } : {}),
    };
    components.push(descriptor);
  }
  return components;
}

function parseProjectionResult(
  payload: SuzukuriJsonObject,
  request: NormalizedProjectionRequest,
  suzukuriVersion: string,
): SuzukuriResult<SuzukuriProjectionResult> {
  const output = typeof payload.output === "string" ? payload.output : undefined;
  const outputSize = nonNegativeInteger(payload.outputSize);
  const byteLength = nonNegativeInteger(payload.byteLength);
  const coreVersion = nonEmptyString(payload.coreVersion);
  const projectionDigest = payload.projectionDigest;
  const completeness = payload.completeness;
  if (
    output === undefined ||
    outputSize === undefined ||
    byteLength === undefined ||
    coreVersion === undefined ||
    typeof projectionDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(projectionDigest) ||
    (completeness !== "complete" && completeness !== "partial")
  ) {
    return malformedProjection("suzukuri projection result is missing required versioned fields.");
  }
  const actualBytes = Buffer.byteLength(output, "utf8");
  if (outputSize !== actualBytes || byteLength !== actualBytes) {
    return malformedProjection("suzukuri projection result has inconsistent output byte lengths.");
  }
  const adapter = parseComponentIdentity(payload.adapter);
  const contract = parseComponentIdentity(payload.contract);
  const semanticContract = parseComponentIdentity(payload.semanticContract);
  const view = parseComponentIdentity(payload.view);
  const renderer = parseComponentIdentity(payload.renderer);
  const components = isRecord(payload.components)
    ? parseComponents(payload.components as SuzukuriJsonObject)
    : undefined;
  const provenance = parseProvenance(payload.provenance);
  const loss = parseLoss(payload.loss);
  if (
    adapter === undefined ||
    contract === undefined ||
    semanticContract === undefined ||
    view === undefined ||
    renderer === undefined ||
    components === undefined ||
    provenance === undefined ||
    loss === undefined ||
    !identityEqual(components.adapter, adapter) ||
    !identityEqual(components.semanticContract, semanticContract) ||
    !identityEqual(components.view, view) ||
    !identityEqual(components.renderer, renderer) ||
    !identityEqual(provenance.adapter, adapter) ||
    !identityEqual(provenance.semanticContract, semanticContract) ||
    !identityEqual(provenance.view, view) ||
    !identityEqual(provenance.renderer, renderer) ||
    provenance.core.id !== "suzukuri-projection-core" ||
    provenance.core.version !== coreVersion ||
    !identityEqual(requestedIdentity(request.adapter, adapter), adapter) ||
    !identityEqual(requestedIdentity(request.view, view), view) ||
    !identityEqual(requestedIdentity(request.renderer, renderer), renderer) ||
    (request.contract !== undefined && !identityEqual(requestedIdentity(request.contract, contract), contract))
  ) {
    return malformedProjection("suzukuri projection result has inconsistent component identity.");
  }
  return {
    ok: true,
    value: {
      source: request.sourceIdentity,
      sourceIdentity: request.sourceIdentity,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      budget: request.budget,
      suzukuriVersion,
      output: boundText(output),
      outputSize,
      byteLength,
      coreVersion,
      adapter,
      contract,
      semanticContract,
      view,
      renderer,
      components,
      provenance,
      projectionDigest,
      completeness,
      loss,
      diagnostics: [],
    },
  };
}

function parseComponentIdentity(value: unknown): SuzukuriComponentIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const version = nonEmptyString(value.version);
  return id === undefined || version === undefined ? undefined : { id, version };
}

function parseComponents(value: SuzukuriJsonObject): SuzukuriProjectionResult["components"] | undefined {
  const adapter = parseComponentIdentity(value.adapter);
  const semanticContract = parseComponentIdentity(value.semanticContract);
  const view = parseComponentIdentity(value.view);
  const renderer = parseComponentIdentity(value.renderer);
  return adapter === undefined || semanticContract === undefined || view === undefined || renderer === undefined
    ? undefined
    : { adapter, semanticContract, view, renderer };
}

function parseProvenance(value: unknown): SuzukuriProjectionProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const core = parseComponentIdentity(value.core);
  const adapter = parseComponentIdentity(value.adapter);
  const semanticContract = parseComponentIdentity(value.semanticContract);
  const view = parseComponentIdentity(value.view);
  const renderer = parseComponentIdentity(value.renderer);
  if (
    core === undefined ||
    adapter === undefined ||
    semanticContract === undefined ||
    view === undefined ||
    renderer === undefined
  ) {
    return undefined;
  }
  const sourceValue = value.source;
  if (sourceValue === undefined) return { core, adapter, semanticContract, view, renderer };
  if (!isRecord(sourceValue)) return undefined;
  const source: { identity?: string; hash?: string; mediaType?: string } = {};
  for (const key of ["identity", "hash", "mediaType"] as const) {
    if (sourceValue[key] !== undefined) {
      const item = nonEmptyString(sourceValue[key]);
      if (item === undefined) return undefined;
      source[key] = boundText(item);
    }
  }
  return { core, adapter, semanticContract, view, renderer, source };
}

function parseLoss(value: unknown): SuzukuriLossMetadata | undefined {
  if (!isRecord(value) || (value.state !== "none" && value.state !== "partial" && value.state !== "total"))
    return undefined;
  if (!Array.isArray(value.discarded) || value.discarded.some((entry) => typeof entry !== "string")) return undefined;
  const reductions = value.reductions === undefined ? undefined : parseReductions(value.reductions);
  if (value.reductions !== undefined && reductions === undefined) return undefined;
  const discardedCounts = value.discardedCounts === undefined ? undefined : parseCounts(value.discardedCounts);
  if (value.discardedCounts !== undefined && discardedCounts === undefined) return undefined;
  return {
    state: value.state,
    discarded: value.discarded.slice(0, 64).map((entry) => boundText(entry as string)),
    ...(reductions === undefined ? {} : { reductions }),
    ...(discardedCounts === undefined ? {} : { discardedCounts }),
  };
}

function parseReductions(value: unknown): readonly SuzukuriLossReduction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reductions: SuzukuriLossReduction[] = [];
  for (const item of value.slice(0, 64)) {
    if (!isRecord(item) || nonEmptyString(item.kind) === undefined) return undefined;
    const path = item.path === undefined ? undefined : nonEmptyString(item.path);
    const count = item.count === undefined ? undefined : nonNegativeInteger(item.count);
    if ((item.path !== undefined && path === undefined) || (item.count !== undefined && count === undefined))
      return undefined;
    const details =
      item.details === undefined ? undefined : isRecord(item.details) ? boundObject(item.details) : undefined;
    if (item.details !== undefined && details === undefined) return undefined;
    reductions.push({
      kind: boundText(item.kind as string),
      ...(path === undefined ? {} : { path: boundText(path) }),
      ...(count === undefined ? {} : { count }),
      ...(details === undefined ? {} : { details }),
    });
  }
  return reductions;
}

function parseCounts(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).slice(0, 64);
  const counts: Record<string, number> = {};
  for (const [key, item] of entries) {
    const count = nonNegativeInteger(item);
    if (count === undefined || key.length === 0) return undefined;
    counts[boundText(key)] = count;
  }
  return counts;
}

function parseVersion(output: string): string | undefined {
  const match = /^suzukuri\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(output.trim());
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
  operation: SuzukuriOperation | undefined,
  limits: ResolvedSuzukuriConfig,
): SuzukuriError | undefined {
  if (result.spawnError !== undefined) {
    const missing = /(?:ENOENT|not found|cannot find)/iu.test(result.spawnError);
    return makeError(
      missing ? "SUZUKURI_COMPANION_MISSING" : "SUZUKURI_PROJECTION_FAILED",
      phase,
      missing ? "suzukuri companion executable was not found." : "suzukuri companion could not be started.",
      missing,
      { operation, summary: summarize(result.spawnError) },
    );
  }
  if (result.timedOut) {
    return makeError("SUZUKURI_TIMEOUT", phase, "suzukuri companion exceeded its bounded timeout.", true, {
      operation,
      timeoutMs: limits.timeoutMs,
    });
  }
  if (result.outputLimit) {
    return makeError("SUZUKURI_OUTPUT_LIMIT", phase, "suzukuri companion exceeded its bounded output limit.", false, {
      operation,
      limitBytes: limits.maxOutputBytes,
    });
  }
  if (result.exitCode !== 0) {
    return makeError(
      phase === "capability" ? "SUZUKURI_COMPANION_INCOMPATIBLE" : "SUZUKURI_PROJECTION_FAILED",
      phase,
      phase === "capability"
        ? "suzukuri companion did not expose a compatible machine contract."
        : "suzukuri projection failed.",
      false,
      { operation, exitCode: result.exitCode ?? -1, summary: summarize(result.stderr || result.stdout) },
    );
  }
  return undefined;
}

function parseRemoteError(value: string): SuzukuriRemoteError | undefined {
  const payload = parseUnknown(value);
  if (!isRecord(payload)) return undefined;
  const candidate = isRecord(payload.error) ? payload.error : payload;
  const code = nonEmptyString(candidate.code);
  const message = nonEmptyString(candidate.message);
  if (code === undefined || message === undefined) return undefined;
  return {
    code: boundText(code),
    message: boundText(message),
    ...(candidate.details === undefined ? {} : { details: boundValue(candidate.details) }),
  };
}

function classifyRemoteError(operation: SuzukuriOperation, remote: SuzukuriRemoteError): SuzukuriResult<never> {
  const projectionCodes = new Set([
    "ADAPTER_VALIDATION_FAILED",
    "DECODE_FAILED",
    "CONTRACT_VALIDATION_FAILED",
    "CONTRACT_NORMALIZATION_FAILED",
    "SEMANTIC_TYPE_MISMATCH",
    "VIEW_PROJECTION_FAILED",
    "RENDER_FAILED",
    "BUDGET_EXCEEDED",
    "BUDGET_TOO_SMALL",
  ]);
  const code: SuzukuriErrorCode = projectionCodes.has(remote.code) ? "SUZUKURI_PROJECTION_FAILED" : "SUZUKURI_REJECTED";
  return {
    ok: false,
    error: {
      code,
      phase: "operation",
      operation,
      message: remote.message,
      retryable: false,
      details: { upstreamCode: remote.code },
      remote,
    },
  };
}

function parsePayload(output: string): SuzukuriJsonObject | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return isRecord(value) ? (value as SuzukuriJsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function parseUnknown(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function invalidRequest(message: string, field: string): SuzukuriResult<never> {
  return {
    ok: false,
    error: { code: "SUZUKURI_INVALID_REQUEST", phase: "input", message, retryable: false, details: { field } },
  };
}

function malformedProjection(message: string): SuzukuriResult<never> {
  return {
    ok: false,
    error: {
      code: "SUZUKURI_MALFORMED_OUTPUT",
      phase: "operation",
      operation: "project",
      message,
      retryable: false,
      details: {},
    },
  };
}

function malformedError(operation: SuzukuriOperation, message: string, result: RunResult): SuzukuriError {
  return makeError("SUZUKURI_MALFORMED_OUTPUT", "operation", message, false, {
    operation,
    summary: summarize(result.stderr || result.stdout),
  });
}

function capabilityError(
  code: "SUZUKURI_COMPANION_INCOMPATIBLE" | "SUZUKURI_CAPABILITY_UNAVAILABLE",
  message: string,
  details: Record<string, string | number | boolean>,
  operation?: SuzukuriOperation,
): SuzukuriError {
  return {
    code,
    phase: "capability",
    ...(operation === undefined ? {} : { operation }),
    message,
    retryable: false,
    details,
  };
}

function withCapabilityContract(error: SuzukuriError): SuzukuriError {
  if (error.phase !== "capability") return error;
  if (
    error.code === "SUZUKURI_COMPANION_MISSING" ||
    error.code === "SUZUKURI_TIMEOUT" ||
    error.code === "SUZUKURI_OUTPUT_LIMIT"
  )
    return error;
  return { ...error, code: "SUZUKURI_COMPANION_INCOMPATIBLE" };
}

function makeError(
  code: SuzukuriErrorCode,
  phase: "capability" | "operation",
  message: string,
  retryable: boolean,
  details: Record<string, string | number | boolean | undefined>,
): SuzukuriError {
  return {
    code,
    phase,
    message,
    retryable,
    details: Object.fromEntries(
      Object.entries(details).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
    ),
  };
}

function requestedIdentity(reference: string, actual: SuzukuriComponentIdentity): SuzukuriComponentIdentity {
  const at = reference.lastIndexOf("@");
  return {
    id: at > 0 ? reference.slice(0, at) : reference,
    version: at > 0 ? reference.slice(at + 1) : actual.version,
  };
}

function identityEqual(left: SuzukuriComponentIdentity, right: SuzukuriComponentIdentity): boolean {
  return left.id === right.id && left.version === right.version;
}

function stableIdentity(value: SuzukuriSourceIdentity): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`suzukuri ${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundText(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}

function boundValue(value: unknown, depth = 0): SuzukuriJsonValue {
  if (depth >= 4) return "[bounded]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? boundText(value) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => boundValue(item, depth + 1));
  if (isRecord(value)) return boundObject(value, depth + 1);
  return "[bounded]";
}

function boundObject(value: Record<string, unknown>, depth = 0): SuzukuriJsonObject {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([key, item]) => [boundText(key), boundValue(item, depth)]),
  ) as SuzukuriJsonObject;
}

function summarize(value: string): string {
  return boundText(value.trim());
}
