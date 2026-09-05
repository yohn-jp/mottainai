#!/usr/bin/env node
/**
 * Hermetic PR proof for the corrected production deployment-artifact chain.
 *
 * The temporary files are release-artifact fixtures only. Descriptor,
 * source-resolution, managed-generation, and identity semantics remain in
 * their production implementations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { packCanonicalPayload } from "./lib/canonical-payload.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFixture = path.join(repositoryRoot, "nix/tests/fixtures/managed-mottainai-v1");
const providerProfile = path.join(repositoryRoot, "release/deployment-provider-profile-linux-x86_64.json");
const flakeLock = path.join(repositoryRoot, "nix/flake.lock");
const version = JSON.parse(fs.readFileSync(path.join(sourceFixture, "package.json"), "utf8")).version;
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function streamOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

function packSourceFixture(directory, versionValue) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-roundtrip-production-source-"));
  try {
    const wrapper = path.join(stagingRoot, `mottainai-${versionValue}`);
    fs.cpSync(directory, wrapper, { recursive: true });
    const archivePath = path.join(stagingRoot, "source.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, path.basename(wrapper)]);
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const { narHashOfTree, resolveCanonicalPayload, resolveMottainaiSource } = await import(
  "../src/bootstrap/source-resolution.ts"
);
const { buildManagedGeneration } = await import("../src/runtime-contract/managed-generation-build.ts");
const { readDeploymentDescriptor } = await import("../src/runtime-contract/deployment-descriptor.ts");
const { generationIdentityOf } = await import("../src/runtime-contract/managed-generation.ts");
const { assertDeploymentArtifactRoundtrip, managedManifestFromDeploymentDescriptor } = await import(
  "../src/runtime-contract/deployment-artifact-roundtrip.ts"
);
const { parseManagedPackageManifest } = await import("../src/runtime-contract/managed-package-manifest.ts");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-deployment-roundtrip-proof-"));
try {
  const initPath = path.join(temporaryRoot, "mottainai-init-linux-x86_64");
  const applianceMetadataPath = path.join(temporaryRoot, "appliance-metadata.json");
  const manifestPath = path.join(temporaryRoot, "managed-package-manifest.json");
  const metadataPath = path.join(temporaryRoot, "managed-generation-metadata.json");
  const managedGenerationPath = path.join(temporaryRoot, "managed-generation.json");
  const descriptorInputPath = path.join(temporaryRoot, "deployment-descriptor-input.json");
  const descriptorPath = path.join(temporaryRoot, "mottainai-deployment-v1.json");

  const payloadSource = path.join(temporaryRoot, "payload-source");
  fs.cpSync(sourceFixture, payloadSource, { recursive: true });
  const payloadPackagePath = path.join(payloadSource, "package.json");
  const payloadPackage = JSON.parse(fs.readFileSync(payloadPackagePath, "utf8"));
  payloadPackage.bin = { mottainai: "dist/index.js", mtnai: "dist/index.js", "mottainai-mcp": "dist/mcp.js" };
  fs.writeFileSync(payloadPackagePath, `${JSON.stringify(payloadPackage)}\n`);
  fs.mkdirSync(path.join(payloadSource, "dist"), { recursive: true });
  fs.writeFileSync(path.join(payloadSource, "dist/index.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(payloadSource, "dist/mcp.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(payloadSource, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const packedPayload = packCanonicalPayload(payloadSource, path.join(temporaryRoot, "payload"));
  const tarballPath = packedPayload.tarballPath;
  fs.writeFileSync(initPath, "corrected production-shaped Route 4 init fixture\n");
  writeJson(applianceMetadataPath, {
    digest: `sha256:${"6".repeat(64)}`,
    rawSha256: "7".repeat(64),
    rawSizeBytes: 2048,
    manifestSha256: "8".repeat(64),
  });

  const sourceSha256 = narHashOfTree(sourceFixture);
  const sourceArchive = packSourceFixture(sourceFixture, version);
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

  // Producer side: the real Nix build boundary emits realized metadata.
  const produced = await buildManagedGeneration({
    repoRoot: repositoryRoot,
    manifest,
    system: "x86_64-linux",
    mottainaiSourcePath: sourceFixture,
    canonicalPayloadPath: tarballPath,
    canonicalPayloadSha256: sha256(tarballPath),
    env: { ...process.env, CI: "true" },
  });
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
      tarballPath,
      "--flake-lock",
      flakeLock,
      "--source-nar-sha256",
      sourceSha256,
      "--output",
      managedGenerationPath,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );

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
      tarballPath,
      "--init",
      initPath,
      "--appliance-metadata",
      applianceMetadataPath,
      "--provider-profile",
      providerProfile,
      "--managed-generation",
      managedGenerationPath,
      "--flake-lock",
      flakeLock,
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

  // Consumer side: use the exact producer output and the real boundaries in
  // the same order as the release verifier.
  const descriptor = readDeploymentDescriptor(descriptorPath);
  const projectedManifest = managedManifestFromDeploymentDescriptor(descriptor);
  const resolvedPayload = await resolveCanonicalPayload({
    identity: descriptor.route1.payload,
    destinationDirectory: path.join(temporaryRoot, "resolved-payload"),
    fetcher: async (url) => {
      assert.equal(url, descriptor.route1.payload.locator);
      return streamOf(fs.readFileSync(tarballPath));
    },
  });
  const sourceDestination = path.join(temporaryRoot, "resolved-source");
  const resolvedSource = await resolveMottainaiSource({
    requestedVersion: projectedManifest.packages.find((entry) => entry.packageId === "mottainai").version,
    expectedSourceSha256: projectedManifest.packages.find((entry) => entry.packageId === "mottainai").source
      .sourceSha256,
    destinationDirectory: sourceDestination,
    fetcher: async (url) => {
      assert.equal(url, `https://github.com/yohn-jp/mottainai/archive/refs/tags/v${version}.tar.gz`);
      return streamOf(sourceArchive);
    },
  });
  const rebuilt = await buildManagedGeneration({
    repoRoot: repositoryRoot,
    manifest: projectedManifest,
    system: "x86_64-linux",
    mottainaiSourcePath: resolvedSource.sourcePath,
    canonicalPayloadPath: resolvedPayload.payloadPath,
    canonicalPayloadSha256: resolvedPayload.sha256,
    env: { ...process.env, CI: "true" },
  });

  const canonicalGenerationIdentity = generationIdentityOf(projectedManifest, rebuilt.metadata);
  assert.equal(descriptor.route2.managedGeneration.packages[0].sourceSha256, sourceSha256);
  assert.notEqual(descriptor.route1.payload.sha256, sourceSha256);
  assert.equal(canonicalGenerationIdentity, descriptor.route2.managedGeneration.identity);
  assert.equal(descriptor.route3.managedGenerationIdentity, canonicalGenerationIdentity);
  assert.equal(rebuilt.generationIdentity, canonicalGenerationIdentity);
  assertDeploymentArtifactRoundtrip({
    descriptor,
    manifest: projectedManifest,
    metadata: rebuilt.metadata,
    resolvedSource,
    payloadSha256: resolvedPayload.sha256,
    payloadSourceRevision: sourceRevision,
    flakeLockSha256: sha256(flakeLock),
  });

  console.log(
    JSON.stringify(
      {
        descriptor: descriptorPath,
        payloadSha256: descriptor.route1.payload.sha256,
        sourceNarSha256: resolvedSource.narHashSha256,
        generationIdentity: canonicalGenerationIdentity,
        route3ManagedGenerationIdentity: descriptor.route3.managedGenerationIdentity,
      },
      null,
      2,
    ),
  );
  console.log("corrected production deployment artifact round-trip: verified");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
