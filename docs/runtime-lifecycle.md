# Runtime lifecycle authority

This document defines the canonical bootstrap, reconcile, activation, health,
rollback, and restart-recovery lifecycle for the bootstrap-only Runtime
architecture (#622).

It composes the contracts owned by #624–#628. It does not redefine their field
schemas. See [`runtime-architecture.md`](runtime-architecture.md) for layer
ownership and [`runtime-state.md`](runtime-state.md) for persistence authority.

## Lifecycle at a glance

```text
fresh appliance
    |
    v
base boot
    |
    v
BOOTSTRAP_READY
    |
    | desired manifest supplied
    v
validate desired state
    |
    v
resolve exact sources (#626)
    |
    v
build + verify managed generation (#625/#626)
    |
    v
BUILT_VERIFIED
    |
    | #628 activation transaction
    v
STAGED
    |
    | atomic active-selection switch
    v
SWITCHED_UNVERIFIED
    |
    | managed-runtime health
    +----------------------+
    | healthy              | unhealthy/interrupted
    v                      v
MANAGED_READY          ROLLBACK/RECOVERY
                           |
                           v
                  previous MANAGED_READY
                  or BOOTSTRAP_READY if
                  no known-good generation exists
```

A base appliance can remain `BOOTSTRAP_READY` indefinitely. Full Mottainai is
not required for that state.

## Readiness definitions

### `BOOTSTRAP_READY`

The guest is bootstrap-ready only when all base-level prerequisites required to
converge managed state are available:

- guest boot completed;
- persistent `mottainai-control` state root is accessible with expected
  ownership/permissions;
- required networking/control-plane access is ready;
- Nix/bootstrap prerequisites are available;
- the #626 bootstrap executable is runnable;
- bounded bootstrap status/verification can execute without full Mottainai.

Bootstrap readiness MUST NOT execute or require full `mottainai`, `nawabari`,
Zellij, or coding-agent binaries from the base closure.

### `MANAGED_READY`

The Runtime is managed-ready only when:

- a canonical desired manifest exists;
- the active generation identity is persisted and unambiguous;
- active selection points to the exact recorded Nix generation;
- the generation satisfies the desired manifest identity;
- compatibility checks pass;
- managed-runtime health against the exact active generation passes.

An active symlink/store path without successful health is not `MANAGED_READY`.

## Command responsibility

The #626 bootstrap command surface, extended by Issue #642, is:

```text
mottainai-bootstrap build <manifest>
mottainai-bootstrap status
mottainai-bootstrap verify
mottainai-bootstrap reconcile
```

`build` ends after producing and verifying a managed generation and persisting
bounded bootstrap evidence. It MUST NOT switch active application state.

`reconcile` is the end-to-end operation that combines #626 build with #628
activation: it always converges the canonical `managed-runtime` control state
against the canonical desired manifest (`src/runtime-contract/managed-runtime.ts`'s
`reconcileManagedRuntime`), never a caller-supplied state directory, file,
pointer, or manifest path. It is the one supported guest-invokable path to
initialize, update, no-op, or roll back a managed generation; a fresh
appliance has exactly this one path to reach `MANAGED_READY`.

## Reconcile input and authority

Reconcile begins from the canonical #624 manifest under the Runtime control
state. It never begins by inspecting PATH and treating observed packages as
desired state.

Required input identities are:

- desired manifest semantic identity;
- deployed appliance/bootstrap compatibility contract;
- currently persisted active/previous activation evidence, if present.

Provider instance state may determine whether the guest is reachable, but it
does not determine package desired state or active generation identity.

## Reconcile decision

Before building, #628 compares desired and active state.

### Fresh deployment

No active generation exists. Build the desired generation, verify it, stage it,
switch to it, and prove health. No previous rollback target exists.

### No-op reconcile

Reconcile is a no-op only when all of these are true:

- persisted desired semantic identity equals the active generation's recorded
  desired semantic identity;
- active selection points to the recorded active generation;
- compatibility remains valid;
- bounded managed-runtime health still passes.

A no-op does not rebuild, switch, or rewrite user/workspace state. It may refresh
bounded observed/health evidence.

### Update/removal

Any semantic desired-state change, including an exact package version/source
change or removal of a managed package, builds a new generation before touching
active selection. Package removal means absence from the newly built managed
generation; it does not delete unrelated persistent-unmanaged or workspace
state.

## Build phase

The build phase is owned by #626 using #625:

```text
parse/validate manifest
-> assert projectable supported package set
-> resolve exact Mottainai source
-> verify requested source/version
-> verify Nix prerequisite
-> build deterministic generation
-> parse generation metadata
-> verify resolved source/version/output identities
-> persist bounded bootstrap success evidence
```

Every error before activation is a pre-switch failure. Active/previous
selection MUST remain unchanged.

No fallback to global npm, ambient PATH, current repository checkout, mutable
latest source, or unmanaged installation is permitted.

## Activation selection boundary

#628 uses one explicit atomic consumer-selection boundary for managed
applications:

```text
/var/lib/mottainai-control/managed-runtime/current
    -> /nix/store/<verified-managed-generation>
```

`current` is a symlink (or an implementation-equivalent single atomic pointer)
whose replacement is performed by create-temporary-link + atomic rename in the
same filesystem. Consumers MUST resolve managed executables/services through
this active-generation boundary, not by searching ambient PATH.

The persisted `managed-runtime/state.json` remains the authority for why a
particular target is active and for recovery. The `current` pointer is an
observable physical fact used to reconcile crashes; neither one may be silently
rewritten to match the other without validating the transaction evidence.

A separate mutable Nix profile is unnecessary unless implementation evidence
shows the atomic pointer cannot satisfy a retained invariant. Do not introduce
NixOS system-generation switching for managed application updates: the base
NixOS appliance is outside this transaction.

## Activation transaction

For candidate generation `C` and prior healthy active generation `P`:

1. Verify `C` and its compatibility again at the activation boundary.
2. Persist transaction evidence naming `C`, `P` (if any), and phase `prepared`.
3. Atomically replace `current` so it points to `C`.
4. Persist phase `switched-health-pending`.
5. Run managed health against executables/services resolved from `C` exactly.
6. If healthy, persist `C` as active/known-good, move `P` to previous, clear
   transaction state, and report `MANAGED_READY`.
7. If unhealthy, persist failure/rollback intent and restore `current` to `P`
   atomically when `P` exists.
8. Verify the restored `P` selection/health, persist rollback completion, and
   retain bounded failure evidence for `C`.

The implementation may use different enum spelling, but these durable phases
and ordering guarantees are mandatory.

## Initial activation failure

On a fresh appliance there is no previous known-good generation. If the first
candidate fails after switch:

- it MUST NOT be marked healthy/known-good;
- active state MUST not claim a valid managed generation;
- the Runtime returns to a recoverable bootstrap state with failure evidence;
- desired manifest remains intact for diagnosis/retry;
- user/workspace state remains untouched.

Keeping the unhealthy candidate in the Nix store for bounded diagnosis is
allowed; treating it as active/healthy is not.

## Pre-switch failure invariant

Any failure before step 3 of activation leaves the current active selection
exactly as it was. This includes:

- invalid/incompatible manifest;
- unsupported managed package;
- source resolution/integrity/version failure;
- unavailable Nix prerequisite;
- Nix generation build failure;
- malformed generation metadata;
- generation compatibility failure;
- inability to persist the prepared transaction safely.

A pre-switch failure records bounded evidence and returns an error. It does not
"partially update" the active Runtime.

## Post-switch health failure invariant

A failure after `current` points to the candidate but before candidate health is
committed is a rollback condition.

When a previous known-good generation exists:

```text
candidate selected
-> candidate unhealthy
-> atomically select previous known-good
-> verify restored selection
-> persist previous as active
-> keep candidate failure evidence
```

The failed candidate never replaces the previous generation as known-good.

## Restart and interrupted-activation recovery

On guest/service restart, #628 first reads canonical activation state and
observes the exact `current` pointer before starting another reconcile.
Recovery is deterministic by persisted transaction phase.

### No transaction

- `current` matches persisted active identity: continue with normal health/no-op
  reconciliation.
- no active state on a fresh appliance and no `current`: remain
  `BOOTSTRAP_READY`.
- `current` disagrees with persisted active state without transaction evidence:
  fail closed; do not choose "newest" or PATH-observed generation.

### `prepared`

Expected identities are candidate `C` and prior `P`.

- `current` still points to `P` (or is absent on first activation): switch never
  committed. Abort/clear the prepared transaction or retry from the verified
  candidate deterministically.
- `current` points to `C`: crash occurred after atomic switch but before phase
  persistence. Treat as `switched-health-pending` and verify `C`.
- `current` points anywhere else: fail closed as ambiguous state.

### `switched-health-pending`

- `current` points to `C`: run candidate health. Commit success or rollback.
- `current` already points to `P`: treat rollback selection as already restored,
  verify `P`, persist rollback completion.
- any other target: fail closed.

### rollback pending/in progress

- restore/select the recorded previous known-good `P` if not already selected;
- verify exact selection and bounded health;
- persist `P` as active and clear transaction only after recovery is proven.

Recovery MUST NOT depend on timestamps, lexicographic store paths, Nix GC order,
or provider instance metadata to guess the active generation.

## Managed health

Managed health is executed against the exact candidate/active generation, not
ambient PATH. At minimum it must prove the application generation is executable
and reports identities/contracts compatible with the desired Runtime state.

The final #628 health surface may compose existing bounded Runtime health
contracts, but it must distinguish:

- base/bootstrap health;
- managed application health;
- compatibility failure;
- transient/unavailable health check;
- confirmed unhealthy generation.

A health timeout/error is not success. Rollback policy may distinguish bounded
retryable observations internally, but the generation is not promoted to
known-good without an explicit successful health result. This activation-time
health check is distinct from the read-only `mottainai-runtime-health`
readiness projection (Issue #644, `docs/linux-runtime-contract.md`
"Managed-runtime readiness projection"): that command never performs health
checks, reconciliation, or activation itself — it only reports the
already-persisted outcome of the activation health check above, from
`managed-runtime/state.json` and `current`.

## Package removal

Removal is declarative:

1. Persist a new valid desired manifest without the package.
2. Build a new managed generation from the complete desired package set.
3. Activate it through the same transaction as any update.
4. Preserve user/workspace and persistent-unmanaged data.
5. Retain the previous generation as rollback state until the new generation is
   healthy.

Do not imperatively delete package files from an active generation; Nix outputs
are immutable.

## Appliance update/replacement

Managed reconcile never mutates the bootable base appliance. If the
NixOS/boot/bootstrap/guest contract changes, #627/#629 produce/distribute a new
base appliance lifecycle artifact.

When a base appliance is replaced while persistent control state is retained:

- revalidate appliance/bootstrap compatibility before activation;
- retain desired and activation evidence;
- re-realize a referenced managed generation if its immutable store object is
  not present on the replacement appliance/storage;
- never claim a missing store object is active merely because its path remains
  recorded.

An application-only update does not enter this path.

## End-to-end proof required by #630

The golden path must prove, using the same base appliance identity across the
application-only update:

```text
boot fresh appliance
-> BOOTSTRAP_READY with full Mottainai/Nawabari absent from base
-> apply canonical desired manifest
-> build exact generation
-> activate and reach MANAGED_READY
-> change only managed Mottainai version/source
-> build/switch new generation without base appliance rebuild
-> reboot
-> recover desired/active state and MANAGED_READY
-> activate deliberately unhealthy generation
-> rollback to previous known-good generation
```

It also proves that persistent-unmanaged state is never represented as managed
and that ephemeral state carries no survival guarantee.

## Non-negotiable invariants

- Build is not activation.
- Presence in `/nix/store` is not activation.
- Bootstrap readiness is not managed-runtime readiness.
- Pre-switch failure does not change active generation.
- Post-switch health failure does not promote the failed candidate.
- User/workspace state is outside managed-generation rollback.
- Managed application updates do not mutate/rebuild the base appliance.
- Provider lifecycle does not determine guest package state.
- Crash recovery uses persisted transaction identities plus exact active-pointer
  observation; it never guesses.
