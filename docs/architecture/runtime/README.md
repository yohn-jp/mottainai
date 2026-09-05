# Runtime architecture authority

This document is the cross-cutting architecture authority for the Mottainai
Runtime introduced by #622. It fixes ownership and lifecycle boundaries that
must remain stable across #624–#630.

Component-specific documents remain authoritative for their own field shapes
and algorithms. In particular:

- [host-bootstrap.md](../../contracts/deployment/host-bootstrap.md) (Issue #654) owns the standalone
  host-side Linux/KVM provider bootstrap; it is distinct from the #626 guest
  bootstrap and from provider VM lifecycle.

- [`managed-package-manifest.md`](../../contracts/runtime/managed-package-manifest.md) owns the
  `mottainai.managed-package-manifest.v1` desired-state schema (#624).
- [`managed-generation.md`](../../contracts/runtime/managed-generation.md) owns deterministic
  manifest-to-Nix generation projection and generation identity (#625).
- `bootstrap.md` (added by #626) owns bootstrap CLI, source resolution, and
  bounded bootstrap evidence.
- [`linux-runtime-contract.md`](../../contracts/runtime/linux-runtime.md) owns the live
  Linux guest capability/health result, subject to the bootstrap-only
  architecture clarified here.
- [`deployment-descriptor.md`](../../contracts/deployment/descriptor.md) and
  `src/runtime-contract/deployment-descriptor.ts` own the immutable
  `mottainai.deployment.v1` release identity graph (#755). It connects the
  four routes without transferring provider VM lifecycle ownership.

When an older document describes a full application stack baked into the base
appliance, this document supersedes that assumption. The base appliance is a
bootstrap substrate, not a snapshot of the current managed application stack.

## Canonical layer model

```text
Deployment provider
  Lima / Proxmox / another supported provider
        |
        | instantiate exact appliance artifact
        v
Canonical Runtime Appliance
  NixOS / boot / guest integration
  network + OpenSSH/control prerequisites
  persistent Runtime control-state layout
  bootstrap/readiness prerequisites
  mottainai-bootstrap
        |
        | read desired state + resolve exact managed source
        v
Managed package manifest (#624)
        |
        | deterministic projection (#625)
        v
Managed Runtime generation
  mottainai <exact identity>
  nawabari <exact identity>
  other explicitly supported managed packages
        |
        | activation/reconcile transaction (#628)
        v
Active managed Runtime
  managed-runtime health/readiness
  active + previous known-good evidence
```

Distribution (#629) publishes the base appliance independently from managed
application generations. End-to-end evidence (#630) proves the complete path
without changing the base appliance during an application-only upgrade.

## Ownership table

| Layer | Owner | Owns | Does not own |
| --- | --- | --- | --- |
| Desired managed package state | #624 | canonical manifest, persistence, semantic identity, supported manifest vocabulary | source fetching, build, activation |
| Managed generation projection | #625 | already-resolved source + projectable manifest -> deterministic Nix generation, metadata, generation identity | source selection/fetch, activation |
| Bootstrap | #626 | manifest validation/error mapping, exact Mottainai source resolution, source verification, invoking #625, bounded build evidence, `build/status/verify` | application lifecycle, generation activation, rollback |
| Base appliance | #627 | NixOS/boot/guest/control/bootstrap closure and `bootstrap-ready` state | full Mottainai/Nawabari/Zellij/coding-agent application stack |
| Activation/reconciliation | #628 | desired/built/staged/active/previous state machine, atomic switch, managed-runtime health, rollback/recovery | base image mutation, source resolution policy, provider VM lifecycle |
| Distribution | #629 | content-addressed appliance publication, OCI artifact layout, digest verification | managed-generation identity, provider lifecycle |
| Golden-path evidence | #630 | proof of the complete bootstrap/update/reboot/rollback/state-boundary contract | weakening any upstream contract to make the test pass |
| Deployment provider | #600 and provider work | physical VM import/create/start/stop/inspect/transport | guest package semantics, managed-generation semantics |

## Base appliance contract

The canonical Runtime Appliance MUST remain useful before full Mottainai is
installed. Its base closure contains only stable substrate needed to boot,
access, verify, recover, and bootstrap the managed Runtime.

Required categories are:

- NixOS system, bootloader, and provider-independent guest integration;
- networking and OpenSSH/control-plane prerequisites;
- the `mottainai-control` identity and persistent control-state layout;
- Nix/runtime prerequisites required by the bootstrap path;
- bootstrap/readiness health primitives;
- the independently packageable bootstrap component from #626.

The following are managed-generation contents, not mandatory members of the
base appliance closure:

- full `mottainai`;
- `nawabari`;
- Zellij;
- coding-agent CLIs;
- other fast-moving packages managed through the supported Runtime package
  manifest/projection path.

A package may remain in the base only when it is a proven prerequisite for
boot, access, verification, recovery, or bootstrap. Convenience is not a
bootstrap prerequisite.

## Readiness phases

Two readiness states are intentionally separate:

1. **bootstrap-ready** — the guest has booted, required control-state and
   network/SSH prerequisites are available, bootstrap is executable, and the
   guest can build/verify a managed generation. Full Mottainai may be absent.
2. **managed-runtime-ready** — a desired managed generation has been
   activated and its managed application health contract has passed.

A fresh canonical appliance MUST be able to reach `bootstrap-ready` without
full Mottainai or Nawabari in the base application PATH/closure. Consumers must
not interpret bootstrap readiness as proof that managed applications are
healthy.

## Identity model

The Runtime deliberately has multiple non-interchangeable identities:

| Identity | Meaning |
| --- | --- |
| Appliance artifact digest | exact distributed base appliance bytes/artifact; GHCR digest is authoritative once #629 lands |
| Runtime/appliance contract version | compatibility generation of the base guest/bootstrap substrate |
| Managed manifest semantic identity | exact desired managed package state, excluding reconciliation ordering bookkeeping |
| Managed generation identity | desired-state semantic identity plus exact resolved Nix outputs produced by #625 |
| Runtime instance identity | stable deployed guest/instance identity reported by the live Runtime contract |
| Active/previous generation identity | transactional application-generation state owned by #628 |

No mutable tag, provider instance name, NixOS generation number, or ambient PATH
state substitutes for these identities.

## Rebuild boundaries

The base appliance and managed generation have intentionally different
lifecycles.

| Change | Rebuild base appliance? | Build/reconcile managed generation? |
| --- | --- | --- |
| Mottainai managed version/source | No | Yes |
| Nawabari managed version/source | No | Yes |
| supported managed package set | No, unless bootstrap capability changes | Yes |
| managed manifest ordering/bookkeeping only | No | Only if semantic desired state changes |
| NixOS/bootloader/guest integration | Yes | Not inherently |
| bootstrap executable/contract | Yes | Existing managed generations may require compatibility revalidation |
| control-state/guest contract incompatible change | Yes | Compatibility handling required |
| provider implementation/version only | No, unless provider compatibility requires a guest contract change | No |
| appliance distribution envelope/tag | No base rebuild when bytes are unchanged | No |

The key invariant is: **an application package/version change alone MUST NOT
require rebuilding the bootable base appliance**.

## Compatibility boundary

Compatibility is checked before activation, not guessed from observed binaries.

- Unknown/incompatible manifest or generation contract versions fail closed.
- #626 verifies that requested Mottainai source/version matches the exact
  resolved source before treating a generation build as trusted.
- #625 verifies requested identities against resolved Nix outputs.
- #628 MUST reject a generation whose compatibility contract is not supported
  by the deployed appliance/bootstrap contract before activation.
- A compatibility failure never falls back to unmanaged/global installation.

Contract evolution must preserve a recovery path to the previous known-good
managed generation whenever one exists.

## Provider boundary

The canonical appliance is provider-independent at the guest boundary.

```text
same canonical appliance
        |
   +----+----+
   |         |
 Lima      Proxmox
 local     server
```

A provider may own image import, VM lifecycle, host/VMM integration, networking
implementation, SSH transport details, and instance inspection. It MUST NOT
change the guest managed-package manifest, bootstrap source-resolution
semantics, managed-generation identity, activation transaction, or
managed/unmanaged persistence semantics.

Lima is the initial local provider direction under #600; it is not part of the
canonical appliance itself. A future Proxmox provider should consume the same
guest contract without inserting Lima into that path.

## Distribution boundary

The base appliance is distributed independently from the managed application
lifecycle.

Under #629:

- the Runtime Appliance is published as a [non-container OCI Artifact in GHCR](appliance-oci.md);
- the OCI digest is the canonical distribution identity;
- convenience tags are locators, not identity;
- the raw disk, manifest, and release metadata remain verified as one bounded
  artifact contract;
- GitHub Release notes/source releases do not need post-publication mutation to
  complete Runtime Appliance publication.

Managed generations are not identified by the appliance OCI digest and do not
force a new appliance artifact when only managed package state changes.

## Responsibility graph

```text
#624 desired manifest
  |
  v
#625 deterministic generation projection
  ^                         \
  | resolved source          \ base artifact
#626 bootstrap                #627 appliance slimming
  \                           /
   +------------+------------+
                v
       #628 activation/reconcile
                |
                v
       #630 end-to-end evidence

#629 appliance distribution depends on #627 artifact shape
and may proceed in parallel with #628 after that boundary is stable.
```

#627 and #628 MUST use this document as the cross-cutting authority rather
than reopening base-vs-managed ownership. #629 MUST use it for artifact identity
and lifecycle separation. #630 MUST test these invariants directly.

## Detailed authorities

- Live Linux guest contract: [`linux-runtime-contract.md`](../../contracts/runtime/linux-runtime.md)
- Desired managed package state: [`managed-package-manifest.md`](../../contracts/runtime/managed-package-manifest.md)
- Managed generation projection: [`managed-generation.md`](../../contracts/runtime/managed-generation.md)
- Runtime state and persistence: [`runtime-state.md`](../../contracts/runtime/state.md)
- Runtime lifecycle and failure transitions: [`runtime-lifecycle.md`](lifecycle.md)
- Provider architecture direction: Issue #600
- Bootstrap-only architecture epic: Issue #622

These documents should be updated when the contract changes. Issue descriptions
and implementation plans may explain why a change is being made, but must not
become the only durable record of a settled Runtime invariant.
