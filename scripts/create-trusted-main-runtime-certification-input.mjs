#!/usr/bin/env node
/**
 * Assemble the exact Route 1/2/3 descriptor consumed by the trusted-main
 * provider-independent Runtime certification.  This is deliberately a thin
 * fan-in helper: payload, managed-generation, and descriptor identities are
 * produced/validated by their existing authorities rather than reimplemented
 * in the certification test.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

const payloadPath = path.resolve(option("payload"));
const payloadIdentityPath = path.resolve(option("payload-identity"));
const applianceManifestPath = path.resolve(option("appliance-manifest"));
const ociManifestPath = path.resolve(option("oci-manifest"));
const initPath = path.resolve(option("init"));
const providerProfilePath = path.resolve(option("provider-profile"));
const flakeLockPath = path.resolve(option("flake-lock"));
const sourceArchivePath = path.resolve(option("source-archive"));
const sourceRevision = option("source-revision").toLowerCase();
const outputDirectory = path.resolve(option("output-directory"));

if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new Error("--source-revision must be a full lowercase Git SHA");
const payloadIdentity = readJson(payloadIdentityPath, "Route 1 payload identity");
const payloadSha256 = sha256(payloadPath);
if (payloadIdentity.payload?.sha256 !== payloadSha256) {
  throw new Error(`Route 1 payload identity does not match bytes: ${payloadSha256}`);
}
if (payloadIdentity.source?.revision !== sourceRevision) {
  throw new Error(
    `Route 1 payload source revision does not match trusted-main revision: ${payloadIdentity.source?.revision}`,
  );
}
const version = payloadIdentity.package?.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/u.test(version)) {
  throw new Error("Route 1 payload identity has an invalid package version");
}

const applianceManifest = readJson(applianceManifestPath, "Runtime Appliance manifest");
if (applianceManifest.sourceRevision !== sourceRevision) {
  throw new Error("Runtime Appliance manifest is not built from the trusted-main revision");
}
const ociDigest = `sha256:${sha256(ociManifestPath)}`;
const applianceMetadataPath = path.join(outputDirectory, "appliance-metadata.json");
fs.mkdirSync(outputDirectory, { recursive: true });
writeJson(applianceMetadataPath, {
  digest: ociDigest,
  rawSha256: applianceManifest.image?.sha256,
  rawSizeBytes: applianceManifest.image?.sizeBytes,
  manifestSha256: sha256(applianceManifestPath),
});

const { narHashOfTree } = await import("../src/bootstrap/source-resolution.ts");
const { buildManagedGeneration } = await import("../src/runtime-contract/managed-generation-build.ts");
const { parseManagedPackageManifest } = await import("../src/runtime-contract/managed-package-manifest.ts");

// Hash the same clean source tree that the guest resolver will extract. The
// working checkout contains ignored CI build outputs and node_modules, so
// hashing repositoryRoot directly would certify bytes that are absent from
// the release-bound source archive.
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-trusted-main-certification-"));
try {
  const sourceTreeRoot = path.join(temporaryRoot, "source");
  fs.mkdirSync(sourceTreeRoot, { recursive: true, mode: 0o700 });
  execFileSync(
    "tar",
    [
      "-xzf",
      sourceArchivePath,
      "-C",
      sourceTreeRoot,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
    ],
    { stdio: "pipe" },
  );
  const sourceSha256 = narHashOfTree(sourceTreeRoot);
  const manifest = parseManagedPackageManifest({
    contractId: "mottainai.managed-package-manifest.v1",
    schemaVersion: 1,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version,
        source: { flakeRef: "nix#mottainai", sourceSha256 },
      },
    ],
  });
  const produced = await buildManagedGeneration({
    repoRoot: repositoryRoot,
    manifest,
    system: "x86_64-linux",
    mottainaiSourcePath: sourceTreeRoot,
    canonicalPayloadPath: payloadPath,
    canonicalPayloadSha256: payloadSha256,
    env: { ...process.env, CI: "true" },
  });
  const sourceStorePath = produced.metadata.nixOutput.packages.find(
    (entry) => entry.packageId === "mottainai",
  )?.sourceStorePath;
  if (sourceStorePath === undefined)
    throw new Error("managed-generation metadata omitted the Mottainai source store path");
  const realizedSourceSha256 = narHashOfTree(sourceStorePath);
  if (realizedSourceSha256 !== sourceSha256) {
    throw new Error(
      `Route 2 source NAR identity changed during realization: ${sourceSha256} != ${realizedSourceSha256}`,
    );
  }

  const manifestPath = path.join(temporaryRoot, "managed-package-manifest.json");
  const metadataPath = path.join(temporaryRoot, "managed-generation-metadata.json");
  const managedPath = path.join(outputDirectory, "managed-generation.json");
  writeJson(manifestPath, manifest);
  writeJson(metadataPath, produced.metadata);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repositoryRoot, "scripts/create-release-managed-generation.mjs"),
      "--manifest",
      manifestPath,
      "--metadata",
      metadataPath,
      "--payload",
      payloadPath,
      "--flake-lock",
      flakeLockPath,
      "--source-nar-sha256",
      sourceSha256,
      "--output",
      managedPath,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );

  const descriptorInputPath = path.join(outputDirectory, "deployment-descriptor-input.json");
  const descriptorPath = path.join(outputDirectory, "mottainai-deployment-v1.json");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repositoryRoot, "scripts/create-release-deployment-descriptor-input.mjs"),
      "--version",
      version,
      "--source-revision",
      sourceRevision,
      "--tarball",
      payloadPath,
      "--init",
      initPath,
      "--appliance-metadata",
      applianceMetadataPath,
      "--provider-profile",
      providerProfilePath,
      "--managed-generation",
      managedPath,
      "--flake-lock",
      flakeLockPath,
      "--output",
      descriptorInputPath,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repositoryRoot, "scripts/build-deployment-descriptor.mjs"),
      "--input",
      descriptorInputPath,
      "--output",
      descriptorPath,
      "--identity-output",
      `${descriptorPath}.sha256`,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );

  // Keep a small, machine-readable handoff alongside the descriptor.  The
  // guest test consumes only descriptor identity and exact bytes; this file
  // makes the Route 1/2 distinction auditable without a build-log parser.
  writeJson(path.join(outputDirectory, "runtime-certification-input.json"), {
    contractId: "mottainai.runtime-certification-input.v1",
    schemaVersion: 1,
    sourceRevision,
    route1Payload: { filename: path.basename(payloadPath), sha256: payloadSha256, version },
    route2: { sourceNarSha256: sourceSha256, generationIdentity: produced.generationIdentity },
    route3: { applianceDigest: ociDigest, rawSha256: applianceManifest.image.sha256 },
  });
  console.log(
    JSON.stringify(
      {
        descriptor: path.join(outputDirectory, "mottainai-deployment-v1.json"),
        payloadSha256,
        sourceNarSha256: sourceSha256,
        generationIdentity: produced.generationIdentity,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
