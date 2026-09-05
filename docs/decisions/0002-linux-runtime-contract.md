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
[`docs/contracts/runtime/linux-runtime`](../contracts/runtime/linux-runtime.md)) and adopts
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

The contract explicitly separates three state domains (detailed in
`docs/contracts/runtime/linux-runtime` "Persistent vs disposable filesystem
layout"), not two — persistence and ownership are independent axes:

- **System-owned disposable state** — the stable substrate, bootstrap
  executable, services, SSH configuration, and the rest of the immutable base
  system closure. Fully reproducible from the pinned NixOS generation and
  replaced wholesale only when the base appliance changes. Fast-moving
  Mottainai/Nawabari/Zellij/coding-agent packages are separate managed
  generations, not base-appliance contents.
- **System/control-owned persistent state** — the `mottainai-control`
  identity's state directory (desired manifest, bootstrap evidence,
  activation/recovery state, Nawabari session/claim registry, Mottainai brain
  state, and control SSH host keys). Survives reboot and managed-generation
  reconciliation, exactly like repository-user state does; it stays out of
  the disposable closure precisely because reconciliation must not delete it.
  It differs from repository-user state only in _who_ owns it:
  `mottainai-control`, not a repository principal.
- **Repository-user-owned persistent state** — repository checkouts, HOME,
  tool caches, and other user-mutated data. Never reverted by ordinary
  Runtime reconciliation.

`mottainai-control` is an explicit trusted identity. Its state/configuration
paths are not world- or repository-readable by default, so repository
principals cannot read or mutate Mottainai brain state (a prerequisite the
Nawabari sandbox boundary in yohn-jp/nawabari#80 depends on).

Base rollback/upgrade uses NixOS's native generation model. Managed package
updates and rollback use the separate #628 generation-selection boundary; a
bad managed generation is rolled back to the prior healthy generation without
rebuilding or mutating the base appliance. The Runtime contract's
health/capability result reports base build identity plus explicit bootstrap
versus managed readiness so callers cannot treat one phase as the other.

## Consequences

- `docs/contracts/runtime/linux-runtime` is the authority for Runtime contract
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
