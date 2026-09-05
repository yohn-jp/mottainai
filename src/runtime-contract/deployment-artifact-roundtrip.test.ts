import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BootstrapError } from "../bootstrap/errors.js";
import { BOOTSTRAP_TRUSTED_SOURCE_ORIGIN, resolveMottainaiSource } from "../bootstrap/source-resolution.js";
import { parseDeploymentDescriptor } from "./deployment-descriptor.js";
import {
  assertDeploymentArtifactRoundtrip,
  DeploymentArtifactRoundtripError,
  managedManifestFromDeploymentDescriptor,
} from "./deployment-artifact-roundtrip.js";
import { generationIdentityOf } from "./managed-generation.js";
import type { ManagedGenerationMetadata } from "./managed-generation.js";

const digest = (character: string): string => character.repeat(64);
const revision = "a".repeat(40);
const fixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../nix/tests/fixtures/alt-mottainai-source",
);

function fixtureArchive(version: string): Buffer {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-roundtrip-source-"));
  try {
    const wrapper = path.join(stagingRoot, `mottainai-${version}`);
    fs.cpSync(fixtureDirectory, wrapper, { recursive: true });
    const packageJsonPath = path.join(wrapper, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = version;
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`);
    const archivePath = path.join(stagingRoot, "source.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, path.basename(wrapper)]);
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

function providerArtifact(name: string, version: string, digestCharacter = "5") {
  return {
    version,
    architecture: "x86_64",
    filename: name,
    sha256: digest(digestCharacter),
    sizeBytes: 1024,
    locator: `https://example.invalid/${name}`,
  };
}

function descriptorValue({ identity = digest("2"), sourceSha256 = digest("4") } = {}) {
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
    route1: {
      payload: {
        packageName: "mottainai",
        version: "1.2.3",
        sourceRevision: revision,
        filename: "mottainai-1.2.3.tgz",
        sha256: digest("1"),
        integrity: `sha512-${"A".repeat(86)}`,
        locator: "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-1.2.3.tgz",
      },
    },
    route2: {
      managedGeneration: {
        contractId: "mottainai.managed-generation.v1",
        schemaVersion: 1,
        version: "1.2.3",
        sourceRevision: revision,
        identity,
        flakeLockSha256: digest("3"),
        applicationPayloadSha256: digest("1"),
        packages: [
          {
            packageId: "mottainai",
            version: "1.2.3",
            flakeRef: "nix#mottainai",
            sourceSha256,
          },
        ],
      },
    },
    route3: {
      appliance: {
        contractId: "mottainai.linux-runtime-appliance.v1",
        schemaVersion: 1,
        architecture: "x86_64-linux",
        version: "1.2.3",
        sourceRevision: revision,
        registry: "ghcr.io",
        repository: "yohn-jp/mottainai/runtime-appliance",
        digest: `sha256:${digest("6")}`,
        rawSha256: digest("7"),
        rawSizeBytes: 2048,
        manifestSha256: digest("8"),
        locator: "https://ghcr.io/v2/yohn-jp/mottainai/runtime-appliance",
      },
      managedGenerationIdentity: identity,
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

function metadataFor(sourceSha256: string): ManagedGenerationMetadata {
  return {
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: {
      packages: [{ packageId: "mottainai", version: "1.2.3", sourceSha256 }],
    },
    resolvedIdentity: {
      packages: [{ packageId: "mottainai", resolvedVersion: "1.2.3" }],
    },
    nixOutput: {
      storePath: "/nix/store/example-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/example-mottainai",
          sourceStorePath: "/nix/store/example-mottainai-source",
        },
      ],
    },
    applicationPayload: { packageName: "mottainai", packageVersion: "1.2.3", sha256: digest("1") },
  };
}

function roundtripInput(sourceSha256 = digest("4")) {
  const initialDescriptor = parseDeploymentDescriptor(descriptorValue({ sourceSha256 }));
  const manifest = managedManifestFromDeploymentDescriptor(initialDescriptor);
  const metadata = metadataFor(sourceSha256);
  const identity = generationIdentityOf(manifest, metadata);
  const descriptor = parseDeploymentDescriptor(descriptorValue({ identity, sourceSha256 }));
  return {
    descriptor,
    manifest,
    metadata,
    resolvedSource: {
      sourcePath: "/tmp/resolved-mottainai-source",
      resolvedTag: "v1.2.3",
      narHashSha256: sourceSha256,
    },
    payloadSha256: digest("1"),
    payloadSourceRevision: revision,
    flakeLockSha256: digest("3"),
  };
}

test("accepts a production-shaped descriptor through the canonical round-trip", () => {
  const input = roundtripInput();
  assert.doesNotThrow(() => assertDeploymentArtifactRoundtrip(input));
  assert.notEqual(input.payloadSha256, input.resolvedSource.narHashSha256);
  assert.notEqual(input.payloadSha256, input.descriptor.route2.managedGeneration.identity);
  assert.notEqual(input.resolvedSource.narHashSha256, input.descriptor.route2.managedGeneration.identity);
});

test("rejects the former npm payload SHA substituted for the source NAR identity", () => {
  const input = roundtripInput(digest("1"));
  input.resolvedSource.narHashSha256 = digest("4");

  assert.throws(
    () => assertDeploymentArtifactRoundtrip(input),
    (error: unknown) =>
      error instanceof DeploymentArtifactRoundtripError && /resolved source NAR identity mismatch/u.test(error.message),
  );
});

test("the real source-resolution boundary rejects the payload SHA substitution", async (t) => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-roundtrip-source-test-"));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));

  const descriptor = parseDeploymentDescriptor(descriptorValue({ sourceSha256: digest("1") }));
  const manifest = managedManifestFromDeploymentDescriptor(descriptor);
  const mottainai = manifest.packages.find((entry) => entry.packageId === "mottainai");
  assert.ok(mottainai);
  const actualSourceNarSha256 = digest("4");

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: mottainai.version,
      expectedSourceSha256: mottainai.source.sourceSha256,
      destinationDirectory: destination,
      fetcher: async (url) => {
        assert.equal(url, `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v${mottainai.version}.tar.gz`);
        return streamOf(fixtureArchive(mottainai.version));
      },
      narHashOfTree: () => actualSourceNarSha256,
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_integrity_mismatch",
  );
});

test("rejects a workflow-specific managed-generation identity", () => {
  const input = roundtripInput();
  const inconsistentDescriptor = parseDeploymentDescriptor(descriptorValue({ identity: digest("c") }));
  input.descriptor = inconsistentDescriptor;

  assert.throws(
    () => assertDeploymentArtifactRoundtrip(input),
    (error: unknown) =>
      error instanceof DeploymentArtifactRoundtripError &&
      /managed-generation identity is not canonical/u.test(error.message),
  );
});
