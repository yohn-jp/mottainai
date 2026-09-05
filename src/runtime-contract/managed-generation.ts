import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";
import { semanticIdentityOf } from "./managed-package-manifest.js";

/**
 * mottainai.managed-generation.v1 — the bounded, machine-readable result of
 * projecting a mottainai.managed-package-manifest.v1 manifest (#624,
 * managed-package-manifest.ts) into a buildable Nix managed generation
 * (Issue #625, nix/managed-generation.nix). Distinct from
 * mottainai.linux-runtime-appliance.v1 (appliance-manifest.ts, the base
 * disk's own build provenance): this generation is a separate Nix build
 * target that never references the appliance's disk image or NixOS system
 * closure, so a manifest change never forces the appliance to rebuild.
 *
 * This module owns only the parts of the projection expressible in pure
 * TypeScript: the closed set of package kinds/ids this projection
 * recognizes (so an unsupported entry can be rejected before Nix is ever
 * invoked), generation-identity derivation, source-integrity verification
 * against the resolved build (given an injected NAR-hash lookup so this
 * module stays subprocess-free), and the schema for the metadata
 * scripts/build-managed-generation.mjs emits after actually running `nix
 * build` against nix/managed-generation.nix. It does not invoke Nix
 * itself — see scripts/build-managed-generation.mjs.
 */
export const MANAGED_GENERATION_CONTRACT_ID = "mottainai.managed-generation.v1" as const;
export const MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION = 1 as const;

/**
 * The exact (packageId, kind, flakeRef) combinations nix/managed-generation.nix
 * has a recipe for. Kept in lockstep with that file's `resolveEntry`
 * function — mirrored here (not imported, TypeScript cannot import Nix) so
 * a manifest containing an unsupported entry can be rejected deterministically
 * before any Nix invocation, matching Issue #625's "fail deterministically
 * for unsupported package kinds or unavailable recipes" without requiring a
 * Nix toolchain to prove it in tests.
 */
// Issue #662 adds zellij: an explicitly delegated nixpkgs package identity
// (nix/flake.nix's `mkZellij` -> pinned `nixpkgs#zellij-unwrapped`, not a
// repository-owned recipe) rather than a new fetchurl/repo-checkout recipe,
// per that Issue's constraint to prefer existing high-quality nixpkgs
// packages. `coding-agent-cli` stays absent from this table: it is a
// #624-recognized packageId with no projection here, since Issue #662 only
// projects a package once Mottainai claims first-class support for it.
const SUPPORTED_PROJECTIONS: ReadonlyArray<{ packageId: string; kind: string; flakeRef: string }> = [
  { packageId: "mottainai", kind: "nix-flake-package", flakeRef: "nix#mottainai" },
  { packageId: "nawabari", kind: "nix-flake-package", flakeRef: "nix/packages/nawabari.nix" },
  { packageId: "zellij", kind: "nix-flake-package", flakeRef: "nixpkgs#zellij-unwrapped" },
];

export class ManagedGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedGenerationError";
  }
}

/**
 * Fails closed: throws ManagedGenerationError naming the first entry this
 * projection has no recipe for, without attempting any Nix build. A
 * manifest entry's packageId/kind alone determined at #624 parse time is
 * not sufficient — this projection additionally requires the exact
 * flakeRef it knows how to build from (Issue #625: "unavailable recipes").
 */
export function assertManifestProjectable(manifest: ManagedPackageManifest): void {
  for (const entry of manifest.packages) {
    const supported = SUPPORTED_PROJECTIONS.some(
      (projection) =>
        projection.packageId === entry.packageId &&
        projection.kind === entry.kind &&
        projection.flakeRef === entry.source.flakeRef,
    );
    if (!supported) {
      throw new ManagedGenerationError(
        `managed generation projection: no recipe for packageId=${entry.packageId} kind=${entry.kind} flakeRef=${entry.source.flakeRef}`,
      );
    }
  }
}

const packageIdentitySchema = z.object({ packageId: z.string().min(1).max(128) }).passthrough();

const requestedPackageSchema = packageIdentitySchema
  .extend({
    version: z.string().min(1).max(128),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
  })
  .strict();

const resolvedPackageSchema = packageIdentitySchema
  .extend({
    resolvedVersion: z.string().min(1).max(128),
  })
  .strict();

const nixOutputPackageSchema = packageIdentitySchema
  .extend({
    storePath: z.string().min(1).max(4_096),
    sourceStorePath: z.string().min(1).max(4_096),
  })
  .strict();

const MAX_METADATA_PACKAGE_ENTRIES = 64 as const;

/** Evidence emitted only when Route 2 consumed an exact Route 1 payload. */
export const ManagedGenerationApplicationPayloadSchema = z
  .object({
    packageName: z.literal("mottainai"),
    packageVersion: z.string().min(1).max(128),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export type ManagedGenerationApplicationPayload = z.infer<typeof ManagedGenerationApplicationPayloadSchema>;

/**
 * Schema for the metadata JSON nix/managed-generation.nix's metadataFile
 * derivation emits. Bounded (array-length caps mirror #624's
 * MAX_PACKAGE_ENTRIES) and machine-readable, satisfying Issue #625's
 * requirement to emit "requested identity, resolved identity, Nix
 * output/store identity, compatibility contract version".
 */
export const ManagedGenerationMetadataSchema = z
  .object({
    contractId: z.literal(MANAGED_GENERATION_CONTRACT_ID),
    schemaVersion: z.literal(MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION),
    compatibilityContractVersion: z.literal(MANAGED_GENERATION_COMPATIBILITY_CONTRACT_VERSION),
    requestedIdentity: z
      .object({ packages: z.array(requestedPackageSchema).max(MAX_METADATA_PACKAGE_ENTRIES) })
      .strict(),
    resolvedIdentity: z.object({ packages: z.array(resolvedPackageSchema).max(MAX_METADATA_PACKAGE_ENTRIES) }).strict(),
    nixOutput: z
      .object({
        storePath: z.string().min(1).max(4_096),
        packages: z.array(nixOutputPackageSchema).max(MAX_METADATA_PACKAGE_ENTRIES),
      })
      .strict(),
    applicationPayload: ManagedGenerationApplicationPayloadSchema.optional(),
  })
  .strict();

export type ManagedGenerationMetadata = z.infer<typeof ManagedGenerationMetadataSchema>;

export function parseManagedGenerationMetadata(value: unknown): ManagedGenerationMetadata {
  const result = ManagedGenerationMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new ManagedGenerationError(
      `managed generation metadata is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

export function readManagedGenerationMetadata(filePath: string): ManagedGenerationMetadata {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ManagedGenerationError(
      `managed generation metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseManagedGenerationMetadata(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new ManagedGenerationError("managed generation identity contains an unsupported value for canonicalization");
}

/**
 * Deterministic generation identity: a SHA-256 of the manifest's own
 * semantic identity (#624 semanticIdentityOf — desired state, independent
 * of activation.generation/JSON ordering) plus the resolved Nix store
 * paths the projection actually produced. Two builds from the same
 * manifest and the same locked Nix inputs (nix/flake.lock unchanged)
 * therefore report the same generation identity; a version bump, a
 * different resolved store path, or a different desired package set all
 * change it (Issue #625: "same manifest and same locked Nix inputs produce
 * the same semantic generation identity").
 */
export function generationIdentityOf(manifest: ManagedPackageManifest, metadata: ManagedGenerationMetadata): string {
  const canonical = {
    manifestSemanticIdentity: semanticIdentityOf(manifest),
    nixOutput: {
      storePath: metadata.nixOutput.storePath,
      packages: [...metadata.nixOutput.packages]
        .sort((left, right) => (left.packageId < right.packageId ? -1 : left.packageId > right.packageId ? 1 : 0))
        .map((entry) => ({ packageId: entry.packageId, storePath: entry.storePath })),
    },
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/**
 * Verifies the manifest's declared sourceSha256 for every entry against
 * the exact source Nix actually resolved and built from (metadata's
 * per-package `sourceStorePath`), unifying sourceSha256's meaning across
 * fetch mechanisms as "resolved build source integrity" rather than a
 * distribution-tarball digest kept as a separate concept. `narHashOf` is
 * injected (rather than this module shelling out to `nix path-info`
 * itself) so this stays pure/subprocess-free and independently testable;
 * scripts/build-managed-generation.mjs supplies it from a real `nix
 * path-info --json` call. Throws ManagedGenerationError naming the first
 * mismatching entry — fails closed rather than reporting a build as
 * verified when its source integrity does not match the manifest.
 */
export function verifySourceIntegrity(
  manifest: ManagedPackageManifest,
  metadata: ManagedGenerationMetadata,
  narHashOf: (sourceStorePath: string) => string,
): void {
  for (const entry of manifest.packages) {
    const resolved = metadata.nixOutput.packages.find((candidate) => candidate.packageId === entry.packageId);
    if (resolved === undefined) {
      throw new ManagedGenerationError(
        `managed generation metadata has no resolved entry for packageId=${entry.packageId}`,
      );
    }
    const actualSha256 = narHashOf(resolved.sourceStorePath).toLowerCase();
    if (actualSha256 !== entry.source.sourceSha256) {
      throw new ManagedGenerationError(
        `managed generation source integrity mismatch for packageId=${entry.packageId}: manifest declares sourceSha256=${entry.source.sourceSha256}, resolved source ${resolved.sourceStorePath} hashes to ${actualSha256}`,
      );
    }
  }
}

/**
 * Fails closed when a resolved package's built version does not exactly
 * match the manifest's requested version (PR #634 review: nix/managed-generation.nix's
 * `resolveEntry` selects a recipe by (packageId, kind, flakeRef) alone —
 * without this check, a manifest requesting mottainai@0.7.2 could silently
 * build whatever version the currently pinned recipe happens to produce
 * (e.g. 0.7.1), pass source-integrity verification, and be reported as a
 * successful managed generation. nix/managed-generation.nix independently
 * enforces the same check at the Nix layer (`requireMatchingVersion`, which
 * fails the build itself before metadata is even produced); this is the
 * script-side confirmation that the metadata a build actually produced
 * still reflects what was requested, matching the same fail-closed
 * contract as verifySourceIntegrity above.
 */
export function assertResolvedVersionsMatch(
  manifest: ManagedPackageManifest,
  metadata: ManagedGenerationMetadata,
): void {
  for (const entry of manifest.packages) {
    const resolved = metadata.resolvedIdentity.packages.find((candidate) => candidate.packageId === entry.packageId);
    if (resolved === undefined) {
      throw new ManagedGenerationError(
        `managed generation metadata has no resolved identity entry for packageId=${entry.packageId}`,
      );
    }
    if (resolved.resolvedVersion !== entry.version) {
      throw new ManagedGenerationError(
        `managed generation version mismatch for packageId=${entry.packageId}: manifest requests version=${entry.version}, but the resolved build produced version=${resolved.resolvedVersion}`,
      );
    }
  }
}
