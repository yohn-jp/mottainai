import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Drives Issue #625's Nix projection (nix/managed-generation.nix) from a
// persisted mottainai.managed-package-manifest.v1 manifest (#624): parses
// and validates the manifest, fails deterministically before touching Nix
// for any entry this projection has no recipe for, invokes `nix build`
// against the repository's pinned flake (nix/flake.nix `lib.mkManagedGeneration`,
// no ambient npm/PATH/network install path), and prints the bounded
// machine-readable metadata plus the derived generation identity.

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nixDir = path.join(repoRoot, "nix");

const manifestPath = path.resolve(option("manifest"));
const system = option("system");

// Run via `node --import tsx` (matches scripts/benchmark-semantic-fact-cache.mjs);
// imports the TypeScript runtime-contract modules directly rather than a
// compiled dist/ output, since this script is not part of the pnpm build.
const { parseManagedPackageManifest } = await import("../src/runtime-contract/managed-package-manifest.ts");
const {
  assertManifestProjectable,
  assertResolvedVersionsMatch,
  generationIdentityOf,
  parseManagedGenerationMetadata,
  verifySourceIntegrity,
} = await import("../src/runtime-contract/managed-generation.ts");

const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifest = parseManagedPackageManifest(manifestJson);

// Deterministic rejection before any Nix invocation (Issue #625: "fail
// deterministically for unsupported package kinds or unavailable
// recipes"). nix/managed-generation.nix independently enforces the same
// bound at the Nix layer; this is the fast, Nix-toolchain-free gate.
assertManifestProjectable(manifest);

const nixExpr = `
let
  flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)} + "?dir=nix");
  manifest = builtins.fromJSON (builtins.readFile ${JSON.stringify(manifestPath)});
in
(flake.lib.mkManagedGeneration { system = ${JSON.stringify(system)}; inherit manifest; }).metadataFile
`;

let metadataStorePath;
try {
  metadataStorePath = execFileSync(
    "nix",
    ["build", "--impure", "--no-link", "--print-out-paths", "--expr", nixExpr],
    // CI=true: nix/mottainai.nix's build reads the repository's own
    // node_modules via `source = ../.`; a locally pnpm-installed
    // node_modules otherwise makes pnpm prompt interactively to remove it.
    { cwd: nixDir, encoding: "utf8", env: { ...process.env, CI: "true" } },
  ).trim();
} catch (error) {
  throw new Error(
    `managed generation build failed for manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const metadata = parseManagedGenerationMetadata(JSON.parse(fs.readFileSync(metadataStorePath, "utf8")));

// Fails closed before reporting the build as verified: the manifest's
// declared sourceSha256 must match the NAR hash of the exact source store
// path Nix resolved and built each package from.
const narHashCache = new Map();
function narHashOf(storePath) {
  const cached = narHashCache.get(storePath);
  if (cached !== undefined) return cached;
  const pathInfo = JSON.parse(
    execFileSync("nix", ["path-info", "--json", "--json-format", "2", storePath], { encoding: "utf8" }),
  );
  const [info] = Object.values(pathInfo.info);
  const sriHash = info.narHash;
  const hex = execFileSync("nix", [
    "eval",
    "--raw",
    "--expr",
    `builtins.convertHash { hash = ${JSON.stringify(sriHash)}; hashAlgo = "sha256"; toHashFormat = "base16"; }`,
  ]).toString("utf8");
  narHashCache.set(storePath, hex);
  return hex;
}
verifySourceIntegrity(manifest, metadata, narHashOf);
assertResolvedVersionsMatch(manifest, metadata);

const generationIdentity = generationIdentityOf(manifest, metadata);

console.log(JSON.stringify({ ...metadata, generationIdentity }, null, 2));
