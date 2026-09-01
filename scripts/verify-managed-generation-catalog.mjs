import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Issue #662 CI proof for the first supported managed Runtime package
// catalog (mottainai, nawabari, zellij): exercises the real, unmocked
// nix/managed-generation.nix projection end to end against all three
// catalog packages at once, using the same production entry points
// scripts/build-managed-generation.mjs and a real Mottainai deployment
// would use — src/runtime-contract/managed-generation-build.ts's
// buildManagedGeneration/buildManagedGenerationMetadata — rather than a
// second, parallel build mechanism.
//
// Requires a real `nix` toolchain; run via
// `node --import tsx scripts/verify-managed-generation-catalog.mjs x86_64-linux`
// from the CI runtime-contract job (see .github/workflows/ci.yml), which
// already has Nix installed for the rest of that job's checks.
//
// What this proves, in order:
//   1. Full-catalog build with exact-version success: a manifest declaring
//      all three catalog packages at their real resolved versions builds
//      end to end, exposing the exact resolved identity/store paths
//      (Issue #662 acceptance criteria: "Building the managed-generation
//      metadata/output necessarily realizes every requested catalog
//      package and exposes exact resolved identity/store paths").
//   2. Source-mismatch rejection: corrupting one package's declared
//      sourceSha256 and re-running the same real build fails closed
//      (verifySourceIntegrity), proven against a real resolved store path
//      rather than a mocked narHash lookup.
//   3. Version-mismatch rejection: requesting a version that does not
//      match the pinned recipe fails closed at the Nix layer itself
//      (nix/managed-generation.nix's requireMatchingVersion), a real `nix
//      build` failure, not just a pure-evaluation proof.
//   4. Unsupported package rejection: a manifest naming a #624-recognized
//      but unprojected packageId (coding-agent-cli) is rejected
//      deterministically before any Nix build is attempted.

const { parseManagedPackageManifest, MANAGED_PACKAGE_MANIFEST_CONTRACT_ID, MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION } =
  await import("../src/runtime-contract/managed-package-manifest.ts");
const { assertManifestProjectable, ManagedGenerationError } = await import(
  "../src/runtime-contract/managed-generation.ts"
);
const { buildManagedGeneration, buildManagedGenerationMetadata, computeNarHash, ManagedGenerationBuildError } =
  await import("../src/runtime-contract/managed-generation-build.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const system = process.argv[2] ?? "x86_64-linux";
// CI=true: matches every other production caller of buildManagedGeneration
// (nix/mottainai.nix's build reads the repository's own node_modules via
// `source = ../.`; a locally pnpm-installed node_modules otherwise makes
// pnpm prompt interactively to remove it).
const env = { ...process.env, CI: "true" };

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function catalogEntry(packageId, kind, flakeRef, version, sourceSha256) {
  return { packageId, kind, version, source: { flakeRef, sourceSha256 } };
}

function catalogManifest(packages) {
  return parseManagedPackageManifest({
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages,
  });
}

// Each catalog package's version, resolved via a plain `nix eval` against
// the same flake attribute nix/managed-generation.nix's resolveEntry
// ultimately builds — a real, exact version identity, not a value this
// script invents.
function packageVersion(attribute) {
  return execFileSync("nix", ["eval", "--no-update-lock-file", "--raw", `.#packages.${system}.${attribute}.version`], {
    cwd: path.join(repoRoot, "nix"),
    encoding: "utf8",
  }).trim();
}

const placeholderSha256 = "0".repeat(64);

const catalog = [
  { packageId: "mottainai", attribute: "mottainai", flakeRef: "nix#mottainai" },
  { packageId: "nawabari", attribute: "nawabari", flakeRef: "nix/packages/nawabari.nix" },
  { packageId: "zellij", attribute: "zellij", flakeRef: "nixpkgs#zellij-unwrapped" },
];

console.log("resolving real catalog package versions...");
const versions = Object.fromEntries(catalog.map((entry) => [entry.packageId, packageVersion(entry.attribute)]));
for (const entry of catalog) console.log(`  ${entry.packageId} -> ${versions[entry.packageId]}`);

const placeholderManifest = catalogManifest(
  catalog.map((entry) => catalogEntry(entry.packageId, "nix-flake-package", entry.flakeRef, versions[entry.packageId], placeholderSha256)),
);
assertManifestProjectable(placeholderManifest);

console.log("building the full catalog once to resolve real source identities...");
const placeholderMetadata = await buildManagedGenerationMetadata({
  repoRoot,
  manifest: placeholderManifest,
  system,
  mottainaiSourcePath: repoRoot,
  env,
});

const realSha256 = {};
for (const entry of catalog) {
  const resolved = placeholderMetadata.nixOutput.packages.find((candidate) => candidate.packageId === entry.packageId);
  if (resolved === undefined) fail(`metadata has no resolved entry for packageId=${entry.packageId}`);
  realSha256[entry.packageId] = computeNarHash(resolved.sourceStorePath, execFileSync);
  console.log(`  ${entry.packageId} sourceStorePath=${resolved.sourceStorePath} sourceSha256=${realSha256[entry.packageId]}`);
}

const realManifest = catalogManifest(
  catalog.map((entry) => catalogEntry(entry.packageId, "nix-flake-package", entry.flakeRef, versions[entry.packageId], realSha256[entry.packageId])),
);

console.log("building the full catalog end to end with real declared identities (exact-version + source-integrity success)...");
const built = await buildManagedGeneration({
  repoRoot,
  manifest: realManifest,
  system,
  mottainaiSourcePath: repoRoot,
  env,
});
console.log(JSON.stringify({ ...built.metadata, generationIdentity: built.generationIdentity }, null, 2));

console.log("proving a mismatched sourceSha256 is rejected against the real build (source-integrity fail-closed)...");
const mismatchedPackages = realManifest.packages.map((entry, index) =>
  index === 0 ? { ...entry, source: { ...entry.source, sourceSha256: "f".repeat(64) } } : entry,
);
try {
  await buildManagedGeneration({
    repoRoot,
    manifest: catalogManifest(mismatchedPackages),
    system,
    mottainaiSourcePath: repoRoot,
    env,
  });
  fail("managed generation build did not reject a mismatched sourceSha256");
} catch (error) {
  if (!(error instanceof ManagedGenerationBuildError) || error.phase !== "source_integrity") {
    fail(`expected a source_integrity ManagedGenerationBuildError, got: ${error instanceof Error ? error.stack : error}`);
  }
  console.log(`  confirmed: ${error.message}`);
}

console.log("proving a requested version that does not match the resolved recipe is rejected by the real Nix build...");
const wrongVersionPackages = realManifest.packages.map((entry, index) =>
  index === 0 ? { ...entry, version: "0.0.0-does-not-exist" } : entry,
);
try {
  await buildManagedGeneration({
    repoRoot,
    manifest: catalogManifest(wrongVersionPackages),
    system,
    mottainaiSourcePath: repoRoot,
    env,
  });
  fail("managed generation build did not reject a requested version mismatch");
} catch (error) {
  if (!(error instanceof ManagedGenerationBuildError) || error.phase !== "nix_build") {
    fail(`expected a nix_build ManagedGenerationBuildError, got: ${error instanceof Error ? error.stack : error}`);
  }
  console.log("  confirmed: the Nix build itself rejected the version mismatch (requireMatchingVersion)");
}

console.log("proving an unsupported packageId is rejected deterministically before any Nix build...");
const unsupportedManifest = catalogManifest([
  ...realManifest.packages,
  catalogEntry("coding-agent-cli", "nix-flake-package", "nix#coding-agent-cli", "1.0.0", placeholderSha256),
]);
try {
  assertManifestProjectable(unsupportedManifest);
  fail("assertManifestProjectable did not reject the coding-agent-cli packageId");
} catch (error) {
  if (!(error instanceof ManagedGenerationError)) {
    fail(`expected a ManagedGenerationError, got: ${error instanceof Error ? error.stack : error}`);
  }
  console.log(`  confirmed: ${error.message}`);
}

console.log("managed Runtime package catalog: full-catalog build, exact-version success, source-mismatch rejection, version-mismatch rejection, and unsupported-package rejection all proved against the real Nix projection.");
