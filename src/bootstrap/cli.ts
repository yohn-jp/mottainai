import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import { defaultBootstrapDependencies, readBootstrapStatus, runBootstrapBuild, verifyBootstrap } from "./build.js";
import { BootstrapError } from "./errors.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";
import { UnreadableManifest } from "./unreadable-manifest.js";

/**
 * Narrow bootstrap dispatcher (Issue #626): `build` / `status` / `verify`
 * only — no `init` alias, no task/session/manager/package-catalog UX.
 * Deliberately does NOT import src/cli.ts, src/index.ts, or any
 * manager/workflow/task-session module: that independence is what lets
 * this CLI work without full `mottainai` installed. Local flag-parsing
 * helpers are re-implemented here rather than imported from src/cli.ts for
 * the same reason.
 *
 * The production state path is always CANONICAL_BOOTSTRAP_STATE_FILE_PATH
 * — there is no `--state-file` flag and no environment-variable override.
 * A single invocation must never be able to redirect governed bootstrap
 * state into an arbitrary workspace path.
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

export async function runBootstrapCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "build":
      return runBuildCommand(rest);
    case "status":
      return runStatusCommand(rest);
    case "verify":
      return runVerifyCommand(rest);
    default:
      process.stderr.write(`unknown bootstrap command: ${command ?? "<none>"} (expected build, status, or verify)\n`);
      return 1;
  }
}
