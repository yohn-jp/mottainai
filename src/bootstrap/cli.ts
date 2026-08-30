import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import { buildManagedGeneration } from "../runtime-contract/managed-generation-build.js";
import type {
  ManagedRuntimeBuiltGeneration,
  ManagedRuntimeCandidate,
  ManagedRuntimeGenerationRecord,
  ManagedRuntimeHealthResult,
} from "../runtime-contract/managed-runtime.js";
import { reconcileManagedRuntime } from "../runtime-contract/managed-runtime.js";
import type { ManagedPackageManifest } from "../runtime-contract/managed-package-manifest.js";
import { defaultBootstrapDependencies, readBootstrapStatus, runBootstrapBuild, verifyBootstrap } from "./build.js";
import { BootstrapError } from "./errors.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";
import { resolveMottainaiSource } from "./source-resolution.js";
import { UnreadableManifest } from "./unreadable-manifest.js";

/**
 * Narrow bootstrap dispatcher (Issue #626, extended by Issue #630's
 * end-to-end evidence): `build` / `status` / `verify` / `reconcile`.
 * Deliberately does NOT import src/cli.ts, src/index.ts, or any
 * manager/workflow/task-session module: that independence is what lets
 * this CLI work without full `mottainai` installed. Local flag-parsing
 * helpers are re-implemented here rather than imported from src/cli.ts for
 * the same reason.
 *
 * The production state path is always CANONICAL_BOOTSTRAP_STATE_FILE_PATH
 * — there is no `--state-file` flag and no environment-variable override.
 * A single invocation must never be able to redirect governed bootstrap
 * state into an arbitrary workspace path. `reconcile` is the same
 * boundary: it always targets the canonical
 * `/var/lib/mottainai-control/managed-runtime` state Issue #628's
 * `reconcileManagedRuntime` defaults to when no override is supplied.
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
 * genuinely executable at its exact resolved store path — `--version` was
 * chosen deliberately over a deeper invocation (e.g. `--help`) because it
 * is the same minimal "does this exact package actually run" probe
 * nix/packages/nawabari.nix's own installCheckPhase already treats as
 * sufficient (`test "$($out/bin/nawabari --version)" = "${version}"`).
 * This does not compare against the currently desired manifest version:
 * during post-switch rollback recovery this same function verifies the
 * *previous* known-good generation, whose version may legitimately differ
 * from what the (now-reverted) desired manifest names.
 */
function verifyManagedBinaryExecutes(storePath: string, packageId: string): string | undefined {
  const binaryPath = path.join(storePath, "bin", packageId);
  try {
    const output = execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    if (output.length === 0) return `${packageId} at ${binaryPath} reported an empty --version output`;
    return undefined;
  } catch (error) {
    return `${packageId} at ${binaryPath} failed to execute: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function reconcileBuildGeneration(
  manifest: ManagedPackageManifest,
  options: { readonly system: string; readonly repoRoot: string; readonly mottainaiSourceOverride?: string; readonly env: NodeJS.ProcessEnv },
): Promise<ManagedRuntimeBuiltGeneration> {
  const mottainaiEntry = manifest.packages.find((entry) => entry.packageId === "mottainai");
  let mottainaiSourcePath = options.repoRoot;
  if (mottainaiEntry !== undefined) {
    if (options.mottainaiSourceOverride !== undefined) {
      // An already-resolved exact source tree supplied by the caller —
      // the same "manifest + already-resolved exact source" boundary
      // buildManagedGeneration itself documents (Issue #625/#626). This
      // never skips verification: verifySourceIntegrity/
      // assertResolvedVersionsMatch below still check this exact tree
      // against the manifest's declared sourceSha256/version.
      mottainaiSourcePath = options.mottainaiSourceOverride;
    } else {
      const destinationDirectory = path.join(os.tmpdir(), `mottainai-reconcile-source-${process.pid}`);
      const resolved = await resolveMottainaiSource({
        requestedVersion: mottainaiEntry.version,
        expectedSourceSha256: mottainaiEntry.source.sourceSha256,
        destinationDirectory,
      });
      mottainaiSourcePath = resolved.sourcePath;
    }
  }
  const built = await buildManagedGeneration({
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

function reconcileHealthCheck(generation: ManagedRuntimeCandidate | ManagedRuntimeGenerationRecord): ManagedRuntimeHealthResult {
  for (const packageId of generation.packageIds ?? []) {
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
 * Composes Issue #626's build interface with Issue #628's already-implemented
 * `reconcileManagedRuntime` state machine (src/runtime-contract/managed-runtime.ts)
 * into the one guest-invokable command the canonical control identity runs to
 * converge the managed Runtime toward its canonical desired manifest — the
 * orchestration docs/runtime-lifecycle.md's "Command responsibility" section
 * anticipates ("a future full Mottainai command may name that orchestration
 * init or reconcile"). This performs real activation: build/verify, atomic
 * switch, managed-runtime health, and rollback on a post-switch health
 * failure — never a partial/simulated result.
 *
 * `--mottainai-source` is an explicit, honest input for an already-resolved
 * exact source tree (see reconcileBuildGeneration above); omitting it
 * performs the real Issue #626 GitHub-tag source resolution, matching
 * `mottainai-bootstrap build`.
 */
async function runReconcileCommand(argv: readonly string[]): Promise<number> {
  const system = requireFlagValue(argv, "system");
  const repoRoot = requireFlagValue(argv, "repo-root") ?? repoRootForNixInvocation();
  const mottainaiSourceOverride = requireFlagValue(argv, "mottainai-source");
  const json = hasFlag(argv, "json");

  if (system === undefined) {
    process.stderr.write("usage: bootstrap reconcile --system <system> [--mottainai-source <path>] [--repo-root <path>] [--json]\n");
    return 1;
  }

  const env = { ...process.env, CI: "true" };

  try {
    const result = await reconcileManagedRuntime({
      dependencies: {
        buildGeneration: (manifest) => reconcileBuildGeneration(manifest, { system, repoRoot, mottainaiSourceOverride, env }),
        healthCheck: (generation) => reconcileHealthCheck(generation),
      },
    });
    if (json) printJson(result);
    else process.stdout.write(`reconcile ${result.outcome}: active=${result.active?.generationIdentity ?? "<none>"}\n`);
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (json) printJson({ code, message: error instanceof Error ? error.message : String(error) });
    else process.stderr.write(`${code ?? "reconcile_failure"}: ${error instanceof Error ? error.message : String(error)}\n`);
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
