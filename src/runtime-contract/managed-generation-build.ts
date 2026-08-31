import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assertResolvedVersionsMatch,
  generationIdentityOf,
  parseManagedGenerationMetadata,
  verifySourceIntegrity,
} from "./managed-generation.js";
import type { ManagedGenerationMetadata } from "./managed-generation.js";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";

/**
 * Importable execution body of Issue #625's Nix projection driver
 * (previously the top-level script logic of
 * scripts/build-managed-generation.mjs, extracted here so both that script
 * and Issue #626's bootstrap module can invoke it without one depending on
 * the other — src/bootstrap/** must not depend on scripts/**).
 *
 * This module's contract is narrow and deliberate: it accepts a manifest
 * that has ALREADY been parsed (parseManagedPackageManifest) and ALREADY
 * passed assertManifestProjectable, plus an already-resolved exact source
 * tree — it does not parse, does not validate, and does not classify
 * unsupported packages itself. Those responsibilities stay with the caller
 * (scripts/build-managed-generation.mjs for the CLI-script path,
 * src/bootstrap/build.ts for the bootstrap path), matching Issue #625's own
 * stated boundary: "manifest + already-resolved exact source -> Nix
 * generation" only.
 */

export interface BuildManagedGenerationOptions {
  /** Directory containing the repository's nix/ subdirectory (i.e. `${repoRoot}/nix` is the flake). */
  readonly repoRoot: string;
  /** Already parsed via parseManagedPackageManifest AND already passed assertManifestProjectable. */
  readonly manifest: ManagedPackageManifest;
  readonly system: string;
  /** Already-resolved exact Mottainai source tree — never fetched by this module. */
  readonly mottainaiSourcePath: string;
  /** Injectable, mirrors verifySourceIntegrity's narHashOf injection — keeps this module's callers subprocess-free in tests. */
  readonly execFile?: typeof execFileSync;
  /**
   * Environment for the `nix build` subprocess. This module never reads
   * `process.env` directly (this repository's documented environment
   * boundary — scripts/architecture-check.mjs's `environmentBoundaryFiles`
   * — restricts that to CLI/entrypoint files); callers construct it,
   * typically as the host process's own environment plus `CI=true`
   * (nix/mottainai.nix's build reads the repository's own node_modules via
   * `source = ../.`; a locally pnpm-installed node_modules otherwise makes
   * pnpm prompt interactively to remove it — see
   * src/bootstrap/cli.ts/scripts/build-managed-generation.mjs for the real
   * construction).
   */
  readonly env: NodeJS.ProcessEnv;
}

export interface BuiltManagedGeneration {
  readonly metadata: ManagedGenerationMetadata;
  readonly generationIdentity: string;
}

/**
 * `phase` distinguishes WHERE within buildManagedGeneration a failure
 * occurred, so src/bootstrap/build.ts's toBootstrapError can map each
 * failure to its own BootstrapErrorCode instead of collapsing every
 * post-build failure into one code (PR review finding P1-3). `"nix_build"`
 * is the Nix subprocess itself failing (exit code, stderr) — the build
 * never produced output. `"metadata"` covers both the raw metadata
 * file read/JSON.parse AND parseManagedGenerationMetadata's schema
 * validation: the build succeeded per exit code but the metadata it
 * produced is unreadable or schema-invalid, which is "the build produced
 * bad metadata" either way — deliberately not split further. `"source_integrity"`
 * is verifySourceIntegrity's post-build NAR-hash mismatch.
 * `"resolved_version"` is assertResolvedVersionsMatch's post-build version
 * mismatch. Defaults to `"nix_build"` so existing construction sites and
 * scripts/build-managed-generation.mjs (which only lets errors propagate/
 * print, never inspects `phase`) keep working unchanged.
 */
export type ManagedGenerationBuildErrorPhase = "nix_build" | "metadata" | "source_integrity" | "resolved_version";

export class ManagedGenerationBuildError extends Error {
  readonly phase: ManagedGenerationBuildErrorPhase;

  constructor(message: string, phase: ManagedGenerationBuildErrorPhase = "nix_build") {
    super(message);
    this.name = "ManagedGenerationBuildError";
    this.phase = phase;
  }
}

function narHashOfFactory(execFile: typeof execFileSync): (storePath: string) => string {
  const cache = new Map<string, string>();
  return (storePath: string) => {
    const cached = cache.get(storePath);
    if (cached !== undefined) return cached;
    const pathInfo = JSON.parse(
      execFile("nix", ["path-info", "--json", "--json-format", "2", storePath], { encoding: "utf8" }) as string,
    ) as { info: Record<string, { narHash: string }> };
    const [info] = Object.values(pathInfo.info);
    const sriHash = info.narHash;
    const hex = execFile("nix", [
      "eval",
      "--raw",
      "--expr",
      `builtins.convertHash { hash = ${JSON.stringify(sriHash)}; hashAlgo = "sha256"; toHashFormat = "base16"; }`,
    ]).toString("utf8");
    cache.set(storePath, hex);
    return hex;
  };
}

/**
 * Invokes `nix build` against `nix/flake.nix`'s `lib.mkManagedGeneration`
 * function output, validates the resulting metadata, verifies source
 * integrity and resolved-version match, and returns the metadata plus
 * derived generation identity. Throws `ManagedGenerationBuildError` on a
 * Nix build failure (the caller is responsible for distinguishing "Nix
 * itself is unavailable" from "the build failed" before calling this, since
 * that distinction matters to Issue #626's error taxonomy but not to this
 * module's own contract).
 */
export async function buildManagedGeneration(options: BuildManagedGenerationOptions): Promise<BuiltManagedGeneration> {
  const execFile = options.execFile ?? execFileSync;
  const nixDir = path.join(options.repoRoot, "nix");
  const manifestJson = JSON.stringify(options.manifest);

  // mottainaiSource must arrive as a Nix path, not a Nix string: assigning a
  // JSON-string-embedded path directly to a derivation's `src` skips Nix's
  // content-addressing. `--arg` (a real Nix value) keeps the type correct;
  // `/. + "<path>"` inside the expression converts the absolute path string
  // --arg hands over into a Nix path value.
  const nixExpr = `
{ mottainaiSource }:
let
  flake = builtins.getFlake (toString ${JSON.stringify(options.repoRoot)} + "?dir=nix");
  manifest = builtins.fromJSON ${JSON.stringify(manifestJson)};
in
(flake.lib.mkManagedGeneration { system = ${JSON.stringify(options.system)}; inherit manifest mottainaiSource; }).metadataFile
`;

  let metadataStorePath: string;
  try {
    metadataStorePath = (
      execFile(
        "nix",
        [
          "build",
          "--impure",
          // This module's whole premise is a Runtime that may have no
          // network access (a fresh Appliance's only source of Nix inputs
          // is what is already in its store — nix/flake.lock's pin plus
          // whatever nixpkgs/etc. shipped with the base image). Without
          // --offline, a flake input Nix cannot resolve from the local
          // store purely by chance (e.g. a `getFlake` target whose git
          // identity differs from what flake.lock last saw) silently blocks
          // on a network fetch that can never succeed here instead of
          // failing fast with a clear error.
          "--offline",
          "--no-link",
          "--print-out-paths",
          "--expr",
          nixExpr,
          "--arg",
          "mottainaiSource",
          `/. + ${JSON.stringify(options.mottainaiSourcePath)}`,
        ],
        { cwd: nixDir, encoding: "utf8", env: options.env },
      ) as string
    ).trim();
  } catch (error) {
    throw new ManagedGenerationBuildError(
      `managed generation build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Raw metadata file read + JSON.parse, and parseManagedGenerationMetadata's
  // schema validation, are both "the build produced bad metadata" — grouped
  // under phase "metadata" (see ManagedGenerationBuildErrorPhase doc above).
  let metadata: ManagedGenerationMetadata;
  try {
    metadata = parseManagedGenerationMetadata(JSON.parse(fs.readFileSync(metadataStorePath, "utf8")));
  } catch (error) {
    throw new ManagedGenerationBuildError(
      `managed generation metadata is malformed: ${error instanceof Error ? error.message : String(error)}`,
      "metadata",
    );
  }

  try {
    verifySourceIntegrity(options.manifest, metadata, narHashOfFactory(execFile));
  } catch (error) {
    throw new ManagedGenerationBuildError(
      error instanceof Error ? error.message : String(error),
      "source_integrity",
    );
  }

  try {
    assertResolvedVersionsMatch(options.manifest, metadata);
  } catch (error) {
    throw new ManagedGenerationBuildError(
      error instanceof Error ? error.message : String(error),
      "resolved_version",
    );
  }

  return { metadata, generationIdentity: generationIdentityOf(options.manifest, metadata) };
}
