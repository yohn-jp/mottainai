# ADR-0002: Versioned Linux Runtime contract, one canonical NixOS system

- Status: Accepted
- Date: 2026-08-15

## Context

Epic #230 needs `mottainai init`, remote bootstrap, repository-principal
isolation, and Runtime migration to operate against a target that is
provably a healthy Mottainai Runtime. Today a local VM and a remote Linux
server can both claim to be Runtimes while having been provisioned through
different, drifting scripts: different users, packages, service versions,
state paths, SSH behavior, or security configuration. Without one explicit
definition of "healthy Mottainai Runtime" and which state Mottainai owns,
`init` cannot determine whether a target is current, repairable, stale, or
compatible, and fresh-image vs in-place-update behavior diverges silently.

This ADR is the first implementation slice of #230 (issue #231). It does not
choose a host VM launcher (#230 next child), SSH target discovery/tunneling
(separate child), or repository UID/GID allocation (separate child).

## Decision

Mottainai defines one versioned **Linux Runtime contract**
(`mottainai.linux-runtime.v1`, documented in
[`docs/linux-runtime-contract.md`](../linux-runtime-contract.md)) and adopts
one pinned NixOS configuration as the canonical specification for the
Mottainai-owned Linux system layer:

```text
pinned NixOS inputs (flake.nix)
        |
        v
nix/modules/runtime.nix  -- canonical system module
        |
        +--> fresh Runtime image/VM build
        +--> in-place reconciliation of an existing compatible Runtime
        |
        v
bounded health/capability result (mottainai.linux-runtime.v1)
        |
        v
mottainai init reconciliation decision (current / repairable / stale / incompatible)
```

The same canonical module produces both fresh builds and the description
used to reconcile an existing Runtime; imperative post-boot shell
provisioning is not a parallel path to the same result.

The contract explicitly separates two ownership domains:

- **System/control-owned state** — packages, services, SSH, the
  `mottainai-control` identity, and Mottainai/Nawabari/bubblewrap runtime
  services. Reproducible from the pinned NixOS generation; replaced on
  reconciliation.
- **Repository-user-owned mutable state** — repository checkouts, HOME,
  tool caches, and other user-mutated data. Never reverted by ordinary
  Runtime reconciliation.

`mottainai-control` is an explicit trusted identity. Its state/configuration
paths are not world- or repository-readable by default, so repository
principals cannot read or mutate Mottainai brain state (a prerequisite the
Nawabari sandbox boundary in yohn-jp/nawabari#80 depends on).

Rollback/upgrade uses NixOS's native generation model: a bad generation is
rolled back to the prior healthy generation rather than through a
Mottainai-specific mutation path. The Runtime contract's health/capability
result reports generation/build identity so `init` and rollback tooling can
reason about this without a bespoke state machine.

## Consequences

- `docs/linux-runtime-contract.md` is the authority for Runtime contract
  version, required system surface, and the state-ownership boundary; this
  ADR records why it exists and does not duplicate its field-level detail.
- `nix/flake.nix` and `nix/modules/runtime.nix` are the canonical
  specification. A second, divergent provisioning path for the same surface
  is a contract violation, not an acceptable alternative.
- `src/runtime-contract/contract.ts` gives TypeScript callers (later
  Manager/Dashboard integration, `init` reconciliation) a typed,
  zod-validated view of the bounded health/capability result without
  parsing raw Nix/NixOS output.
- NixOS evaluation/build and the NixOS VM tests in `nix/tests/runtime.nix`
  require a Nix toolchain this repository's default TypeScript CI does not
  provision; they are checked by a Nix-capable pipeline, not `pnpm verify`.
  The TypeScript-side rollback fixture in
  `src/runtime-contract/contract.test.ts` proves rollback-selection logic
  deterministically without requiring a live NixOS VM.
- Local VM provisioning, SSH/remote bootstrap, and repository-principal
  allocation (later #230 children) build on top of this contract instead of
  re-deriving their own definition of a healthy Runtime.

The decision explicitly rejects provisioning a Runtime through per-target
imperative scripts that each reimplement user/package/service setup, since
that is precisely the drift #231's failing scenario describes.
