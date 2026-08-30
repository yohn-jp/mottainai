import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Thin CLI wrapper around Issue #625's Nix projection (nix/managed-generation.nix):
// parses and validates a persisted mottainai.managed-package-manifest.v1
// manifest (#624), fails deterministically before touching Nix for any
// entry this projection has no recipe for, then delegates the actual `nix
// build` invocation to src/runtime-contract/managed-generation-build.ts —
// the same importable module Issue #626's bootstrap component uses, so the
// build-execution logic lives in exactly one place.

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifestPath = path.resolve(option("manifest"));
const system = option("system");
// The manifest's Mottainai entry projects onto an already-resolved exact
// source tree, not this repository's own checkout (Issue #625 owns
// manifest+resolved-source -> Nix generation only; Issue #626 owns
// resolving/fetching which source that is). This script is a caller like
// any other and must supply one explicitly — no fallback to `../.` here,
// or every build would silently stay coupled to the checkout invoking it.
const mottainaiSource = path.resolve(option("mottainai-source"));

// Run via `node --import tsx` (matches scripts/benchmark-semantic-fact-cache.mjs);
// imports the TypeScript runtime-contract modules directly rather than a
// compiled dist/ output, since this script is not part of the pnpm build.
const { parseManagedPackageManifest } = await import("../src/runtime-contract/managed-package-manifest.ts");
const { assertManifestProjectable } = await import("../src/runtime-contract/managed-generation.ts");
const { buildManagedGeneration } = await import("../src/runtime-contract/managed-generation-build.ts");

const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifest = parseManagedPackageManifest(manifestJson);

// Deterministic rejection before any Nix invocation (Issue #625: "fail
// deterministically for unsupported package kinds or unavailable
// recipes"). nix/managed-generation.nix independently enforces the same
// bound at the Nix layer; this is the fast, Nix-toolchain-free gate.
assertManifestProjectable(manifest);

const result = await buildManagedGeneration({
  repoRoot,
  manifest,
  system,
  mottainaiSourcePath: mottainaiSource,
  // CI=true: nix/mottainai.nix's build reads the repository's own
  // node_modules via `source = ../.`; a locally pnpm-installed
  // node_modules otherwise makes pnpm prompt interactively to remove it.
  env: { ...process.env, CI: "true" },
});

console.log(JSON.stringify({ ...result.metadata, generationIdentity: result.generationIdentity }, null, 2));
