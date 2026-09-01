# Canonical local Runtime

> **Architecture status:** the earlier Mottainai-owned direct-QEMU lifecycle
> described by this document has been superseded by Issue #600. The canonical
> guest is now defined by the provider-independent bootstrap-only Runtime
> architecture in [`runtime-architecture.md`](runtime-architecture.md).

Local Runtime lifecycle and canonical guest semantics are separate concerns.
Mottainai owns the declarative Runtime contract, exact appliance identity,
managed desired state, guest reconciliation policy, and bounded evidence. The
selected local provider owns physical VM lifecycle and host/VMM integration.

## Current boundary

```text
Mottainai Runtime specification
        |
        v
local provider adapter
        |
        v
Lima (initial direction under #600)
        |
        v
QEMU/KVM on Linux
        |
        v
same canonical Runtime Appliance
```

Lima is the initial local-provider direction, not part of the guest contract.
A future provider such as Proxmox must be able to instantiate the same canonical
appliance without inserting Lima into its path.

The production `mottainai-init runtime ensure` implementation of this local
Lima path, and how it differs from direct canonical-Appliance consumption by
another provider, is documented in
[`lima-runtime-orchestration.md`](lima-runtime-orchestration.md).

Mottainai therefore does **not** own, for the Lima-managed local path:

- a private QEMU binary/archive distribution;
- direct QEMU command-line/device topology construction;
- private QMP lifecycle as the canonical product interface;
- provider-specific disk/network/SSH implementation details already owned by
  the provider.

Mottainai still owns fail-closed validation of the provider/toolchain and
virtualization capabilities required by a supported profile, plus evidence
connecting the provider instance to the exact canonical appliance and Runtime
state.

## Canonical appliance

The appliance is a bootstrap substrate, not a full application snapshot:

```text
Canonical Runtime Appliance
├─ NixOS / boot / guest integration
├─ networking + OpenSSH/control prerequisites
├─ persistent Runtime control-state layout
├─ bootstrap/readiness prerequisites
└─ mottainai-bootstrap
        |
        v
Managed Runtime generation
├─ mottainai
├─ nawabari
└─ other explicitly supported managed packages
```

Full Mottainai, Nawabari, Zellij, and coding-agent CLIs are not mandatory base
appliance contents. #627 physically enforces that split. #626 provides the
minimal bootstrap component; #628 owns activation/reconcile/rollback.

Changing only a managed application version must not rebuild the base appliance.
See [`runtime-architecture.md`](runtime-architecture.md) for the authoritative
layer and rebuild boundaries.

## Readiness

Local-provider readiness and guest application readiness are distinct:

1. Provider lifecycle makes the canonical guest reachable.
2. The guest reaches `bootstrap-ready` without full Mottainai installed.
3. Bootstrap resolves/builds the exact managed generation.
4. #628 atomically activates that generation and proves managed-runtime health.

A provider reporting a running VM is not evidence that the managed Runtime is
healthy. Conversely, guest package semantics never depend on private provider
state.

## State ownership

Provider instance state remains provider-owned. Canonical guest control state
lives under the persistent `mottainai-control` state root and includes desired
managed-package state, bootstrap evidence, and activation/recovery evidence.
User/workspace data has a separate persistence boundary.

See [`runtime-state.md`](runtime-state.md) for the authoritative ownership and
survival matrix and [`runtime-lifecycle.md`](runtime-lifecycle.md) for
activation/restart recovery.

## Historical direct-QEMU model

The previous `mottainai-local-runtime-v1` implementation assumed a
Mottainai-managed QEMU artifact, private QMP endpoint, fixed SSH forwarding,
and host-specific KVM/HVF/WHPX behavior. Those details are not forward
architecture requirements after #600. Generic verification/security primitives
may be reused, but they must not reintroduce Mottainai-owned VM plumbing that
the provider boundary intentionally removes.

Issue #600 remains the decision record for the provider migration. This document
records the current forward contract only; use Git history when historical
implementation details are required.
