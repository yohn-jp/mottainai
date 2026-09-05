import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalDeploymentDescriptorText,
  deploymentDescriptorIdentityOf,
  parseDeploymentDescriptor,
  DeploymentDescriptorError,
} from "./deployment-descriptor.js";

const digest = (character: string): string => character.repeat(64);
const revision = "a".repeat(40);

function validDescriptor(): Record<string, unknown> {
  const route1Payload = {
    packageName: "mottainai",
    version: "1.2.3",
    sourceRevision: revision,
    filename: "mottainai-1.2.3.tgz",
    sha256: digest("1"),
    integrity: "sha512-" + "A".repeat(86),
    locator: "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-1.2.3.tgz",
  };
  const managedGeneration = {
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    version: "1.2.3",
    sourceRevision: revision,
    identity: digest("2"),
    flakeLockSha256: digest("3"),
    applicationPayloadSha256: digest("1"),
    packages: [{ packageId: "mottainai", version: "1.2.3", flakeRef: "nix#mottainai", sourceSha256: digest("4") }],
  };
  const providerArtifact = (name: string, providerVersion: string, digestCharacter = "5") => ({
    version: providerVersion,
    architecture: "x86_64",
    filename: name,
    sha256: digest(digestCharacter),
    sizeBytes: 1024,
    locator: `https://example.invalid/${name}`,
  });
  return {
    contractId: "mottainai.deployment.v1",
    schemaVersion: 1,
    release: { version: "1.2.3", tag: "v1.2.3", sourceRevision: revision },
    profile: "linux-x86_64",
    architecture: "x86_64-linux",
    contracts: {
      descriptor: "mottainai.deployment.v1",
      application: "mottainai.npm-payload.v1",
      managedGeneration: "mottainai.managed-generation.v1",
      appliance: "mottainai.linux-runtime-appliance.v1",
      provider: "mottainai.route4-provider-profile.v1",
    },
    route1: { payload: route1Payload },
    route2: { managedGeneration },
    route3: {
      appliance: {
        contractId: "mottainai.linux-runtime-appliance.v1",
        schemaVersion: 1,
        architecture: "x86_64-linux",
        version: "1.2.3",
        sourceRevision: revision,
        registry: "ghcr.io",
        repository: "yohn-jp/mottainai/runtime-appliance",
        digest: "sha256:" + digest("6"),
        rawSha256: digest("7"),
        rawSizeBytes: 2048,
        manifestSha256: digest("8"),
        locator: "https://ghcr.io/v2/yohn-jp/mottainai/runtime-appliance",
      },
      managedGenerationIdentity: digest("2"),
    },
    route4: {
      mottainaiInit: {
        version: "1.2.3",
        sourceRevision: revision,
        architecture: "x86_64-linux",
        filename: "mottainai-init-linux-x86_64",
        sha256: digest("9"),
        locator: "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-init-linux-x86_64",
      },
      provider: {
        profileId: "linux-x86_64",
        architecture: "x86_64-linux",
        provisioning: { strategy: "pinned-verified-archives", contractVersion: 1, stateDirectory: "host-bootstrap" },
        lima: providerArtifact("lima.tar.gz", "2.2.0"),
        qemu: {
          version: "9.2.0",
          architecture: "x86_64",
          identity: digest("a"),
          identityKind: "executable-digest",
          systemBinary: providerArtifact("qemu-system-x86_64", "9.2.0", "6"),
          imageBinary: providerArtifact("qemu-img", "9.2.0", "7"),
          dataArtifact: providerArtifact("qemu-data.tar.gz", "9.2.0", "8"),
          minimumVersion: "9.2.0",
        },
        compatibility: { limaMajor: 2, qemuMajor: 9, requiresKvm: true },
      },
    },
  };
}

test("accepts a complete descriptor and derives deterministic identity", () => {
  const descriptor = parseDeploymentDescriptor(validDescriptor());
  assert.match(deploymentDescriptorIdentityOf(descriptor), /^[0-9a-f]{64}$/u);
  assert.equal(canonicalDeploymentDescriptorText(descriptor), canonicalDeploymentDescriptorText(descriptor));
});

test("canonical identity is independent of managed package ordering", () => {
  const first = validDescriptor();
  const route2 = first.route2 as { managedGeneration: { packages: unknown[] } };
  route2.managedGeneration.packages.push({
    packageId: "nawabari",
    version: "0.6.1",
    flakeRef: "nix/packages/nawabari.nix",
    sourceSha256: digest("b"),
  });
  const second = structuredClone(first);
  const packages = (second.route2 as { managedGeneration: { packages: unknown[] } }).managedGeneration.packages;
  packages.reverse();
  assert.equal(
    deploymentDescriptorIdentityOf(parseDeploymentDescriptor(first)),
    deploymentDescriptorIdentityOf(parseDeploymentDescriptor(second)),
  );
});

test("rejects unknown schema, mutable-only appliance identity, and cross-release artifacts", () => {
  const unknownSchema = validDescriptor();
  unknownSchema.schemaVersion = 2;
  assert.throws(() => parseDeploymentDescriptor(unknownSchema), DeploymentDescriptorError);

  const mutableOnly = validDescriptor();
  (mutableOnly.route3 as { appliance: Record<string, unknown> }).appliance.digest = "v1.2.3";
  assert.throws(() => parseDeploymentDescriptor(mutableOnly), DeploymentDescriptorError);

  const wrongRevision = validDescriptor();
  (wrongRevision.route4 as { mottainaiInit: Record<string, unknown> }).mottainaiInit.sourceRevision = "b".repeat(40);
  assert.throws(() => parseDeploymentDescriptor(wrongRevision), DeploymentDescriptorError);
});

test("rejects an identity graph whose Route 3 generation differs from Route 2", () => {
  const descriptor = validDescriptor();
  (descriptor.route3 as { managedGenerationIdentity: string }).managedGenerationIdentity = digest("c");
  assert.throws(() => parseDeploymentDescriptor(descriptor), /exact managed-generation identity/u);
});

test("rejects a Route 1 payload without an immutable locator", () => {
  const descriptor = validDescriptor();
  delete (descriptor.route1 as { payload: Record<string, unknown> }).payload.locator;
  assert.throws(() => parseDeploymentDescriptor(descriptor), DeploymentDescriptorError);
});

test("rejects an incompatible provider profile", () => {
  const descriptor = validDescriptor();
  const provider = (descriptor.route4 as { provider: { compatibility: Record<string, unknown> } }).provider;
  provider.compatibility.requiresKvm = false;
  assert.throws(() => parseDeploymentDescriptor(descriptor), DeploymentDescriptorError);
});

test("the release Route 4 provider profile matches the canonical pinned-verified-archives contract", () => {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "release",
    "deployment-provider-profile-linux-x86_64.json",
  );
  const profile = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(profile.provisioning.strategy, "pinned-verified-archives");
  assert.equal(profile.qemu.identityKind, "executable-digest");
  assert.ok(profile.qemu.systemBinary, "pinned-verified-archives QEMU profile must bind systemBinary");
  assert.ok(profile.qemu.imageBinary, "pinned-verified-archives QEMU profile must bind imageBinary");
  assert.ok(profile.qemu.dataArtifact, "every QEMU profile must bind the firmware/data artifact");
  assert.equal(profile.qemu.version, "11.0.0");
  assert.equal(profile.compatibility.qemuMajor, 11);
  assert.notEqual(profile.qemu.dataArtifact.sha256, profile.qemu.systemBinary.sha256);
  assert.notEqual(profile.qemu.dataArtifact.sha256, profile.qemu.imageBinary.sha256);

  const withReleaseProfile = validDescriptor();
  (withReleaseProfile.route4 as { provider: unknown }).provider = profile;
  const descriptor = parseDeploymentDescriptor(withReleaseProfile);
  assert.equal(descriptor.route4.provider.provisioning.strategy, "pinned-verified-archives");
});

test("requires a distinct QEMU firmware/data identity", () => {
  const descriptor = validDescriptor();
  const qemu = (descriptor.route4 as { provider: { qemu: Record<string, unknown> } }).provider.qemu;
  qemu.dataArtifact = qemu.systemBinary;
  assert.throws(() => parseDeploymentDescriptor(descriptor), /distinct artifacts/u);
});

test("changing only QEMU data identity changes the descriptor identity", () => {
  const first = parseDeploymentDescriptor(validDescriptor());
  const secondValue = validDescriptor();
  const qemu = (secondValue.route4 as { provider: { qemu: { dataArtifact: { sha256: string } } } }).provider.qemu;
  qemu.dataArtifact.sha256 = digest("b");
  const second = parseDeploymentDescriptor(secondValue);
  assert.notEqual(deploymentDescriptorIdentityOf(first), deploymentDescriptorIdentityOf(second));
});

test("fails closed when the QEMU firmware/data identity is missing", () => {
  const descriptor = validDescriptor();
  const qemu = (descriptor.route4 as { provider: { qemu: Record<string, unknown> } }).provider.qemu;
  delete qemu.dataArtifact;
  assert.throws(() => parseDeploymentDescriptor(descriptor), DeploymentDescriptorError);
});
