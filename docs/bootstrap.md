# Bootstrap component (`mottainai.bootstrap-state.v1`)

This document is the field-level authority for Issue #626's bootstrap
component: the minimal executable shipped in the base Runtime Appliance
that converges a fresh environment — with no full `mottainai` binary on
`PATH`, no Mottainai repository checkout, and no npm global install — toward
having a verified managed Mottainai generation. The TypeScript
implementation lives under [`src/bootstrap/`](../src/bootstrap/); the
standalone Nix packaging lives in
[`nix/bootstrap.nix`](../nix/bootstrap.nix).

This Issue implements bootstrap/build/status/verify only. It does not
implement activation, switch, or rollback (#628), and it does not implement
publication (#629). The #627 base-appliance integration consumes this
component while keeping activation and managed-runtime health in #628.

## Relationship to the other Runtime contracts

| Contract                                | File                                    | Describes                                                                   | Produced by                    | Consumed by                              |
| ---------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| `mottainai.managed-package-manifest.v1` | `src/runtime-contract/managed-package-manifest.ts` | Desired-state record of managed packages/versions (#624)             | An operator/release process    | #625 projection, #626 bootstrap, #628 reconciliation |
| `mottainai.managed-generation.v1`       | `src/runtime-contract/managed-generation.ts`       | Bounded result of one Nix generation build (#625)                    | `nix/managed-generation.nix`   | #626 bootstrap, #628 reconciliation      |
| `mottainai.bootstrap-state.v1`          | `src/bootstrap/state.ts`                | Bounded evidence of the bootstrap component's last attempt/success (#626) | `bootstrap build`/`status`/`verify` | Runtime bootstrap readiness and managed activation |

## What this component does

```text
managed-package-manifest.v1 (persisted desired state, #624)
        |
        v
src/bootstrap/source-resolution.ts   -- resolves+verifies the exact
        |                                Mottainai source tree for the
        |                                manifest's requested version
        v
src/runtime-contract/managed-generation-build.ts (#625's build interface,
        |                                          already-parsed manifest +
        |                                          already-resolved source)
        v
managed-generation-metadata.json + generationIdentity (#625)
        |
        v
src/bootstrap/state.ts -- bootstrap-state.v1 bounded evidence,
                           persisted atomically under mottainai-control
```

`src/bootstrap/build.ts`'s `runBootstrapBuild` owns this whole sequence: it
parses and validates the manifest (#624), classifies unsupported managed
packages before touching the network or Nix, resolves the manifest's exact
requested Mottainai source, invokes #625's build interface, and persists the
outcome — success or failure — as bounded state.

## Source resolution

`src/bootstrap/source-resolution.ts` resolves a manifest's `mottainai`
package entry to a local, verified source tree, filling the boundary #625
explicitly refused to own ("manifest + already-resolved exact source ->
deterministic Nix generation" only — see `docs/managed-generation.md`
"Source resolution boundary").

- **Origin**: `https://github.com/yohn-jp/mottainai/archive/refs/tags/v<version>.tar.gz`
  — GitHub's auto-generated tag source archive. Fetches are HTTPS-only and
  redirect-host-allowlisted (`github.com`, `codeload.github.com`), with a
  capped redirect count and an absolute download-size ceiling.
- **Extraction**: tar entries are enumerated and type-checked before
  extraction (rejecting symlinks/special files and unsafe/absolute/traversal
  paths), then extracted with `--strip-components=1` to drop GitHub's
  `<repo>-<tag>/` wrapper directory — the same idiom
  `nix/mottainai.nix`'s own `installPhase` already uses.
- **Integrity — tree content hash, not archive bytes**: `sourceSha256` is
  verified against the NAR hash of the *extracted tree*
  (`nix hash path --sri --type sha256`, converted to lowercase hex the same
  way `scripts/build-managed-generation.mjs`'s `narHashOf` already does),
  not a hash of the downloaded `.tar.gz` file itself. GitHub does not
  guarantee byte-stability of its auto-generated tag archives across gzip
  implementation changes — only the resulting tree content is stable — and
  this also matches how #624/#625 define `sourceSha256`: the identity of
  the source Nix itself would resolve and build from, not a distribution
  archive digest.
- **Version cross-check**: the extracted tree's `package.json` version is
  compared against the manifest's requested version before source
  integrity is even checked, failing closed on mismatch.
- **No fallback**: any fetch, extraction, or verification failure throws;
  there is no fallback to a local checkout, `PATH` lookup, or npm global
  install.

## Error taxonomy

Every failure `src/bootstrap/build.ts` can produce is re-thrown as one of
nine stable `BootstrapError` codes (`src/bootstrap/errors.ts`) before it
reaches a caller — internal error classes from #624/#625/this module's own
state validation are wrapped at the point they surface, never leaked
directly:

| Code                                    | Meaning                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `invalid_manifest`                      | The manifest fails #624's schema (unknown contract id/schema version, malformed field, etc.) |
| `unsupported_managed_package`           | A manifest entry has no #625 recipe for its `(packageId, kind, flakeRef)`  |
| `source_resolution_failure`             | Fetching or extracting the requested Mottainai source tree failed          |
| `source_integrity_mismatch`             | The resolved/built source's NAR hash does not match the manifest's declared `sourceSha256` |
| `requested_resolved_version_mismatch`   | The resolved/built version does not exactly match the manifest's requested version |
| `unavailable_nix_prerequisite`          | The `nix` binary is missing or unusable                                    |
| `nix_generation_build_failure`          | `nix build` itself failed                                                  |
| `malformed_generation_metadata`         | #625's build output metadata fails its own schema                          |
| `bootstrap_state_corruption`            | Persisted bootstrap state fails to parse                                   |

There is no best-effort fallback to an unmanaged install for any of these.

## State schema and persistence

`BootstrapStateSchema` (`src/bootstrap/state.ts`) deliberately separates two
fields rather than merging them into one record:

- **`lastAttempt`** — the outcome of the most recent `build` invocation,
  regardless of how far it got. A first-ever invalid-manifest failure
  produces a valid `lastAttempt` with `outcome: "failure"` and no
  `desiredManifestSemanticIdentity` (parsing never succeeded far enough to
  compute one). Always persisted, on every attempt.
- **`lastSuccessfulBuild`** — only ever advances on an actual successful
  build: manifest semantic identity (#624's `semanticIdentityOf`), resolved
  Mottainai source identity/version, and the resulting managed-generation
  identity/store path (#625's `generationIdentityOf` and
  `nixOutput.storePath`). A later failed attempt updates `lastAttempt` alone
  and leaves this field completely untouched — a failure never erases
  previously recorded known-good build evidence.

**Persistence location**: the single fixed path
`CANONICAL_BOOTSTRAP_STATE_FILE_PATH` (`src/bootstrap/paths.ts`) =
`/var/lib/mottainai-control/bootstrap/state.json` — sibling to #624's
`managed-packages/manifest.json` under the same Runtime control-state root
(`mottainai-control`'s `stateDir`, `nix/modules/runtime.nix`), never a new
state root and never user/workspace state. There is no `--state-file` CLI
flag and no environment-variable override in production: a single
invocation must never be able to redirect governed bootstrap state into an
arbitrary workspace path. Tests override the state path exclusively through
`BootstrapDependencies.stateFilePath` dependency injection at the module
level. A deployment-specific `stateDir` remap, if ever needed, is a Nix-level
concern (e.g. bind-mounting a different path at
`/var/lib/mottainai-control`), not a bootstrap CLI argument.

Writes go through `replaceFileAtomically` (`src/atomic-file.ts`, reused
as-is): a same-directory temp file, fsync, atomic rename, parent-directory
fsync — the destination is byte-for-byte unchanged on any partial failure.

## CLI

`src/bootstrap/cli.ts` dispatches exactly three commands — `build`,
`status`, `verify` — deliberately narrow, with no `init` alias (reserved,
unused, for later end-to-end initialization/reconciliation work spanning
#626/#628) and no task/session/manager/package-catalog UX. It does not
import `src/cli.ts`, `src/index.ts`, or any manager/workflow/task-session
module: that independence is what lets bootstrap work without importing the
full Mottainai runtime as a hidden dependency.

```text
mottainai-bootstrap build <manifest-path> --system <system> [--repo-root <path>] [--json]
mottainai-bootstrap status [--json]
mottainai-bootstrap verify [--json]
```

`status`/`verify` output is bounded and machine-readable:

```jsonc
// status --json
{ "contractId": "mottainai.bootstrap-state.v1", "schemaVersion": 1, "present": false }
// or, once a build has been attempted:
{ "contractId": "...", "schemaVersion": 1, "present": true, "state": { /* BootstrapState */ } }

// verify --json
{ "contractId": "mottainai.bootstrap-state.v1", "schemaVersion": 1, "verified": false, "reason": "bootstrap has never been attempted" }
```

`verify` is lighter than a full rebuild: it re-checks that persisted state
parses and, if it names a generation store path, that the store path still
resolves via `nix path-info` — it never re-fetches source or re-runs `nix
build`.

Two production entrypoints share the same dispatcher
(`src/bootstrap/cli.ts`'s `runBootstrapCli`):
[`src/bootstrap/main.ts`](../src/bootstrap/main.ts) is the compiled
executable entry `nix/bootstrap.nix` wraps directly as
`bin/mottainai-bootstrap`; [`scripts/bootstrap.mjs`](../scripts/bootstrap.mjs)
runs the same file uncompiled via `node --import tsx` for local/CI use.

## Nix packaging

`nix/bootstrap.nix` packages `src/bootstrap/**` (plus the
`src/runtime-contract/**` modules it composes: `managed-package-manifest.ts`,
`managed-generation.ts`, `managed-generation-build.ts`; plus
`src/atomic-file.ts`, `src/boundary.ts`) as a standalone Nix derivation,
exposed as the flake output `packages.<system>.mottainai-bootstrap` and
proven via `checks.<system>.bootstrap`
(`nix/tests/bootstrap.nix`).

This is deliberately **not** modeled on `nix/mottainai.nix`'s `pnpm install
--frozen-lockfile` recipe, which installs every root `dependencies` entry
(`@modelcontextprotocol/sdk`, `@xterm/*`, `node-pty`, `tree-sitter*`,
`typescript`, `ws`) regardless of what bootstrap actually imports.
Bootstrap's entire runtime import graph uses only `zod` and Node built-ins,
so `nix/bootstrap.nix` is modeled on `nix/packages/nawabari.nix`'s
single-dependency `fetchurl` pinning pattern instead: `zod` and (as a
build-time-only type-declaration dependency, never present in the installed
output) `@types/node` are pinned directly by version + npm tarball
integrity hash, without `nix/bootstrap.nix` parsing `pnpm-lock.yaml` at
Nix-eval time — this repository's Nix files never do that. nixpkgs' own
`typescript` package compiles the TypeScript at build time and is likewise
absent from the installed closure.

Those two pins are a second, independently maintained authority against
`pnpm-lock.yaml`'s own resolved entries. `src/bootstrap/nix-dependency-pin.test.ts`
is the synchronization check: it reads `pnpm-lock.yaml`'s real `zod@` and
`@types/node@` resolution entries and asserts they match the literal values
hardcoded in `nix/bootstrap.nix`, failing loudly the moment they diverge.

### Embedded Nix projection — building with no repository checkout

`buildManagedGeneration` (`src/runtime-contract/managed-generation-build.ts`)
resolves `${repoRoot}/nix` via `builtins.getFlake` to reach #625's
`lib.mkManagedGeneration`. A deployed `mottainai-bootstrap build` therefore
needs a `nix/` directory with a resolvable `flake.nix` — but the whole point
of this component is running with no Mottainai repository checkout on the
deployed host. `nix/bootstrap.nix`'s `installPhase` resolves this by
packaging its own minimal copy of #625's Nix projection alongside the
compiled CLI: `nix/flake.nix`, `nix/flake.lock`, `nix/managed-generation.nix`,
`nix/mottainai.nix`, `nix/packages/nawabari.nix`, and `nix/bootstrap.nix`
itself, copied into `nix-projection/nix/` next to `bootstrap/main.js` inside
the installed package, and committed into a throwaway git working tree
there (`builtins.getFlake` requires a VCS working tree to resolve a flake).
`src/bootstrap/cli.ts`'s `repoRootForNixInvocation` looks for this sibling
directory first, falling back to `process.cwd()` only for the
`scripts/bootstrap.mjs` dev/CI entrypoint (which runs directly against
uncompiled `src/`, where no such packaged sibling exists) — `--repo-root`
remains available to override either default explicitly.

This works because `lib.mkManagedGeneration`'s own dependency graph never
forces `mkMottainai`'s `source = ../.` binding (`nix/flake.nix`) — that
binding is only reachable through `packages.<system>.mottainai`, which this
projection never touches — so Nix's laziness means the embedded `nix/`
copy never needs a full repository checkout above it to evaluate or build
correctly. Verified during development against an isolated git-tracked
directory containing only this exact file list, with no repository root
above it: `flake.lib.mkManagedGeneration` evaluated and built a real
generation from it directly.

`checks.<system>.bootstrap` (`nix/tests/bootstrap.nix`) is a real
`runCommand` build (not pure evaluation) proving three things pure
evaluation cannot: the packaged `mottainai-bootstrap status` binary actually
runs, with no full `mottainai` package present in its build environment, and
reports a bounded `present: false`; the built package's real dependency
closure (obtained via Nix's `exportReferencesGraph` derivation attribute,
since a sandboxed build has no access to the host store database to query
it any other way) genuinely excludes the full `mottainai` derivation and the
unrelated dependencies named above — not merely that `nix/bootstrap.nix` was
written with that intent; and the packaged Nix projection's file layout
(`nix-projection/nix/{flake.nix,flake.lock,managed-generation.nix,
mottainai.nix,packages/nawabari.nix}` plus a `.git` working tree) is
actually present in the installed output. That check's own sandbox has no
Nix daemon access for a *nested* `nix build`, so the full standalone-build
proof — `mottainai-bootstrap build <manifest> --system <system>` succeeding
through to a real `nix build` invocation with no checkout anywhere on the
path — was verified manually against the built package during development
(a Nawabari-only manifest resolved source, invoked `nix build` against the
packaged projection, and reached the production control-state write step,
failing only on a sandboxed test environment's lack of write access to
`/var/lib/mottainai-control` — not on anything checkout-related).

The package is the application-facing component of the bootstrap-only base
Runtime Appliance. #627 wires it into `nix/modules/runtime.nix` while keeping
the full `mottainai`, `nawabari`, Zellij, and coding-agent packages out of the
base closure. Its presence establishes executable bootstrap capability; it
does not mean that a managed application generation has been activated.

## Constraints this component deliberately honors

- Does not implement activation, switch, or rollback (#628 owns reconciling
  a Runtime against a built generation).
- Does not fall back to `PATH`, npm global install, or any unmanaged
  package source on any failure.
- Does not mutate user/workspace state; all persisted evidence lives under
  the Runtime control-state root.
- Does not build a second package-resolution framework: source resolution
  is narrowly the "manifest -> exact Mottainai source tree" step, nothing
  broader.
- Does not import or execute full Mottainai runtime/task/session/manager
  code — `src/bootstrap/cli.ts` never imports `src/cli.ts` or `src/index.ts`.
- Does not expose a state-path override in the production CLI.
- `src/runtime-contract/managed-generation-build.ts` never re-parses or
  re-classifies a manifest — that stays `src/bootstrap/build.ts`'s job
  (and, for the CLI-script path, `scripts/build-managed-generation.mjs`'s).
- A managed Mottainai version/source change does not require rebuilding
  `runtime-appliance-image` or `nix/modules/runtime.nix`; a bootstrap
  executable/contract change does, because #627 embeds this package in the
  base closure.

## Test layer

`src/bootstrap/*.test.ts` and `src/runtime-contract/managed-generation-build.test.ts`
run under the existing `node --test` suite (via `node --import tsx`) and
require no Nix toolchain except where explicitly noted. They prove:

- a fresh environment with no `mottainai` on `PATH` can build a generation
  containing Mottainai and Nawabari, using injected `resolveSource`/
  `runManagedGenerationBuild` dependencies (`build.test.ts`)
- source resolution does not depend on this repository's own checkout,
  using a packed fixture tree with a version this checkout doesn't have
  (`source-resolution.test.ts`, `nix/tests/fixtures/alt-mottainai-source`)
- a requested/resolved version or source-integrity mismatch fails closed
  with the correct `BootstrapError` code (`source-resolution.test.ts`,
  `build.test.ts`)
- an invalid or unsupported manifest fails before `resolveSource`/
  `runManagedGenerationBuild` are ever called, asserted via call-count spies
  (`build.test.ts`)
- a Nix build failure and an unavailable Nix prerequisite produce distinct
  deterministic error codes (`build.test.ts`)
- `status`/`verify` output is a bounded, fixed-key JSON envelope, including
  the "never attempted" case (`cli.test.ts`)
- persisted evidence round-trips deterministically, including
  attempt-only and attempt-plus-success shapes (`state.test.ts`)
- corrupted persisted state fails closed rather than being silently treated
  as "never attempted" (`state.test.ts`, `cli.test.ts`)
- a first-ever invalid-manifest failure persists valid bounded state, and a
  later failed attempt preserves previously recorded successful-build
  evidence unchanged (`build.test.ts`)
- bootstrap performs no user/workspace mutation (`build.test.ts`)
- the production CLI exposes no state-path override surface (`cli.test.ts`)
- no code path in `source-resolution.ts`/`build.ts` invokes `npm`, `npx`, or
  a global install (`source-resolution.test.ts`, `build.test.ts`)
- `nix/bootstrap.nix`'s pinned `zod`/`@types/node` versions and integrity
  hashes match `pnpm-lock.yaml`'s real resolved entries
  (`nix-dependency-pin.test.ts`)

`nix/tests/bootstrap.nix` (run as `nix build .#checks.<system>.bootstrap`)
is the real-build counterpart: it proves the packaged binary runs standalone
and that its actual dependency closure excludes the full `mottainai`
derivation and the unrelated root dependencies, as described above.
