import assert from "node:assert/strict";
import test from "node:test";
import { buildLimaRuntimeSpec } from "./build-lima-runtime-spec.mjs";

// Fakes stand in for the real runtime-contract/managed-package-manifest.ts
// authority so this test stays a plain, tsx-free .mjs unit test of the pure
// transform. The real authority is exercised by
// src/runtime-contract/managed-package-manifest.test.ts; this test only
// proves buildLimaRuntimeSpec wires its inputs to that authority correctly.
function fakeParseManagedPackageManifest(value) {
  assert.equal(value.contractId, "mottainai.managed-package-manifest.v1");
  assert.equal(value.schemaVersion, 1);
  return value;
}

function fakeCanonicalPersistedManagedPackageManifestText(manifest) {
  const sortedPackages = [...manifest.packages].sort((left, right) => (left.packageId < right.packageId ? -1 : 1));
  return JSON.stringify({
    contractId: manifest.contractId,
    schemaVersion: manifest.schemaVersion,
    activation: manifest.activation,
    packages: sortedPackages,
  });
}

function descriptorFixture() {
  return {
    release: { version: "0.9.0" },
    route2: {
      managedGeneration: {
        packages: [
          { packageId: "mottainai", version: "0.9.0", flakeRef: "nix#mottainai", sourceSha256: "e".repeat(64) },
          { packageId: "nawabari", version: "0.6.1", flakeRef: "nix#nawabari", sourceSha256: "f".repeat(64) },
        ],
      },
    },
    route3: {
      appliance: {
        registry: "ghcr.io",
        repository: "yohn-jp/mottainai/runtime-appliance",
        digest: `sha256:${"a".repeat(64)}`,
      },
      managedGenerationIdentity: "c".repeat(64),
    },
  };
}

test("derives a bounded RuntimeSpec with a materialized managed-generation manifest from the descriptor alone", () => {
  const spec = buildLimaRuntimeSpec({
    descriptor: descriptorFixture(),
    parseManagedPackageManifest: fakeParseManagedPackageManifest,
    canonicalPersistedManagedPackageManifestText: fakeCanonicalPersistedManagedPackageManifestText,
  });

  assert.equal(spec.schema_version, "mottainai.host-bootstrap.lima-runtime-spec.v1");
  assert.equal(spec.instance_name, "mottainai-runtime");
  assert.equal(spec.architecture, "x86_64");
  assert.equal(spec.cpus, 2);
  assert.equal(spec.memory_mib, 4096);
  assert.deepEqual(spec.mounts, []);
  assert.equal(spec.appliance.digest, `sha256:${"a".repeat(64)}`);
  assert.equal(spec.managed_generation.identity, "c".repeat(64));
  assert.equal(spec.managed_generation.manifest.activation.generation, 1);
  assert.deepEqual(
    spec.managed_generation.manifest.packages.map((entry) => entry.packageId),
    ["mottainai", "nawabari"],
  );
  for (const entry of spec.managed_generation.manifest.packages) {
    assert.equal(entry.kind, "nix-flake-package");
  }
});

test("honors explicit instance name and bounded CPU/memory product-level intent", () => {
  const spec = buildLimaRuntimeSpec({
    descriptor: descriptorFixture(),
    instanceName: "custom-instance",
    cpus: 4,
    memoryMib: 8192,
    parseManagedPackageManifest: fakeParseManagedPackageManifest,
    canonicalPersistedManagedPackageManifestText: fakeCanonicalPersistedManagedPackageManifestText,
  });

  assert.equal(spec.instance_name, "custom-instance");
  assert.equal(spec.cpus, 4);
  assert.equal(spec.memory_mib, 8192);
});

test("rejects a non-positive cpus or memoryMib before touching the descriptor", () => {
  const deps = {
    descriptor: descriptorFixture(),
    parseManagedPackageManifest: fakeParseManagedPackageManifest,
    canonicalPersistedManagedPackageManifestText: fakeCanonicalPersistedManagedPackageManifestText,
  };
  assert.throws(() => buildLimaRuntimeSpec({ ...deps, cpus: 0 }), /cpus must be a positive integer/);
  assert.throws(() => buildLimaRuntimeSpec({ ...deps, memoryMib: -1 }), /memoryMib must be a positive integer/);
});

test("never invents a package kind: every entry is exactly the closed nix-flake-package kind", () => {
  const spec = buildLimaRuntimeSpec({
    descriptor: descriptorFixture(),
    parseManagedPackageManifest: fakeParseManagedPackageManifest,
    canonicalPersistedManagedPackageManifestText: fakeCanonicalPersistedManagedPackageManifestText,
  });
  const kinds = new Set(spec.managed_generation.manifest.packages.map((entry) => entry.kind));
  assert.deepEqual([...kinds], ["nix-flake-package"]);
});
