import type { ResolvedMottainaiSource } from "../bootstrap/source-resolution.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
  parseManagedPackageManifest,
} from "./managed-package-manifest.js";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";
import { generationIdentityOf } from "./managed-generation.js";
import type { ManagedGenerationMetadata } from "./managed-generation.js";
import type { DeploymentDescriptor } from "./deployment-descriptor.js";

/**
 * Composition-only release gate for the existing deployment, source, and
 * managed-generation contracts. This module deliberately owns no wire schema
 * and no identity algorithm; it only proves that the artifacts emitted by the
 * release producer agree at their real consumer boundaries.
 */
export interface DeploymentArtifactRoundtripInput {
  readonly descriptor: DeploymentDescriptor;
  readonly manifest: ManagedPackageManifest;
  readonly metadata: ManagedGenerationMetadata;
  readonly resolvedSource: ResolvedMottainaiSource;
  readonly payloadSha256: string;
  readonly payloadSourceRevision?: string;
  readonly flakeLockSha256: string;
}

export class DeploymentArtifactRoundtripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentArtifactRoundtripError";
  }
}

/**
 * Projects the descriptor's Route 2 package identities into the existing
 * managed-package manifest contract. The descriptor has one closed package
 * kind today, so this is a lossless boundary projection rather than another
 * package vocabulary or source-resolution implementation.
 */
export function managedManifestFromDeploymentDescriptor(descriptor: DeploymentDescriptor): ManagedPackageManifest {
  return parseManagedPackageManifest({
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: descriptor.route2.managedGeneration.packages.map((entry) => ({
      packageId: entry.packageId,
      kind: "nix-flake-package",
      version: entry.version,
      source: { flakeRef: entry.flakeRef, sourceSha256: entry.sourceSha256 },
    })),
  });
}

function fail(message: string): never {
  throw new DeploymentArtifactRoundtripError(message);
}

function mapByPackageId<T extends { packageId: string }>(entries: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (result.has(entry.packageId)) fail(`${label} contains duplicate packageId=${entry.packageId}`);
    result.set(entry.packageId, entry);
  }
  return result;
}

function assertSamePackageIds(expected: Map<string, unknown>, actual: Map<string, unknown>, label: string): void {
  if (expected.size !== actual.size || [...expected.keys()].some((packageId) => !actual.has(packageId))) {
    fail(`${label} package identities do not match the descriptor Route 2 package set`);
  }
}

/**
 * Fails closed unless one production-shaped descriptor agrees with the exact
 * payload bytes, the source resolver result, the realized managed-generation
 * metadata, and the canonical runtime generation identity.
 */
export function assertDeploymentArtifactRoundtrip(input: DeploymentArtifactRoundtripInput): void {
  const { descriptor, manifest, metadata, resolvedSource } = input;
  const route2 = descriptor.route2.managedGeneration;
  const descriptorPackages = mapByPackageId(route2.packages, "descriptor Route 2");
  const manifestPackages = mapByPackageId(manifest.packages, "managed manifest");
  const requestedPackages = mapByPackageId(
    metadata.requestedIdentity.packages,
    "managed-generation requested identity",
  );
  const outputPackages = mapByPackageId(metadata.nixOutput.packages, "managed-generation Nix output");

  assertSamePackageIds(descriptorPackages, manifestPackages, "managed manifest");
  assertSamePackageIds(descriptorPackages, requestedPackages, "managed-generation requested identity");
  assertSamePackageIds(descriptorPackages, outputPackages, "managed-generation Nix output");

  const payloadSha256 = input.payloadSha256.toLowerCase();
  if (route2.applicationPayloadSha256 !== payloadSha256 || descriptor.route1.payload.sha256 !== payloadSha256) {
    fail(
      `Route 1 payload identity mismatch: descriptor declares ${descriptor.route1.payload.sha256}, actual payload is ${input.payloadSha256}`,
    );
  }
  const payloadEvidence = metadata.applicationPayload;
  if (
    payloadEvidence === undefined ||
    payloadEvidence.packageName !== "mottainai" ||
    payloadEvidence.packageVersion !== descriptor.route1.payload.version ||
    payloadEvidence.sha256 !== payloadSha256
  ) {
    fail("managed-generation metadata does not prove the exact Route 1 payload was consumed");
  }
  if (input.payloadSourceRevision !== undefined) {
    const payloadSourceRevision = input.payloadSourceRevision.toLowerCase();
    if (descriptor.release.sourceRevision !== payloadSourceRevision) {
      fail(
        `Route 1 source revision mismatch: descriptor declares ${descriptor.release.sourceRevision}, payload declares ${input.payloadSourceRevision}`,
      );
    }
  }
  if (route2.flakeLockSha256 !== input.flakeLockSha256.toLowerCase()) {
    fail(
      `managed-generation flake lock identity mismatch: descriptor declares ${route2.flakeLockSha256}, actual lock is ${input.flakeLockSha256}`,
    );
  }

  for (const entry of manifest.packages) {
    const descriptorEntry = descriptorPackages.get(entry.packageId);
    const requestedEntry = requestedPackages.get(entry.packageId);
    if (descriptorEntry === undefined || requestedEntry === undefined) {
      fail(`managed-generation package identity is missing for packageId=${entry.packageId}`);
    }
    if (
      descriptorEntry.version !== entry.version ||
      descriptorEntry.flakeRef !== entry.source.flakeRef ||
      descriptorEntry.sourceSha256 !== entry.source.sourceSha256
    ) {
      fail(`descriptor Route 2 package identity differs from the managed manifest for packageId=${entry.packageId}`);
    }
    if (requestedEntry.version !== entry.version || requestedEntry.sourceSha256 !== entry.source.sourceSha256) {
      fail(`realized managed-generation requested identity differs for packageId=${entry.packageId}`);
    }
  }

  const mottainai = manifest.packages.find((entry) => entry.packageId === "mottainai");
  if (mottainai === undefined) fail("managed manifest has no mottainai package for source resolution");
  const expectedTag = `v${mottainai.version}`;
  if (resolvedSource.resolvedTag !== expectedTag) {
    fail(`source resolver resolved ${resolvedSource.resolvedTag}, expected ${expectedTag}`);
  }
  if (resolvedSource.narHashSha256.toLowerCase() !== mottainai.source.sourceSha256) {
    fail(
      `resolved source NAR identity mismatch for ${expectedTag}: manifest declares ${mottainai.source.sourceSha256}, resolver returned ${resolvedSource.narHashSha256}`,
    );
  }

  const canonicalGenerationIdentity = generationIdentityOf(manifest, metadata);
  if (route2.identity !== canonicalGenerationIdentity) {
    fail(
      `managed-generation identity is not canonical: descriptor declares ${route2.identity}, runtime contract derives ${canonicalGenerationIdentity}`,
    );
  }
  if (descriptor.route3.managedGenerationIdentity !== canonicalGenerationIdentity) {
    fail(
      `Route 3 managed-generation identity does not match the canonical runtime identity ${canonicalGenerationIdentity}`,
    );
  }
}
