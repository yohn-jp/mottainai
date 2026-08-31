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

## Source resolution boundary

The Mottainai side of the recipe table above is not a pre-built, fixed
derivation this file receives — `nix/managed-generation.nix`'s signature is
`{ pkgs, lib, buildMottainai, mottainaiSource, nawabariPackage, manifest }:`,
where `buildMottainai = source: import ./mottainai.nix { inherit pkgs source; }`
(`nix/mottainai.nix` partially applied over `pkgs`) is built from the
caller-supplied `mottainaiSource` argument at projection time. `nix/flake.nix`'s
`lib.mkManagedGeneration` requires `mottainaiSource` explicitly, with no
default falling back to this flake's own checkout.

This is a deliberate boundary, not an oversight: an earlier revision of
this file received a `mottainaiPackage` derivation already fixed to this
flake's own checkout (`nix/flake.nix`'s `mkMottainai pkgs`, `source = ../.`,
still used unchanged for `packages.<system>.mottainai` and the canonical
Runtime module). That made the projection incapable of building any
Mottainai version other than whatever this exact checkout happened to be —
impossible to satisfy from a fresh bootstrap appliance building a
manifest-requested release that isn't this checkout's own tagged version
(PR #634 review).

**Issue #625 owns projection only**: "manifest + an already-resolved exact
source -> deterministic Nix generation." **Issue #626 owns resolving which
source that is** — obtaining/fetching the exact source tree a manifest
entry's requested version corresponds to (a tagged release checkout, a
downloaded tarball, whatever a bootstrap appliance's package-manager UX
produces) is explicitly out of scope here; this projection only consumes
the result. `scripts/build-managed-generation.mjs`'s `--mottainai-source`
flag mirrors this: it is a required, already-resolved path, not something
the script fetches on the caller's behalf.

`nawabariPackage`, by contrast, is still received pre-built: it is
unaffected by this boundary because `nix/packages/nawabari.nix` already
resolves its own source internally via `fetchurl`.

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
  --system x86_64-linux \
  --mottainai-source path/to/resolved/mottainai/source
```

`--mottainai-source` is required and is not fetched by this script — it
must already be the exact resolved source tree the manifest's Mottainai
entry names (see "Source resolution boundary" above). The script parses
and validates the manifest against #624's schema, fails closed via
`assertManifestProjectable` before touching Nix for any entry it cannot
project, invokes `nix build` against `nix/flake.nix`'s
`lib.mkManagedGeneration` function output (the pinned flake inputs — no
ambient npm/PATH/network install path) with `mottainaiSource` converted to a
Nix path value via `/. + "<path>"` and inlined directly into a
self-contained `--expr` (not string-substituted as a raw string, which would
silently break Nix's content-addressing for that source, and not passed
through `--arg` to a function parameter — Issue #643: that indirection made
`builtins.getFlake` resolve unreliably when the subprocess's working
directory was itself inside the same repository the flake ref points at).
The subprocess also runs from a neutral working directory rather than
inside the repository, so the same manifest and resolved source always
produce the same build regardless of the caller's own current directory.
The result validates against `ManagedGenerationMetadataSchema`, and the
script prints the metadata plus the derived `generationIdentity`.

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

The same file also proves the "Source resolution boundary" section above
holds, not just that it's documented:
[`nix/tests/fixtures/alt-mottainai-source`](../nix/tests/fixtures/alt-mottainai-source)
is a separate tracked source tree with its own `package.json` declaring a
version (`0.0.1-fixture-alt-source`) this repository checkout's own
`package.json` does not have. Two assertions exercise it: a manifest
requesting exactly that fixture version resolves successfully only when
the fixture is supplied as `mottainaiSource` — a projection silently
falling back to this flake's own checkout (the bug this refactor fixes)
would resolve the checkout's version instead and fail this assertion; and
the same fixture supplied against a manifest requesting _this checkout's_
version still fails deterministically, proving the version-match check
isn't trivially satisfied once an external source is wired in. Both run at
Nix evaluation time, same as the rest of this file.

`nix/managed-generation.nix` was additionally exercised end-to-end against
a real manifest with `nix build` during development, proving: both
supported entries resolve and build via the existing `mottainai.nix` /
`nawabari.nix` derivations; an unsupported `packageId` is rejected by Nix
before any build starts; rebuilding after a manifest change that drops an
already-built package (`mottainai` removed, `nawabari` unchanged) reuses
the cached `nawabari` derivation rather than rebuilding it; and — the
decoupling proof for the actual build path, not just Nix evaluation — a
manifest requesting version `9.9.9` against an independent, on-disk copy of
this repository with `package.json`'s version bumped to `9.9.9` builds
`mottainai-9.9.9` end to end (`scripts/build-managed-generation.mjs
--mottainai-source <that independent tree>`), including a passing
`verifySourceIntegrity` check against that tree's real NAR hash.
