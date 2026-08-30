import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * mottainai.managed-package-manifest.v1 — the canonical, persisted
 * desired-state contract for packages managed inside a Runtime generation
 * (Issue #624, child of #622's bootstrap-only Appliance contract). Distinct
 * from both mottainai.linux-runtime.v1 (contract.ts, the live
 * health/capability result an already-running Runtime reports) and
 * mottainai.linux-runtime-appliance.v1 (appliance-manifest.ts, the
 * build-time provenance record for the base disk artifact): this manifest
 * describes *desired* managed application/package state that #625's
 * projection consumes to build a Nix-managed generation, and that #626/#628
 * reconcile a Runtime against. It intentionally carries no Nix build output,
 * no Lima/Proxmox/QEMU-specific field, and no host-specific state — see
 * docs/managed-package-manifest.md.
 */
export const MANAGED_PACKAGE_MANIFEST_CONTRACT_ID = "mottainai.managed-package-manifest.v1" as const;
export const MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The only package kinds this contract currently knows how to express as
 * managed/reproducible. A kind absent from this list is unsupported, not
 * silently treated as unmanaged — parseManagedPackageManifest rejects it
 * (Issue #624 acceptance criterion: "unsupported package kinds produce a
 * deterministic unsupported result rather than silently degrading to
 * unmanaged"). Extending to a genuinely new ecosystem (arbitrary npm
 * packages, for example) is an explicit future contract change, not an
 * emergent side effect of adding an entry here.
 */
export const MANAGED_PACKAGE_KINDS = ["nix-flake-package"] as const;
export type ManagedPackageKind = (typeof MANAGED_PACKAGE_KINDS)[number];

/**
 * The closed set of logical package identities this contract can express.
 * Issue #624 requires exact managed identities for Mottainai and Nawabari
 * specifically, extensible to Zellij/coding-agent CLI packages without
 * claiming arbitrary npm packages are reproducible — so this is a bounded
 * enum, not a free-form string. Adding a new managed package is a deliberate
 * change to this list, never an unvalidated caller-supplied value.
 */
export const MANAGED_PACKAGE_IDS = ["mottainai", "nawabari", "zellij", "coding-agent-cli"] as const;
export type ManagedPackageId = (typeof MANAGED_PACKAGE_IDS)[number];

export const MAX_PACKAGE_ENTRIES = 64 as const;
export const MAX_IDENTITY_LENGTH = 256 as const;
export const MAX_VERSION_LENGTH = 128 as const;
export const MAX_COMPATIBILITY_ENTRIES = 16 as const;

/**
 * Accepts upper- or lower-case hex but always normalizes to lowercase, so
 * two manifests differing only in digest case parse to byte-identical
 * values and therefore always produce the same semantic identity (a
 * mixed-case sha256HexSchema previously let case differences leak through
 * into canonicalizeManagedPackageManifest, since canonicalization does not
 * re-normalize field values).
 */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/iu).transform((value) => value.toLowerCase());

/**
 * Exact source/integrity identity for a nix-flake-package entry. `flakeRef`
 * names the pinned input/output this entry projects from (mirrors
 * canonicalSource in appliance-manifest.ts); `sourceSha256` is the integrity
 * digest of the fetched source archive (mirrors nix/packages/nawabari.nix's
 * fetchurl hash), not a store path — store paths are build output, not
 * desired-state input, and must not appear in this manifest.
 */
const nixFlakePackageSourceSchema = z
  .object({
    flakeRef: z.string().min(1).max(MAX_IDENTITY_LENGTH),
    sourceSha256: sha256HexSchema,
  })
  .strict();

const compatibilityMetadataSchema = z
  .object({
    minimumRuntimeContractSchemaVersion: z.number().int().min(1).optional(),
    notes: z.string().max(512).optional(),
  })
  .strict();

export const ManagedPackageEntrySchema = z
  .object({
    packageId: z.enum(MANAGED_PACKAGE_IDS),
    kind: z.enum(MANAGED_PACKAGE_KINDS),
    version: z.string().min(1).max(MAX_VERSION_LENGTH),
    source: nixFlakePackageSourceSchema,
    compatibility: compatibilityMetadataSchema.optional(),
  })
  .strict();

export type ManagedPackageEntry = z.infer<typeof ManagedPackageEntrySchema>;

/**
 * Activation metadata needed for deterministic reconciliation: which
 * generation this desired state belongs to, and monotonic ordering against
 * prior generations. No host/provider/timestamp field lives here — semantic
 * identity (below) must stay independent of when or where the manifest was
 * written.
 */
const activationSchema = z
  .object({
    generation: z.number().int().min(1),
  })
  .strict();

export const ManagedPackageManifestSchema = z
  .object({
    contractId: z.literal(MANAGED_PACKAGE_MANIFEST_CONTRACT_ID),
    schemaVersion: z.literal(MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION),
    activation: activationSchema,
    packages: z
      .array(ManagedPackageEntrySchema)
      .max(MAX_PACKAGE_ENTRIES)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.packageId)).size === entries.length,
        "duplicate packageId in managed package manifest",
      ),
  })
  .strict();

export type ManagedPackageManifest = z.infer<typeof ManagedPackageManifestSchema>;

/**
 * Where the canonical manifest is persisted inside a Runtime, relative to
 * the existing `mottainai-control` state root (`stateDir` in
 * nix/modules/runtime.nix, `/var/lib/mottainai-control` by default,
 * reported at runtime as `stateOwners.system` in
 * src/runtime-contract/contract.ts). It lives under system/control-owned
 * persistent state, not repository-user or disposable state: it survives
 * reconciliation like the rest of that root, and repository principals
 * cannot read or mutate it (docs/linux-runtime-contract.md
 * "`mottainai-control` trusted identity and protected paths"). This constant
 * fixes the relative layout; the absolute path is
 * `${stateOwners.system control root}/${MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH}`.
 */
export const MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH = "managed-packages/manifest.json" as const;

export class ManagedPackageManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedPackageManifestError";
  }
}

/**
 * Fails closed: an unrecognized contractId, unsupported package kind,
 * unknown packageId, malformed integrity digest, or any field outside this
 * bounded shape (`.strict()` at every object level) is rejected rather than
 * coerced into a best-effort partial manifest.
 */
export function parseManagedPackageManifest(value: unknown): ManagedPackageManifest {
  const result = ManagedPackageManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ManagedPackageManifestError(
      `managed package manifest is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic canonical JSON: object keys sorted, arrays left in caller
 * order (packages are sorted explicitly below since their order is not
 * semantically meaningful), no whitespace. Mirrors
 * src/semantics/ir/canonical.ts's stableStringifyValue; duplicated rather
 * than imported because the semantics IR module is a distinct subsystem
 * this contract must not depend on.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new ManagedPackageManifestError("managed package manifest contains an unsupported value for canonicalization");
}

function canonicalizePackageEntries(packages: readonly ManagedPackageEntry[]): unknown[] {
  return [...packages]
    .sort((left, right) => compareText(left.packageId, right.packageId))
    .map((entry) => ({
      packageId: entry.packageId,
      kind: entry.kind,
      version: entry.version,
      source: { flakeRef: entry.source.flakeRef, sourceSha256: entry.source.sourceSha256 },
      ...(entry.compatibility === undefined ? {} : { compatibility: entry.compatibility }),
    }));
}

/**
 * Full, lossless canonical projection of every required contract field,
 * including `activation.generation`. This is the persisted-manifest
 * projection: writing this text to disk and reading it back through
 * `parseManagedPackageManifest` must reproduce the same manifest, generation
 * included. It must never be used as an identity source — two manifests that
 * differ only in `activation.generation` intentionally produce different
 * text here (see `canonicalizeManagedPackageManifestForIdentity` for the
 * identity projection, which excludes it).
 */
export function canonicalizePersistedManagedPackageManifest(manifest: ManagedPackageManifest): unknown {
  return {
    contractId: manifest.contractId,
    schemaVersion: manifest.schemaVersion,
    activation: { generation: manifest.activation.generation },
    packages: canonicalizePackageEntries(manifest.packages),
  };
}

/**
 * Canonical JSON text suitable for writing the persisted manifest to disk
 * (Issue #624's Runtime control-state location): deterministic key/array
 * ordering, but lossless — every required field, including
 * `activation.generation`, round-trips through `parseManagedPackageManifest`
 * unchanged. Do not use this for semantic identity; use
 * `semanticIdentityOf`/`canonicalManagedPackageManifestTextForIdentity`
 * instead, which intentionally excludes reconciliation bookkeeping.
 */
export function canonicalPersistedManagedPackageManifestText(manifest: ManagedPackageManifest): string {
  return stableStringify(canonicalizePersistedManagedPackageManifest(manifest));
}

/**
 * The semantic-identity projection: activation.generation is excluded
 * because it is bookkeeping for reconciliation ordering, not part of what
 * makes two desired states "the same" (Issue #624: "identical desired state
 * produces identical semantic identity independent of JSON key ordering or
 * incidental timestamps"). Packages are sorted by packageId so entry order
 * in the source JSON never affects identity. This projection is lossy by
 * design and must never be used to write the persisted manifest — use
 * `canonicalizePersistedManagedPackageManifest` for that.
 */
export function canonicalizeManagedPackageManifestForIdentity(manifest: ManagedPackageManifest): unknown {
  return {
    contractId: manifest.contractId,
    schemaVersion: manifest.schemaVersion,
    packages: canonicalizePackageEntries(manifest.packages),
  };
}

/** Canonical JSON text for a manifest's semantic identity only — lossy (excludes activation.generation), never suitable for persisting the manifest itself. */
export function canonicalManagedPackageManifestTextForIdentity(manifest: ManagedPackageManifest): string {
  return stableStringify(canonicalizeManagedPackageManifestForIdentity(manifest));
}

/**
 * Deterministic SHA-256 semantic identity: two manifests with identical
 * desired package state hash identically regardless of source JSON key
 * order, package array order, activation.generation, or sourceSha256 digest
 * case (normalized to lowercase at parse time).
 */
export function semanticIdentityOf(manifest: ManagedPackageManifest): string {
  return createHash("sha256").update(canonicalManagedPackageManifestTextForIdentity(manifest), "utf8").digest("hex");
}
