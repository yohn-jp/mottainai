import fs from "node:fs";
import path from "node:path";
import {
  assertManifestProjectable,
  generationIdentityOf,
  parseManagedGenerationMetadata,
} from "./managed-generation.js";
import type { ManagedGenerationMetadata } from "./managed-generation.js";
import { parseManagedPackageManifest, semanticIdentityOf } from "./managed-package-manifest.js";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";
import {
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH,
  MANAGED_RUNTIME_STATE_CONTRACT_ID,
  MANAGED_RUNTIME_STATE_SCHEMA_VERSION,
  atomicallySelectManagedRuntimeGeneration,
  assertManagedStorePath,
  clearManagedRuntimePointer,
  readManagedRuntimePointer,
  readManagedRuntimeState,
  resolveManagedRuntimePaths,
  writeManagedRuntimeState,
} from "./managed-runtime-state.js";
import type {
  ManagedRuntimeActivation,
  ManagedRuntimeActivationPhase,
  ManagedRuntimeCandidate,
  ManagedRuntimeFailureCode,
  ManagedRuntimeFailureEvidence,
  ManagedRuntimeGenerationRecord,
  ManagedRuntimeObservedState,
  ManagedRuntimePaths,
  ManagedRuntimeState,
} from "./managed-runtime-state.js";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import type { BoundaryOperations } from "../boundary.js";

/** Minimum supported managed-generation metadata contract. */
export const SUPPORTED_MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION = 1 as const;
export const SUPPORTED_RUNTIME_CONTRACT_ID = "mottainai.linux-runtime.v1" as const;
export const SUPPORTED_RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const;

const MAX_ERROR_MESSAGE_LENGTH = 2_048 as const;
const MAX_HEALTH_EVIDENCE_LENGTH = 2_048 as const;

/** Result returned by #625/#626 after a complete build and verification. */
export interface ManagedRuntimeBuiltGeneration {
  readonly generationIdentity: string;
  /** The exact managed-generation buildEnv output path. */
  readonly storePath?: string;
  /** Bootstrap evidence uses this spelling; it is normalized to `storePath`. */
  readonly generationStorePath?: string;
  /** Metadata is recommended; when supplied it is checked again at activation. */
  readonly metadata?: ManagedGenerationMetadata;
  /** Compatibility version echoed by a build adapter that does not expose metadata. */
  readonly compatibilityContractVersion?: number;
}

export interface ManagedRuntimeVerificationInput {
  readonly manifest: ManagedPackageManifest;
  readonly generation: ManagedRuntimeBuiltGeneration;
  readonly candidate: ManagedRuntimeCandidate;
}

/** Health result must be explicitly successful; timeout/error is never success. */
export interface ManagedRuntimeHealthResult {
  readonly healthy?: boolean;
  /** Optional status spelling used by guest health adapters. */
  readonly status?: "healthy" | "unhealthy" | "pending" | "unknown";
  /** Optional success spelling used by command adapters. */
  readonly ok?: boolean;
  readonly generationIdentity?: string;
  readonly storePath?: string;
  readonly evidence?: string;
  readonly reason?: string;
}

export type ManagedRuntimeHealthCheckResult = ManagedRuntimeHealthResult | boolean;

export interface ManagedRuntimeApplianceContract {
  readonly contractId: string;
  readonly schemaVersion?: number;
  readonly contractVersion?: number;
  readonly managedGenerationCompatibilityContractVersion?: number;
}

export interface ManagedRuntimeDependencies {
  /** Build and verify a generation. The adapter must not mutate `current` or user/workspace state. */
  readonly buildGeneration?: (
    manifest: ManagedPackageManifest,
  ) => Promise<ManagedRuntimeBuiltGeneration> | ManagedRuntimeBuiltGeneration;
  /** Alias accepted for small embedders. */
  readonly build?: (
    manifest: ManagedPackageManifest,
  ) => Promise<ManagedRuntimeBuiltGeneration> | ManagedRuntimeBuiltGeneration;
  /** Optional second verification at the activation boundary. */
  readonly verifyGeneration?:
    | ((input: ManagedRuntimeVerificationInput) => Promise<boolean | void> | boolean | void)
    | ((
        generation: ManagedRuntimeBuiltGeneration,
        manifest: ManagedPackageManifest,
      ) => Promise<boolean | void> | boolean | void);
  /** Compatibility checks supplied by bootstrap/appliance integration. */
  readonly checkCompatibility?: (
    manifest: ManagedPackageManifest,
    generation?: ManagedRuntimeBuiltGeneration,
  ) => Promise<boolean | void> | boolean | void;
  readonly verifyCompatibility?: (
    manifest: ManagedPackageManifest,
    generation?: ManagedRuntimeBuiltGeneration,
  ) => Promise<boolean | void> | boolean | void;
  /** Managed health must resolve executables/services through the supplied candidate identity. */
  readonly healthCheck?: (
    generation: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
  ) => Promise<ManagedRuntimeHealthCheckResult> | ManagedRuntimeHealthCheckResult;
  /** Alias accepted for embedders that call the operation `health`. */
  readonly health?: (
    generation: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
  ) => Promise<ManagedRuntimeHealthCheckResult> | ManagedRuntimeHealthCheckResult;
}

export interface ManagedRuntimeReconcileOptions {
  readonly stateDirectory?: string;
  readonly stateFilePath?: string;
  readonly currentPointerPath?: string;
  readonly manifestPath?: string;
  /** A caller may provide parsed or raw manifest; otherwise the canonical file is read. */
  readonly manifest?: unknown;
  readonly dependencies: ManagedRuntimeDependencies;
  readonly applianceContract?: ManagedRuntimeApplianceContract;
  readonly supportedRuntimeContractId?: string;
  readonly supportedRuntimeContractSchemaVersion?: number;
  readonly supportedGenerationCompatibilityContractVersion?: number;
  readonly now?: () => Date;
  readonly boundaries?: BoundaryOperations;
}

export interface ManagedRuntimeStatusOptions {
  readonly stateDirectory?: string;
  readonly stateFilePath?: string;
  readonly currentPointerPath?: string;
}

export interface ManagedRuntimeStatusReport {
  readonly contractId: typeof MANAGED_RUNTIME_STATE_CONTRACT_ID;
  readonly schemaVersion: typeof MANAGED_RUNTIME_STATE_SCHEMA_VERSION;
  readonly present: boolean;
  readonly desiredManifestSemanticIdentity?: string;
  readonly activeGenerationIdentity?: string;
  readonly activeStorePath?: string;
  readonly previousGenerationIdentity?: string;
  readonly previousStorePath?: string;
  readonly observedGenerationIdentity?: string;
  readonly observedStorePath?: string;
  readonly activationPhase?: ManagedRuntimeActivationPhase;
  readonly failure?: ManagedRuntimeFailureEvidence;
  readonly state?: ManagedRuntimeState;
}

export type ManagedRuntimeReconcileOutcome =
  | "initialized"
  | "noop"
  | "updated"
  | "removed"
  | "recovered"
  | "rolled-back";

export interface ManagedRuntimeReconcileResult {
  readonly ok: true;
  readonly outcome: ManagedRuntimeReconcileOutcome;
  readonly desiredManifestSemanticIdentity: string;
  readonly active?: ManagedRuntimeGenerationRecord;
  readonly previous?: ManagedRuntimeGenerationRecord;
  readonly observed?: ManagedRuntimeObservedState;
  readonly status: ManagedRuntimeStatusReport;
}

export type ManagedRuntimeErrorCode = ManagedRuntimeFailureCode | "manifest_read_failure" | "recovery_required";

export class ManagedRuntimeError extends Error {
  readonly code: ManagedRuntimeErrorCode;
  readonly phase: ManagedRuntimeActivationPhase;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code: ManagedRuntimeErrorCode,
    message: string,
    phase: ManagedRuntimeActivationPhase = "idle",
    details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "ManagedRuntimeError";
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedMessage(message: string, max = MAX_ERROR_MESSAGE_LENGTH): string {
  if (message.length <= max) return message;
  const suffix = "...[truncated]";
  return `${message.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
}

function statePaths(
  options: Pick<
    ManagedRuntimeReconcileOptions,
    "stateDirectory" | "stateFilePath" | "currentPointerPath" | "manifestPath"
  >,
): ManagedRuntimePaths {
  const resolved = resolveManagedRuntimePaths(options.stateDirectory ?? MANAGED_RUNTIME_CONTROL_STATE_ROOT);
  const stateFileDirectory = options.stateFilePath === undefined ? undefined : path.dirname(options.stateFilePath);
  const derivedRoot = stateFileDirectory === undefined ? undefined : path.dirname(stateFileDirectory);
  return {
    ...resolved,
    stateFile: options.stateFilePath ?? resolved.stateFile,
    currentPointer:
      options.currentPointerPath ??
      (stateFileDirectory === undefined ? resolved.currentPointer : path.join(stateFileDirectory, "current")),
    manifestFile:
      options.manifestPath ??
      (derivedRoot === undefined
        ? resolved.manifestFile
        : path.join(derivedRoot, MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH)),
  };
}

function initialActivation(timestamp: string): ManagedRuntimeActivation {
  return { phase: "idle", startedAt: timestamp, updatedAt: timestamp };
}

function initialState(desiredIdentity: string, timestamp: string): ManagedRuntimeState {
  return {
    contractId: MANAGED_RUNTIME_STATE_CONTRACT_ID,
    schemaVersion: MANAGED_RUNTIME_STATE_SCHEMA_VERSION,
    desiredManifestSemanticIdentity: desiredIdentity,
    activation: initialActivation(timestamp),
    updatedAt: timestamp,
  };
}

function withoutActivationFields(activation: ManagedRuntimeActivation): ManagedRuntimeActivation {
  return {
    phase: "idle",
    ...(activation.updatedAt === undefined ? {} : { updatedAt: activation.updatedAt }),
    ...(activation.startedAt === undefined ? {} : { startedAt: activation.startedAt }),
  };
}

function candidatePackageIds(manifest: ManagedPackageManifest): string[] {
  return manifest.packages.map((entry) => entry.packageId).sort();
}

function asCandidate(
  manifest: ManagedPackageManifest,
  generation: ManagedRuntimeBuiltGeneration,
  supportedCompatibilityVersion: number,
): ManagedRuntimeCandidate {
  if (generation === null || typeof generation !== "object") {
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation result is invalid");
  }
  const identity = generation.generationIdentity;
  if (typeof identity !== "string" || identity.length === 0 || identity.length > 256) {
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation identity is invalid");
  }
  let metadata: ManagedGenerationMetadata | undefined;
  if (generation.metadata !== undefined) {
    try {
      metadata = parseManagedGenerationMetadata(generation.metadata);
    } catch (error) {
      throw new ManagedRuntimeError("generation_verification_failure", errorMessage(error));
    }
  }

  const suppliedStorePaths = [
    ["storePath", generation.storePath],
    ["generationStorePath", generation.generationStorePath],
    ["metadata.nixOutput.storePath", metadata?.nixOutput.storePath],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (suppliedStorePaths.length === 0) {
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation did not provide a store path");
  }
  let normalizedStorePath: string | undefined;
  for (const [field, storePath] of suppliedStorePaths) {
    let normalized: string;
    try {
      normalized = assertManagedStorePath(storePath);
    } catch (error) {
      throw new ManagedRuntimeError(
        "generation_verification_failure",
        `managed generation ${field} store path is invalid: ${errorMessage(error)}`,
      );
    }
    if (normalizedStorePath !== undefined && normalizedStorePath !== normalized) {
      throw new ManagedRuntimeError("generation_verification_failure", "managed generation store path fields disagree");
    }
    normalizedStorePath = normalized;
  }
  if (normalizedStorePath === undefined) {
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation did not provide a store path");
  }

  if (metadata !== undefined) {
    try {
      const expectedIdentity = generationIdentityOf(manifest, metadata);
      if (identity !== expectedIdentity) {
        throw new ManagedRuntimeError(
          "generation_verification_failure",
          `managed generation identity mismatch: adapter=${identity}, metadata=${expectedIdentity}`,
        );
      }
      if (metadata.compatibilityContractVersion !== supportedCompatibilityVersion) {
        throw new ManagedRuntimeError(
          "compatibility_mismatch",
          `managed generation compatibility contract ${metadata.compatibilityContractVersion} is not supported (expected ${supportedCompatibilityVersion})`,
        );
      }
    } catch (error) {
      if (error instanceof ManagedRuntimeError) throw error;
      throw new ManagedRuntimeError("generation_verification_failure", errorMessage(error));
    }
  }
  const compatibilityContractVersion =
    generation.compatibilityContractVersion ?? metadata?.compatibilityContractVersion ?? supportedCompatibilityVersion;
  if (compatibilityContractVersion !== supportedCompatibilityVersion) {
    throw new ManagedRuntimeError(
      "compatibility_mismatch",
      `managed generation compatibility contract ${compatibilityContractVersion} is not supported (expected ${supportedCompatibilityVersion})`,
    );
  }
  return {
    generationIdentity: identity,
    storePath: normalizedStorePath,
    desiredManifestSemanticIdentity: semanticIdentityOf(manifest),
    compatibilityContractVersion,
    packageIds: candidatePackageIds(manifest),
  };
}

function recordFromCandidate(
  candidate: ManagedRuntimeCandidate,
  checkedAt: string,
  evidence?: string,
): ManagedRuntimeGenerationRecord {
  return {
    ...candidate,
    health: {
      state: "healthy",
      checkedAt,
      ...(evidence === undefined ? {} : { evidence: boundedMessage(evidence, MAX_HEALTH_EVIDENCE_LENGTH) }),
    },
  };
}

function candidateFromRecord(record: ManagedRuntimeGenerationRecord): ManagedRuntimeCandidate {
  const { health: _health, ...candidate } = record;
  return candidate;
}

function pointerMatches(pointer: string | undefined, target: string | undefined): boolean {
  if (pointer === undefined || target === undefined) return pointer === target;
  return path.normalize(pointer) === path.normalize(target);
}

function observedFor(
  pointer: string | undefined,
  state: ManagedRuntimeState,
  timestamp: string,
  health?: ManagedRuntimeHealthStateLike,
  reason?: string,
): ManagedRuntimeObservedState {
  const active = state.active;
  const previous = state.previous;
  const candidate = state.activation.candidate;
  const matched =
    active !== undefined && pointerMatches(pointer, active.storePath)
      ? active
      : previous !== undefined && pointerMatches(pointer, previous.storePath)
        ? previous
        : candidate !== undefined && pointerMatches(pointer, candidate.storePath)
          ? candidate
          : undefined;
  return {
    observedAt: timestamp,
    ...(pointer === undefined ? {} : { currentStorePath: pointer }),
    ...(matched === undefined
      ? {}
      : {
          generationIdentity: matched.generationIdentity,
          desiredManifestSemanticIdentity: matched.desiredManifestSemanticIdentity,
        }),
    ...(health === undefined ? {} : { health }),
    ...(reason === undefined ? {} : { reason: boundedMessage(reason, MAX_HEALTH_EVIDENCE_LENGTH) }),
  };
}

type ManagedRuntimeHealthStateLike = "healthy" | "unhealthy" | "pending" | "unknown";

function failureEvidence(
  code: ManagedRuntimeFailureCode,
  phase: ManagedRuntimeActivationPhase,
  message: string,
  timestamp: string,
  candidate?: ManagedRuntimeCandidate,
): ManagedRuntimeFailureEvidence {
  return {
    code,
    phase,
    message: boundedMessage(message),
    recordedAt: timestamp,
    ...(candidate === undefined
      ? {}
      : { generationIdentity: candidate.generationIdentity, storePath: candidate.storePath }),
  };
}

function healthFailureMessage(health: ManagedRuntimeHealthResult, fallback: string): string {
  return typeof health.reason !== "string" || health.reason.length === 0 ? fallback : health.reason;
}

function stateWithFailure(
  state: ManagedRuntimeState,
  desiredIdentity: string,
  evidence: ManagedRuntimeFailureEvidence,
  timestamp: string,
  pointer: string | undefined,
): ManagedRuntimeState {
  return {
    ...state,
    desiredManifestSemanticIdentity: desiredIdentity,
    activation: withoutActivationFields({
      ...state.activation,
      phase: "idle",
      candidate: undefined,
      previous: undefined,
      failure: undefined,
      updatedAt: timestamp,
    }),
    failure: evidence,
    observed: observedFor(pointer, state, timestamp, "unknown", evidence.message),
    updatedAt: timestamp,
  };
}

function stateWithActivation(
  state: ManagedRuntimeState,
  activation: ManagedRuntimeActivation,
  timestamp: string,
): ManagedRuntimeState {
  return { ...state, activation: { ...activation, updatedAt: timestamp }, updatedAt: timestamp };
}

function readManifestFile(filePath: string): ManagedPackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ManagedRuntimeError(
      "manifest_read_failure",
      `managed package manifest cannot be read: ${errorMessage(error)}`,
    );
  }
  try {
    return parseManagedPackageManifest(value);
  } catch (error) {
    throw new ManagedRuntimeError("invalid_manifest", errorMessage(error));
  }
}

function manifestValue(value: unknown | undefined, filePath: string): ManagedPackageManifest {
  if (value === undefined) return readManifestFile(filePath);
  try {
    return parseManagedPackageManifest(value);
  } catch (error) {
    throw new ManagedRuntimeError("invalid_manifest", errorMessage(error));
  }
}

function validateManifestCompatibility(
  manifest: ManagedPackageManifest,
  options: ManagedRuntimeReconcileOptions,
): void {
  const appliance = options.applianceContract;
  const expectedId = options.supportedRuntimeContractId ?? SUPPORTED_RUNTIME_CONTRACT_ID;
  const expectedSchema = options.supportedRuntimeContractSchemaVersion ?? SUPPORTED_RUNTIME_CONTRACT_SCHEMA_VERSION;
  const applianceSchemaVersion = appliance?.schemaVersion ?? appliance?.contractVersion;
  if (
    appliance !== undefined &&
    (appliance.contractId !== expectedId ||
      applianceSchemaVersion === undefined ||
      applianceSchemaVersion < expectedSchema)
  ) {
    throw new ManagedRuntimeError(
      "compatibility_mismatch",
      `appliance contract ${appliance.contractId}@${applianceSchemaVersion ?? "unknown"} is incompatible with ${expectedId}@${expectedSchema}`,
    );
  }
  const runtimeSchemaVersion = applianceSchemaVersion ?? expectedSchema;
  for (const entry of manifest.packages) {
    const minimum = entry.compatibility?.minimumRuntimeContractSchemaVersion;
    if (minimum !== undefined && minimum > runtimeSchemaVersion) {
      throw new ManagedRuntimeError(
        "compatibility_mismatch",
        `package ${entry.packageId} requires Runtime contract schema ${minimum}, but appliance provides ${runtimeSchemaVersion}`,
      );
    }
  }
}

function supportedGenerationCompatibilityVersion(options: ManagedRuntimeReconcileOptions): number {
  return (
    options.supportedGenerationCompatibilityContractVersion ??
    options.applianceContract?.managedGenerationCompatibilityContractVersion ??
    SUPPORTED_MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION
  );
}

async function invokeCompatibility(
  dependencies: ManagedRuntimeDependencies,
  manifest: ManagedPackageManifest,
  generation?: ManagedRuntimeBuiltGeneration,
): Promise<void> {
  const check = dependencies.verifyCompatibility ?? dependencies.checkCompatibility;
  if (check === undefined) return;
  let result: boolean | void;
  try {
    result = await check(manifest, generation);
  } catch (error) {
    throw new ManagedRuntimeError("compatibility_mismatch", errorMessage(error));
  }
  if (result === false)
    throw new ManagedRuntimeError("compatibility_mismatch", "managed generation compatibility check failed");
}

async function invokeVerification(
  dependencies: ManagedRuntimeDependencies,
  input: ManagedRuntimeVerificationInput,
): Promise<void> {
  if (dependencies.verifyGeneration === undefined) return;
  let result: boolean | void;
  try {
    // Support both the object-shaped and two-argument callback forms without
    // requiring callers to inspect an implementation-specific class.
    if (dependencies.verifyGeneration.length >= 2) {
      result = await (
        dependencies.verifyGeneration as (
          generation: ManagedRuntimeBuiltGeneration,
          manifest: ManagedPackageManifest,
        ) => Promise<boolean | void> | boolean | void
      )(input.generation, input.manifest);
    } else {
      result = await (
        dependencies.verifyGeneration as (
          value: ManagedRuntimeVerificationInput,
        ) => Promise<boolean | void> | boolean | void
      )(input);
    }
  } catch (error) {
    if (error instanceof ManagedRuntimeError) throw error;
    throw new ManagedRuntimeError("generation_verification_failure", errorMessage(error));
  }
  if (result === false)
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation verification failed");
}

function normalizeHealthResult(
  result: ManagedRuntimeHealthCheckResult,
  candidate: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
): ManagedRuntimeHealthResult {
  if (typeof result === "boolean") return { healthy: result };
  if (result === null || typeof result !== "object")
    return { healthy: false, reason: "managed health returned an invalid result" };
  if (result.generationIdentity !== undefined && typeof result.generationIdentity !== "string") {
    return { healthy: false, reason: "managed health returned an invalid generation identity" };
  }
  if (result.storePath !== undefined && typeof result.storePath !== "string") {
    return { healthy: false, reason: "managed health returned an invalid store path" };
  }
  if (result.evidence !== undefined && typeof result.evidence !== "string") {
    return { healthy: false, reason: "managed health returned invalid evidence" };
  }
  if (result.reason !== undefined && typeof result.reason !== "string") {
    return { healthy: false, reason: "managed health returned an invalid reason" };
  }
  const candidateIdentity = candidate.generationIdentity;
  const candidateStorePath = candidate.storePath;
  const reconciliation = (result as { readonly reconciliation?: unknown }).reconciliation;
  const explicitlyUnhealthy =
    result.healthy === false ||
    result.ok === false ||
    result.status === "unhealthy" ||
    result.status === "pending" ||
    result.status === "unknown" ||
    reconciliation === "stale" ||
    reconciliation === "incompatible" ||
    (result as { readonly upgradeRequired?: unknown }).upgradeRequired === true;
  const healthy =
    !explicitlyUnhealthy &&
    (result.healthy === true ||
      result.ok === true ||
      result.status === "healthy" ||
      reconciliation === "current" ||
      reconciliation === "repairable");
  if (result.generationIdentity !== undefined && result.generationIdentity !== candidateIdentity) {
    return {
      healthy: false,
      generationIdentity: result.generationIdentity,
      reason: `managed health identified ${result.generationIdentity}, expected ${candidateIdentity}`,
    };
  }
  if (result.storePath !== undefined && !pointerMatches(result.storePath, candidateStorePath)) {
    return {
      healthy: false,
      storePath: result.storePath,
      reason: `managed health observed ${result.storePath}, expected ${candidateStorePath}`,
    };
  }
  return {
    healthy,
    ...(result.generationIdentity === undefined
      ? { generationIdentity: candidateIdentity }
      : { generationIdentity: result.generationIdentity }),
    ...(result.storePath === undefined ? { storePath: candidateStorePath } : { storePath: result.storePath }),
    ...(result.evidence === undefined ? {} : { evidence: boundedMessage(result.evidence, MAX_HEALTH_EVIDENCE_LENGTH) }),
    ...(result.reason === undefined ? {} : { reason: boundedMessage(result.reason, MAX_HEALTH_EVIDENCE_LENGTH) }),
  };
}

async function checkHealth(
  dependencies: ManagedRuntimeDependencies,
  candidate: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
): Promise<ManagedRuntimeHealthResult> {
  const check = dependencies.healthCheck ?? dependencies.health;
  if (check === undefined) return { healthy: false, reason: "managed health check is not configured" };
  try {
    return normalizeHealthResult(await check(candidate), candidate);
  } catch (error) {
    return { healthy: false, reason: errorMessage(error) };
  }
}

function persist(filePath: string, state: ManagedRuntimeState, boundaries: BoundaryOperations): void {
  try {
    writeManagedRuntimeState(filePath, state, boundaries);
  } catch (error) {
    throw new ManagedRuntimeError("state_corrupt", `managed Runtime state persistence failed: ${errorMessage(error)}`);
  }
}

function loadStateAndPointer(paths: ManagedRuntimePaths): {
  state: ManagedRuntimeState | undefined;
  pointer: string | undefined;
} {
  let state: ManagedRuntimeState | undefined;
  try {
    state = readManagedRuntimeState(paths.stateFile);
  } catch (error) {
    throw new ManagedRuntimeError("state_corrupt", errorMessage(error));
  }
  let pointer: string | undefined;
  try {
    pointer = readManagedRuntimePointer(paths.currentPointer);
  } catch (error) {
    throw new ManagedRuntimeError("pointer_corrupt", errorMessage(error));
  }
  if (state === undefined && pointer !== undefined) {
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      "managed Runtime has a current pointer but no persisted activation state",
    );
  }
  return { state, pointer };
}

function assertStablePointer(state: ManagedRuntimeState, pointer: string | undefined): void {
  const expected = state.active?.storePath;
  if (!pointerMatches(pointer, expected)) {
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      `managed Runtime current pointer does not match persisted active generation (observed=${pointer ?? "absent"}, expected=${expected ?? "absent"})`,
    );
  }
}

function assertIdleActivation(state: ManagedRuntimeState): void {
  if (
    state.activation.candidate !== undefined ||
    state.activation.previous !== undefined ||
    state.activation.transactionId !== undefined ||
    state.activation.failure !== undefined
  ) {
    throw new ManagedRuntimeError(
      "state_corrupt",
      "idle managed Runtime state contains an unfinished activation transaction",
      "idle",
    );
  }
}

function activationWithCandidate(
  candidate: ManagedRuntimeCandidate,
  previous: ManagedRuntimeGenerationRecord | undefined,
  transactionId: string,
  timestamp: string,
  phase: ManagedRuntimeActivationPhase = "prepared",
  failure?: ManagedRuntimeFailureEvidence,
): ManagedRuntimeActivation {
  return {
    phase,
    transactionId,
    candidate,
    ...(previous === undefined ? {} : { previous }),
    ...(failure === undefined ? {} : { failure }),
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

function transactionCandidate(state: ManagedRuntimeState): ManagedRuntimeCandidate {
  const candidate = state.activation.candidate;
  if (candidate === undefined) {
    throw new ManagedRuntimeError(
      "state_corrupt",
      "managed Runtime activation transaction has no candidate",
      state.activation.phase,
    );
  }
  return candidate;
}

function transactionPrevious(state: ManagedRuntimeState): ManagedRuntimeGenerationRecord | undefined {
  return state.activation.previous;
}

interface RecoveryResult {
  readonly state: ManagedRuntimeState;
  readonly pointer: string | undefined;
  readonly recovered: boolean;
  readonly rolledBack: boolean;
}

/**
 * Finish one durable transaction after a restart. No build is attempted here:
 * the persisted candidate and exact pointer identities are the recovery input.
 */
async function recoverTransaction(
  state: ManagedRuntimeState,
  pointer: string | undefined,
  paths: ManagedRuntimePaths,
  dependencies: ManagedRuntimeDependencies,
  boundaries: BoundaryOperations,
  now: () => Date,
  supportedCompatibilityVersion: number,
): Promise<RecoveryResult> {
  const phase = state.activation.phase;
  if (phase === "idle") {
    assertIdleActivation(state);
    assertStablePointer(state, pointer);
    return { state, pointer, recovered: false, rolledBack: false };
  }
  const candidate = transactionCandidate(state);
  const previous = transactionPrevious(state);
  if (state.desiredManifestSemanticIdentity !== candidate.desiredManifestSemanticIdentity) {
    throw new ManagedRuntimeError(
      "state_corrupt",
      "managed Runtime transaction candidate does not match persisted desired manifest identity",
      phase,
    );
  }
  if (candidate.compatibilityContractVersion !== supportedCompatibilityVersion) {
    throw new ManagedRuntimeError(
      "compatibility_mismatch",
      `interrupted candidate compatibility contract ${candidate.compatibilityContractVersion} is not supported (expected ${supportedCompatibilityVersion})`,
      phase,
    );
  }
  if (previous !== undefined && previous.compatibilityContractVersion !== supportedCompatibilityVersion) {
    throw new ManagedRuntimeError(
      "compatibility_mismatch",
      `rollback generation compatibility contract ${previous.compatibilityContractVersion} is not supported (expected ${supportedCompatibilityVersion})`,
      phase,
    );
  }
  const timestamp = nowIso(now);
  const expectedPreviousPath = previous?.storePath;

  const persistPhase = (
    nextPhase: ManagedRuntimeActivationPhase,
    failure?: ManagedRuntimeFailureEvidence,
  ): ManagedRuntimeState => {
    const activation = {
      ...state.activation,
      phase: nextPhase,
      ...(failure === undefined ? {} : { failure }),
      updatedAt: timestamp,
    };
    const next = stateWithActivation(state, activation, timestamp);
    persist(paths.stateFile, next, boundaries);
    return next;
  };

  const selectPreviousAndVerify = async (
    currentState: ManagedRuntimeState,
    currentPointer: string | undefined,
  ): Promise<RecoveryResult> => {
    if (previous === undefined) {
      if (currentPointer !== undefined) clearManagedRuntimePointer(paths.currentPointer, boundaries);
      const next: ManagedRuntimeState = {
        ...currentState,
        activation: withoutActivationFields(currentState.activation),
        active: undefined,
        observed: observedFor(
          undefined,
          { ...currentState, activation: withoutActivationFields(currentState.activation), active: undefined },
          nowIso(now),
          "unknown",
          "initial generation was unhealthy; bootstrap-ready recovery required",
        ),
        updatedAt: nowIso(now),
      };
      persist(paths.stateFile, next, boundaries);
      return { state: next, pointer: undefined, recovered: true, rolledBack: true };
    }
    let selected = currentPointer;
    if (!pointerMatches(selected, previous.storePath)) {
      atomicallySelectManagedRuntimeGeneration(paths.currentPointer, previous.storePath, boundaries);
      selected = previous.storePath;
    }
    const pendingTimestamp = nowIso(now);
    const pending = stateWithActivation(
      currentState,
      { ...currentState.activation, phase: "rollback-health-pending", updatedAt: pendingTimestamp },
      pendingTimestamp,
    );
    persist(paths.stateFile, pending, boundaries);
    const health = await checkHealth(dependencies, previous);
    const observed = observedFor(
      selected,
      pending,
      nowIso(now),
      health.healthy ? "healthy" : "unhealthy",
      health.reason,
    );
    if (!health.healthy) {
      const failure = failureEvidence(
        "rollback_failure",
        "rollback-health-pending",
        healthFailureMessage(health, "previous known-good generation failed recovery health"),
        nowIso(now),
        candidate,
      );
      const failed: ManagedRuntimeState = { ...pending, failure, observed, updatedAt: nowIso(now) };
      persist(paths.stateFile, failed, boundaries);
      throw new ManagedRuntimeError("rollback_failure", failure.message, "rollback-health-pending");
    }
    const restored = recordFromCandidate(candidateFromRecord(previous), nowIso(now), health.evidence);
    const committed: ManagedRuntimeState = {
      ...pending,
      active: restored,
      activation: withoutActivationFields(pending.activation),
      observed,
      updatedAt: nowIso(now),
      // Keep bounded evidence for the failed candidate, but do not claim it as active.
      failure: pending.failure,
    };
    persist(paths.stateFile, committed, boundaries);
    return { state: committed, pointer: selected, recovered: true, rolledBack: true };
  };

  const verifyCandidateAndCommit = async (
    currentState: ManagedRuntimeState,
    currentPointer: string | undefined,
  ): Promise<RecoveryResult> => {
    const pendingState =
      currentState.activation.phase === "switched-health-pending"
        ? currentState
        : persistPhase("switched-health-pending", currentState.activation.failure);
    const health = await checkHealth(dependencies, candidate);
    const observed = observedFor(
      currentPointer,
      pendingState,
      nowIso(now),
      health.healthy ? "healthy" : "unhealthy",
      health.reason,
    );
    if (!health.healthy) {
      const failure = failureEvidence(
        "health_failure",
        "rollback-pending",
        healthFailureMessage(health, "managed generation failed post-switch health"),
        nowIso(now),
        candidate,
      );
      const rollbackPending: ManagedRuntimeState = {
        ...pendingState,
        activation: { ...pendingState.activation, phase: "rollback-pending", failure, updatedAt: nowIso(now) },
        failure,
        observed,
        updatedAt: nowIso(now),
      };
      persist(paths.stateFile, rollbackPending, boundaries);
      return selectPreviousAndVerify(rollbackPending, currentPointer);
    }
    const active = recordFromCandidate(candidate, nowIso(now), health.evidence);
    const committed: ManagedRuntimeState = {
      ...pendingState,
      desiredManifestSemanticIdentity: candidate.desiredManifestSemanticIdentity,
      active,
      ...(previous === undefined ? {} : { previous }),
      activation: withoutActivationFields(pendingState.activation),
      observed: observedFor(currentPointer, pendingState, nowIso(now), "healthy", health.evidence),
      failure: undefined,
      updatedAt: nowIso(now),
    };
    persist(paths.stateFile, committed, boundaries);
    return { state: committed, pointer: currentPointer, recovered: true, rolledBack: false };
  };

  if (phase === "prepared") {
    if (pointerMatches(pointer, candidate.storePath)) return verifyCandidateAndCommit(state, pointer);
    if (pointerMatches(pointer, expectedPreviousPath)) {
      atomicallySelectManagedRuntimeGeneration(paths.currentPointer, candidate.storePath, boundaries);
      return verifyCandidateAndCommit(persistPhase("switched-health-pending"), candidate.storePath);
    }
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      `prepared activation observed an unexpected current pointer (observed=${pointer ?? "absent"})`,
      "prepared",
    );
  }

  if (phase === "switched-health-pending") {
    if (pointerMatches(pointer, candidate.storePath)) return verifyCandidateAndCommit(state, pointer);
    if (pointerMatches(pointer, expectedPreviousPath)) return selectPreviousAndVerify(state, pointer);
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      `switched activation observed an unexpected current pointer (observed=${pointer ?? "absent"})`,
      "switched-health-pending",
    );
  }

  if (phase === "rollback-pending" || phase === "rollback-health-pending") {
    if (previous === undefined) {
      if (pointer === undefined || pointerMatches(pointer, candidate.storePath))
        return selectPreviousAndVerify(state, pointer);
      throw new ManagedRuntimeError(
        "ambiguous_activation",
        `rollback activation without a previous generation observed an unexpected current pointer (observed=${pointer})`,
        phase,
      );
    }
    if (pointerMatches(pointer, expectedPreviousPath)) return selectPreviousAndVerify(state, pointer);
    // A crash may occur after the candidate pointer is removed (or before a
    // replacement pointer is visible). An absent pointer is recoverable when
    // the transaction names an exact previous target; an unrelated pointer is
    // still ambiguous and must fail closed.
    if (pointer === undefined || pointerMatches(pointer, candidate.storePath))
      return selectPreviousAndVerify(state, pointer);
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      `rollback activation observed an unexpected current pointer (observed=${pointer ?? "absent"})`,
      phase,
    );
  }

  throw new ManagedRuntimeError("state_corrupt", `unsupported activation phase ${phase}`, phase);
}

function buildDependency(
  dependencies: ManagedRuntimeDependencies,
): (manifest: ManagedPackageManifest) => Promise<ManagedRuntimeBuiltGeneration> | ManagedRuntimeBuiltGeneration {
  const build = dependencies.buildGeneration ?? dependencies.build;
  if (build === undefined) {
    throw new ManagedRuntimeError("build_failure", "managed generation build adapter is not configured");
  }
  return build;
}

function isRemoval(previous: ManagedRuntimeGenerationRecord | undefined, manifest: ManagedPackageManifest): boolean {
  if (previous?.packageIds === undefined) return false;
  const current = new Set<string>(manifest.packages.map((entry) => entry.packageId));
  return previous.packageIds.some((packageId) => !current.has(packageId));
}

function resultFromState(
  state: ManagedRuntimeState,
  paths: ManagedRuntimePaths,
  outcome: ManagedRuntimeReconcileOutcome,
): ManagedRuntimeReconcileResult {
  let pointer: string | undefined;
  try {
    pointer = readManagedRuntimePointer(paths.currentPointer);
  } catch (error) {
    throw new ManagedRuntimeError("pointer_corrupt", errorMessage(error));
  }
  return {
    ok: true,
    outcome,
    desiredManifestSemanticIdentity: state.desiredManifestSemanticIdentity,
    ...(state.active === undefined ? {} : { active: state.active }),
    ...(state.previous === undefined ? {} : { previous: state.previous }),
    ...(state.observed === undefined ? {} : { observed: state.observed }),
    status: statusFromState(state, pointer),
  };
}

function statusFromState(state: ManagedRuntimeState, pointer: string | undefined): ManagedRuntimeStatusReport {
  let observedGenerationIdentity: string | undefined;
  let observedStorePath = pointer;
  if (pointerMatches(pointer, state.active?.storePath)) observedGenerationIdentity = state.active?.generationIdentity;
  else if (pointerMatches(pointer, state.previous?.storePath))
    observedGenerationIdentity = state.previous?.generationIdentity;
  else if (pointerMatches(pointer, state.activation.candidate?.storePath))
    observedGenerationIdentity = state.activation.candidate?.generationIdentity;
  if (pointer === undefined) observedStorePath = state.observed?.currentStorePath;
  return {
    contractId: MANAGED_RUNTIME_STATE_CONTRACT_ID,
    schemaVersion: MANAGED_RUNTIME_STATE_SCHEMA_VERSION,
    present: true,
    desiredManifestSemanticIdentity: state.desiredManifestSemanticIdentity,
    ...(state.active === undefined
      ? {}
      : { activeGenerationIdentity: state.active.generationIdentity, activeStorePath: state.active.storePath }),
    ...(state.previous === undefined
      ? {}
      : { previousGenerationIdentity: state.previous.generationIdentity, previousStorePath: state.previous.storePath }),
    ...(observedGenerationIdentity === undefined ? {} : { observedGenerationIdentity }),
    ...(observedStorePath === undefined ? {} : { observedStorePath }),
    activationPhase: state.activation.phase,
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    state,
  };
}

/** Read bounded status/evidence without mutating state or guessing from the Nix store. */
export function readManagedRuntimeStatus(options: ManagedRuntimeStatusOptions = {}): ManagedRuntimeStatusReport {
  const paths = statePaths(options);
  const loaded = loadStateAndPointer(paths);
  if (loaded.state === undefined) {
    return {
      contractId: MANAGED_RUNTIME_STATE_CONTRACT_ID,
      schemaVersion: MANAGED_RUNTIME_STATE_SCHEMA_VERSION,
      present: false,
      ...(loaded.pointer === undefined ? {} : { observedStorePath: loaded.pointer }),
    };
  }
  return statusFromState(loaded.state, loaded.pointer);
}

/** Alias used by callers that name this operation `status`. */
export const managedRuntimeStatus = readManagedRuntimeStatus;

/** Read and validate the canonical desired manifest without changing it. */
export function readManagedRuntimeManifest(
  filePath = resolveManagedRuntimePaths().manifestFile,
): ManagedPackageManifest {
  return readManifestFile(filePath);
}

/**
 * Converge one Runtime against the canonical desired manifest. The function
 * owns only managed-generation selection and control-state evidence; it never
 * mutates the base appliance or persistent user/workspace data.
 */
export async function reconcileManagedRuntime(
  options: ManagedRuntimeReconcileOptions,
): Promise<ManagedRuntimeReconcileResult> {
  const boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
  const now = options.now ?? (() => new Date());
  const paths = statePaths(options);
  let loaded: { state: ManagedRuntimeState | undefined; pointer: string | undefined };
  try {
    loaded = loadStateAndPointer(paths);
  } catch (error) {
    throw error instanceof ManagedRuntimeError ? error : new ManagedRuntimeError("state_corrupt", errorMessage(error));
  }

  let state = loaded.state;
  let pointer = loaded.pointer;
  let recovered = false;
  let rolledBack = false;

  if (state !== undefined && state.activation.phase !== "idle") {
    const recovery = await recoverTransaction(
      state,
      pointer,
      paths,
      options.dependencies,
      boundaries,
      now,
      supportedGenerationCompatibilityVersion(options),
    );
    state = recovery.state;
    pointer = recovery.pointer;
    recovered = recovery.recovered;
    rolledBack = recovery.rolledBack;
  }

  let manifest: ManagedPackageManifest | undefined;
  try {
    manifest = manifestValue(options.manifest, paths.manifestFile);
    validateManifestCompatibility(manifest, options);
    assertManifestProjectable(manifest);
  } catch (error) {
    const managedError =
      error instanceof ManagedRuntimeError
        ? error
        : new ManagedRuntimeError(
            error instanceof Error && error.name === "ManagedGenerationError"
              ? "unsupported_managed_package"
              : "invalid_manifest",
            errorMessage(error),
          );
    const desiredIdentity = (() => {
      try {
        if (manifest !== undefined) return semanticIdentityOf(manifest);
        if (options.manifest !== undefined) return semanticIdentityOf(parseManagedPackageManifest(options.manifest));
        return semanticIdentityOf(readManifestFile(paths.manifestFile));
      } catch {
        return state?.desiredManifestSemanticIdentity;
      }
    })();
    if (desiredIdentity !== undefined) {
      const timestamp = nowIso(now);
      const evidence = failureEvidence(
        managedError.code === "compatibility_mismatch"
          ? "compatibility_mismatch"
          : managedError.code === "unsupported_managed_package"
            ? "unsupported_managed_package"
            : "invalid_manifest",
        "idle",
        managedError.message,
        timestamp,
      );
      const base = state ?? initialState(desiredIdentity, timestamp);
      const failed = stateWithFailure(base, desiredIdentity, evidence, timestamp, pointer);
      try {
        persist(paths.stateFile, failed, boundaries);
      } catch {
        // Preserve the original validation error; state persistence is evidence only.
      }
    }
    throw managedError;
  }

  if (manifest === undefined)
    throw new ManagedRuntimeError("invalid_manifest", "managed package manifest is unavailable");
  const desiredIdentity = semanticIdentityOf(manifest);
  if (state === undefined) state = initialState(desiredIdentity, nowIso(now));

  if (state.activation.phase === "idle") {
    try {
      assertIdleActivation(state);
      assertStablePointer(state, pointer);
    } catch (error) {
      throw error instanceof ManagedRuntimeError
        ? error
        : new ManagedRuntimeError("ambiguous_activation", errorMessage(error));
    }
  }

  // A matching active generation is a no-op only after compatibility and exact
  // managed-runtime health pass. It never invokes build or switches current.
  if (
    state.active !== undefined &&
    state.desiredManifestSemanticIdentity === desiredIdentity &&
    state.active.desiredManifestSemanticIdentity === desiredIdentity
  ) {
    const active = state.active;
    const supportedCompatibility = supportedGenerationCompatibilityVersion(options);
    if (active.compatibilityContractVersion !== supportedCompatibility) {
      const timestamp = nowIso(now);
      const evidence = failureEvidence(
        "compatibility_mismatch",
        "idle",
        `active generation compatibility contract ${active.compatibilityContractVersion} is not supported (expected ${supportedCompatibility})`,
        timestamp,
        active,
      );
      const failed = stateWithFailure(state, desiredIdentity, evidence, timestamp, pointer);
      persist(paths.stateFile, failed, boundaries);
      throw new ManagedRuntimeError("compatibility_mismatch", evidence.message);
    }
    const health = await checkHealth(options.dependencies, active);
    const timestamp = nowIso(now);
    if (health.healthy) {
      const refreshed: ManagedRuntimeState = {
        ...state,
        desiredManifestSemanticIdentity: desiredIdentity,
        active: recordFromCandidate(candidateFromRecord(active), timestamp, health.evidence),
        observed: observedFor(pointer, state, timestamp, "healthy", health.evidence),
        failure: undefined,
        updatedAt: timestamp,
      };
      persist(paths.stateFile, refreshed, boundaries);
      return resultFromState(refreshed, paths, recovered ? "recovered" : "noop");
    }
    const evidence = failureEvidence(
      "health_failure",
      "idle",
      healthFailureMessage(health, "active managed generation health failed"),
      timestamp,
      active,
    );
    const failed = stateWithFailure(state, desiredIdentity, evidence, timestamp, pointer);
    persist(paths.stateFile, failed, boundaries);
    throw new ManagedRuntimeError("health_failure", evidence.message);
  }

  let built: ManagedRuntimeBuiltGeneration;
  let candidate: ManagedRuntimeCandidate | undefined;
  try {
    const build = buildDependency(options.dependencies);
    await invokeCompatibility(options.dependencies, manifest);
    built = await build(manifest);
    const supportedCompatibility = supportedGenerationCompatibilityVersion(options);
    candidate = asCandidate(manifest, built, supportedCompatibility);
    await invokeCompatibility(options.dependencies, manifest, built);
    await invokeVerification(options.dependencies, { manifest, generation: built, candidate });
  } catch (error) {
    const managedError =
      error instanceof ManagedRuntimeError ? error : new ManagedRuntimeError("build_failure", errorMessage(error));
    const timestamp = nowIso(now);
    const failureCode: ManagedRuntimeFailureCode =
      managedError.code === "compatibility_mismatch"
        ? "compatibility_mismatch"
        : managedError.code === "unsupported_managed_package"
          ? "unsupported_managed_package"
          : managedError.code === "generation_verification_failure"
            ? "generation_verification_failure"
            : "build_failure";
    const evidence = failureEvidence(failureCode, "idle", managedError.message, timestamp, candidate);
    const failed = stateWithFailure(state, desiredIdentity, evidence, timestamp, pointer);
    try {
      persist(paths.stateFile, failed, boundaries);
    } catch {
      // Do not mask the pre-switch failure with a secondary evidence-write error.
    }
    throw managedError;
  }

  if (candidate === undefined) {
    throw new ManagedRuntimeError("generation_verification_failure", "managed generation candidate is unavailable");
  }
  let pointerAfterBuild: string | undefined;
  try {
    pointerAfterBuild = readManagedRuntimePointer(paths.currentPointer);
  } catch (error) {
    throw new ManagedRuntimeError("pointer_corrupt", errorMessage(error));
  }
  if (!pointerMatches(pointerAfterBuild, pointer)) {
    throw new ManagedRuntimeError(
      "ambiguous_activation",
      `managed generation build changed current selection unexpectedly (observed=${pointerAfterBuild ?? "absent"}, expected=${pointer ?? "absent"})`,
    );
  }
  const previous = state.active;
  const transactionId = `${nowIso(now)}-${candidate.generationIdentity.slice(0, 16)}`;
  const timestamp = nowIso(now);
  const prepared: ManagedRuntimeState = {
    ...state,
    desiredManifestSemanticIdentity: desiredIdentity,
    activation: activationWithCandidate(candidate, previous, transactionId, timestamp),
    observed: observedFor(pointer, state, timestamp, "pending"),
    failure: undefined,
    updatedAt: timestamp,
  };

  // Persist candidate and rollback identity before touching `current`.
  try {
    persist(paths.stateFile, prepared, boundaries);
  } catch (error) {
    const managedError =
      error instanceof ManagedRuntimeError
        ? error
        : new ManagedRuntimeError("state_corrupt", errorMessage(error), "prepared");
    throw managedError;
  }

  try {
    // Verify once more at the activation boundary, after durable staging. A
    // failure here is still pre-switch and leaves the previous pointer intact.
    await invokeCompatibility(options.dependencies, manifest, built);
    await invokeVerification(options.dependencies, { manifest, generation: built, candidate });
    atomicallySelectManagedRuntimeGeneration(paths.currentPointer, candidate.storePath, boundaries);
  } catch (error) {
    const managedError =
      error instanceof ManagedRuntimeError
        ? error
        : new ManagedRuntimeError("activation_failure", errorMessage(error), "prepared");
    // If pointer replacement did not commit, clear the staged transaction and
    // retain the old active/previous identities. If it did commit but phase
    // persistence failed, leave durable prepared evidence for recovery.
    let observedPointer: string | undefined;
    try {
      observedPointer = readManagedRuntimePointer(paths.currentPointer);
    } catch (error) {
      // An unreadable pointer is not evidence that the old selection survived.
      // Keep `prepared` durable so the next invocation can recover or fail
      // closed from the exact transaction identities.
      throw new ManagedRuntimeError(
        "ambiguous_activation",
        `managed Runtime current pointer could not be observed after activation failure: ${errorMessage(error)}`,
        "prepared",
      );
    }
    if (pointerMatches(observedPointer, pointer)) {
      const evidence = failureEvidence(
        managedError.code === "generation_verification_failure"
          ? "generation_verification_failure"
          : managedError.code === "compatibility_mismatch"
            ? "compatibility_mismatch"
            : "activation_failure",
        "prepared",
        managedError.message,
        nowIso(now),
        candidate,
      );
      const failed = stateWithFailure(state, desiredIdentity, evidence, nowIso(now), pointer);
      try {
        persist(paths.stateFile, failed, boundaries);
      } catch {
        // Keep the primary activation/pre-switch error.
      }
    }
    throw managedError;
  }

  pointer = candidate.storePath;
  const switchedTimestamp = nowIso(now);
  const switched: ManagedRuntimeState = stateWithActivation(
    prepared,
    { ...prepared.activation, phase: "switched-health-pending" },
    switchedTimestamp,
  );
  // If this write is interrupted, the persisted `prepared` state plus the
  // exact candidate pointer gives recoverTransaction an unambiguous path.
  try {
    persist(paths.stateFile, switched, boundaries);
  } catch (error) {
    throw error instanceof ManagedRuntimeError
      ? error
      : new ManagedRuntimeError("state_corrupt", errorMessage(error), "switched-health-pending");
  }

  const health = await checkHealth(options.dependencies, candidate);
  const healthTimestamp = nowIso(now);
  const observed = observedFor(
    pointer,
    switched,
    healthTimestamp,
    health.healthy ? "healthy" : "unhealthy",
    health.reason,
  );
  if (!health.healthy) {
    const failure = failureEvidence(
      "health_failure",
      "rollback-pending",
      healthFailureMessage(health, "managed generation failed post-switch health"),
      healthTimestamp,
      candidate,
    );
    const rollbackPending: ManagedRuntimeState = {
      ...switched,
      activation: { ...switched.activation, phase: "rollback-pending", failure, updatedAt: healthTimestamp },
      failure,
      observed,
      updatedAt: healthTimestamp,
    };
    persist(paths.stateFile, rollbackPending, boundaries);
    const recovery = await recoverTransaction(
      rollbackPending,
      pointer,
      paths,
      options.dependencies,
      boundaries,
      now,
      supportedGenerationCompatibilityVersion(options),
    );
    if (recovery.rolledBack) {
      throw new ManagedRuntimeError("health_failure", failure.message, "rollback-pending");
    }
    throw new ManagedRuntimeError(
      "rollback_failure",
      "managed generation rollback did not complete",
      "rollback-pending",
    );
  }

  const committed: ManagedRuntimeState = {
    ...switched,
    active: recordFromCandidate(candidate, healthTimestamp, health.evidence),
    ...(previous === undefined ? {} : { previous }),
    activation: withoutActivationFields(switched.activation),
    observed,
    failure: undefined,
    updatedAt: healthTimestamp,
  };
  persist(paths.stateFile, committed, boundaries);
  const outcome: ManagedRuntimeReconcileOutcome =
    previous === undefined ? "initialized" : isRemoval(previous, manifest) ? "removed" : "updated";
  return resultFromState(committed, paths, rolledBack ? "rolled-back" : recovered ? "recovered" : outcome);
}

/** Explicit recovery entrypoint; it never starts a new build for an interrupted transaction. */
export async function recoverManagedRuntime(
  options: ManagedRuntimeReconcileOptions,
): Promise<ManagedRuntimeReconcileResult> {
  const boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
  const now = options.now ?? (() => new Date());
  const paths = statePaths(options);
  const loaded = loadStateAndPointer(paths);
  if (loaded.state === undefined || loaded.state.activation.phase === "idle") {
    // There is no durable transaction to recover. Fall through to the normal
    // lifecycle so a fresh deployment can still initialize and an idle state
    // can perform its ordinary health/no-op/update decision.
    return reconcileManagedRuntime(options);
  }
  const recovery = await recoverTransaction(
    loaded.state,
    loaded.pointer,
    paths,
    options.dependencies,
    boundaries,
    now,
    supportedGenerationCompatibilityVersion(options),
  );
  return resultFromState(recovery.state, paths, recovery.rolledBack ? "rolled-back" : "recovered");
}

/** Stateful facade for guest services that perform repeated reconcile/status calls. */
export class ManagedRuntimeReconciler {
  constructor(private readonly options: ManagedRuntimeReconcileOptions) {}

  reconcile(manifest?: unknown): Promise<ManagedRuntimeReconcileResult> {
    return reconcileManagedRuntime(manifest === undefined ? this.options : { ...this.options, manifest });
  }

  recover(manifest?: unknown): Promise<ManagedRuntimeReconcileResult> {
    return recoverManagedRuntime(manifest === undefined ? this.options : { ...this.options, manifest });
  }

  status(): ManagedRuntimeStatusReport {
    return readManagedRuntimeStatus(this.options);
  }
}

export function createManagedRuntimeReconciler(options: ManagedRuntimeReconcileOptions): ManagedRuntimeReconciler {
  return new ManagedRuntimeReconciler(options);
}

/** Naming aliases kept for callers that use the lifecycle terminology from the authority docs. */
export const runManagedRuntimeReconcile = reconcileManagedRuntime;
export const reconcileManagedRuntimeState = reconcileManagedRuntime;

export * from "./managed-runtime-state.js";
