import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION,
  MANAGED_GENERATION_CONTRACT_ID,
  ManagedGenerationError,
  assertManifestProjectable,
  generationIdentityOf,
  parseManagedGenerationMetadata,
  verifySourceIntegrity,
} from "./managed-generation.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
  parseManagedPackageManifest,
} from "./managed-package-manifest.js";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "0.7.1",
        source: { flakeRef: "nix#mottainai", sourceSha256: "a".repeat(64) },
      },
      {
        packageId: "nawabari",
        kind: "nix-flake-package",
        version: "0.6.1",
        source: { flakeRef: "nix/packages/nawabari.nix", sourceSha256: "b".repeat(64) },
      },
    ],
    ...overrides,
  };
}

function validMetadata(overrides: Record<string, unknown> = {}) {
  return {
    contractId: MANAGED_GENERATION_CONTRACT_ID,
    schemaVersion: MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION,
    compatibilityContractVersion: MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION,
    requestedIdentity: {
      packages: [
        { packageId: "mottainai", version: "0.7.1", sourceSha256: "a".repeat(64) },
        { packageId: "nawabari", version: "0.6.1", sourceSha256: "b".repeat(64) },
      ],
    },
    resolvedIdentity: {
      packages: [
        { packageId: "mottainai", resolvedVersion: "0.7.1" },
        { packageId: "nawabari", resolvedVersion: "0.6.1" },
      ],
    },
    nixOutput: {
      storePath: "/nix/store/aaaa-mottainai-managed-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/bbbb-mottainai-0.7.1",
          sourceStorePath: "/nix/store/1111-source",
        },
        {
          packageId: "nawabari",
          storePath: "/nix/store/cccc-nawabari-0.6.1",
          sourceStorePath: "/nix/store/2222-nawabari-0.6.1.tgz",
        },
      ],
    },
    ...overrides,
  };
}

test("assertManifestProjectable accepts the supported mottainai/nawabari nix-flake-package entries", () => {
  assert.doesNotThrow(() => assertManifestProjectable(parseManagedPackageManifest(validManifest())));
});

test("assertManifestProjectable rejects an unsupported packageId deterministically, before any Nix build", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  // zellij is a recognized #624 packageId but has no #625 projection recipe
  // yet — this proves rejection is scoped to "this projection has a
  // recipe", not merely "#624 recognizes the identity".
  packages.push({
    packageId: "zellij",
    kind: "nix-flake-package",
    version: "1.0.0",
    source: { flakeRef: "nix#zellij", sourceSha256: "c".repeat(64) },
  });
  const parsed = parseManagedPackageManifest(manifest);
  assert.throws(() => assertManifestProjectable(parsed), ManagedGenerationError);
});

test("assertManifestProjectable rejects a supported packageId with an unrecognized flakeRef (no recipe available)", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], source: { flakeRef: "nix#mottainai-fork", sourceSha256: "a".repeat(64) } };
  const parsed = parseManagedPackageManifest(manifest);
  assert.throws(() => assertManifestProjectable(parsed), ManagedGenerationError);
});

test("parseManagedGenerationMetadata accepts well-formed metadata", () => {
  const parsed = parseManagedGenerationMetadata(validMetadata());
  assert.equal(parsed.contractId, MANAGED_GENERATION_CONTRACT_ID);
});

test("parseManagedGenerationMetadata rejects an unrecognized contractId (fail closed)", () => {
  assert.throws(() => parseManagedGenerationMetadata(validMetadata({ contractId: "other" })), ManagedGenerationError);
});

test("parseManagedGenerationMetadata rejects a field outside the bounded shape (strict schema)", () => {
  assert.throws(() => parseManagedGenerationMetadata({ ...validMetadata(), extra: "field" }), ManagedGenerationError);
});

test("generationIdentityOf is a deterministic sha256 hex digest, stable across repeated calls", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  const first = generationIdentityOf(manifest, metadata);
  const second = generationIdentityOf(manifest, metadata);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test("generationIdentityOf is independent of nixOutput.packages array order", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  const reordered = parseManagedGenerationMetadata(
    validMetadata({
      nixOutput: {
        storePath: metadata.nixOutput.storePath,
        packages: [...metadata.nixOutput.packages].reverse(),
      },
    }),
  );
  assert.equal(generationIdentityOf(manifest, metadata), generationIdentityOf(manifest, reordered));
});

test("generationIdentityOf is independent of manifest activation.generation (bookkeeping, not desired state)", () => {
  const generationOne = parseManagedPackageManifest(validManifest({ activation: { generation: 1 } }));
  const generationFive = parseManagedPackageManifest(validManifest({ activation: { generation: 5 } }));
  const metadata = parseManagedGenerationMetadata(validMetadata());
  assert.equal(generationIdentityOf(generationOne, metadata), generationIdentityOf(generationFive, metadata));
});

test("generationIdentityOf changes when the managed Mottainai version changes", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());

  const bumpedManifest = parseManagedPackageManifest(
    validManifest({
      packages: [
        { ...(validManifest().packages as Record<string, unknown>[])[0], version: "0.7.2" },
        (validManifest().packages as Record<string, unknown>[])[1],
      ],
    }),
  );
  const bumpedMetadata = parseManagedGenerationMetadata(
    validMetadata({
      requestedIdentity: {
        packages: [
          { packageId: "mottainai", version: "0.7.2", sourceSha256: "a".repeat(64) },
          { packageId: "nawabari", version: "0.6.1", sourceSha256: "b".repeat(64) },
        ],
      },
      resolvedIdentity: {
        packages: [
          { packageId: "mottainai", resolvedVersion: "0.7.2" },
          { packageId: "nawabari", resolvedVersion: "0.6.1" },
        ],
      },
      nixOutput: {
        storePath: "/nix/store/dddd-mottainai-managed-generation",
        packages: [
          {
            packageId: "mottainai",
            storePath: "/nix/store/eeee-mottainai-0.7.2",
            sourceStorePath: "/nix/store/3333-source",
          },
          {
            packageId: "nawabari",
            storePath: "/nix/store/cccc-nawabari-0.6.1",
            sourceStorePath: "/nix/store/2222-nawabari-0.6.1.tgz",
          },
        ],
      },
    }),
  );

  assert.notEqual(generationIdentityOf(manifest, metadata), generationIdentityOf(bumpedManifest, bumpedMetadata));
});

test("generationIdentityOf changes when the resolved Nix output store path changes but the manifest does not", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  const rebuiltMetadata = parseManagedGenerationMetadata(
    validMetadata({
      nixOutput: {
        storePath: "/nix/store/ffff-mottainai-managed-generation",
        packages: metadata.nixOutput.packages,
      },
    }),
  );
  assert.notEqual(generationIdentityOf(manifest, metadata), generationIdentityOf(manifest, rebuiltMetadata));
});

test("generationIdentityOf is the same for the same manifest and the same resolved Nix output (reproducible build)", () => {
  const manifestA = parseManagedPackageManifest(validManifest());
  const manifestB = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  assert.equal(generationIdentityOf(manifestA, metadata), generationIdentityOf(manifestB, metadata));
});

test("metadata carries requested identity, resolved identity, Nix output/store identity, and compatibility contract version", () => {
  const parsed = parseManagedGenerationMetadata(validMetadata());
  assert.ok(parsed.requestedIdentity.packages.length > 0);
  assert.ok(parsed.resolvedIdentity.packages.length > 0);
  assert.ok(parsed.nixOutput.storePath.length > 0);
  assert.equal(parsed.compatibilityContractVersion, MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION);
});

test("verifySourceIntegrity passes when every entry's resolved source hashes to the manifest's declared sourceSha256", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  const narHashes: Record<string, string> = {
    "/nix/store/1111-source": "a".repeat(64),
    "/nix/store/2222-nawabari-0.6.1.tgz": "b".repeat(64),
  };
  assert.doesNotThrow(() => verifySourceIntegrity(manifest, metadata, (storePath) => narHashes[storePath] ?? ""));
});

test("verifySourceIntegrity fails closed when a resolved source's hash does not match the manifest's declared sourceSha256", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  assert.throws(() => verifySourceIntegrity(manifest, metadata, () => "f".repeat(64)), ManagedGenerationError);
});

test("verifySourceIntegrity normalizes an uppercase-hex narHash before comparing", () => {
  const manifest = parseManagedPackageManifest(validManifest());
  const metadata = parseManagedGenerationMetadata(validMetadata());
  const narHashes: Record<string, string> = {
    "/nix/store/1111-source": "A".repeat(64),
    "/nix/store/2222-nawabari-0.6.1.tgz": "B".repeat(64),
  };
  assert.doesNotThrow(() => verifySourceIntegrity(manifest, metadata, (storePath) => narHashes[storePath] ?? ""));
});
