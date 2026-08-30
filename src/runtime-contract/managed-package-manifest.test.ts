import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MANAGED_PACKAGE_IDS,
  MANAGED_PACKAGE_KINDS,
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
  ManagedPackageManifestError,
  canonicalManagedPackageManifestText,
  parseManagedPackageManifest,
  semanticIdentityOf,
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
        source: {
          flakeRef: "nix#mottainai",
          sourceSha256: "a".repeat(64),
        },
      },
      {
        packageId: "nawabari",
        kind: "nix-flake-package",
        version: "0.6.1",
        source: {
          flakeRef: "nix/packages/nawabari.nix",
          sourceSha256: "b".repeat(64),
        },
      },
    ],
    ...overrides,
  };
}

test("parses a well-formed managed package manifest", () => {
  const parsed = parseManagedPackageManifest(validManifest());
  assert.equal(parsed.contractId, MANAGED_PACKAGE_MANIFEST_CONTRACT_ID);
  assert.equal(parsed.packages.length, 2);
});

test("MANAGED_PACKAGE_IDS covers Mottainai and Nawabari and is extensible to Zellij/coding-agent CLI", () => {
  assert.ok(MANAGED_PACKAGE_IDS.includes("mottainai"));
  assert.ok(MANAGED_PACKAGE_IDS.includes("nawabari"));
  assert.ok(MANAGED_PACKAGE_IDS.includes("zellij"));
  assert.ok(MANAGED_PACKAGE_IDS.includes("coding-agent-cli"));
});

test("rejects an unrecognized contractId", () => {
  assert.throws(() => parseManagedPackageManifest(validManifest({ contractId: "other" })), ManagedPackageManifestError);
});

test("rejects an unrecognized schemaVersion", () => {
  assert.throws(() => parseManagedPackageManifest(validManifest({ schemaVersion: 2 })), ManagedPackageManifestError);
});

test("rejects a field outside the bounded contract (strict schema, fail closed)", () => {
  assert.throws(() => parseManagedPackageManifest({ ...validManifest(), extra: "field" }), ManagedPackageManifestError);
});

test("rejects an unknown/ambiguous packageId rather than silently degrading to unmanaged", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], packageId: "arbitrary-npm-package" };
  assert.throws(() => parseManagedPackageManifest(manifest), ManagedPackageManifestError);
});

test("rejects an unsupported package kind deterministically", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], kind: "npm-package" };
  assert.throws(() => parseManagedPackageManifest(manifest), ManagedPackageManifestError);
});

test("rejects a malformed source integrity digest", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], source: { flakeRef: "nix#mottainai", sourceSha256: "not-a-sha256" } };
  assert.throws(() => parseManagedPackageManifest(manifest), ManagedPackageManifestError);
});

test("rejects duplicate packageId entries", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  assert.throws(() => parseManagedPackageManifest({ ...manifest, packages: [packages[0], packages[0]] }), ManagedPackageManifestError);
});

test("rejects an entry missing a required identity field", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  const { version: _version, ...withoutVersion } = packages[0];
  assert.throws(() => parseManagedPackageManifest({ ...manifest, packages: [withoutVersion] }), ManagedPackageManifestError);
});

test("accepts optional compatibility metadata", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], compatibility: { minimumRuntimeContractSchemaVersion: 1, notes: "requires sshd" } };
  assert.doesNotThrow(() => parseManagedPackageManifest(manifest));
});

test("rejects unknown fields inside compatibility metadata (strict)", () => {
  const manifest = validManifest();
  const packages = manifest.packages as Record<string, unknown>[];
  packages[0] = { ...packages[0], compatibility: { unexpected: true } };
  assert.throws(() => parseManagedPackageManifest(manifest), ManagedPackageManifestError);
});

test("semantic identity is independent of JSON key ordering", () => {
  const parsed = parseManagedPackageManifest(validManifest());
  const reordered = parseManagedPackageManifest({
    packages: parsed.packages.map((entry) => ({
      source: { sourceSha256: entry.source.sourceSha256, flakeRef: entry.source.flakeRef },
      version: entry.version,
      kind: entry.kind,
      packageId: entry.packageId,
    })),
    schemaVersion: parsed.schemaVersion,
    activation: parsed.activation,
    contractId: parsed.contractId,
  });
  assert.equal(semanticIdentityOf(parsed), semanticIdentityOf(reordered));
});

test("semantic identity is independent of package array order", () => {
  const parsed = parseManagedPackageManifest(validManifest());
  const shuffled = parseManagedPackageManifest({ ...parsed, packages: [...parsed.packages].reverse() });
  assert.equal(semanticIdentityOf(parsed), semanticIdentityOf(shuffled));
});

test("semantic identity is independent of activation.generation (incidental bookkeeping, not desired state)", () => {
  const generationOne = parseManagedPackageManifest(validManifest({ activation: { generation: 1 } }));
  const generationFive = parseManagedPackageManifest(validManifest({ activation: { generation: 5 } }));
  assert.equal(semanticIdentityOf(generationOne), semanticIdentityOf(generationFive));
});

test("semantic identity changes when desired package state changes", () => {
  const base = parseManagedPackageManifest(validManifest());
  const changed = parseManagedPackageManifest(validManifest({ packages: [{ ...(validManifest().packages as Record<string, unknown>[])[0], version: "0.7.2" }] }));
  assert.notEqual(semanticIdentityOf(base), semanticIdentityOf(changed));
});

test("semantic identity is a deterministic sha256 hex digest, stable across repeated calls", () => {
  const parsed = parseManagedPackageManifest(validManifest());
  const first = semanticIdentityOf(parsed);
  const second = semanticIdentityOf(parsed);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test("canonical text is deterministic and reproducible across process runs (no timestamp/incidental fields)", () => {
  const parsed = parseManagedPackageManifest(validManifest());
  const textA = canonicalManagedPackageManifestText(parsed);
  const textB = canonicalManagedPackageManifestText(parsed);
  assert.equal(textA, textB);
  assert.doesNotMatch(textA, /generation/u);
});

test("MANAGED_PACKAGE_KINDS is bounded to the explicitly supported ecosystems", () => {
  assert.deepEqual(MANAGED_PACKAGE_KINDS, ["nix-flake-package"]);
});

test("persistence path is a relative path under the control-owned state root, not an absolute host path", () => {
  assert.ok(!MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH.startsWith("/"));
});
