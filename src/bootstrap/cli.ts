import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import { buildManagedGeneration } from "../runtime-contract/managed-generation-build.js";
import type { BuildManagedGenerationOptions, BuiltManagedGeneration } from "../runtime-contract/managed-generation-build.js";
import { ManagedRuntimeError, reconcileManagedRuntime } from "../runtime-contract/managed-runtime.js";
import type {
  ManagedRuntimeBuiltGeneration,
  ManagedRuntimeCandidate,
  ManagedRuntimeGenerationRecord,
  ManagedRuntimeHealthCheckResult,
  ManagedRuntimeReconcileResult,
} from "../runtime-contract/managed-runtime.js";
import type { ManagedPackageManifest } from "../runtime-contract/managed-package-manifest.js";
import { defaultBootstrapDependencies, readBootstrapStatus, runBootstrapBuild, verifyBootstrap } from "./build.js";
import { BootstrapError } from "./errors.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";
import { resolveMottainaiSource } from "./source-resolution.js";
import type { ResolveMottainaiSourceOptions, ResolvedMottainaiSource } from "./source-resolution.js";
import { UnreadableManifest } from "./unreadable-manifest.js";

/**
 * Narrow bootstrap dispatcher (Issue #626, extended by Issue #642's
 * reconcile composition): `build` / `status` / `verify` / `reconcile` —
 * still no task/session/manager/package-catalog UX. Deliberately does NOT
 * import src/cli.ts, src/index.ts, or any manager/workflow/task-session
 * module: that independence is what lets this CLI work without full
 * `mottainai` installed. Local flag-parsing helpers are re-implemented here
 * rather than imported from src/cli.ts for the same reason.
 *
 * The production state path is always CANONICAL_BOOTSTRAP_STATE_FILE_PATH
 * — there is no `--state-file` flag and no environment-variable override.
 * A single invocation must never be able to redirect governed bootstrap
 * state into an arbitrary workspace path. `reconcile` is the same
 * boundary: it never overrides `reconcileManagedRuntime`'s state
 * directory/file/pointer/manifest paths, so it always targets the
 * canonical `/var/lib/mottainai-control/managed-runtime` state Issue #628
 * defaults to.
 */

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function requireFlagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * nix/bootstrap.nix's installPhase copies Issue #625's Nix projection
 * (flake.nix, flake.lock, managed-generation.nix, mottainai.nix,
 * packages/nawabari.nix) into a `nix-projection/nix/` directory sibling to
 * this compiled file's own directory (`$packageRoot/nix-projection/nix`,
 * next to `$packageRoot/bootstrap/main.js`) — a self-contained git working
 * tree `buildManagedGeneration`'s `builtins.getFlake` can resolve with no
 * repository checkout anywhere else on the deployed host (PR review
 * finding P0-1). This is checked first; a development/CI invocation (via
 * scripts/bootstrap.mjs, run directly against uncompiled `src/bootstrap/`)
 * has no such sibling directory, so falls back to `process.cwd()` matching
 * scripts/build-managed-generation.mjs's own convention of being run from
 * the repository root. `--repo-root` remains available to override either
 * default explicitly.
 */
function repoRootForNixInvocation(): string {
  const packagedProjectionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "nix-projection");
  if (fs.existsSync(path.join(packagedProjectionRoot, "nix", "flake.nix"))) {
    return packagedProjectionRoot;
  }
  return process.cwd();
}

/** Positional arguments: every token that isn't a recognized `--flag` and isn't that flag's value. */
function positionalArgs(argv: readonly string[], flagsWithValues: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      if (flagsWithValues.includes(token.slice(2))) index += 1;
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

async function runBuildCommand(argv: readonly string[]): Promise<number> {
  const manifestPath = positionalArgs(argv, ["system", "repo-root"])[0];
  const system = requireFlagValue(argv, "system");
  const repoRoot = requireFlagValue(argv, "repo-root") ?? repoRootForNixInvocation();
  const json = hasFlag(argv, "json");

  if (manifestPath === undefined || system === undefined) {
    process.stderr.write("usage: bootstrap build <manifest-path> --system <system> [--repo-root <path>] [--json]\n");
    return 1;
  }

  // A manifest file that cannot be read or does not parse as JSON is not
  // special-cased here: it is wrapped as an UnreadableManifest sentinel that
  // runBootstrapBuild recognizes and rejects through its normal
  // lastAttempt-persisting path (PR review finding P1-4 — previously this
  // returned before runBootstrapBuild was ever called, so no lastAttempt
  // was persisted for this specific failure, including a first-ever attempt
  // before any bootstrap state exists).
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  } catch (error) {
    manifestValue = new UnreadableManifest(error instanceof Error ? error.message : String(error));
  }

  const deps = defaultBootstrapDependencies({
    stateFilePath: CANONICAL_BOOTSTRAP_STATE_FILE_PATH,
    boundaries: DIRECT_BOUNDARIES,
    repoRoot,
    system,
    // CI=true: nix/mottainai.nix's build reads the repository's own
    // node_modules via `source = ../.`; a locally pnpm-installed
    // node_modules otherwise makes pnpm prompt interactively to remove it.
    env: { ...process.env, CI: "true" },
  });

  try {
    const state = await runBootstrapBuild(manifestValue, deps);
    if (json) printJson(state);
    else process.stdout.write(`bootstrap build succeeded: generationIdentity=${state.lastSuccessfulBuild?.generationIdentity}\n`);
    return 0;
  } catch (error) {
    const bootstrapError = error instanceof BootstrapError ? error : new BootstrapError("nix_generation_build_failure", String(error));
    if (json) printJson({ code: bootstrapError.code, message: bootstrapError.message });
    else process.stderr.write(`${bootstrapError.code}: ${bootstrapError.message}\n`);
    return 1;
  }
}

function runStatusCommand(argv: readonly string[]): number {
  const json = hasFlag(argv, "json");
  try {
    const report = readBootstrapStatus({ stateFilePath: CANONICAL_BOOTSTRAP_STATE_FILE_PATH });
    if (json) printJson(report);
    else process.stdout.write(report.present ? `present: last attempt outcome=${report.state?.lastAttempt.outcome}\n` : "present: false\n");
    return 0;
  } catch (error) {
    const bootstrapError = error instanceof BootstrapError ? error : new BootstrapError("bootstrap_state_corruption", String(error));
    if (json) printJson({ code: bootstrapError.code, message: bootstrapError.message });
    else process.stderr.write(`${bootstrapError.code}: ${bootstrapError.message}\n`);
    return 1;
  }
}

async function runVerifyCommand(argv: readonly string[]): Promise<number> {
  const json = hasFlag(argv, "json");
  try {
    const report = await verifyBootstrap({ stateFilePath: CANONICAL_BOOTSTRAP_STATE_FILE_PATH });
    if (json) printJson(report);
    else process.stdout.write(`verified: ${report.verified}${report.reason ? ` (${report.reason})` : ""}\n`);
    return report.verified ? 0 : 1;
  } catch (error) {
    const bootstrapError = error instanceof BootstrapError ? error : new BootstrapError("bootstrap_state_corruption", String(error));
    if (json) printJson({ code: bootstrapError.code, message: bootstrapError.message });
    else process.stderr.write(`${bootstrapError.code}: ${bootstrapError.message}\n`);
    return 1;
  }
}

/**
 * Real, side-effect-free proof that a managed generation's binary is
 * genuinely executable at its exact resolved store path — `--version` is
 * the same minimal "does this exact package actually run" probe
 * nix/packages/nawabari.nix's own installCheckPhase already treats as
 * sufficient (`test "$($out/bin/nawabari --version)" = "${version}"`), not
 * a deeper application-level check. This does not compare against the
 * currently desired manifest version: during rollback recovery this same
 * function verifies the *previous* known-good generation, whose version
 * may legitimately differ from the (now-reverted) desired manifest.
 */
function verifyManagedBinaryExecutes(storePath: string, packageId: string): string | undefined {
  const binaryPath = path.join(storePath, "bin", packageId);
  try {
    const output = execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    return output.length === 0 ? `${packageId} at ${binaryPath} reported an empty --version output` : undefined;
  } catch (error) {
    return `${packageId} at ${binaryPath} failed to execute: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * #628's healthCheck adapter: resolves every package the candidate declares
 * through its own store path, never ambient PATH. A candidate that declares
 * NO package identities (`packageIds` absent or empty — schema-legal, e.g.
 * an empty-`packages` desired manifest) fails closed rather than reporting
 * vacuous health: docs/runtime-lifecycle.md's "Managed health" requires
 * this check to "prove the application generation is executable", and a
 * generation with nothing to execute cannot be proven anything, so it must
 * never be silently promoted to known-good on that basis (review response:
 * a prior revision looped `packageIds ?? []`, which reported `healthy:
 * true` for zero packages without verifying anything at all).
 */
export function reconcileHealthCheck(
  generation: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
): ManagedRuntimeHealthCheckResult {
  const packageIds = generation.packageIds ?? [];
  if (packageIds.length === 0) {
    return {
      healthy: false,
      generationIdentity: generation.generationIdentity,
      storePath: generation.storePath,
      reason: "managed generation declares no package identities to verify",
    };
  }
  for (const packageId of packageIds) {
    const failure = verifyManagedBinaryExecutes(generation.storePath, packageId);
    if (failure !== undefined) {
      return {
        healthy: false,
        generationIdentity: generation.generationIdentity,
        storePath: generation.storePath,
        reason: failure,
      };
    }
  }
  return { healthy: true, generationIdentity: generation.generationIdentity, storePath: generation.storePath };
}

/**
 * Injectable seam for `runReconcile`'s composition below. Production
 * (`runReconcileCommand`) never overrides any of these — real GitHub-tag
 * source resolution, real `nix build`, real `--version` executable proof.
 * Tests inject fakes here to exercise the real adapter-shaping/composition
 * logic (reconcileBuildGeneration/reconcileHealthCheck) and #628's
 * reconcileManagedRuntime state machine together, without a Nix toolchain.
 */
export interface ReconcileCommandDependencies {
  readonly resolveSource?: (options: ResolveMottainaiSourceOptions) => Promise<ResolvedMottainaiSource>;
  readonly runManagedGenerationBuild?: (options: BuildManagedGenerationOptions) => Promise<BuiltManagedGeneration>;
  readonly healthCheck?: (
    generation: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord,
  ) => Promise<ManagedRuntimeHealthCheckResult> | ManagedRuntimeHealthCheckResult;
}

/**
 * #628's buildGeneration adapter: resolves the manifest's exact requested
 * Mottainai source the same way `bootstrap build` does
 * (src/bootstrap/build.ts's runBootstrapBuild) — real GitHub-tag source
 * resolution via source-resolution.ts, never a caller-supplied override —
 * then delegates to #625/#626's build interface.
 */
async function reconcileBuildGeneration(
  manifest: ManagedPackageManifest,
  options: {
    readonly system: string;
    readonly repoRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly resolveSource: (options: ResolveMottainaiSourceOptions) => Promise<ResolvedMottainaiSource>;
    readonly runManagedGenerationBuild: (options: BuildManagedGenerationOptions) => Promise<BuiltManagedGeneration>;
  },
): Promise<ManagedRuntimeBuiltGeneration> {
  const mottainaiEntry = manifest.packages.find((entry) => entry.packageId === "mottainai");
  let mottainaiSourcePath = options.repoRoot;
  if (mottainaiEntry !== undefined) {
    const destinationDirectory = path.join(os.tmpdir(), `mottainai-reconcile-source-${process.pid}`);
    const resolved = await options.resolveSource({
      requestedVersion: mottainaiEntry.version,
      expectedSourceSha256: mottainaiEntry.source.sourceSha256,
      destinationDirectory,
    });
    mottainaiSourcePath = resolved.sourcePath;
  }
  const built = await options.runManagedGenerationBuild({
    repoRoot: options.repoRoot,
    manifest,
    system: options.system,
    mottainaiSourcePath,
    env: options.env,
  });
  return {
    generationIdentity: built.generationIdentity,
    storePath: built.metadata.nixOutput.storePath,
    metadata: built.metadata,
    compatibilityContractVersion: built.metadata.compatibilityContractVersion,
  };
}

export interface RunReconcileOptions {
  readonly system: string;
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dependencies?: ReconcileCommandDependencies;
  /**
   * Test-only DI seam mirroring reconcileManagedRuntime's own
   * ManagedRuntimeReconcileOptions — `runReconcileCommand` (the real CLI
   * entrypoint) never sets either of these from argv, so the canonical
   * `/var/lib/mottainai-control/managed-runtime` state root and manifest
   * remain the only production target.
   */
  readonly stateDirectory?: string;
  readonly manifest?: unknown;
}

/**
 * Composes #626's build interface with #628's already-implemented
 * `reconcileManagedRuntime` state machine (src/runtime-contract/managed-runtime.ts)
 * into the one guest-invokable command that converges the managed Runtime
 * toward its canonical desired manifest — the orchestration
 * docs/runtime-lifecycle.md's "Command responsibility" section anticipates
 * ("a future full Mottainai command may name that orchestration init or
 * reconcile"). This performs real activation: build/verify, atomic switch,
 * managed-runtime health, and rollback on a post-switch health failure —
 * never a partial/simulated result. Exported so tests can exercise this
 * exact composition (initialize/noop/update/rollback) with injected
 * build/health dependencies, without a Nix toolchain or `#630`'s VM
 * harness — `runReconcileCommand` below is a thin argv-parsing wrapper
 * over this function using only the real defaults.
 */
export async function runReconcile(options: RunReconcileOptions): Promise<ManagedRuntimeReconcileResult> {
  const resolveSource = options.dependencies?.resolveSource ?? resolveMottainaiSource;
  const runManagedGenerationBuild = options.dependencies?.runManagedGenerationBuild ?? buildManagedGeneration;
  const healthCheck = options.dependencies?.healthCheck ?? reconcileHealthCheck;
  return reconcileManagedRuntime({
    ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    dependencies: {
      buildGeneration: (manifest) =>
        reconcileBuildGeneration(manifest, {
          system: options.system,
          repoRoot: options.repoRoot,
          env: options.env,
          resolveSource,
          runManagedGenerationBuild,
        }),
      healthCheck,
    },
  });
}

async function runReconcileCommand(argv: readonly string[]): Promise<number> {
  const system = requireFlagValue(argv, "system");
  const repoRoot = requireFlagValue(argv, "repo-root") ?? repoRootForNixInvocation();
  const json = hasFlag(argv, "json");

  if (system === undefined) {
    process.stderr.write("usage: bootstrap reconcile --system <system> [--repo-root <path>] [--json]\n");
    return 1;
  }

  // CI=true: nix/mottainai.nix's build reads the repository's own
  // node_modules via `source = ../.`; a locally pnpm-installed
  // node_modules otherwise makes pnpm prompt interactively to remove it.
  const env = { ...process.env, CI: "true" };

  try {
    const result = await runReconcile({ system, repoRoot, env });
    if (json) printJson(result);
    else process.stdout.write(`reconcile ${result.outcome}: active=${result.active?.generationIdentity ?? "<none>"}\n`);
    return 0;
  } catch (error) {
    const managedError =
      error instanceof ManagedRuntimeError
        ? error
        : new ManagedRuntimeError("build_failure", error instanceof Error ? error.message : String(error));
    if (json) printJson({ code: managedError.code, message: managedError.message });
    else process.stderr.write(`${managedError.code}: ${managedError.message}\n`);
    return 1;
  }
}

export async function runBootstrapCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "build":
      return runBuildCommand(rest);
    case "status":
      return runStatusCommand(rest);
    case "verify":
      return runVerifyCommand(rest);
    case "reconcile":
      return runReconcileCommand(rest);
    default:
      process.stderr.write(`unknown bootstrap command: ${command ?? "<none>"} (expected build, status, verify, or reconcile)\n`);
      return 1;
  }
}
