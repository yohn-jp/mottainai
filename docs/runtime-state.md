# Runtime state and persistence authority

This document is the cross-cutting authority for Runtime state ownership,
persistence, and rollback boundaries under the bootstrap-only architecture
(#622). Field-level schemas remain owned by their component contracts; this
document defines how those records relate and what may change together.

See also:

- [`runtime-architecture.md`](runtime-architecture.md) — layer ownership and
  rebuild boundaries;
- [`managed-package-manifest.md`](managed-package-manifest.md) — canonical
  desired managed-package state (#624);
- [`managed-generation.md`](managed-generation.md) — immutable generation
  identity/build output (#625);
- [`runtime-lifecycle.md`](runtime-lifecycle.md) — transitions among the states
  defined here.

## Canonical control-state root

System-owned Runtime state lives under the persistent `mottainai-control`
state root, `/var/lib/mottainai-control` by default. It is not stored in a
repository, workspace, user HOME, provider-private state directory, or mutable
application generation.

Canonical records include:

```text
/var/lib/mottainai-control/
├─ managed-packages/
│  └─ manifest.json             # #624 desired state
├─ bootstrap/
│  └─ state.json                # #626 bounded bootstrap attempt/success evidence
└─ managed-runtime/
   └─ state.json                # #628 activation/recovery authority
```

The final field schema for `managed-runtime/state.json` is implemented by #628,
but its ownership and semantics are fixed below. Writes to canonical control
records MUST be atomic. Corrupt canonical state fails closed; it is never
silently replaced with an inferred state from PATH, running processes, or
provider metadata.

## State classes

### Desired state

The persisted #624 managed package manifest is the authoritative declaration of
what the managed Runtime should contain.

- Identity: `semanticIdentityOf(manifest)`.
- Persistence: control-state root.
- Mutability: explicit desired-state update only.
- It is not inferred from installed binaries or active Nix store paths.
- `activation.generation` orders reconciliation but is excluded from semantic
  desired-state identity.

### Resolved source state

#626 resolves exact source inputs required to build a desired generation. For
Mottainai, the requested version and source NAR SHA-256 must match the exact
resolved tree before it is trusted.

Resolved source data is evidence/input to a generation build, not a second
source of desired state. A temporary extracted source tree may be discarded
after the generation is built; bounded verified source identity belongs in
bootstrap/generation evidence.

### Built generation

A #625 managed generation is an immutable Nix build output plus bounded metadata
and a deterministic generation identity.

A built generation is not active merely because it exists in `/nix/store`.
Building MUST NOT mutate active application state.

### Staged generation

#628 may mark one verified built generation as the candidate for activation.
Staging means "eligible for the current activation transaction," not "active."
At most one activation transaction may own the canonical staged slot at a time.

A staged generation MUST carry enough durable identity to recover after an
interruption without guessing which store path was intended.

### Active generation

The active generation is the generation currently selected by the managed
Runtime activation boundary. Its canonical evidence includes, at minimum:

- managed generation identity;
- generation store path;
- desired manifest semantic identity it satisfies;
- activation transaction/ordering identity sufficient for crash recovery;
- whether managed-runtime health was proven for this activation.

The active record is authoritative. Observing another generation in the Nix
store or PATH does not change it.

### Previous known-good generation

The previous known-good generation is the rollback target retained while a
newer generation is being proven healthy.

- It MUST have previously passed managed-runtime health.
- A generation that never became healthy is never promoted to known-good.
- A failed update MUST NOT erase or overwrite the prior known-good evidence.
- #628 MUST retain at least one usable known-good rollback target whenever one
  existed before the update.

After a newer generation is proven healthy, the former active generation may
become `previous`. Garbage collection MUST NOT remove a generation while it is
still referenced as required rollback state.

### Observed state

Observed state is bounded evidence collected from the live guest/Nix/runtime to
check whether persisted state matches reality. It is not authoritative desired
state.

Examples include:

- whether the recorded active store path exists/is queryable;
- whether the active executable/service reports the expected contract;
- managed-runtime health result;
- bootstrap readiness;
- provider/guest reachability where relevant.

Observed state may trigger reconciliation, but it MUST NOT silently rewrite
canonical desired/active identities to match whatever happens to be observed.

### Bootstrap evidence

#626 persists bounded evidence under `bootstrap/state.json`.

It separates the latest build attempt from the latest successful build so a
failed attempt can always be recorded without destroying known-good evidence.
Conceptually:

```text
bootstrap state
├─ lastAttempt
│  ├─ outcome
│  ├─ completedAt
│  ├─ manifest semantic identity, when parsing reached that point
│  └─ bounded error code/message on failure
└─ lastSuccessfulBuild, optional
   ├─ desired manifest semantic identity
   ├─ resolved Mottainai source identity
   ├─ managed generation identity
   └─ managed generation store path
```

Bootstrap evidence does not activate a generation and does not replace #628's
active/previous state authority.

## Managed, persistent-unmanaged, and ephemeral state

These classes are independent from active-generation status.

### Managed

Managed package state is declared in the #624 manifest and reproducible through
the supported #625/#626 Nix path. It is reconciled as one managed generation.
Only explicitly supported package identities/recipes qualify.

A manually installed binary is not managed merely because it is present.

### Persistent-unmanaged

User/workspace state may live on persistent storage and survive managed
reconciliation, but Mottainai does not claim it is reproducible or rolled back
with managed generations.

Examples include repository contents, user configuration, and manually added
workspace tools outside the supported managed package route.

Persistent-unmanaged state MUST NOT be included in managed generation identity
or represented as successfully reconciled managed state.

### Ephemeral

Temporary files, caches, downloaded bootstrap archives after verification,
experiments, and other explicitly disposable state may be discarded across
reboot/reconciliation/replacement according to their owning subsystem. No
reproducibility or persistence guarantee exists.

## Persistence matrix

`Yes` means the Runtime contract requires the state/evidence to survive when the
underlying persistent control/workspace storage is preserved. `Re-realize`
means identity/evidence survives but immutable Nix output may need to be rebuilt
or fetched again after a base-appliance/storage replacement.

| State | Reboot | Managed generation switch | Managed rollback | Base appliance replacement |
| --- | --- | --- | --- | --- |
| desired managed manifest | Yes | Yes | Yes | Yes, when control-state volume is preserved |
| bootstrap evidence | Yes | Yes | Yes | Yes, when control-state volume is preserved |
| #628 active/previous evidence | Yes | Yes | Yes | Yes, when control-state volume is preserved |
| immutable managed generation store object | Normally yes | Yes | Yes while retained | Re-realize if store object is not preserved |
| repository/workspace persistent-unmanaged data | Yes | Yes | Yes | Only when its persistent storage is explicitly preserved |
| user/workspace data | Yes | Yes | Yes | Only when its persistent storage is explicitly preserved |
| ephemeral/cache/temp | Not guaranteed | Not guaranteed | Not guaranteed | No guarantee |
| base appliance system closure | Yes | unchanged by managed switch | unchanged by managed rollback | Replaced |

A managed generation rollback therefore changes managed application selection,
not user/workspace content and not the base appliance.

## `managed-runtime/state.json` semantics for #628

#628 owns the concrete schema, but it MUST represent these facts without
ambiguity:

```text
managed runtime state
├─ desired manifest semantic identity
├─ active generation, optional on a fresh appliance
│  ├─ identity
│  ├─ store path
│  └─ health/known-good evidence
├─ previous known-good generation, optional
│  ├─ identity
│  ├─ store path
│  └─ health/known-good evidence
└─ activation transaction
   ├─ phase
   ├─ candidate/staged generation identity, when applicable
   └─ enough evidence to resume or roll back deterministically
```

The durable activation phase MUST distinguish at least:

- no activation in progress;
- candidate staged but active selection unchanged;
- switch committed and health verification pending;
- rollback required/in progress when a post-switch failure occurred.

Exact enum names are implementation detail. The persisted meaning is not.
After restart, #628 must be able to determine one of: continue verification,
complete rollback, restore the previous known-good selection, or fail closed.
It must never choose an active generation by "latest store path" heuristics.

## Write and ordering rules

1. Desired manifest updates are atomic.
2. Generation build completes and verifies before activation state can refer to
   it as a candidate.
3. Candidate/staged evidence is persisted before any active-selection mutation
   that would require crash recovery.
4. Active-selection mutation is atomic from managed consumers' perspective.
5. Managed-runtime health is verified after the candidate is selected.
6. Only a healthy candidate may become the new known-good active generation.
7. Previous known-good evidence is retained until the new candidate is proven
   healthy and recovery no longer depends on the old record.
8. Failure evidence is bounded and never overwrites the desired manifest or
   user/workspace state.

## Failure invariants

- Invalid/incompatible desired state: active/previous generation unchanged.
- Source resolution failure: active/previous generation unchanged.
- Generation build/verification failure: active/previous generation unchanged.
- Failure after staging but before switch: active generation unchanged; staged
  transaction is cleared/recovered deterministically.
- Failure after switch but before health success: restore previous known-good
  generation when one exists; initial deployment with no previous generation
  fails without fabricating a healthy active state.
- Corrupt canonical activation state: fail closed; do not infer active identity
  from PATH or provider state.
- User/workspace and persistent-unmanaged data are not rolled back for any
  managed-generation failure.

## Ownership boundaries

| State | Writer | Readers |
| --- | --- | --- |
| managed package manifest | governed Mottainai/operator desired-state path (#624/#628) | #625, #626, #628 |
| bootstrap evidence | #626 | bootstrap status/verify, #628 diagnostics |
| generation metadata | #625 build path | #626, #628, evidence/tests |
| active/previous/transaction state | #628 | managed-runtime status/health/recovery |
| appliance manifest/distribution digest | appliance build/#629 | providers, verification, #630 |
| provider instance state | provider adapter | provider reconciliation/evidence only |
| user/workspace state | user/repository processes | user/repository processes; never activation authority |

No layer gains authority over another layer merely because it can observe its
files or processes.
