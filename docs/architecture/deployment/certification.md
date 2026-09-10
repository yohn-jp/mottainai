# Deployment and Runtime certification boundaries

This document is the certification-boundary authority for [Epic #890](https://github.com/yohn-jp/mottainai/issues/890). It refines, but does not replace, the cumulative deployment model in [ADR-0003](../../decisions/0003-layered-declarative-deployment.md), the programme scope in [#232](https://github.com/yohn-jp/mottainai/issues/232), or the final external evidence required by [#261](https://github.com/yohn-jp/mottainai/issues/261).

## Two different claims

The product's **Deployment Golden Path** remains cumulative:

```text
fresh supported Linux host
  -> Route 4: standalone mottainai-init
  -> Route 3: canonical Runtime Appliance through Lima/QEMU/KVM
  -> Route 2: managed Runtime generation
  -> Route 1: release-bound npm application payload
  -> managedRuntimeReady + functional CLI/MCP
```

This is the user-facing strongest deployment guarantee. Route 4 is mandatory
for the current supported fresh-host profile: it must establish or verify the
supported Lima and QEMU prerequisites without manual dependency installation or
artifact/state wiring, then converge on Route 3. A provider or host-bootstrap
failure cannot be reclassified as a Route 1-3 semantic failure, but a Route 1-3
proof cannot be presented as fresh-host deployment support.

The independently certifiable **Runtime correctness boundary** is narrower:

```text
Route 3: canonical provider-independent Runtime Appliance
  -> Route 2: exact managed Runtime generation
  -> Route 1: exact release-bound npm application payload
  -> managedRuntimeReady + functional CLI/MCP
```

Runtime correctness proves the guest/appliance, managed-generation, and
application-payload contract. It intentionally does not prove Route 4 host
bootstrap, Lima/QEMU VM lifecycle, host KVM availability, provider transport,
or fresh-host convergence. Those are separate provider and deployment claims.

## Route 3 is the provider-independent convergence boundary

Route 3 is the canonical NixOS Runtime Appliance plus its guest Runtime
contract, identity, desired-state, managed-generation, and readiness semantics.
It is the boundary consumed by Lima/QEMU today and by future providers such as
Proxmox if they are supported later. The provider may own VM creation,
transport, device topology, and lifecycle mechanics; it must consume the same
descriptor-bound Appliance and preserve the same guest semantics.

No provider may create a guest-specific Runtime fork, substitute a different
managed-generation authority, or turn `bootstrapReady` into
`managedRuntimeReady`. Provider success is evidence for the provider layer;
only the Runtime correctness layer can claim Route 3 -> Route 2 -> Route 1
semantic correctness.

## Seven-layer certification ladder

The layers are a proof hierarchy, not a requirement that every pull request run
every expensive layer. A higher layer may consume lower-layer evidence, but it
cannot silently replace a missing lower-layer proof.

| Layer | Proves | Does not prove |
| --- | --- | --- |
| 1. Static/code contract | Route ownership, schemas, invariants, identity transitions, fail-closed behavior, and deterministic regression coverage | That a built artifact has the expected bytes, that an Appliance boots, or that a host/provider works |
| 2. Artifact/descriptor identity | The exact descriptor, Appliance manifest/raw identity, Route 1 payload identity, and certified-to-published identity continuity selected for the run | Boot, guest reconciliation, managed-generation activation, or provider lifecycle |
| 3. Route 3 Appliance boot | The exact canonical Appliance materializes and boots to the supported guest/bootstrap boundary under the test harness | Route 2/Route 1 functional readiness, fresh-host bootstrap, or a real Lima/QEMU/KVM support claim |
| 4. Route 3 -> Route 2 -> Route 1 Runtime correctness | Descriptor-bound Appliance plus exact managed generation and exact Route 1 payload reach `managedRuntimeReady`; active-generation CLI/MCP, GC durability, no-op, rollback, and recovery semantics work | Route 4 host convergence, Lima/QEMU lifecycle/transport, KVM availability, or a published fresh-host support claim |
| 5. Provider certification | A named provider (currently Lima/QEMU) consumes the canonical Route 3 Appliance with the required identity, lifecycle, transport, and accelerator behavior | Route 1-3 semantic correctness; `bootstrapReady` or provider SSH success alone is not Runtime certification |
| 6. Route 4 fresh-host bootstrap | Standalone `mottainai-init` establishes/verifies the supported Lima/QEMU prerequisites on a fresh supported host and reaches the Route 3 entry boundary without manual bridging | The full managed-generation/application proof, published-release identity continuity, or support for another host/provider profile |
| 7. Published-release Route 4 -> Route 3 -> Route 2 -> Route 1 certification ([#261](https://github.com/yohn-jp/mottainai/issues/261)) | One selected immutable published release completes the entire current Linux x86_64/KVM chain from fresh host through functional CLI/MCP, with identity continuity and bounded evidence | Support for untested releases, operating systems, accelerators, providers, or a future provider's independent certification |

Layer 4 is the Runtime certificate. Layer 5 is the current Lima provider
certificate. Layer 6 preserves the Route 4 fresh-host guarantee. Layer 7 is the
only final claim for the complete published Deployment Golden Path on the
supported real-host profile.

## Terminology alignment

| Term | Meaning and authority |
| --- | --- |
| Deployment Golden Path | Cumulative `R4 -> R3 -> R2 -> R1` product path established by [#232](https://github.com/yohn-jp/mottainai/issues/232) and [ADR-0003](../../decisions/0003-layered-declarative-deployment.md). |
| Runtime correctness | Independent `R3 -> R2 -> R1` semantic certificate at layer 4; it is not a replacement for Route 4. |
| Route 3 convergence | Provider-independent canonical Appliance/guest boundary consumed by each provider. |
| Lima provider certification | Layer 5 evidence for the current Lima/QEMU/KVM provider; it does not claim Runtime correctness by itself. |
| Final external certification | Layer 7 [#261](https://github.com/yohn-jp/mottainai/issues/261), which consumes the lower certificates and proves the published fresh-host chain. |

## Blockers and certification gate

The Wave 0 correctness blockers remain part of the evidence chain before
another #261 run:

| Wave 0 blocker | Boundary it protects |
| --- | --- |
| [#891](https://github.com/yohn-jp/mottainai/issues/891) | Managed-generation GC durability and fail-closed readiness |
| [#892](https://github.com/yohn-jp/mottainai/issues/892) | Descriptor-bound Route 3 materialized Appliance identity |
| [#893](https://github.com/yohn-jp/mottainai/issues/893) | Exact active-generation CLI/MCP functional smoke |
| [#894](https://github.com/yohn-jp/mottainai/issues/894) | Certified-to-published Runtime Appliance identity continuity |

The current follow-up blockers must also be tracked before the next final
external run:

| Current blocker | Boundary it protects |
| --- | --- |
| [#901](https://github.com/yohn-jp/mottainai/issues/901) | Trusted-main certification staging, evidence generation, and certified artifact upload |
| [#902](https://github.com/yohn-jp/mottainai/issues/902) | Canonical Appliance authority for managed-generation GC roots |
| [#903](https://github.com/yohn-jp/mottainai/issues/903) | Stable deterministic static/code complexity evidence |
| [#904](https://github.com/yohn-jp/mottainai/issues/904) | Independent production-contract Runtime correctness certificate |

Before the next [#261](https://github.com/yohn-jp/mottainai/issues/261) run,
the following gate is mandatory:

1. Layer 4 Runtime correctness is green against the descriptor-bound canonical
   Route 3 Appliance and exact Route 1 payload, including readiness, functional
   CLI/MCP, GC durability, no-op, and rollback/recovery evidence.
2. Layer 5 Lima provider certification is green against that same Route 3
   Appliance and identity, including provider lifecycle, transport, and usable
   KVM evidence. Provider `bootstrapReady` alone is insufficient.
3. Layer 6 Route 4 fresh-host prerequisites are green for the current supported
   Lima/QEMU profile. Only then may layer 7 consume the published release and
   claim the complete `R4 -> R3 -> R2 -> R1` chain.

This gate separates failure localization while preserving the product contract:
Route 4 remains mandatory, Route 3 remains provider-independent, and #261
remains the final real-host certification rather than an architecture-discovery
loop.
