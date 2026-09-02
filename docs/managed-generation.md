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
| `mottainai` | `nix-flake-package` | `nix#mottainai`             | `mottainaiSource`'s own `nix/mottainai.nix` (release-owned; Issue #702) |
| `nawabari`  | `nix-flake-package` | `nix/packages/nawabari.nix` | `nix/packages/nawabari.nix` (existing packaging)    |
| `zellij`    | `nix-flake-package` | `nixpkgs#zellij-unwrapped`  | Delegated nixpkgs identity (`nix/flake.nix`'s `mkZellij`, no repository-owned recipe) |

A manifest entry outside this table — an unsupported `packageId` (e.g.
`coding-agent-cli`, recognized by #624 but not yet projected here), an
unsupported `kind`, or an unrecognized `flakeRef` — is rejected
deterministically before any Nix build is attempted
(`src/runtime-contract/managed-generation.ts`'s `assertManifestProjectable`,
mirrored by `nix/managed-generation.nix`'s own `resolveEntry` as the
authoritative Nix-level gate). This is a closed table, not a general
package-resolution framework: extending it to a new packageId/flakeRef is a
deliberate, reviewed change to both files, never an emergent side effect of
a manifest declaring one.

## The first supported managed Runtime package catalog (Issue #662)

The table above **is** the first explicit, documented supported managed
Runtime package catalog: `mottainai`, `nawabari`, `zellij`. Nothing becomes
supported merely by existing in nixpkgs/npm or being on `PATH` — a package
is in the catalog only once both this table and `nix/managed-generation.nix`
carry a deliberate entry for it, and `MANAGED_PACKAGE_IDS`
(`src/runtime-contract/managed-package-manifest.ts`) recognizes its
identity.

`coding-agent-cli` is deliberately excluded from this catalog at this
release stage. It remains a recognized `MANAGED_PACKAGE_IDS` identity (so a
future manifest can name it once a concrete coding-agent/runtime package and
Mottainai's first-class support commitment for it both exist), but no
`(packageId, kind, flakeRef)` entry projects it — a manifest naming it is
rejected the same as any other unsupported `packageId` (see
`nix/tests/managed-generation.nix`'s `unsupportedPackageId` assertion and
`src/runtime-contract/managed-generation.test.ts`'s equivalent). This is a
deliberate scope boundary, not an oversight: Issue #662's non-goals rule out
"adding tools with no explicit Mottainai support commitment merely for
completeness."

`zellij` is packaged as a **delegated nixpkgs identity** rather than a
repository-owned recipe (`nix/flake.nix`'s `mkZellij pkgs = pkgs.zellij-unwrapped`):
nixpkgs already packages Zellij with the exact version/source control this
catalog needs, so no recipe is reimplemented (Issue #662's constraint:
"prefer existing high-quality nixpkgs packages ... create repository-owned
recipes only where the product requires stronger version/source control or
the package is unavailable"). `zellij-unwrapped` is used rather than the
`zellij` nixpkgs attribute itself: the latter (`pkgs/by-name/ze/zellij/package.nix`)
is a `symlinkJoin` wrapper whose own `.src` is not the upstream Zellij
source tree, which would make this file's `sourceStorePath` projection
(every resolved entry's `"${r.drv.src}"`, in `metadataFile` below) reference
the wrong object for this package; `zellij-unwrapped` is the real
`fetchFromGitHub`-based derivation, and both provide the identical
`bin/zellij`. The catalog's pinned identity — version `0.44.3` against this
flake's locked nixpkgs input (`nix/flake.lock`) — matches the same Zellij
release this repository's own CI already installs independently for
`src/manager/zellij.ts`'s integration/e2e/package suites (`.github/workflows/ci.yml`)
and satisfies that module's `MINIMUM_ZELLIJ_VERSION` floor.

## Source resolution boundary

The Mottainai side of the recipe table above is not resolved by
`nix/managed-generation.nix` itself — its signature is
`{ pkgs, lib, mottainaiPackage, nawabariPackage, zellijPackage, manifest }:`.
`nix/flake.nix`'s `lib.mkManagedGeneration` requires `mottainaiPackage`
explicitly (an already-built derivation), with no default falling back to
this flake's own checkout.

This is a deliberate boundary, not an oversight: an earlier revision of
this file received a `mottainaiPackage` derivation already fixed to this
flake's own checkout (`nix/flake.nix`'s `mkMottainai pkgs`, `source = ../.`,
still used unchanged for `packages.<system>.mottainai` and the canonical
Runtime module). That made the projection incapable of building any
Mottainai version other than whatever this exact checkout happened to be —
impossible to satisfy from a fresh bootstrap appliance building a
manifest-requested release that isn't this checkout's own tagged version
(PR #634 review).

**Issue #625 owns projection only**: "manifest + already-resolved packages
-> deterministic Nix generation." **Issue #626 owns resolving which source
a manifest entry corresponds to and building it into a package** —
obtaining/fetching the exact source tree (a tagged release checkout, a
downloaded tarball, whatever a bootstrap appliance's package-manager UX
produces) and turning it into `mottainaiPackage` is explicitly out of scope
here; this projection only consumes the result.
`src/runtime-contract/managed-generation-build.ts` (driven by
`scripts/build-managed-generation.mjs`'s `--mottainai-source` flag) is the
caller that performs this resolution, described below.

`nawabariPackage`/`zellijPackage`, by contrast, were always received
pre-built this same way: `nix/packages/nawabari.nix` resolves its own
source internally via `fetchurl`, and `zellij` delegates to a pinned
nixpkgs identity — `mottainaiPackage` now follows the identical shape.

### Release-owned recipe resolution (Issue #702)

Between #634 and #702, this file itself took a `mottainaiSource` (an
already-resolved exact source tree) plus a `buildMottainai = source: import
./mottainai.nix { inherit pkgs source; }` function — HEAD's own
`nix/mottainai.nix` partially applied over `pkgs`, then called against
whatever `mottainaiSource` was supplied, including a historical tagged
release's source tree. That combined "HEAD's current recipe" with "a
foreign source" in a way neither side owns: a release already carries its
own `nix/flake.nix` pinned to its own release-era nixpkgs, Node.js/pnpm
versions, and matching `pnpmDeps.outputHash` for its own lockfile (e.g.
`v0.7.0`'s pre-#700 Node.js 22 recipe). Forcing HEAD to rebuild that
release meant HEAD's `nix/mottainai.nix` had to carry a `pnpm-lock.yaml
content hash -> outputHash` table spanning every lockfile any historical
release might ever need — permanent mutable knowledge in HEAD that every
future HEAD toolchain migration would have to extend.

The natural fix — resolve a source's own `nix#mottainai` output via
`builtins.getFlake` inside `nix/managed-generation.nix` — turned out to be
incompatible with `nix flake check` (used by
`.github/workflows/ci.yml`'s `Nix Runtime evaluation` job): `getFlake` on
an unlocked local path is an impure operation Nix refuses outside
`--impure`, and `nix flake check` evaluates `checks.<system>.*` — which
exercises `nix/managed-generation.nix` through
`checks.<system>.managed-generation` / `checks.<system>.appliance-boundary`
— without it. `builtins.tryEval` does not catch this class of failure; it
aborted the whole `nix flake check` invocation regardless.

Resolution therefore moved one layer up, to whichever caller already runs
impure: `src/runtime-contract/managed-generation-build.ts`'s
`buildManagedGenerationMetadata` already invokes `nix build --impure` (see
"`sourceSha256` meaning" below for why). Its Nix expression now resolves
`mottainaiSource`'s own `packages.<system>.mottainai` via
`builtins.getFlake (toString mottainaiSource + "?dir=nix")` — the same
flakeref shape it already uses to load HEAD's own flake — *before* calling
`flake.lib.mkManagedGeneration`, and passes the resolved derivation in as
`mottainaiPackage`. `nix/managed-generation.nix` and
`nix/flake.nix`'s `lib.mkManagedGeneration` never call `getFlake`
themselves, so both stay pure-evaluable. There is still only one
production resolution path: when `mottainaiSource` is this flake's own
checkout, it resolves to the exact same recipe `nix/flake.nix`'s own
`packages.<system>.mottainai` output builds; when it is a historical
tagged release, it resolves that release's own recipe, toolchain, nixpkgs
pin, and dependency hash — never HEAD's. `nix/mottainai.nix` therefore
only ever builds from its own tree and needs a single fixed-output hash
for its own current lockfile, not a historical-lockfile registry. A source
exposing no `nix/flake.nix`, or whose flake exposes no
`packages.<system>.mottainai` output, fails deterministically before any
build is attempted, at that same call site.

`nix/tests/managed-generation.nix` and `nix/tests/runtime-appliance.nix`
(both pure-evaluated by `nix flake check`) resolve `mottainaiPackage`
their own way: a plain `import (source + "/nix/mottainai.nix") { inherit
pkgs source; }` — still always that source's own recipe file, never HEAD's
`../mottainai.nix` applied to a foreign source, but without resolving that
source's own pinned nixpkgs the way `builtins.getFlake` does (plain
`import` reuses whatever `pkgs` the caller already has). That is a
narrower proof than the production path's, sufficient for these pure-eval
regression tests (`nix/tests/managed-generation.nix`'s
`headRecipeIsGenuinelyUsed`/`externalSourceNotReinterpretedByHeadRecipe`/
`sourceWithoutExpectedPackageOutput` assertions and their
`nix/tests/fixtures/alt-mottainai-source`/`alt-mottainai-source-no-flake`
fixtures) — the full `getFlake`-based, own-nixpkgs-pin resolution is
additionally proven end to end against real historical tagged releases
(`v0.7.0`/`v0.7.1`) by `nix/tests/runtime-appliance-golden-path.nix`, which
runs the real production driver inside its guest VM.

## `sourceSha256` meaning and a known Mottainai fragility

`sourceSha256` is verified as "the exact source Nix resolved and built
this package from" (`verifySourceIntegrity`,
`src/runtime-contract/managed-generation.ts`), not a distribution-tarball
digest kept as a separate concept — unifying its meaning across fetch
mechanisms:

- **Nawabari**: the resolved source is `nix/packages/nawabari.nix`'s
  `fetchurl` result — the exact npm tarball for that version. Stable
  across builds; unaffected by anything outside that one package.
- **Mottainai**: `nix#mottainai` resolves via `mottainaiSource`'s own
  `nix/mottainai.nix` (Issue #702's release-owned resolution above), whose
  `source` argument is the _entire_ resolved release's checkout tree — for
  HEAD, `nix/flake.nix`'s `mkMottainai pkgs = import ./mottainai.nix
{ inherit pkgs; source = ../.; }`. Its resolved `sourceSha256` therefore
  reflects that whole tracked tree at build time, not only the `mottainai`
  package's own meaningful content — a change to any tracked file anywhere
  in that tree changes this hash, even one wholly unrelated to the
  `mottainai` package itself. This is an existing property of
  `nix/mottainai.nix` (Issue #625 was constrained to prefer it over
  inventing a second Mottainai packaging path), not something this
  projection introduces or can narrow on its own. A manifest's
  `sourceSha256` for `mottainai` is therefore only meaningful pinned
  against one exact resolved source tree, not "the mottainai package at
  version X" independent of the rest of that tree.

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
the supported `mottainai`/`nawabari`/`zellij` entries, deterministic
rejection of an unsupported `packageId` (`coding-agent-cli`, Issue #662's
recognized-but-unprojected identity) and of a supported `packageId` with an
unrecognized `flakeRef`, metadata schema acceptance/rejection (unknown
contract id, strict-schema field rejection), generation-identity
determinism (stable across repeated calls, independent of
`nixOutput.packages` array order and of `activation.generation`, changes
when the managed Mottainai version changes, changes when the resolved Nix
output store path changes with the manifest unchanged), source-integrity
verification (`verifySourceIntegrity` passes/fails closed against an
injected narHash lookup), and resolved-version matching
(`assertResolvedVersionsMatch` passes/fails closed for both Mottainai and
Nawabari).

`nix/tests/managed-generation.nix` (run as
`nix build .#checks.<system>.managed-generation`, no KVM/nixosTest
infrastructure required) is the real-projection counterpart PR #634 review
asked for: it calls the actual `nix/managed-generation.nix` `resolveEntry`/
`requireMatchingVersion` logic against the real `pkgs.mottainai` /
`pkgs.nawabari` / `pkgs.zellij-unwrapped` derivations (not fabricated
stand-ins), proving at Nix evaluation time — no build required,
`builtins.tryEval` against `.generation.outPath` — that: a manifest
requesting each package's actual current version resolves successfully; a
manifest requesting a version that does not match the currently pinned
recipe (e.g. Mottainai `0.0.0` against a `0.7.1` recipe) fails
deterministically before any build, proving the exact-identity acceptance
criterion holds and closing the gap PR #634 review found (`resolveEntry`
previously selected a recipe by `(packageId, kind, flakeRef)` alone and
silently ignored `entry.version`); an unsupported `packageId`
(`coding-agent-cli`, Issue #662) and an unsupported `kind` both fail
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

Four more assertions prove Issue #702's release-owned resolution
specifically: HEAD's own source resolves to the exact `drvPath`
`nix/mottainai.nix` itself would produce for that source
(`headRecipeIsGenuinelyUsed`); the alternate fixture's resolved `drvPath`
is provably _not_ what HEAD's `nix/mottainai.nix` would produce if called
directly against that foreign source — the pre-#702 bug pattern
(`externalSourceNotReinterpretedByHeadRecipe`); a `mottainaiSource` with no
`nix/mottainai.nix` at all
([`nix/tests/fixtures/alt-mottainai-source-no-flake`](../nix/tests/fixtures/alt-mottainai-source-no-flake))
fails deterministically instead of falling back to HEAD's recipe; and
`nix/mottainai.nix`'s own source text contains no historical-lockfile hash
registry or placeholder fixed-output hash.

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

### Full-catalog CI proof (Issue #662)

The above was a manual, development-time exercise for the original
mottainai/nawabari pair. Issue #662's CI (`runtime-contract` job,
`.github/workflows/ci.yml`) now automates the equivalent proof for the
**complete three-package catalog** on every Nix-affecting PR:

1. `nix build .#mottainai .#nawabari .#zellij` builds all three catalog
   packages directly, which also runs each one's own bounded smoke check
   (`nix/mottainai.nix` / `nix/packages/nawabari.nix`'s `installCheckPhase`,
   `nix/flake.nix`'s `checks.zellij`) — proving "package smoke
   verification" against real, realized store paths, not fixtures.
2. `nix build .#checks.x86_64-linux.managed-generation` builds
   `nix/tests/managed-generation.nix` (see above), proving exact-version
   success and deterministic rejection (unsupported `packageId`, unsupported
   `kind`, version mismatch) for the full catalog at Nix evaluation speed.
3. A dedicated step resolves each catalog package's real NAR hash (`nix
   path-info` against the already-realized `.src` from step 1, converted via
   `builtins.convertHash`, the same computation
   `src/runtime-contract/managed-generation-build.ts`'s `narHashOfFactory`
   performs) and constructs a manifest declaring exactly those hashes and
   each package's actual resolved version. Running
   `scripts/build-managed-generation.mjs` against that manifest is the real
   **full-catalog build**: `assertManifestProjectable`, the Nix build, exact
   resolved identity/store paths, `verifySourceIntegrity`, and
   `assertResolvedVersionsMatch` all pass end to end for all three packages
   in one generation — printed as the same `mottainai.managed-generation.v1`
   metadata a caller would receive in production. The same step then
   corrupts one package's declared `sourceSha256` by a single character and
   re-runs the script, asserting it now fails — a live, source-mismatch
   rejection proof against the real build, not a mocked unit test.
