# ADR-0003: Layered declarative deployment routes

- Status: Accepted
- Date: 2026-09-03
- Authority: Issue #749
- Preserves: ADR-0002, the canonical Linux Runtime contract, and the Lima VM-lifecycle boundary established by #600
- Supersedes in part: #600, #654, and #232 only where they require QEMU to be supplied manually outside the final host-bootstrap contract

## Context

Mottainai now has several individually strong delivery and Runtime components, but they evolved as separate boundaries:

- the public npm package and CLI/MCP entrypoints;
- the Nix package and managed Runtime generation;
- the canonical provider-independent NixOS Runtime Appliance;
- the Lima/QEMU local Runtime provider path; and
- the standalone `mottainai-init` host bootstrap.

The missing product contract is how these surfaces compose. Treating them as unrelated installation alternatives permits drift: a Nix build can construct a different application payload than the npm release, a Lima boot can stop at bootstrap-only health without a usable managed Mottainai generation, and the strongest host-bootstrap path can still require an operator to install QEMU or hand-wire release identities before Mottainai can start.

The deployment model therefore needs to be cumulative. Each stronger route must establish the assumptions of the route below it and then delegate to that route rather than independently reconstructing Mottainai.

This ADR also resolves a narrow ownership tension in #600/#654. Moving VM lifecycle to Lima was correct: Mottainai should not construct QEMU command lines, own QMP, define QEMU device topology, or maintain a second VM manager. That does not require a fresh supported host to obtain QEMU manually. Provisioning a pinned, verified host-toolchain dependency and operating that dependency are different responsibilities.

## Decision

Mottainai defines four cumulative deployment routes.

```text
Route 4: standalone host bootstrap
  supported Linux host + usable KVM + network
      |
      +-- establish verified Lima + QEMU host toolchain
      v
Route 3: isolated local Runtime
  verified Lima + QEMU/KVM
      |
      +-- boot/reconcile canonical NixOS Runtime Appliance
      v
Route 2: declarative Nix Runtime/application closure
  Nix Runtime contract
      |
      +-- materialize/activate managed Runtime generation
      +-- provide Node/npm and all required application/runtime dependencies
      v
Route 1: canonical npm application payload
  Node/npm + documented external prerequisites
      |
      +-- Mottainai CLI/MCP application payload
      v
functional Mottainai
```

The arrows are normative dependency direction. Route 4 consumes Route 3, Route 3 consumes Route 2, and Route 2 consumes Route 1. A higher route may add guarantees, isolation, reconciliation, or dependencies, but it must not introduce a second implementation of the lower route's Mottainai payload or semantics.

### Route 1 — npm application package

Route 1 is the canonical application-distribution payload.

**Preconditions**

- a supported Node.js/npm environment;
- any external executable prerequisite explicitly documented by the npm package, currently including `rg` where product behavior requires it; and
- an operating system supported by the npm application contract.

**Output**

- one versioned Mottainai application payload exposing the supported CLI and MCP entrypoints.

**Readiness**

Route 1 is ready only when the packed/released artifact can be installed into a fresh consumer and representative CLI/MCP behavior succeeds. `--version` alone is package-identity evidence, not functional readiness.

The release workflow must produce one canonical packed payload identity. Downstream routes consume that identity instead of rebuilding a semantically independent application from source.

### Route 2 — Nix Runtime/application closure

Route 2 removes the assumption that the host already has a correct Node/npm/application environment.

**Precondition**

- a supported Nix evaluation/build environment or an already-built canonical Runtime closure derived from it.

**Consumes**

- the exact Route 1 application payload identity for the same release.

The implementation may consume the immutable npm tarball directly or a release-local artifact produced by the exact same canonical pack operation before registry publication. It must not independently reinterpret the source tree into a different application payload unless the build proves that the resulting canonical packed payload identity is identical to Route 1. This avoids making npm registry publication an unnecessary build-order dependency while retaining one application artifact authority.

**Adds**

- pinned Node.js/npm execution support;
- native dependencies and required command-line tools such as `rg`;
- the managed Runtime package catalog and generation contract; and
- deterministic Nix identities, activation, rollback, and health projection.

**Output**

- a complete managed Mottainai Runtime generation that can execute the Route 1 application without borrowing undeclared application dependencies from the surrounding host.

The bootstrap-only base Appliance remains separate from the fast-moving managed generation as established by ADR-0002 and the existing managed-generation design. Route 2 does not require Mottainai application packages to be baked permanently into the base operating-system closure.

**Readiness**

Route 2 is ready when the managed generation is active, its exact identity is reported, required companion tools are present, and representative Mottainai CLI/MCP behavior succeeds inside the Runtime environment.

### Route 3 — Lima/QEMU isolated Runtime

Route 3 removes the assumption that the application may safely execute directly in the host environment. It uses Lima as the local VM-lifecycle/provider boundary and the canonical provider-independent NixOS Runtime Appliance as the guest boundary.

**Preconditions**

- a supported, verified Lima installation;
- a supported, verified QEMU installation usable by Lima;
- usable KVM for the initial Linux `x86_64` production profile; and
- the immutable identity of the canonical Runtime Appliance/release inputs.

**Consumes**

- Route 2 as the application/runtime environment inside the canonical Appliance.

**Adds**

- VM isolation;
- explicit CPU/memory/storage/mount policy;
- provider lifecycle reconciliation through documented Lima interfaces;
- canonical Appliance identity verification; and
- guest bootstrap, managed-generation activation, restart/reconcile behavior, and bounded evidence.

Lima owns local VM lifecycle, QEMU invocation, QEMU device topology, SSH/provider transport implementation, and other provider internals. Mottainai renders bounded product-level intent and validates the resulting Runtime. It does not revive the retired direct-QEMU/QMP implementation.

The guest remains provider-independent. Lima-specific lifecycle/configuration is host-side and must not create a Lima-specific fork of the canonical NixOS Runtime semantics.

**Readiness**

`bootstrapReady` is an intermediate state, not Route 3 success. Route 3 succeeds only when the intended managed generation is active, canonical health reports managed Runtime readiness, and functional Mottainai validation succeeds. A booted bootstrap-only Appliance is insufficient.

### Route 4 — standalone host bootstrap

Route 4 is the strongest normal local deployment path. It removes the assumption that Lima, QEMU, Nix, Node, npm, `rg`, or Mottainai are already installed on the host.

**Preconditions**

For the initial supported profile:

- Linux `x86_64`;
- a kernel/host capable of the required virtualization;
- `/dev/kvm` usable by the invoking user; and
- network access to the bounded release/artifact sources required by the selected release.

The standalone bootstrap itself must remain independently executable without Node, npm, Python, Nix, Lima, QEMU, or a distro package manager.

**Consumes**

- Route 3 after establishing Route 3's host-toolchain preconditions.

**Adds**

- immutable release resolution;
- download/materialization and verification of the supported Lima host toolchain;
- download/materialization and verification of the supported QEMU runtime required by that Lima profile when QEMU is absent;
- controlled binding of Lima to the verified QEMU identity; and
- idempotent host-side reconciliation and bounded evidence.

Route 4 may distribute or materialize QEMU as part of a reviewed, pinned host-toolchain closure. That does **not** transfer QEMU VM lifecycle ownership to Mottainai. Mottainai owns artifact selection, integrity, materialization, and the environment binding needed to ensure the selected Lima instance actually uses the verified toolchain. Lima still owns QEMU command construction and VM/device lifecycle.

Route 4 must not silently adopt arbitrary ambient `PATH` state as the canonical managed toolchain. When a compatible externally supplied installation is intentionally supported, adoption must be explicit, identity-verified, and covered by the same provider contract. The strongest default path is the managed toolchain.

Route 4 does not promise to repair missing hardware virtualization, change BIOS/UEFI settings, silently grant KVM permissions, or emulate production support through TCG. Those conditions fail closed with bounded diagnostics.

**Readiness**

Route 4 succeeds only when Route 3 succeeds. Merely materializing Lima/QEMU is host-bootstrap progress, not completed Mottainai deployment.

## Composition invariants

The following invariants apply across all routes.

1. **One application payload authority.** Route 1 defines the canonical Mottainai application payload for a release. Route 2 must consume/prove that payload rather than create an unrelated second package.
2. **One Linux Runtime authority.** ADR-0002/#231 remains the canonical Linux guest/system/health contract. Route 3 does not redefine it through Lima provisioning.
3. **Managed generation remains separate from the base Appliance.** The base system is bootstrap-capable and provider-independent; fast-moving application packages use the managed-generation activation/rollback boundary.
4. **Higher routes compose lower routes.** A higher route can close more environmental assumptions but cannot bypass a lower route's release identity or readiness contract.
5. **Lima owns VM lifecycle.** No direct QMP authority, private QEMU topology manager, or second local VM lifecycle engine is reintroduced.
6. **Route 4 owns host-toolchain convergence.** Manual installation of QEMU/Lima is not part of the final normal Route 4 contract.
7. **Hardware capability remains external reality.** Required KVM capability is validated and fails closed; Mottainai does not manufacture or silently emulate it.
8. **No ambient dependency leakage.** Each route may depend only on its documented preconditions plus artifacts established by the route itself/lower routes.
9. **Immutable identity before use.** Downloaded executable, application, provider, and Appliance artifacts are verified by immutable identity before execution or activation.
10. **Final readiness is functional.** Installation, boot, or `--version` checks alone cannot establish a support claim where the route promises a working Mottainai environment.
11. **Explicit host exposure.** Route 3/4 preserve bounded workspace mounts and do not inherit broad host-home sharing for provider convenience.
12. **Idempotent reconciliation.** Re-running a converged route must be a no-op except for bounded observation/verification; interrupted managed mutations must be recoverable or fail closed.

## Release identity and zero-manual composition

A release must expose enough immutable metadata for every route to derive the next lower route without operator archaeology. The target contract is one release/deployment descriptor (exact schema is implementation work) that binds at least:

- Mottainai release version/tag and exact source revision;
- canonical Route 1 packed payload identity/integrity;
- Route 2 Nix/managed-generation identities needed for that release;
- canonical Runtime Appliance immutable OCI/raw identity;
- standalone `mottainai-init` artifact identity;
- supported Lima artifact/version identity; and
- supported Route 4 QEMU host-toolchain identity.

The descriptor is an identity graph, not a second package manager. Individual route artifacts remain independently verifiable and testable.

Normal Route 3/4 use must not require the operator to discover an OCI digest manually, hand-author a Runtime specification solely to connect release artifacts, manually inject the initial managed-package manifest, or use a distro package manager to create the supported toolchain. Advanced explicit overrides may exist, but they are not the golden path.

Conceptually, the strongest path should be reducible to selecting a Mottainai release and desired bounded Runtime resources, after which `mottainai-init` derives and verifies the rest. This ADR does not freeze the final CLI spelling.

## Preserved decisions

This ADR deliberately preserves the following prior decisions:

- ADR-0002/#231: one canonical versioned Linux Runtime contract and NixOS system authority;
- the bootstrap-only base Appliance plus separately managed application generation and rollback boundary;
- #600's use of Lima as the initial local VM/provider lifecycle boundary;
- provider-independent guest semantics and no Lima-specific Runtime fork;
- no Mottainai-owned direct QEMU command-line/device/QMP lifecycle;
- explicit bounded mounts and fail-closed security/capability behavior;
- initial production scope of Linux `x86_64` with usable KVM until other profiles have equivalent evidence; and
- real-host evidence before publishing a platform/provider support claim.

## Superseded decisions

The following narrower statements are superseded for the final Route 4 contract:

- #600/#654/#232 wording that categorically excludes Mottainai from distributing or materializing QEMU;
- `docs/host-bootstrap.md` guidance that requires the administrator to install QEMU before the canonical host-bootstrap flow; and
- #261's current test starting condition that assumes QEMU is already installed.

The supersession is intentionally narrow. It changes **who establishes the QEMU artifact prerequisite**, not **who operates QEMU as a VM manager**. Lima retains that operational authority.

## Current implementation gaps

At the time this ADR is accepted, the repository does not yet satisfy the target architecture end to end. In particular:

- `nix/mottainai.nix` currently rebuilds/packs Mottainai from the source tree rather than consuming the canonical Route 1 packed payload identity;
- the Nix package/readiness checks do not yet constitute a full Route 1-equivalent functional contract for every required runtime dependency;
- `mottainai-init` currently verifies an already-present `qemu-system-x86_64`/`qemu-img` installation and records it, but does not materialize QEMU when absent;
- the Lima execution environment is not yet defined as a complete managed host-toolchain closure bound to the exact verified QEMU identity;
- Route 3 currently requires externally prepared Runtime/release specification inputs that the normal release path should derive automatically;
- initial managed-generation intent/activation and first-boot control access are not yet one fully automatic Route 3 convergence chain; and
- final local Runtime certification must require managed-generation functional readiness rather than treating bootstrap-only guest health as sufficient.

These are implementation gaps against this target ADR, not reasons to duplicate the architecture again.

## Alternatives considered

### Four independent installation alternatives

Rejected. It allows each path to package different application/runtime semantics and makes cross-route testing unable to prove composition.

### Keep QEMU permanently administrator-supplied

Rejected for Route 4. It leaves the strongest fallback path dependent on manual host package management and makes the deployment environment less declarative exactly where the user needs the strongest guarantee.

This remains a possible explicit externally-managed profile only if its identity/adoption contract is separately supported and tested; it is not the canonical Route 4 golden path.

### Return to direct Mottainai-managed QEMU/QMP lifecycle

Rejected. The complexity that #600 removed remains unnecessary. Materializing a QEMU toolchain does not justify rebuilding Lima's VM lifecycle/provider responsibilities in Mottainai.

### Bake all application packages into the immutable base Appliance

Rejected. It couples routine Mottainai/Nawabari/Zellij application updates to operating-system image rebuilds and discards the existing managed-generation activation/rollback boundary.

### Make the guest Lima-specific

Rejected. Local provider convenience must not redefine the canonical Runtime or block future providers from consuming the same NixOS appliance contract.

## Consequences

- Release engineering gains a single artifact-identity graph and can fan the four route checks out from one release payload rather than sequencing unrelated publication mechanisms.
- Route 2 becomes the declarative closure for Route 1 rather than a parallel implementation of it.
- Route 3 becomes complete only at managed application readiness, not merely successful VM boot.
- Route 4 becomes a true fresh-host bootstrap path and therefore needs a reviewed relocatable/pinned QEMU host-toolchain distribution/materialization strategy.
- `mottainai-init` remains a host reconciliation executable, but its managed toolchain boundary grows from Lima-only materialization plus QEMU observation to Lima+QEMU materialization and exact binding.
- #232 and #261 must be updated to use this ADR as the forward architecture and evidence boundary.
- Existing documentation describing the pre-ADR implementation may remain temporarily accurate as current-state documentation, but it must not be mistaken for the final support contract.

## Migration

Implementation should proceed from the bottom of the dependency graph while preserving independent tests for every route:

1. freeze and test the canonical Route 1 packed payload identity;
2. make Route 2 consume that payload and close all runtime dependencies;
3. make Route 3 automatically reach managed Runtime readiness from exact release inputs;
4. add the Route 4 managed Lima+QEMU host-toolchain convergence and exact environment binding;
5. publish one immutable release/deployment descriptor connecting the artifacts; and
6. certify each route independently and the complete Route 4 -> Route 3 -> Route 2 -> Route 1 chain, with real Linux/KVM evidence for the outer boundary.

During migration, current behavior may fail earlier than the target contract (for example, missing ambient QEMU). Do not hide that discrepancy. Implementation/user documentation should label current prerequisites truthfully until the corresponding route Issue lands.

## Acceptance model

The final programme is complete only when the following claims are independently reproducible:

| Route | Starting assumption | Required final proof |
| --- | --- | --- |
| 1 | supported Node/npm + documented external prerequisites | packed release installs; representative CLI and MCP behavior work |
| 2 | Nix only / canonical Nix build environment | exact Route 1 payload is present; all runtime dependencies are in closure; functional CLI/MCP behavior works |
| 3 | verified Lima + QEMU/KVM | canonical Appliance boots, intended managed generation activates, `managedRuntimeReady` is true, functional Mottainai works |
| 4 | supported Linux `x86_64` + usable KVM + network | pinned Lima/QEMU toolchain is established, then Route 3, Route 2, and Route 1 all converge without manual package installation/artifact wiring |

A support claim must name the exact route/profile proven by its evidence. Success of a stronger route also exercises lower-route integration, but lower routes keep their own focused acceptance so defects are attributable to the correct boundary.
