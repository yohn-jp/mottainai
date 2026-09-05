#!/usr/bin/env node
/**
 * Release-only composition gate for the production deployment artifact.
 *
 * The descriptor is the producer output. This script feeds its Route 2
 * identity back through the existing source-resolution and managed-generation
 * boundaries, then asks the canonical runtime contract to derive the exact
 * generation identity. It intentionally contains no descriptor schema or
 * identity algorithm of its own.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyCanonicalPayload } from "./lib/canonical-payload.mjs";

function option(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    if (!required) return undefined;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function gitRevision(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim().toLowerCase();
}

const repositoryRoot = path.resolve(
  option("repo-root", false) ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const descriptorPath = path.resolve(option("descriptor"));
const tarballPath = path.resolve(option("tarball"));
const identityPath = `${tarballPath}.identity.json`;
const system = option("system", false) ?? "x86_64-linux";

const { readDeploymentDescriptor } = await import("../src/runtime-contract/deployment-descriptor.ts");
const { resolveMottainaiSource } = await import("../src/bootstrap/source-resolution.ts");
const { buildManagedGeneration } = await import("../src/runtime-contract/managed-generation-build.ts");
const { assertDeploymentArtifactRoundtrip, managedManifestFromDeploymentDescriptor } = await import(
  "../src/runtime-contract/deployment-artifact-roundtrip.ts"
);

const descriptor = readDeploymentDescriptor(descriptorPath);
if (descriptor.route1.payload.filename !== path.basename(tarballPath)) {
  throw new Error(
    `Route 1 payload filename mismatch: descriptor declares ${descriptor.route1.payload.filename}, input is ${path.basename(tarballPath)}`,
  );
}

const payloadIdentity = verifyCanonicalPayload(tarballPath, identityPath, repositoryRoot);
const manifest = managedManifestFromDeploymentDescriptor(descriptor);
const sourceRevision = gitRevision(repositoryRoot);
if (sourceRevision !== descriptor.release.sourceRevision) {
  throw new Error(
    `release checkout revision ${sourceRevision} does not match descriptor sourceRevision ${descriptor.release.sourceRevision}`,
  );
}

const destinationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-deployment-artifact-roundtrip-"));
try {
  const mottainai = manifest.packages.find((entry) => entry.packageId === "mottainai");
  if (mottainai === undefined) throw new Error("Route 2 descriptor has no mottainai package");

  console.log(`resolving ${mottainai.version} through the production source-resolution contract...`);
  const resolvedSource = await resolveMottainaiSource({
    requestedVersion: mottainai.version,
    expectedSourceSha256: mottainai.source.sourceSha256,
    destinationDirectory,
  });

  console.log("building the resolved source through the production managed-generation boundary...");
  const built = await buildManagedGeneration({
    repoRoot: repositoryRoot,
    manifest,
    system,
    mottainaiSourcePath: resolvedSource.sourcePath,
    env: { ...process.env, CI: "true" },
  });

  assertDeploymentArtifactRoundtrip({
    descriptor,
    manifest,
    metadata: built.metadata,
    resolvedSource,
    payloadSha256: sha256(tarballPath),
    payloadSourceRevision: payloadIdentity.source?.revision,
    flakeLockSha256: sha256(path.join(repositoryRoot, "nix", "flake.lock")),
  });

  console.log(
    JSON.stringify(
      {
        contractId: descriptor.contractId,
        release: descriptor.release,
        payloadSha256: descriptor.route1.payload.sha256,
        sourceResolution: {
          tag: resolvedSource.resolvedTag,
          narHashSha256: resolvedSource.narHashSha256,
        },
        generationIdentity: built.generationIdentity,
      },
      null,
      2,
    ),
  );
  console.log("deployment artifact round-trip: verified");
} finally {
  fs.rmSync(destinationDirectory, { recursive: true, force: true });
}
