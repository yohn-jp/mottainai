# Managed generation projection (`mottainai.managed-generation.v1`)

This document is the field-level authority for Issue #625's deterministic
projection of the canonical managed package manifest
([`mottainai.managed-package-manifest.v1`](managed-package-manifest.md),
Issue #624) into a buildable, independently-versioned Nix managed
generation. The Nix projection lives in
[`nix/managed-generation.nix`](../nix/managed-generation.nix); the typed
metadata schema and generation-identity derivation live in
[`src/runtime-contract/managed-generation.ts`](../src/runtime-contract/managed-generation.ts);
the driving script is
[`scripts/build-managed-generation.mjs`](../scripts/build-managed-generation.mjs).

This Issue produces and verifies generations only. It does not implement
the bootstrap/package manager (#626) or init/reconcile/activation/rollback
(#628); those consume this projection's output without it pre-implementing
them.

## What this projection does

```text
managed-package-manifest.v1 (persisted desired state, #624)
        |
        v
nix/managed-generation.nix   -- resolves each entry to an existing
        |                        Nix derivation (pkgs.mottainai /
        |                        pkgs.nawabari), fails deterministically
        |                        for anything it has no recipe for
        v
managed generation build      -- pkgs.buildEnv of the resolved packages,
        |                        independent of runtime-appliance-image
        v
managed-generation-metadata.json (mottainai.managed-generation.v1)
        |
        v
generationIdentityOf(manifest, metadata)  -- deterministic sha256
```

Only the exact `(packageId, kind, flakeRef)` combinations this projection
recognizes are ever built:

| packageId   | kind                | flakeRef                    | Recipe                                              |
| ----------- | ------------------- | --------------------------- | --------------------------------------------------- |
| `mottainai` | `nix-flake-package` | `nix#mottainai`             | `nix/mottainai.nix` (existing repository packaging) |
| `nawabari`  | `nix-flake-package` | `nix/packages/nawabari.nix` | `nix/packages/nawabari.nix` (existing packaging)    |

A manifest entry outside this table — an unsupported `packageId` (e.g.
`zellij`, recognized by #624 but not yet projected here), an unsupported
`kind`, or an unrecognized `flakeRef` — is rejected deterministically
before any Nix build is attempted
(`src/runtime-contract/managed-generation.ts`'s `assertManifestProjectable`,
mirrored by `nix/managed-generation.nix`'s own `resolveEntry` as the
authoritative Nix-level gate). This is a closed table, not a general
package-resolution framework: extending it to a new packageId/flakeRef is a
deliberate, reviewed change to both files, never an emergent side effect of
a manifest declaring one.

## `sourceSha256` meaning and a known Mottainai fragility

`sourceSha256` is verified as "the exact source Nix resolved and built
this package from" (`verifySourceIntegrity`,
`src/runtime-contract/managed-generation.ts`), not a distribution-tarball
digest kept as a separate concept — unifying its meaning across fetch
mechanisms:

- **Nawabari**: the resolved source is `nix/packages/nawabari.nix`'s
  `fetchurl` result — the exact npm tarball for that version. Stable
  across builds; unaffected by anything outside that one package.
- **Mottainai**: `nix#mottainai` resolves via the existing
  `nix/mottainai.nix`, whose `source` argument is the _entire_ repository
  checkout tree (`nix/flake.nix`'s `mkMottainai pkgs = import ./mottainai.nix
{ inherit pkgs; source = ../.; }`). Its resolved `sourceSha256` therefore
  reflects the whole tracked repository at build time, not only the
  `mottainai` package's own meaningful content — a change to any tracked
  file anywhere in the repository changes this hash, even one wholly
  unrelated to the `mottainai` package itself. This is an existing
  property of `nix/mottainai.nix` (Issue #625 was constrained to prefer
  it over inventing a second Mottainai packaging path), not something this
  projection introduces or can narrow on its own. A manifest's
  `sourceSha256` for `mottainai` is therefore only meaningful pinned
  against one exact repository commit's tree, not "the mottainai package
  at version X" independent of the rest of the repository at that commit.

## Independence from the bootable appliance

`nix/managed-generation.nix` never imports or references
`nix/runtime-appliance-image.nix`, `applianceConfigurations`, or the NixOS
system closure `runtime-system` builds. The managed generation is a
`pkgs.buildEnv` of the resolved package derivations alone. Consequently,
changing only the managed package manifest (for example, bumping the
managed Mottainai version) never forces `runtime-appliance-image` to
rebuild — proven by inspection of the derivation graph (no shared
derivation) rather than by any coordination logic between the two files.

## Generation identity

`generationIdentityOf` (`src/runtime-contract/managed-generation.ts`) is a
SHA-256 of the manifest's own semantic identity
(`semanticIdentityOf` from #624 — desired state, independent of
`activation.generation` and JSON ordering) combined with the resolved Nix
output store paths the projection actually produced. This means:

- The same manifest, built against the same locked Nix inputs
  (`nix/flake.lock` unchanged), always produces the same generation
  identity — proven deterministically in
  [`src/runtime-contract/managed-generation.test.ts`](../src/runtime-contract/managed-generation.test.ts)
  without a Nix toolchain.
- A version change to any managed package changes the generation identity.
- A different resolved Nix store path (a rebuild that produces different
  output, for example after a `nixpkgs` bump) changes the generation
  identity even if the manifest itself is unchanged.
- `activation.generation` never affects generation identity, for the same
  reason it is excluded from #624's manifest semantic identity: it is
  reconciliation-ordering bookkeeping, not part of desired state.

## Metadata contract

`nix/managed-generation.nix`'s `metadataFile` derivation emits bounded JSON
matching `ManagedGenerationMetadataSchema`
(`src/runtime-contract/managed-generation.ts`):

```text
{
  contractId: "mottainai.managed-generation.v1",
  schemaVersion: 1,
  compatibilityContractVersion: 1,
  requestedIdentity.packages[]:  { packageId, version, sourceSha256 }
  resolvedIdentity.packages[]:   { packageId, resolvedVersion }
  nixOutput:
    storePath: <generation store path>
    packages[]: { packageId, storePath }
}
```

`requestedIdentity` echoes back what the manifest asked for;
`resolvedIdentity` and `nixOutput` report what Nix actually built. A caller
comparing the two can verify the build matches the desired state without
needing to re-derive it from the manifest directly.

## Building a generation

```sh
node --import tsx scripts/build-managed-generation.mjs \
  --manifest path/to/manifest.json \
  --system x86_64-linux
```

The script parses and validates the manifest against #624's schema, fails
closed via `assertManifestProjectable` before touching Nix for any entry it
cannot project, invokes `nix build` against
`nix/flake.nix`'s `lib.mkManagedGeneration` function output (the pinned
flake inputs — no ambient npm/PATH/network install path), validates the
resulting metadata against `ManagedGenerationMetadataSchema`, and prints
the metadata plus the derived `generationIdentity`.

## Constraints this projection deliberately honors

- Does not build a general package-resolution framework: only the closed
  `(packageId, kind, flakeRef)` table above is ever projected.
- Does not auto-convert arbitrary npm packages and claim reproducibility.
- Does not mutate user/workspace state; the build output is a Nix store
  path like any other Nix build.
- Does not implement activation, switch, or rollback — this is a build
  interface only (#628 owns reconciliation against a running Runtime).
- Does not require rebuilding `runtime-appliance-image` for a
  managed-package-only change.

## Test layer

`src/runtime-contract/managed-generation.test.ts` runs under the existing
`node --test` suite and requires no Nix toolchain. It proves: acceptance of
the supported `mottainai`/`nawabari` entries, deterministic rejection of an
unsupported `packageId` and of a supported `packageId` with an unrecognized
`flakeRef`, metadata schema acceptance/rejection (unknown contract id,
strict-schema field rejection), generation-identity determinism (stable
across repeated calls, independent of `nixOutput.packages` array order and
of `activation.generation`, changes when the managed Mottainai version
changes, changes when the resolved Nix output store path changes with the
manifest unchanged), source-integrity verification
(`verifySourceIntegrity` passes/fails closed against an injected narHash
lookup), and resolved-version matching (`assertResolvedVersionsMatch`
passes/fails closed for both Mottainai and Nawabari).

`nix/tests/managed-generation.nix` (run as
`nix build .#checks.<system>.managed-generation`, no KVM/nixosTest
infrastructure required) is the real-projection counterpart PR #634 review
asked for: it calls the actual `nix/managed-generation.nix` `resolveEntry`/
`requireMatchingVersion` logic against the real `pkgs.mottainai` /
`pkgs.nawabari` derivations (not fabricated stand-ins), proving at Nix
evaluation time — no build required, `builtins.tryEval` against
`.generation.outPath` — that: a manifest requesting each package's actual
current version resolves successfully; a manifest requesting a version
that does not match the currently pinned recipe (e.g. Mottainai `0.0.0`
against a `0.7.1` recipe) fails deterministically before any build,
proving the exact-identity acceptance criterion holds and closing the gap
PR #634 review found (`resolveEntry` previously selected a recipe by
`(packageId, kind, flakeRef)` alone and silently ignored `entry.version`);
an unsupported `packageId` and an unsupported `kind` both fail
deterministically. `nix/managed-generation.nix` requires this same version
match at the Nix layer itself (`requireMatchingVersion`), independent of
`src/runtime-contract/managed-generation.ts`'s `assertResolvedVersionsMatch`
script-side check — a manifest/build mismatch is caught even if a caller
skips the TypeScript verification layer.

`nix/managed-generation.nix` was additionally exercised end-to-end against
a real manifest with `nix build` during development, proving: both
supported entries resolve and build via the existing `mottainai.nix` /
`nawabari.nix` derivations; an unsupported `packageId` is rejected by Nix
before any build starts; and rebuilding after a manifest change that drops
an already-built package (`mottainai` removed, `nawabari` unchanged) reuses
the cached `nawabari` derivation rather than rebuilding it.
