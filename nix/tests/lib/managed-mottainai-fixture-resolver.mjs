import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue #703's test-only fixture resolver: maps the requested managed
 * Mottainai test version to one of the two repository-owned fixture source
 * directories in ../fixtures, verifying the selected tree's real NAR
 * SHA-256 the same way src/bootstrap/source-resolution.ts's
 * defaultNarHashOfTree does. It performs no HTTP request and never falls
 * back outside these two fixed directories. This module is test-only and
 * must not be imported by src/** production code.
 */

const FIXTURE_DIRECTORIES = {
  "1.0.0": "managed-mottainai-v1",
  "2.0.0": "managed-mottainai-v2",
};

function narHashOfTree(treePath) {
  const sri = execFileSync("nix", ["hash", "path", "--sri", "--type", "sha256", treePath], { encoding: "utf8" }).trim();
  return execFileSync("nix", [
    "eval",
    "--raw",
    "--expr",
    `builtins.convertHash { hash = ${JSON.stringify(sri)}; hashAlgo = "sha256"; toHashFormat = "base16"; }`,
  ])
    .toString("utf8")
    .trim()
    .toLowerCase();
}

/**
 * @param {{ requestedVersion: string, expectedSourceSha256: string }} options
 * @returns {Promise<{ sourcePath: string, resolvedTag: string, narHashSha256: string }>}
 */
export async function resolveManagedMottainaiFixtureSource(options) {
  const fixtureDirectoryName = FIXTURE_DIRECTORIES[options.requestedVersion];
  if (fixtureDirectoryName === undefined) {
    throw new Error(
      `managed-mottainai-fixture-resolver: unsupported fixture Mottainai version: ${options.requestedVersion}`,
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(here, "..", "fixtures", fixtureDirectoryName);

  const narHashSha256 = narHashOfTree(sourcePath);
  if (narHashSha256 !== options.expectedSourceSha256.toLowerCase()) {
    throw new Error(
      `managed-mottainai-fixture-resolver: fixture Mottainai source tree for ${options.requestedVersion} hashes to ${narHashSha256}, but manifest declares sourceSha256=${options.expectedSourceSha256}`,
    );
  }

  return { sourcePath, resolvedTag: `v${options.requestedVersion}`, narHashSha256 };
}
