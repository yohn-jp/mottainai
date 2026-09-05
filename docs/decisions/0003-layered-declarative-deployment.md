# ADR-0003: Layered declarative deployment routes

- Status: Accepted
- Date: 2026-09-03
- Authority: Issue #749
- Preserves: ADR-0002, #600's Lima VM-lifecycle boundary, #622's bootstrap-only Appliance model, and #659's artifact-completion model
- Supersedes in part: #600, #654, and the previous #232 only where they require QEMU to be supplied manually outside the final host-bootstrap contract

## Context

Mottainai has several individually strong delivery and Runtime components:

- the public npm package and CLI/MCP entrypoints;
- the Nix package and managed Runtime generation;
- the canonical provider-independent NixOS Runtime Appliance;
- the Lima/QEMU local Runtime provider path;
- the guest-side `mottainai-bootstrap`; and
- the standalone `mottainai-init` host bootstrap.

The remaining problem is composition. These components can build or validate independently while the product-level deployment path still requires an operator to bridge their identities or prerequisites manually. Examples include independently repacking the Mottainai application in Nix, stopping Lima success at bootstrap-only guest health, manually supplying Runtime Appliance identities, manually injecting desired managed state, or requiring the host administrator to install QEMU before the strongest bootstrap path can begin.

The deployment model therefore needs to be cumulative. Each stronger entry route establishes the assumptions of the route below it and delegates to that route rather than reconstructing Mottainai independently.

This ADR also resolves a narrow ownership tension in #600/#654. Moving VM lifecycle to Lima was correct: Mottainai should not construct production QEMU command lines, own QMP, define QEMU device topology, or maintain a second VM manager. That does not imply that a fresh supported host must obtain QEMU manually. Provisioning a pinned, verified host-toolchain dependency and operating that dependency as a VM manager are different responsibilities.

## Decision

Mottainai defines four cumulative deployment entry routes.

```text
Route 4: standalone host bootstrap
  supported Linux x86_64 + usable KVM + network
      |
      +-- establish verified Lima + QEMU host toolchain
      v
Route 3: isolated local Runtime
  verified Lima + QEMU/KVM
      |
      +-- boot/reconcile canonical NixOS Runtime Appliance
      +-- converge intended managed Runtime generation
      v
Route 2: declarative Nix Runtime/application closure
  Nix Runtime/build contract
      |
      +-- provide Node/npm and all declared runtime dependencies
      +-- consume canonical Mottainai application payload
      v
Route 1: canonical npm application payload
  supported Node/npm + documented external prerequisites
      |
      +-- Mottainai CLI/MCP application payload
      v
functional Mottainai
```

The arrows are normative dependency direction. Route 4 consumes Route 3, Route 3 consumes Route 2, and Route 2 consumes Route 1. A higher route may add guarantees, isolation, reconciliation, or dependencies, but it must not introduce a second semantic implementation of a lower route.

### Relationship to the artifact-completion model (#659)

The word **route** in this ADR does not reverse #659's decision to track Runtime product artifacts independently. #659 correctly rejected treating Lima, direct QEMU, Proxmox, or other provider variants as separate product artifacts or duplicated end-to-end implementations.

The two models are orthogonal:

- **Artifact completeness** asks whether `mottainai-init`, the canonical Runtime Appliance, `mottainai-bootstrap`, and the managed Runtime generation each have a stable build, identity, distribution boundary, and local acceptance contract.
- **Deployment routes** ask how many environmental assumptions the caller supplies before those same artifacts are composed into a working Mottainai environment.

Route 3 is therefore not a new "Lima product artifact" competing with a direct-QEMU or future-Proxmox route. It is the initial supported isolated-local **entry boundary** that composes the existing artifacts through Lima. A future Proxmox provider may consume the same canonical Appliance and guest/bootstrap artifacts without becoming "Route 5" and without forking guest semantics.

Artifact completion remains tracked by artifact. Route acceptance proves composition and the environmental guarantees offered at each entry boundary.

## Route contracts

### Route 1 — npm application package

Route 1 is the canonical application-distribution payload.

**Preconditions**

- a supported Node.js/npm environment;
- external executables explicitly documented by the application contract, currently including `rg` where product behavior requires it; and
- a supported application host OS/profile.

**Output**

- one versioned Mottainai application payload exposing the supported CLI and MCP entrypoints.

**Readiness**

The packed/released artifact installs into a fresh consumer and representative CLI/MCP behavior succeeds. `--version` is identity evidence, not sufficient functional readiness.

The release pipeline must establish one canonical packed payload identity. Downstream routes consume or prove that exact payload rather than independently rebuilding a semantically different package from the same repository.

### Route 2 — Nix Runtime/application closure

Route 2 removes the assumption that the surrounding environment already has a correct Node/npm/application runtime.

**Precondition**

- a supported Nix evaluation/build environment or an already-built canonical Runtime closure derived from it.

**Consumes**

- the exact Route 1 application payload identity for the same release.

The implementation may consume the immutable npm tarball directly or a release-local artifact produced by the exact same canonical pack operation before registry publication. It must not introduce a public npm-registry publication-order dependency merely to prove that Route 1 and Route 2 use one application payload.

**Adds**

- pinned Node.js/npm execution support;
- native libraries and required command-line tools such as `rg`;
- the managed Runtime package catalog and generation contract; and
- deterministic Nix identities, activation, rollback, and health projection.

**Output**

- a complete managed Mottainai Runtime generation that executes Route 1 without borrowing undeclared application dependencies from the surrounding host.

The bootstrap-only base Appliance remains separate from the fast-moving managed generation. Route 2 does not require Mottainai/Nawabari/Zellij or other fast-moving application packages to be baked permanently into the base OS closure.

**Readiness**

The intended managed generation is active, its exact identity is observable, required companion tools are present, and representative Mottainai CLI/MCP behavior succeeds from the Route 2 closure.

### Route 3 — Lima/QEMU isolated Runtime

Route 3 removes the assumption that Mottainai may execute directly in the host environment. Lima is the initial local VM-lifecycle/provider boundary; the canonical provider-independent NixOS Runtime Appliance remains the guest boundary.

**Preconditions**

- a supported, verified Lima installation;
- a supported, verified QEMU runtime usable by Lima;
- usable KVM for the initial Linux `x86_64` production profile; and
- exact release/Runtime identities required to resolve the canonical Appliance and intended managed generation.

**Consumes**

- Route 2 as the application/runtime environment inside the canonical Appliance.

**Adds**

- VM isolation;
- explicit CPU/memory/storage/mount policy;
- lifecycle reconciliation through documented Lima interfaces;
- canonical Appliance identity verification;
- bounded first-boot/control transport; and
- guest bootstrap, managed-generation activation, restart/reconcile behavior, and bounded evidence.

Lima owns local VM lifecycle, QEMU invocation, QEMU device topology, SSH/provider transport implementation, and other provider internals. Mottainai supplies bounded product intent and validates the resulting Runtime. It does not revive the retired direct-QEMU/QMP implementation.

The guest remains provider-independent. Lima-specific configuration/lifecycle stays host-side and must not create a Lima-specific fork of the canonical NixOS Runtime or managed package semantics.

**Readiness**

`bootstrapReady` is an intermediate state only. Route 3 succeeds when the intended managed generation is active, canonical health reports managed Runtime readiness for that generation, and functional Mottainai validation succeeds. A merely booted bootstrap-only Appliance is insufficient.

### Route 4 — standalone host bootstrap

Route 4 is the strongest normal local deployment entry. It removes the assumption that Lima, QEMU, Nix, Node, npm, `rg`, or Mottainai are already installed on the host.

**Preconditions**

For the initial supported profile:

- Linux `x86_64`;
- kernel/hardware capability for the required virtualization;
- `/dev/kvm` usable by the invoking user; and
- network access to the bounded immutable release/artifact sources required by the selected release.

The standalone bootstrap itself must be independently executable without Node, npm, Python, Nix, Lima, QEMU, or a distro package manager.

**Consumes**

- Route 3 after establishing Route 3's host-toolchain preconditions.

**Adds**

- immutable release resolution;
- download/materialization and verification of the supported Lima runtime;
- download/materialization and verification of the complete supported QEMU runtime required by that Lima profile when absent;
- controlled binding of Lima to the exact verified QEMU/toolchain identity; and
- idempotent host-side reconciliation and bounded evidence.

Route 4 may distribute or materialize QEMU as part of a reviewed, pinned host-toolchain closure. That does **not** transfer QEMU VM-lifecycle ownership to Mottainai. Mottainai owns artifact selection, integrity, materialization, and the environment binding required to ensure the selected Lima runtime actually uses the verified toolchain. Lima still owns QEMU command construction and VM/device lifecycle.

Route 4 must not silently adopt arbitrary ambient `PATH` state as canonical managed toolchain state. If an externally managed compatible Lima/QEMU installation is supported later, adoption must be explicit, identity-verified, and independently accepted. It is not the canonical fresh-host golden path.

Route 4 does not promise to repair missing hardware virtualization, change BIOS/UEFI settings, silently grant KVM permissions, or emulate production support through TCG. Those conditions fail closed with bounded diagnostics.

**Readiness**

Route 4 succeeds only when Route 3 succeeds. Materializing Lima/QEMU alone is bootstrap progress, not completed Mottainai deployment.

## Composition invariants

1. **One application payload authority.** Route 1 defines the canonical Mottainai application payload for a release; Route 2 consumes or proves that payload.
2. **One Linux Runtime authority.** ADR-0002/#231 remains the canonical Linux guest/system/health contract; Route 3 does not redefine it through Lima provisioning.
3. **Artifact and route taxonomies stay distinct.** #659 remains valid: artifacts are completed independently; routes are cumulative entry/precondition boundaries over those artifacts.
4. **Managed generation stays separate from the base Appliance.** Fast-moving application packages use the managed-generation activation/rollback boundary.
5. **Higher routes compose lower routes.** A higher route may close more environmental assumptions but cannot bypass a lower route's release identity or readiness contract.
6. **Lima owns VM lifecycle.** No direct QMP authority, private QEMU topology manager, or second local VM lifecycle engine is reintroduced.
7. **Route 4 owns host-toolchain convergence.** Manual installation of Lima/QEMU is not part of the final canonical Route 4 contract.
8. **Hardware capability remains external reality.** Required KVM capability is validated and fails closed; Mottainai does not manufacture or silently emulate it.
9. **No ambient dependency leakage.** Each route may depend only on documented preconditions plus artifacts established by itself/lower routes.
10. **Immutable identity before use.** Downloaded executable, application, provider, Appliance, and release-descriptor artifacts are verified before execution/activation.
11. **Final readiness is functional.** Installation, boot, or `--version` checks alone cannot establish a support claim where the route promises a working environment.
12. **Explicit host exposure.** Route 3/4 preserve bounded workspace mounts and do not inherit broad host-home sharing for provider convenience.
13. **Idempotent reconciliation.** Re-running a converged route is a no-op except bounded observation/verification; interrupted managed mutations recover deterministically or fail closed.

## Release identity and zero-manual composition

A release must expose enough immutable metadata for every route to derive its lower-route inputs without operator archaeology. The target contract is one bounded release/deployment descriptor whose exact schema is implementation work and which binds at least:

- Mottainai release version/tag and exact source revision;
- canonical Route 1 packed payload identity/integrity;
- Route 2 Nix/managed-generation identities required by that release;
- canonical Runtime Appliance immutable OCI/raw identity;
- standalone `mottainai-init` artifact identity;
- supported Lima artifact/version identity; and
- supported Route 4 QEMU host-toolchain identity.

The descriptor is an immutable identity graph, not a second package manager. The independently complete artifacts from #659 remain independently verifiable and distributable.

Normal Route 3/4 use must not require the operator to discover an OCI digest manually, hand-author a Runtime specification solely to connect release artifacts, manually inject the initial managed-package manifest, or use a distro package manager to create the supported toolchain. Advanced explicit overrides may exist, but they are not the golden path.

Conceptually, the strongest path reduces to selecting a Mottainai release plus bounded Runtime resources; `mottainai-init` then derives, verifies, and reconciles the remaining identities. This ADR does not freeze the final CLI spelling.

## Preserved decisions

This ADR deliberately preserves:

- ADR-0002/#231: one canonical versioned Linux Runtime contract and NixOS system authority;
- #622: the bootstrap-only base Appliance plus separately managed application generation and rollback boundary;
- #659: independent artifact-completion tracking for host bootstrap, canonical Appliance, guest bootstrap, and managed Runtime generation;
- #600: Lima as the initial local VM/provider lifecycle boundary;
- provider-independent guest semantics and no Lima-specific Runtime fork;
- no Mottainai-owned direct QEMU command-line/device/QMP lifecycle;
- explicit bounded mounts and fail-closed security/capability behavior;
- initial production scope of Linux `x86_64` with usable KVM until other profiles have equivalent evidence; and
- real-host evidence before publishing a platform/provider support claim.

## Narrowly superseded decisions

The following statements are superseded for the final Route 4 contract:

- #600/#654/previous #232 wording that categorically excludes Mottainai from distributing or materializing QEMU;
- `docs/contracts/deployment/host-bootstrap` guidance that requires the administrator to install QEMU before the canonical strongest host-bootstrap flow; and
- the previous #261 starting condition that assumes QEMU is already installed.

The supersession changes **who establishes the QEMU artifact prerequisite**, not **who operates QEMU as a VM manager**. Lima retains that operational authority.

## Current implementation gaps

At ADR acceptance, the repository does not yet satisfy the target architecture end to end:

- `nix/mottainai.nix` independently rebuilds/packs Mottainai from source rather than consuming/proving the canonical Route 1 packed payload identity;
- Route 2 readiness does not yet prove a complete Route 1-equivalent functional contract for every required runtime dependency;
- `mottainai-init` verifies an already-present `qemu-system-x86_64`/`qemu-img` installation but does not materialize a complete QEMU runtime when absent;
- the Lima execution environment is not yet a complete managed host-toolchain closure bound to the exact verified QEMU identity;
- Route 3 still requires externally prepared Runtime/release inputs that the normal release path should derive automatically;
- initial managed-generation intent/activation and first-boot control access are not yet one fully automatic Route 3 convergence chain; and
- final local Runtime certification must require managed-generation functional readiness rather than treating bootstrap-only health as success.

These are implementation gaps against this ADR, not reasons to create independent competing deployment implementations.

## Alternatives considered

### Treat the four routes as four independent product implementations

Rejected. This would contradict both the composition goal and #659. It would permit duplicated application/runtime semantics and turn provider choice into product-artifact taxonomy again.

### Track only artifact completeness and omit route contracts

Rejected. #659 remains necessary but is insufficient to describe what a user may assume at each supported entry boundary or to prove that complete artifacts actually compose without manual environmental bridging.

### Keep QEMU permanently administrator-supplied

Rejected for Route 4. It leaves the strongest fallback path dependent on manual host package management and weakens declarative convergence exactly where the strongest guarantee is required.

An externally managed profile may be added separately if it has an explicit identity/adoption contract and matching evidence; it is not the canonical Route 4 golden path.

### Return to direct Mottainai-managed QEMU/QMP lifecycle

Rejected. The complexity removed by #600 remains unnecessary. Materializing a QEMU runtime does not justify rebuilding Lima's VM lifecycle/provider responsibilities in Mottainai.

### Bake all application packages into the immutable base Appliance

Rejected. It couples routine application updates to OS image rebuilds and discards the managed-generation lifecycle/rollback boundary established by #622.

### Make the guest Lima-specific

Rejected. Provider convenience must not redefine the canonical Runtime or block future providers from consuming the same guest/appliance artifacts.

## Consequences

- #659's artifact boundaries remain stable and reusable.
- Route 2 becomes the declarative execution closure around one Route 1 application payload rather than a parallel application build authority.
- Route 3 becomes complete only at managed application readiness, not merely successful VM boot.
- Route 4 becomes a true fresh-host bootstrap path and therefore needs a reviewed, reproducible/relocatable QEMU host-toolchain distribution strategy.
- `mottainai-init` remains the host reconciliation executable, but its managed toolchain boundary grows from Lima materialization plus QEMU observation to Lima+QEMU materialization and exact binding.
- Release engineering gains one immutable identity graph and can build independent artifacts from the same exact release lineage rather than infer correctness from publication ordering.
- #232 becomes the programme Epic for composition work; #261 becomes the final real Linux/KVM certification boundary.

## Migration

Implementation proceeds from the lower-route authorities while preserving independent artifact and route tests:

1. freeze and test the canonical Route 1 packed payload identity;
2. make Route 2 consume/prove that payload and close all declared runtime dependencies;
3. make Route 3 automatically reach managed Runtime readiness from exact release intent;
4. add Route 4 managed Lima+QEMU host-toolchain convergence and exact environment binding;
5. publish one immutable deployment descriptor connecting all required artifact identities; and
6. certify the complete Route 4 -> Route 3 -> Route 2 -> Route 1 chain with real Linux/KVM evidence.

During migration, current behavior may fail earlier than the target contract (for example, missing ambient QEMU). Documentation must describe current prerequisites truthfully until the owning implementation Issue lands; it must not present target architecture as already-supported behavior.

## Acceptance model

The programme is complete only when these entry claims are independently reproducible:

| Route | Starting assumption | Required final proof |
| --- | --- | --- |
| 1 | supported Node/npm + documented external prerequisites | canonical packed release installs; representative CLI/MCP behavior works |
| 2 | Nix only / canonical Nix build environment | exact Route 1 payload is present; all declared runtime dependencies are in closure; functional CLI/MCP behavior works |
| 3 | verified Lima + QEMU/KVM | canonical Appliance boots; intended managed generation activates; `managedRuntimeReady` is true; functional Mottainai works |
| 4 | supported Linux `x86_64` + usable KVM + network | pinned Lima/QEMU toolchain is established; Route 3, Route 2, and Route 1 converge without manual package installation or artifact/state wiring |

A support claim must name the exact route/profile proven by its evidence. Success of a stronger route exercises lower-route integration, while lower routes retain focused acceptance so defects remain attributable to the correct boundary.