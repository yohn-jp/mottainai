# Managed package manifest (`mottainai.managed-package-manifest.v1`)

This document is the field-level authority for the canonical, persisted
desired-state contract for packages managed inside a Runtime generation,
established by Issue #624 as a child of #622's bootstrap-only Runtime
Appliance contract. The typed, zod-validated TypeScript view lives in
[`src/runtime-contract/managed-package-manifest.ts`](../../../src/runtime-contract/managed-package-manifest.ts).

This Issue defines the manifest contract only. It does not implement the
manifest-to-Nix generation projection (#625), the bootstrap/package manager
(#626), or init/reconcile/activation/rollback (#628); those consume this
contract without it pre-implementing them.

## Relationship to the other two Runtime contracts

Three distinct, non-overlapping contracts exist under `src/runtime-contract/`:

| Contract                                | File                          | Describes                                                                                | Produced by                           | Consumed by                                   |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| `mottainai.linux-runtime.v1`            | `contract.ts`                 | Live health/capability result an already-running Runtime reports                         | A running Runtime                     | `mottainai init` reconciliation               |
| `mottainai.linux-runtime-appliance.v1`  | `appliance-manifest.ts`       | Build-time provenance record for the downloadable base disk artifact                     | CI appliance build (#601)             | Appliance distribution/verification           |
| `mottainai.managed-package-manifest.v1` | `managed-package-manifest.ts` | Desired-state record of which managed packages/versions a Runtime generation should have | An operator/Mottainai release process | #625 Nix projection, #626/#628 reconciliation |

The managed package manifest is desired state — what a generation _should_
contain — never the live result of inspecting an already-running Runtime,
and never the appliance's own build provenance. It carries no NixOS build
output, no Lima/Proxmox/QEMU-specific field, and no host-specific state, so
the same manifest is meaningful regardless of which provider deployed the
Runtime it will be reconciled against.

## Contract identity and versioning

- Contract id: `mottainai.managed-package-manifest.v1`.
- Schema version: `1`, following the same contract-id/schemaVersion split as
  `mottainai.linux-runtime.v1` and `nawabari.standalone-execution.v1`: the
  id names a compatibility generation, the schema version names the
  wire-shape revision within it.
- A manifest reporting an unrecognized `contractId`, an unrecognized
  `schemaVersion`, an unknown/ambiguous `packageId`, an unsupported `kind`,
  or any field outside the bounded `.strict()` shape is rejected — fail
  closed, never coerced into a best-effort partial manifest
  (`parseManagedPackageManifest` throws `ManagedPackageManifestError`).

## Minimum model

```text
Managed package manifest
├─ contractId / schemaVersion         -- contract identity
├─ activation
│  └─ generation                      -- monotonic ordering for reconciliation, excluded from semantic identity
└─ packages[]
   ├─ packageId                       -- closed set: mottainai | nawabari | zellij | coding-agent-cli
   ├─ kind                            -- closed set: nix-flake-package
   ├─ version                         -- exact version/revision
   ├─ source
   │  ├─ flakeRef                     -- pinned input/output this entry projects from
   │  └─ sourceSha256                 -- NAR-hash identity of the resolved build source (see below)
   └─ compatibility?                  -- optional: minimumRuntimeContractSchemaVersion, notes
```

## Supported package kinds

`MANAGED_PACKAGE_KINDS` currently contains exactly one entry:
`"nix-flake-package"` — a package built from a pinned Nix flake input or
derivation, the same shape `nix/packages/nawabari.nix` already uses
(`fetchurl` + a source integrity hash, not a mutable registry lookup at
reconciliation time).

A `kind` outside this list is unsupported and `parseManagedPackageManifest`
rejects it deterministically. This is a deliberate design choice, not an
oversight: Issue #624 explicitly requires that unsupported package kinds
"produce a deterministic unsupported result rather than silently degrading
to unmanaged," and that this contract not "design a general package
ecosystem." In particular, arbitrary npm packages are never treated as
managed/reproducible merely because they resolve — only entries this
contract explicitly recognizes are.

## Managed package identities

`MANAGED_PACKAGE_IDS` is a closed enum, not a free-form string:
`"mottainai"`, `"nawabari"`, `"zellij"`, `"coding-agent-cli"`. This
satisfies the Issue #624 requirement to express exact managed identities for
Mottainai and Nawabari specifically while remaining extensible to
Zellij/coding-agent CLI packages. Extending the set is a deliberate,
reviewed change to this list; a manifest entry can never introduce a new
managed identity simply by naming one.

Each entry's identity does not depend on ambient `PATH` state: `version` and
`source.sourceSha256` fully pin what the entry means, independent of
whatever happens to be installed or resolvable on a given machine.

The manifest identities above are application packages. Route 2 also owns a
separate explicit Nix runtime-dependency catalog for the lower-level
executables required by the supported Mottainai surface; the current entries
are versioned `git` and `ripgrep` (`rg`). They are joined into the realized
managed generation and are not resolved from ambient `PATH`. Optional
configured authority tools remain outside this built-in closure and must be
declared by the integration that uses them.

## Runtime compatibility requirements

`compatibility.minimumRuntimeContractSchemaVersion` is checked during
reconciliation against the Runtime contract schema reported by the appliance.
The canonical `mottainai-bootstrap reconcile` path has no appliance override;
in that case its default is the current `RUNTIME_CONTRACT_SCHEMA_VERSION`
from [`src/runtime-contract/contract.ts`](../../../src/runtime-contract/contract.ts),
currently schema `2`, matching [`nix/modules/runtime.nix`](../../../nix/modules/runtime.nix)
and this document's Runtime contract authority. Requirements at or below the
current schema, including schema `1`, are accepted. A requirement above it
fails closed with `compatibility_mismatch` before build or activation.

## `source.sourceSha256` meaning

`source.sourceSha256` is the SHA-256 NAR-hash identity of the exact source
object Nix resolves and builds this entry's recipe from — unified across
fetch mechanisms as "resolved build source integrity," not a distribution
archive digest kept as a separate concept. (Revised from an earlier
definition, "integrity digest of the fetched source archive," per PR #634
review: that definition mirrored `nix/packages/nawabari.nix`'s `fetchurl`
`hash` field directly, but is incompatible with `nix#mottainai`'s recipe
— `nix/mottainai.nix`, whose build source is a repository checkout tree,
not a fetched archive.)

Concretely, for the two recipes Issue #625's projection currently supports:

- **Nawabari** (`nix/packages/nawabari.nix`, a `fetchurl`-based recipe): the
  NAR hash of the fetched source tarball's resolved store path — not the
  `fetchurl`-native `hash` field on that derivation directly, which is
  typically a different digest algorithm/encoding (a sha512 SRI hash);
  computing this NAR hash requires `nix path-info` against the realized
  store path.
- **Mottainai** (`nix/mottainai.nix`, a repository-checkout-based recipe,
  `nix#mottainai`): the NAR hash of the checked-out source tree Nix
  resolves as that recipe's build input. Because that source is the
  _entire_ tracked repository checkout, not only the `mottainai` package's
  own meaningful content, this hash changes with any tracked-file change
  anywhere in the repository — see
  [`docs/contracts/runtime/managed-generation`](managed-generation.md) "`sourceSha256`
  meaning and a known Mottainai fragility" for the full detail. This is an
  existing property of `nix/mottainai.nix`'s packaging, not something this
  contract or Issue #625's projection introduces.

Still not a store path in either case: this is the source's own content
identity, computed before the recipe's own build phase runs, never build
output.

## Managed / persistent-unmanaged / ephemeral state boundaries

- **Managed**: declared in this manifest, reproducible through the
  supported Nix projection/generation path (#625). Only entries expressible
  by `MANAGED_PACKAGE_IDS` + `MANAGED_PACKAGE_KINDS` above ever qualify.
  Replaced/reconciled deterministically from the manifest; never inferred
  from what happens to already be installed.
- **Persistent-unmanaged**: may remain on persistent user/workspace storage
  (the repository-user-owned persistent state
  `docs/contracts/runtime/linux-runtime` already defines) but is outside managed
  package guarantees. A manually `npm install -g`'d tool, for example,
  survives reconciliation because reconciliation never touches
  repository-user state — but it is never promised to be reproducible,
  rolled back, or upgraded by this contract.
- **Ephemeral**: caches/tmp/experiment output that may be discarded at any
  time. Neither reconciliation nor this manifest makes any persistence
  promise about it.

This is the same three-way boundary
`docs/contracts/runtime/linux-runtime`'s "Persistent vs disposable filesystem
layout" defines for the base Runtime contract, applied to package state
specifically: managed and persistent-unmanaged are both persistent, but only
managed is reproducible/guaranteed; ephemeral is neither.

## Persistence location and ownership

The canonical manifest is persisted under the Runtime's existing
system/control-owned state root — `mottainai-control`'s `stateDir`
(`/var/lib/mottainai-control` by default, `nix/modules/runtime.nix`;
reported at runtime as `stateOwners.system` in
[`src/runtime-contract/contract.ts`](../../../src/runtime-contract/contract.ts)) —
at the relative path `MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH`
(`managed-packages/manifest.json`).

It is never persisted under repository-user or workspace state: the Issue
#624 constraint is explicit ("Persist the canonical manifest under the
Runtime control state rather than user workspace state"). Consequently it
inherits the same ownership/permission boundary
`docs/contracts/runtime/linux-runtime` already defines for that root — owned by
`mottainai-control`, mode excluding world and repository-user read/write
access — and the same survival property: it is persistent, control-owned
state and is not touched by ordinary disposable-closure replacement.

This document fixes the relative layout under that root; it does not define
a new Nix option or state directory, and does not require rebuilding
`nix/modules/runtime.nix` to exist as a contract.

## Canonical serialization and semantic identity

Two distinct canonical projections exist, and they are not interchangeable:

- **Persisted serialization** — `canonicalPersistedManagedPackageManifestText`
  / `canonicalizePersistedManagedPackageManifest`. Lossless: every required
  contract field, including `activation.generation`, is retained. This is
  the only serialization suitable for writing the canonical manifest to its
  persisted location (above); writing it and reading it back through
  `parseManagedPackageManifest` reproduces the same manifest.
- **Identity projection** — `semanticIdentityOf` /
  `canonicalManagedPackageManifestTextForIdentity` /
  `canonicalizeManagedPackageManifestForIdentity`. Deliberately lossy:
  `activation.generation` is excluded because it is reconciliation-ordering
  bookkeeping, not part of what makes two desired states "the same." Two
  manifests that declare identical package state at different generations
  report the same semantic identity. This projection must never be used to
  write the persisted manifest — doing so would silently drop
  `activation.generation`.

Both projections share the same deterministic canonicalization rules:

- Object keys are sorted (mirrors the canonicalization approach in
  `src/semantics/ir/canonical.ts`'s `stableStringifyValue`, reimplemented
  locally rather than imported since the semantics IR module is a distinct
  subsystem this contract must not depend on).
- `packages[]` is sorted by `packageId`, so source JSON entry order never
  affects either serialization.
- `source.sourceSha256` is normalized to lowercase hex at parse time
  (`parseManagedPackageManifest`), so two manifests whose SHA-256 digests
  differ only in case parse to byte-identical values and therefore always
  produce the same semantic identity.

`semanticIdentityOf` hashes the identity projection with SHA-256. This
satisfies the Issue #624 requirement that "identical desired state produces
identical semantic identity independent of JSON key ordering or incidental
timestamps" — proven deterministically by the fixtures in
[`src/runtime-contract/managed-package-manifest.test.ts`](../../../src/runtime-contract/managed-package-manifest.test.ts),
which require no Nix toolchain or live Runtime.

## Constraints this contract deliberately honors

- Does not infer managed desired state from currently installed binaries —
  every field is declared, never observed.
- Does not put user/workspace data inside the manifest or its identity.
- Does not include Lima/Proxmox/QEMU-specific fields.
- Does not model a general package ecosystem — only the identities needed by
  the initial supported subset (`MANAGED_PACKAGE_IDS`), plus the single
  explicit extension point (`MANAGED_PACKAGE_KINDS`).
- Adds no Nix build/switch implementation; `source.sourceSha256` is an
  integrity input to a future build, never a store path or build output.

## Test layer

`src/runtime-contract/managed-package-manifest.test.ts` runs under the
existing `node --test` suite and requires no Nix toolchain. It proves:
schema acceptance/rejection (unknown contract id/schema version, unsupported
kind, unknown packageId, malformed integrity digest, duplicate packageId,
missing required field, strict-schema field rejection), and deterministic
semantic identity (independent of key order, package array order, and
`activation.generation`; changes when desired package state changes; stable
across repeated calls).
