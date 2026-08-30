import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BoundaryOperations } from "../boundary.js";
import { buildManagedGeneration, ManagedGenerationBuildError } from "../runtime-contract/managed-generation-build.js";
import type { BuildManagedGenerationOptions, BuiltManagedGeneration } from "../runtime-contract/managed-generation-build.js";
import { assertManifestProjectable, ManagedGenerationError } from "../runtime-contract/managed-generation.js";
import {
  ManagedPackageManifestError,
  parseManagedPackageManifest,
  semanticIdentityOf,
} from "../runtime-contract/managed-package-manifest.js";
import type { ManagedPackageManifest } from "../runtime-contract/managed-package-manifest.js";
import { BootstrapError } from "./errors.js";
import { resolveMottainaiSource } from "./source-resolution.js";
import { UnreadableManifest } from "./unreadable-manifest.js";
import type { ResolveMottainaiSourceOptions, ResolvedMottainaiSource } from "./source-resolution.js";
import { BootstrapStateError, readBootstrapState, writeBootstrapState } from "./state.js";
import type { BootstrapLastAttempt, BootstrapLastSuccessfulBuild, BootstrapState } from "./state.js";

/**
 * Orchestrates Issue #626's convergence loop: parse #624's manifest ->
 * resolve the exact requested Mottainai source -> invoke #625's build
 * interface -> verify the result -> persist bounded bootstrap evidence.
 * This is the one place that owns manifest parsing, unsupported-package
 * classification, and BootstrapError-code mapping — the modules it calls
 * (managed-generation-build.ts, source-resolution.ts) deliberately do not
 * know about BootstrapError themselves.
 */

export interface BootstrapDependencies {
  readonly resolveSource: (options: ResolveMottainaiSourceOptions) => Promise<ResolvedMottainaiSource>;
  readonly runManagedGenerationBuild: (options: BuildManagedGenerationOptions) => Promise<BuiltManagedGeneration>;
  /** Production callers pass paths.ts's CANONICAL_BOOTSTRAP_STATE_FILE_PATH; tests inject a temp path directly. */
  readonly stateFilePath: string;
  readonly boundaries: BoundaryOperations;
  readonly now: () => Date;
  readonly repoRoot: string;
  readonly system: string;
  /**
   * Environment for the `nix build` subprocess this ultimately drives
   * (see runtime-contract/managed-generation-build.ts). This module never
   * reads `process.env` itself — the CLI boundary (src/bootstrap/cli.ts)
   * constructs it from the host process's own environment plus `CI=true`,
   * matching this repository's documented environment-boundary convention.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Injectable Nix-availability probe, defaults to `execFileSync("nix", ["--version"])`. */
  readonly checkNixAvailable?: () => void;
}

export function defaultBootstrapDependencies(
  overrides: Pick<BootstrapDependencies, "stateFilePath" | "boundaries" | "repoRoot" | "system" | "env">,
): BootstrapDependencies {
  return {
    resolveSource: resolveMottainaiSource,
    runManagedGenerationBuild: buildManagedGeneration,
    now: () => new Date(),
    checkNixAvailable: () => {
      execFileSync("nix", ["--version"], { stdio: "ignore" });
    },
    ...overrides,
  };
}

export interface BootstrapStatusReport {
  readonly contractId: "mottainai.bootstrap-state.v1";
  readonly schemaVersion: 1;
  readonly present: boolean;
  readonly state?: BootstrapState;
}

export interface BootstrapVerifyReport {
  readonly contractId: "mottainai.bootstrap-state.v1";
  readonly schemaVersion: 1;
  readonly verified: boolean;
  readonly reason?: string;
  readonly state?: BootstrapState;
}

/**
 * `ManagedGenerationError` reaching here only ever comes from
 * assertManifestProjectable (called directly in runBootstrapBuild, BEFORE
 * buildManagedGeneration runs) — genuinely "no recipe for this package",
 * so it always maps to unsupported_managed_package. The THREE post-build
 * verification failures inside buildManagedGeneration (malformed metadata,
 * source-integrity mismatch, resolved-version mismatch) no longer surface
 * as raw ManagedGenerationError: managed-generation-build.ts catches each
 * at its own call site and re-throws ManagedGenerationBuildError with a
 * `phase` discriminant instead (PR review finding P1-3 — these three cases
 * were previously misclassified as unsupported_managed_package because
 * this function checked `instanceof ManagedGenerationError` before
 * `instanceof ManagedGenerationBuildError`).
 */
function toBootstrapError(error: unknown, fallbackCode: BootstrapError["code"]): BootstrapError {
  if (error instanceof BootstrapError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ManagedPackageManifestError) return new BootstrapError("invalid_manifest", message);
  if (error instanceof ManagedGenerationBuildError) {
    switch (error.phase) {
      case "metadata":
        return new BootstrapError("malformed_generation_metadata", message);
      case "source_integrity":
        return new BootstrapError("source_integrity_mismatch", message);
      case "resolved_version":
        return new BootstrapError("requested_resolved_version_mismatch", message);
      case "nix_build":
        return new BootstrapError("nix_generation_build_failure", message);
    }
  }
  if (error instanceof ManagedGenerationError) return new BootstrapError("unsupported_managed_package", message);
  if (error instanceof BootstrapStateError) return new BootstrapError("bootstrap_state_corruption", message);
  return new BootstrapError(fallbackCode, message);
}

/**
 * lastAttempt.message is bounded to 2048 chars by BootstrapStateSchema
 * (state.ts) — a long Nix/subprocess/fetch error message (plausible: Nix
 * build failures can emit long stderr-derived messages) must never be
 * persisted verbatim, or the resulting state.json would itself violate its
 * own schema and fail a later readBootstrapState call (PR review finding
 * P1-6). Truncation is simple, deterministic slicing — never clever — to a
 * fixed length safely below the 2048 bound, with an indicator suffix when
 * truncation actually occurred.
 */
const MAX_PERSISTED_ATTEMPT_MESSAGE_LENGTH = 2000 as const;
const TRUNCATION_INDICATOR = "...[truncated]" as const;

function truncateAttemptMessage(message: string): string {
  if (message.length <= MAX_PERSISTED_ATTEMPT_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_PERSISTED_ATTEMPT_MESSAGE_LENGTH)}${TRUNCATION_INDICATOR}`;
}

function failureAttempt(
  error: BootstrapError,
  desiredManifestSemanticIdentity: string | undefined,
  completedAt: string,
): BootstrapLastAttempt {
  return {
    completedAt,
    outcome: "failure",
    // errorCode comes from `error.code` directly, independent of the
    // (possibly truncated) message below — the original failure category
    // stays fully observable even when the message text is cut.
    errorCode: error.code,
    message: truncateAttemptMessage(error.message),
    ...(desiredManifestSemanticIdentity === undefined ? {} : { desiredManifestSemanticIdentity }),
  };
}

/**
 * Runs one full bootstrap `build` attempt and persists the outcome
 * atomically. Always writes bootstrap state — success or failure,
 * including a first-ever attempt that fails before a manifest identity
 * exists — but a failed attempt never erases a previously recorded
 * `lastSuccessfulBuild`.
 */
export async function runBootstrapBuild(manifestValue: unknown, deps: BootstrapDependencies): Promise<BootstrapState> {
  // Read existing state first so a prior lastSuccessfulBuild survives this
  // run's outcome regardless of whether this run succeeds or fails. A
  // corrupt existing state file fails closed here rather than being
  // silently discarded and overwritten.
  let previousState: BootstrapState | undefined;
  try {
    previousState = readBootstrapState(deps.stateFilePath);
  } catch (error) {
    throw toBootstrapError(error, "bootstrap_state_corruption");
  }

  const completedAt = deps.now().toISOString();
  let desiredManifestSemanticIdentity: string | undefined;

  const persistFailure = (error: BootstrapError): never => {
    const state: BootstrapState = {
      contractId: "mottainai.bootstrap-state.v1",
      schemaVersion: 1,
      lastAttempt: failureAttempt(error, desiredManifestSemanticIdentity, completedAt),
      ...(previousState?.lastSuccessfulBuild === undefined ? {} : { lastSuccessfulBuild: previousState.lastSuccessfulBuild }),
    };
    try {
      writeBootstrapState(deps.stateFilePath, state, deps.boundaries);
    } catch {
      // The original failure (error) is what the caller must see — a
      // secondary failure persisting evidence of it (disk full, permission
      // denied, etc.) must never mask or reclassify it as some unrelated
      // code (e.g. cli.ts's outer catch defaulting to
      // nix_generation_build_failure for any non-BootstrapError). Best
      // effort only; the original error always wins.
    }
    throw error;
  };

  if (manifestValue instanceof UnreadableManifest) {
    return persistFailure(new BootstrapError("invalid_manifest", `manifest file cannot be read: ${manifestValue.reason}`));
  }

  let manifest: ManagedPackageManifest;
  try {
    manifest = parseManagedPackageManifest(manifestValue);
  } catch (error) {
    return persistFailure(toBootstrapError(error, "invalid_manifest"));
  }

  desiredManifestSemanticIdentity = semanticIdentityOf(manifest);

  try {
    assertManifestProjectable(manifest);
  } catch (error) {
    return persistFailure(toBootstrapError(error, "unsupported_managed_package"));
  }

  const mottainaiEntry = manifest.packages.find((entry) => entry.packageId === "mottainai");
  let resolvedSource: ResolvedMottainaiSource | undefined;
  let sourceDirectory: string | undefined;

  if (mottainaiEntry !== undefined) {
    sourceDirectory = path.join(os.tmpdir(), `mottainai-bootstrap-source-${process.pid}`);
    try {
      resolvedSource = await deps.resolveSource({
        requestedVersion: mottainaiEntry.version,
        expectedSourceSha256: mottainaiEntry.source.sourceSha256,
        destinationDirectory: sourceDirectory,
      });
    } catch (error) {
      return persistFailure(toBootstrapError(error, "source_resolution_failure"));
    }
  }

  const checkNixAvailable = deps.checkNixAvailable ?? (() => execFileSync("nix", ["--version"], { stdio: "ignore" }));
  try {
    checkNixAvailable();
  } catch (error) {
    return persistFailure(
      new BootstrapError(
        "unavailable_nix_prerequisite",
        `nix is not available: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  let built: BuiltManagedGeneration;
  try {
    built = await deps.runManagedGenerationBuild({
      repoRoot: deps.repoRoot,
      manifest,
      system: deps.system,
      // nix/managed-generation.nix's mottainaiSource argument is lazily
      // evaluated (only forced when a manifest entry actually names
      // packageId "mottainai"); when the manifest has no such entry, this
      // path is never dereferenced, so any valid Nix path placeholder is
      // safe here — deps.repoRoot always exists.
      mottainaiSourcePath: resolvedSource?.sourcePath ?? deps.repoRoot,
      env: deps.env,
    });
  } catch (error) {
    return persistFailure(toBootstrapError(error, "nix_generation_build_failure"));
  }

  const lastSuccessfulBuild: BootstrapLastSuccessfulBuild = {
    completedAt,
    desiredManifestSemanticIdentity,
    // Omit the key entirely (rather than writing empty-string placeholders)
    // when the manifest had no `mottainai` entry, e.g. a Nawabari-only
    // manifest — matches managed-package-manifest.ts's canonicalizePackageEntries
    // conditional-spread style. Empty strings would fail lastSuccessfulBuildSchema's
    // own non-empty/hex constraints (PR review finding P1-5).
    ...(mottainaiEntry !== undefined && resolvedSource !== undefined
      ? {
          resolvedMottainaiSource: {
            version: mottainaiEntry.version,
            narHashSha256: resolvedSource.narHashSha256,
          },
        }
      : {}),
    generationIdentity: built.generationIdentity,
    generationStorePath: built.metadata.nixOutput.storePath,
  };

  const state: BootstrapState = {
    contractId: "mottainai.bootstrap-state.v1",
    schemaVersion: 1,
    lastAttempt: { completedAt, outcome: "success", desiredManifestSemanticIdentity },
    lastSuccessfulBuild,
  };
  writeBootstrapState(deps.stateFilePath, state, deps.boundaries);
  return state;
}

export function readBootstrapStatus(deps: Pick<BootstrapDependencies, "stateFilePath">): BootstrapStatusReport {
  let state: BootstrapState | undefined;
  try {
    state = readBootstrapState(deps.stateFilePath);
  } catch (error) {
    throw toBootstrapError(error, "bootstrap_state_corruption");
  }
  if (state === undefined) {
    return { contractId: "mottainai.bootstrap-state.v1", schemaVersion: 1, present: false };
  }
  return { contractId: "mottainai.bootstrap-state.v1", schemaVersion: 1, present: true, state };
}

/**
 * Lighter than a full rebuild: re-checks that the persisted state parses
 * and, if it names a generation store path, that the store path still
 * resolves via `nix path-info`. Never touches the network or re-fetches
 * source.
 */
export async function verifyBootstrap(
  deps: Pick<BootstrapDependencies, "stateFilePath"> & { readonly checkStorePath?: (storePath: string) => boolean },
): Promise<BootstrapVerifyReport> {
  let state: BootstrapState | undefined;
  try {
    state = readBootstrapState(deps.stateFilePath);
  } catch (error) {
    throw toBootstrapError(error, "bootstrap_state_corruption");
  }
  if (state === undefined) {
    return { contractId: "mottainai.bootstrap-state.v1", schemaVersion: 1, verified: false, reason: "bootstrap has never been attempted" };
  }
  if (state.lastSuccessfulBuild === undefined) {
    return {
      contractId: "mottainai.bootstrap-state.v1",
      schemaVersion: 1,
      verified: false,
      reason: "no successful build has been recorded yet",
      state,
    };
  }
  const checkStorePath =
    deps.checkStorePath ??
    ((storePath: string) => {
      try {
        execFileSync("nix", ["path-info", storePath], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
  const storePathValid = checkStorePath(state.lastSuccessfulBuild.generationStorePath);
  if (!storePathValid) {
    return {
      contractId: "mottainai.bootstrap-state.v1",
      schemaVersion: 1,
      verified: false,
      reason: `recorded generation store path is no longer valid: ${state.lastSuccessfulBuild.generationStorePath}`,
      state,
    };
  }
  return { contractId: "mottainai.bootstrap-state.v1", schemaVersion: 1, verified: true, state };
}
