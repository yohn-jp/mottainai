# Deployment route implementation vehicles

This document supplements [ADR-0003](decisions/0003-layered-declarative-deployment.md) by fixing the implementation and execution vehicle used at each cumulative deployment entry boundary. It does not create new routes or change the dependency direction defined by ADR-0003.

## Canonical mapping

| Route | Canonical entry artifact / implementation | Execution substrate | Responsibility added by the route |
| --- | --- | --- | --- |
| Route 1 | published Mottainai npm package | supported Node.js/npm environment | canonical CLI/MCP application payload |
| Route 2 | Nix Runtime/application closure and managed generation | Nix / NixOS | declarative, pinned application runtime and companion dependencies |
| Route 3 | canonical NixOS Runtime Appliance operated through the Lima provider integration | Lima -> QEMU -> supported hardware accelerator (initially KVM) | isolated boot, lifecycle reconciliation, guest bootstrap, and managed-generation activation |
| Route 4 | compiled standalone `mottainai-init` native executable, implemented in Rust | supported host OS/kernel with the required hardware virtualization and network capability | fresh-host discovery, provisioning, verification, and convergence into Route 3 |

The mapping is intentionally asymmetric. The outermost route absorbs host variation; the inner routes become progressively more Nix-native and declarative. Portability is enforced at the host/provider boundary rather than by weakening the NixOS Runtime contract.

## Route 1 — npm is the application distribution vehicle

Route 1 is implemented and distributed as the canonical npm package. Node.js is an explicit precondition of this route rather than something Route 1 provisions for itself.

The npm payload is the single application identity consumed by stronger routes. Route 2 must consume or prove the exact Route 1 payload rather than independently creating a second Mottainai application build.

The release surface is `scripts/pack-canonical-payload.mjs`. It performs the
single `npm pack --ignore-scripts` operation after the explicit build stage and
writes the tarball together with a versioned identity sidecar containing the
package metadata, included-file surface, lockfile digest, SHA-256, and npm
integrity value. Package smoke tests and `npm publish` consume that same
tarball. The sidecar and tarball are verified before either consumer proceeds.

## Route 2 — Nix is the Runtime closure vehicle

Route 2 is expressed as the Nix Runtime/application closure and managed Runtime generation. Its purpose is to turn the Route 1 application payload plus all declared runtime dependencies into a deterministic Nix-managed execution environment.

`nix/mottainai.nix` consumes the release-local tarball through its
`canonicalPayload`/`canonicalPayloadSha256` boundary and verifies the raw
payload digest before adding pinned Node/native dependencies. A local Nix build
may produce the release-local payload once when no tarball is supplied; the
Route 2 derivation itself never repacks or rebuilds `dist`.

Route 2 is not merely a disk image. The canonical NixOS Runtime Appliance is the system boundary that can host the Route 2 closure, while the fast-moving managed generation remains independently activatable and rollback-capable as required by ADR-0003.

## Route 3 — Lima manages the canonical NixOS Appliance

Route 3 is not a Rust implementation and is not equivalent to "the QEMU route." Its deployment vehicle is the canonical provider-independent NixOS Runtime Appliance operated through the supported Lima provider integration.

The ownership boundary remains strict:

- Mottainai owns the desired Runtime intent, canonical Appliance identity, managed-generation identity, bounded host exposure, and readiness validation.
- Lima owns local VM lifecycle, QEMU invocation, QEMU device topology, and provider transport details.
- QEMU is an external virtualization dependency used by the selected Lima profile; Mottainai does not regain direct QEMU/QMP lifecycle ownership.
- NixOS remains the guest/runtime authority. Lima-specific implementation details must not fork the guest contract or managed package semantics.

This allows the outer layer to absorb host/provider differences while the guest is deliberately optimized around NixOS reproducibility and declarative state.

## Route 4 — Rust `mottainai-init` is the host bootstrap vehicle

Route 4 is entered through a compiled standalone `mottainai-init` executable implemented in Rust and published as a host-native release artifact. The user must not need a Rust toolchain to run it.

The bootstrap must be able to start before Node.js, npm, Python, Nix, Lima, QEMU, or a distribution package manager is available. Its job is to converge a supported fresh host into the Route 3 preconditions and then delegate to Route 3.

Conceptually:

```text
fresh supported host
        |
        v
mottainai-init
standalone Rust executable
        |
        | detect / diagnose / provision / verify
        v
Lima + required virtualization dependencies
        |
        v
Route 3: canonical NixOS Runtime Appliance
        |
        v
Route 2: Nix Runtime / managed generation
        |
        v
Route 1: canonical npm application payload
```

Rust is therefore a bootstrap implementation choice, not a second Runtime implementation. Once Route 4 has established Route 3, application/runtime semantics continue to come from Routes 3, 2, and 1.

## Provisioning is not ownership

Route 4 must distinguish three separate concepts:

1. **Requirement** — Mottainai defines the capabilities required to establish the supported Route 3 profile.
2. **Provisioning** — `mottainai-init` may discover that Lima or a required QEMU runtime is absent and may guide, acquire, materialize, or otherwise establish the supported dependency according to the reviewed host-toolchain strategy.
3. **Operational ownership** — after provisioning, Lima still owns QEMU command construction and VM/device lifecycle. Mottainai does not own QMP, QEMU topology, or a parallel VM manager.

Therefore, obtaining or verifying a QEMU artifact does not reverse the decision to abandon direct Mottainai-owned QEMU lifecycle management. Conversely, refusing QEMU lifecycle ownership does not justify stopping bootstrap at "QEMU is missing." Route 4 owns the convergence experience and must either establish the supported requirement or fail closed with actionable bounded diagnostics.

The exact acquisition mechanism for Lima/QEMU may evolve independently of this ownership boundary. ADR-0003's immutable identity and verification requirements still apply to executable artifacts before use.

## Design rule

The deployment architecture follows one directional rule:

> Absorb host diversity outside the Runtime boundary; exploit Nix determinism inside it.

Route 4 is optimized for independence from host tooling. Route 3 normalizes virtualization through Lima. Routes 2 and 1 then deliberately stop being host-generic: the Runtime is defined declaratively through Nix/NixOS and consumes one canonical npm application payload.

A change that makes the NixOS guest less deterministic merely to accommodate a host/provider difference is therefore suspect. Host/provider differences should first be contained in Route 4 provisioning or the Route 3 Lima integration.
