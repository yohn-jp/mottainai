# `mottainai-init` local Lima Runtime orchestration (Issue #661)

This document is the production-implementation record for the local Lima
provider adapter described by [#600](https://github.com/yohn-jp/mottainai/issues/600)
and scoped by [#661](https://github.com/yohn-jp/mottainai/issues/661). It
describes what `mottainai-init runtime ensure` does and, explicitly, what it
is not: a second way to define or consume the canonical Runtime Appliance.

## Scope: local Lima orchestration vs. direct Appliance consumption

Two separate things both start from the same canonical Runtime Appliance
digest, and this document only covers the first:

| | `mottainai-init runtime ensure` (this document) | Direct canonical-Appliance consumption |
| --- | --- | --- |
| Consumer | The standalone `mottainai-init` host bootstrap, for one local Linux/KVM host | Any QEMU/KVM-capable deployment path, e.g. a future Proxmox provider, or a manual `qemu-system-x86_64` boot for evidence work (`docs/runtime-appliance-proxmox.md`) |
| VM lifecycle owner | Lima (`limactl`), through documented/public interfaces only | Owned entirely by that consumer; Lima is not involved |
| What is verified | The exact appliance digest, via the same [OCI Artifact contract](runtime-appliance-oci.md) | The same contract, verified independently by that consumer |
| Guest/appliance semantics | Unchanged — no Lima-specific package, service, or provisioning is added to `runtime-appliance-image` or `mottainai-bootstrap` | Unchanged |

`mottainai-init runtime ensure` is one Lima-specific *provider adapter*
implementation living entirely inside the standalone host-bootstrap Rust
artifact (`host-bootstrap/src/{appliance,oci,lima}.rs`). It is not a
separately distributed Lima launcher, and it does not change what the
canonical Appliance *is*. A direct QEMU/KVM consumer of the same Appliance
digest — including a future Proxmox provider — needs none of the Lima
plumbing this document describes and remains unaffected by it.

## What `mottainai-init runtime ensure` does

Given a versioned Runtime specification (`mottainai.host-bootstrap.lima-runtime-spec.v1`)
naming an immutable Appliance digest plus bounded product-level intent (CPU,
memory, explicit mounts), one invocation converges a local Lima instance to
ready state:

1. **Resolve and verify the canonical Appliance** (`appliance.rs`) — fetches
   the pinned `sha256:` digest's OCI manifest and its three declared layers
   from the registry named in the Runtime specification, cross-verifies the
   manifest/release-metadata contract exactly as
   [`runtime-appliance-oci.md`](runtime-appliance-oci.md) describes, and
   decompresses the raw disk into managed state, verifying its digest and
   size against the manifest before it is ever handed to Lima. A previously
   verified materialization for the same digest is reused with no network
   access.
2. **Render one bounded Lima configuration** (`lima.rs`'s
   `render_lima_config`) — `vmType: qemu`, the verified raw disk path under
   the documented `images:` key, and no host mount unless the Runtime
   specification explicitly lists one. Nothing QEMU- or Lima-internal beyond
   these documented YAML keys is added, and canonical guest semantics are
   never touched.
3. **Create/start or reconcile the instance** through exactly the
   documented, public `limactl` operations: `list --all-fields --format
   json`, `create`, `start`, and `shell` (guest exec). No private state
   files, sockets, or driver internals are read.
4. **Wait for the canonical guest/bootstrap health boundary**, not merely
   Lima's own `Running` state: `limactl shell <instance> -- mottainai-bootstrap
   managed-status --json`, the same re-runnable, always-`exit 0` bounded
   command documented in [`linux-runtime-contract.md`](linux-runtime-contract.md#managed-runtime-readiness-projection-issue-644).
   A Lima instance reported `Running` with an unreachable or invalid guest
   health boundary is reported not-ready (`runtime_not_ready`), never
   silently accepted.
5. **Report deterministic bounded evidence** — instance name, appliance
   digest, Lima status, whether anything changed, and the guest health
   result — as one JSON document (`--json`) or a short human summary.

## Idempotency and fail-closed reconciliation

- A **missing** instance is created and started. The Lima instance
  configuration and a managed intent record are written *before* `create`
  is invoked, so a process interruption between `create` succeeding and
  `start` running is recognized and resumed on the next `ensure` call,
  without repeating `create` or recreating the instance.
- A **stopped** instance whose recorded provenance matches the desired
  Runtime specification is started, never recreated.
- A **running** instance whose recorded provenance matches is left alone
  (`limactl start`/`create` are not invoked); its health is still
  re-verified on every call.
- An **ambient** Lima instance with the target name but no managed
  provenance record is never adopted — this mirrors how the managed Lima
  *provider binary* itself already refuses to adopt an ambient `limactl` on
  `PATH` (`provider.rs`). It fails closed as `lima_instance_ambiguous`.
- An existing instance whose recorded provenance **disagrees** with the
  current Runtime specification (different appliance digest, CPU, memory,
  or mounts) fails closed as `lima_instance_incompatible`. Recreation is
  never the automatic reconciliation mechanism; an operator must resolve
  the drift explicitly.
- An instance in any Lima status other than `Running`/`Stopped` (for
  example a driver-reported broken state) fails closed as
  `lima_instance_ambiguous` rather than guessing at a repair action.

## Prerequisite: the managed Lima provider

`runtime ensure` requires the managed Lima provider (`mottainai-init` with
no subcommand) to already be bootstrapped and verified; it refuses to run
against an ambient `limactl` and fails closed with
`provider_not_bootstrapped` otherwise. This keeps the whole `limactl`
identity — the exact binary this orchestration invokes — inside the same
verified-artifact boundary [`host-bootstrap.md`](host-bootstrap.md) already
establishes for the Lima provider archive.

## Non-goals

- This is not a generic multi-provider abstraction. Only a concrete Lima
  provider adapter exists; a future second provider (e.g. Proxmox) is out
  of scope until it is actually needed (#600's own constraint).
- This does not perform real Linux/KVM hardware acceptance. CI exercises
  every reconciliation path in this document against hermetic `limactl`/OCI
  fixtures (`host-bootstrap/tests/appliance.rs`,
  `host-bootstrap/src/lima.rs`'s test module); real-hardware evidence
  remains separate, per #661's own non-goals.
- This does not run or depend on the Node-based research probes
  (`scripts/lima-validation-probe.mjs`,
  `scripts/lima-appliance-boot-probe.mjs`). Those remain pre-adoption
  research harnesses for #649/#655; this document describes the production
  Rust implementation that superseded treating them as the product.
