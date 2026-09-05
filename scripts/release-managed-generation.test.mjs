import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const createManagedGeneration = path.join(repositoryRoot, "scripts", "create-release-managed-generation.mjs");
const createDescriptorInput = path.join(repositoryRoot, "scripts", "create-release-deployment-descriptor-input.mjs");
const buildDescriptor = path.join(repositoryRoot, "scripts", "build-deployment-descriptor.mjs");
const providerProfile = path.join(repositoryRoot, "release", "deployment-provider-profile-linux-x86_64.json");
const flakeLock = path.join(repositoryRoot, "nix", "flake.lock");
const managedGenerationContract = path.join(repositoryRoot, "src", "runtime-contract", "managed-generation.ts");
const managedManifestContract = path.join(repositoryRoot, "src", "runtime-contract", "managed-package-manifest.ts");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "publish.yml");

const digest = (character) => character.repeat(64);
const revision = "a".repeat(40);

function run(command, args, options = {}) {
  try {
    return { status: 0, stdout: execFileSync(command, args, { ...options, encoding: "utf8" }) };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function writeProductionFixture(directory) {
  const payloadPath = path.join(directory, "mottainai-1.2.3.tgz");
  const initPath = path.join(directory, "mottainai-init-linux-x86_64");
  const manifestPath = path.join(directory, "managed-package-manifest.json");
  const metadataPath = path.join(directory, "managed-generation-metadata.json");
  const managedPath = path.join(directory, "managed-generation.json");
  const descriptorInputPath = path.join(directory, "deployment-descriptor-input.json");
  const descriptorPath = path.join(directory, "mottainai-deployment-v1.json");
  const appliancePath = path.join(directory, "appliance-metadata.json");

  fs.writeFileSync(payloadPath, "canonical release payload\n");
  fs.writeFileSync(initPath, "canonical init artifact\n");

  const manifest = {
    contractId: "mottainai.managed-package-manifest.v1",
    schemaVersion: 1,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "1.2.3",
        source: { flakeRef: "nix#mottainai", sourceSha256: digest("a") },
      },
    ],
  };
  const metadata = {
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: { packages: [{ packageId: "mottainai", version: "1.2.3", sourceSha256: digest("a") }] },
    resolvedIdentity: { packages: [{ packageId: "mottainai", resolvedVersion: "1.2.3" }] },
    nixOutput: {
      storePath: "/nix/store/1111-mottainai-managed-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/2222-mottainai-1.2.3",
          sourceStorePath: "/nix/store/3333-mottainai-source",
        },
      ],
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  fs.writeFileSync(
    appliancePath,
    JSON.stringify({
      digest: `sha256:${digest("b")}`,
      rawSha256: digest("c"),
      rawSizeBytes: 2048,
      manifestSha256: digest("d"),
    }),
  );

  return {
    payloadPath,
    initPath,
    manifestPath,
    metadataPath,
    managedPath,
    descriptorInputPath,
    descriptorPath,
    appliancePath,
    sourceNarSha256: digest("a"),
    manifest,
    metadata,
  };
}

function buildManagedGenerationFixture(fixture) {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      createManagedGeneration,
      "--manifest",
      fixture.manifestPath,
      "--metadata",
      fixture.metadataPath,
      "--payload",
      fixture.payloadPath,
      "--flake-lock",
      flakeLock,
      "--source-nar-sha256",
      fixture.sourceNarSha256,
      "--output",
      fixture.managedPath,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
}

function buildDescriptorInput(fixture, providerProfilePath = providerProfile) {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      createDescriptorInput,
      "--version",
      "1.2.3",
      "--source-revision",
      revision,
      "--tarball",
      fixture.payloadPath,
      "--init",
      fixture.initPath,
      "--appliance-metadata",
      fixture.appliancePath,
      "--provider-profile",
      providerProfilePath,
      "--managed-generation",
      fixture.managedPath,
      "--flake-lock",
      flakeLock,
      "--output",
      fixture.descriptorInputPath,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
}

function canonicalIdentityFromRuntimeContract(fixture) {
  const expression = `
    import fs from "node:fs";
    const { generationIdentityOf, parseManagedGenerationMetadata } = await import(${JSON.stringify(managedGenerationContract)});
    const { parseManagedPackageManifest } = await import(${JSON.stringify(managedManifestContract)});
    const manifest = parseManagedPackageManifest(JSON.parse(fs.readFileSync(${JSON.stringify(fixture.manifestPath)}, "utf8")));
    const metadata = parseManagedGenerationMetadata(JSON.parse(fs.readFileSync(${JSON.stringify(fixture.metadataPath)}, "utf8")));
    process.stdout.write(generationIdentityOf(manifest, metadata));
  `;
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", expression], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("release publication consumes the runtime-backed generation artifact", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(workflow, /managed_identity=/u);
  assert.doesNotMatch(workflow, /version:\$SOURCE_REVISION:\$payload_sha256:\$lock_sha256/u);
  assert.match(workflow, /create-release-managed-generation\.mjs/u);
  assert.match(workflow, /name: mottainai-managed-generation/u);
});

test("production-shaped descriptor consumes the canonical realized generation identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-managed-generation-"));
  try {
    const fixture = writeProductionFixture(directory);
    buildManagedGenerationFixture(fixture);
    buildDescriptorInput(fixture);
    execFileSync(
      process.execPath,
      ["--import", "tsx", buildDescriptor, "--input", fixture.descriptorInputPath, "--output", fixture.descriptorPath],
      { cwd: repositoryRoot, stdio: "pipe" },
    );

    const descriptor = JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8"));
    const managed = JSON.parse(fs.readFileSync(fixture.managedPath, "utf8"));
    const payloadSha256 = crypto.createHash("sha256").update(fs.readFileSync(fixture.payloadPath)).digest("hex");
    assert.equal(managed.manifest.packages[0].source.sourceSha256, fixture.sourceNarSha256);
    assert.equal(managed.metadata.requestedIdentity.packages[0].sourceSha256, fixture.sourceNarSha256);
    assert.notEqual(managed.manifest.packages[0].source.sourceSha256, payloadSha256);
    const expected = canonicalIdentityFromRuntimeContract(fixture);
    assert.equal(descriptor.route2.managedGeneration.identity, expected);
    assert.equal(descriptor.route3.managedGenerationIdentity, expected);
    assert.equal(managed.generationIdentity, expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("production provider profile transports the QEMU data identity and binds it into descriptor identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-qemu-data-identity-"));
  try {
    const fixture = writeProductionFixture(directory);
    buildManagedGenerationFixture(fixture);
    buildDescriptorInput(fixture);
    execFileSync(
      process.execPath,
      ["--import", "tsx", buildDescriptor, "--input", fixture.descriptorInputPath, "--output", fixture.descriptorPath],
      { cwd: repositoryRoot, stdio: "pipe" },
    );

    const profile = JSON.parse(fs.readFileSync(providerProfile, "utf8"));
    const descriptor = JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8"));
    assert.deepEqual(descriptor.route4.provider.qemu.dataArtifact, profile.qemu.dataArtifact);
    const firstIdentity = fs.readFileSync(`${fixture.descriptorPath}.sha256`, "utf8").split(/\s+/u)[0];

    const changedProfile = structuredClone(profile);
    changedProfile.qemu.dataArtifact.sha256 = digest("e");
    const changedProfilePath = path.join(directory, "changed-provider-profile.json");
    const changedInputPath = path.join(directory, "changed-descriptor-input.json");
    const changedDescriptorPath = path.join(directory, "changed-descriptor.json");
    fs.writeFileSync(changedProfilePath, JSON.stringify(changedProfile));
    buildDescriptorInput({ ...fixture, descriptorInputPath: changedInputPath }, changedProfilePath);
    execFileSync(
      process.execPath,
      ["--import", "tsx", buildDescriptor, "--input", changedInputPath, "--output", changedDescriptorPath],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
    const changedIdentity = fs.readFileSync(`${changedDescriptorPath}.sha256`, "utf8").split(/\s+/u)[0];
    assert.notEqual(changedIdentity, firstIdentity);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release generation rejects the npm payload digest substituted for source NAR identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-managed-generation-payload-source-"));
  try {
    const fixture = writeProductionFixture(directory);
    const payloadSha256 = crypto.createHash("sha256").update(fs.readFileSync(fixture.payloadPath)).digest("hex");
    fixture.manifest.packages[0].source.sourceSha256 = payloadSha256;
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));

    const result = run(
      process.execPath,
      [
        "--import",
        "tsx",
        createManagedGeneration,
        "--manifest",
        fixture.manifestPath,
        "--metadata",
        fixture.metadataPath,
        "--payload",
        fixture.payloadPath,
        "--flake-lock",
        flakeLock,
        "--source-nar-sha256",
        fixture.sourceNarSha256,
        "--output",
        fixture.managedPath,
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest source identity mismatch/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("descriptor assembly fails closed for an inconsistent realized generation identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-managed-generation-mismatch-"));
  try {
    const fixture = writeProductionFixture(directory);
    buildManagedGenerationFixture(fixture);
    const managed = JSON.parse(fs.readFileSync(fixture.managedPath, "utf8"));
    managed.generationIdentity = crypto.createHash("sha256").update("inconsistent").digest("hex");
    fs.writeFileSync(fixture.managedPath, JSON.stringify(managed));

    const result = run(
      process.execPath,
      [
        "--import",
        "tsx",
        createDescriptorInput,
        "--version",
        "1.2.3",
        "--source-revision",
        revision,
        "--tarball",
        fixture.payloadPath,
        "--init",
        fixture.initPath,
        "--appliance-metadata",
        fixture.appliancePath,
        "--provider-profile",
        providerProfile,
        "--managed-generation",
        fixture.managedPath,
        "--flake-lock",
        flakeLock,
        "--output",
        fixture.descriptorInputPath,
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed-generation identity mismatch/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
