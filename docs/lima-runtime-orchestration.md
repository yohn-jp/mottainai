# `mottainai-init` local Lima Runtime orchestration (Issue #661)

This document is the production-implementation record for the local Lima
provider adapter described by [#600](https://github.com/yohn-jp/mottainai/issues/600)
and scoped by [#661](https://github.com/yohn-jp/mottainai/issues/661), extended
by [#753](https://github.com/yohn-jp/mottainai/issues/753) to converge to
managed Runtime readiness per [ADR-0003](decisions/0003-layered-declarative-deployment.md).
It describes what `mottainai-init runtime ensure` does and, explicitly, what it
is not: a second way to define or consume the canonical Runtime Appliance, or
a second managed-generation build/activation/rollback authority.

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
   Lima's own `Running` state: `limactl shell <instance> --
   mottainai-runtime-health`, the packaged executable
   (`nix/modules/runtime.nix`'s `healthScript`, exposed via
   `environment.systemPackages`) that produces the full
   `mottainai.linux-runtime.v1` schema-2 health/capability result —
   `contractId`, `schemaVersion`, `bootstrapReady`, `managedRuntimeReady`,
   `readiness`, `reconciliation` — documented in
   [`linux-runtime-contract.md`](linux-runtime-contract.md#healthcapability-result).
   This is the same command the guest's own
   `mottainai-runtime-health.service` runs; `mottainai-init` never
   reinterprets the lower-level `mottainai-bootstrap managed-status --json`
   read itself. A Lima instance reported `Running` with an unreachable
   guest, a malformed/mismatched contract, or `bootstrapReady: false` is
   reported not-ready (`runtime_not_ready`), never silently accepted.
5. **Converge the intended managed generation, when requested** (Issue
   #753, `lima.rs`'s `converge_managed_generation`) — when the Runtime
   specification's optional `managed_generation` names a desired
   `mottainai.managed-package-manifest.v1` document and its exact
   `mottainai.managed-generation.v1` identity,
   `scripts/build-lima-runtime-spec.mjs` having derived both from a release
   deployment descriptor (`docs/deployment-descriptor.md`) with no manual
   guest file injection:
   - the exact intended generation identity is checked first, through the
     same canonical, read-only `mottainai-bootstrap managed-status --json`
     the health projection itself consumes — an already-active, healthy,
     matching generation makes this whole step a true no-op;
   - otherwise the manifest is written to the guest's canonical
     `managed-packages/manifest.json` and `mottainai-bootstrap reconcile
     --system x86_64-linux --json` is invoked over the same `limactl shell`
     transport — the existing #628/#642 build/activate/health/rollback
     authority, never a second package/generation implementation;
   - guest health is re-verified and the intended generation identity is
     confirmed active; `bootstrapReady: true` alone, or a healthy
     *different* generation, is never accepted;
   - a bounded packaged CLI/MCP functional smoke (`mottainai --version` and
     one `mottainai-mcp` stdio `initialize` exchange) runs against the
     active generation before Route 3 reports success.
   A Runtime specification with no `managed_generation` preserves the
   pre-#753 boundary exactly: convergence stops at `bootstrapReady`.
6. **Report deterministic bounded evidence** — instance name, appliance
   digest, Lima status, whether anything changed, the guest health
   result, and (when a managed generation was requested)
   `managed_runtime_ready`/`functional_smoke_verified` — as one JSON
   document (`--json`) or a short human summary.

## Shared writer lock and ownership

`mottainai-init runtime ensure` is a writer of the same host-bootstrap state
root as the host bootstrap. The host bootstrap owns QEMU and managed Lima
provider state; `runtime ensure` owns the verified `appliances/` materialization,
the `runtime/` configuration and provenance records, and the isolated
`lima-home/` used by its `limactl` calls. Both paths use the root's existing
`bootstrap.lock` (`BootstrapLock`) as one non-blocking writer boundary and hold
it through the full reconciliation, including external Lima create/start
operations and provider/appliance state promotion.

A busy lock fails closed with the stable bounded `bootstrap_locked`
classification. The root directory can be created to make the lock file
available, but no state, configuration, or staging write is performed before
the lock is acquired. The lock-scoped Runtime mutation entrypoint also rejects
the lock if it is bound to a different state root, before invoking Appliance,
Runtime-state, or Lima mutation. Read-only inspection helpers may be called
independently; they do not grant mutation authority to a caller.

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
- An existing instance that does not report an explicit `qemu` `vmType` —
  including one that omits the field entirely — fails closed as
  `lima_instance_incompatible`. A missing observation is never treated as an
  implicit pass.

## Prerequisite: the managed Lima provider

`runtime ensure` requires the managed Lima provider (`mottainai-init` with
no subcommand) and its verified QEMU host toolchain to already be bootstrapped
and verified; it refuses to run against an ambient `limactl` or QEMU and fails
closed with `provider_not_bootstrapped` otherwise. This keeps the whole
`limactl` identity — and the exact QEMU system executable/image pair it may
resolve — inside the same verified-artifact boundary
[`host-bootstrap.md`](host-bootstrap.md) already establishes for Route 4.
Lima remains the sole VM/QEMU lifecycle authority; `runtime ensure` only
passes the verified binding into that provider.

## Non-goals

- This is not a generic multi-provider abstraction. Only a concrete Lima
  provider adapter exists; a future second provider (e.g. Proxmox) is out
  of scope until it is actually needed (#600's own constraint).
- This does not build, activate, health-check, or roll back a managed
  generation itself. `converge_managed_generation` transports a manifest
  and invokes the guest's own packaged `mottainai-bootstrap reconcile`;
  every build/activation/rollback decision remains #628/#642's authority
  (`src/runtime-contract/managed-runtime.ts`).
- This does not perform real Linux/KVM hardware acceptance. CI exercises
  every reconciliation path in this document against hermetic `limactl`/OCI
  fixtures (`host-bootstrap/tests/appliance.rs`,
  `host-bootstrap/src/lima.rs`'s test module); real-hardware evidence
  remains separate, per #661's own non-goals. CI additionally proves the
  production artifact boundary itself, not only synthetic fixtures: the
  `runtime-contract` job builds the real `runtime-appliance-image`, packages
  it into a local OCI-shaped layout
  (`scripts/build-runtime-appliance-oci-fixture.mjs`), and runs
  `host-bootstrap/tests/appliance_real.rs` (an `#[ignore]`d test, driven
  explicitly by that CI step) to resolve and byte-verify it through
  `ensure_appliance` — still no KVM required.
- This does not run or depend on the Node-based research probes
  (`scripts/lima-validation-probe.mjs`,
  `scripts/lima-appliance-boot-probe.mjs`). Those remain pre-adoption
  research harnesses for #649/#655; this document describes the production
  Rust implementation that superseded treating them as the product.
