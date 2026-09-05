# Linux Runtime contract (`mottainai.linux-runtime.v1`)

This document is the field-level authority for the versioned Mottainai
Runtime contract established by
[ADR-0002](../../decisions/0002-linux-runtime-contract.md). It defines what a
healthy Mottainai Runtime is, which state Mottainai owns, and the bounded
health/capability result `mottainai init` and later Manager/Dashboard
integration consume to decide whether a target is current, repairable,
stale, or incompatible.

The canonical NixOS specification that implements this contract lives in
[`nix/`](../../../nix). The typed, zod-validated TypeScript view of the
health/capability result lives in
[`src/runtime-contract/contract.ts`](../../../src/runtime-contract/contract.ts).
The desired-state record of which managed packages a Runtime generation
should contain is a separate contract, documented in
[`docs/contracts/runtime/managed-package-manifest`](managed-package-manifest.md)
(`mottainai.managed-package-manifest.v1`, Issue #624).

## Scope

In scope: the Mottainai-owned Linux system layer of a Runtime target — the
stable boot/control/bootstrap substrate, and the managed application generation
that is activated on top of it. Out of scope, per #231's non-goals: the host VM
launcher, SSH target discovery/tunneling, repository UID/GID principal
allocation, requiring repository projects to use Nix, and reverting mutable
repository-user package installations during ordinary reconciliation.

## Contract identity and versioning

- Contract id: `mottainai.linux-runtime.v1`.
- Schema version: `2` (integer, independent of the contract id's `v1`
  suffix; the suffix names a compatibility generation, the schema version
  names the wire-shape revision within it — mirroring the existing
  `nawabari.standalone-execution.v1` / `schemaVersion` split in
  `src/workflow/nawabari.ts`).
- A Runtime that cannot report a contract id and schema version is treated
  as `unknown`, never assumed compatible.
- A Runtime reporting a lower schema version than the client's minimum is
  `stale` and reconcilable; a higher/unrecognized major contract id is
  `incompatible` and reconciliation must not proceed automatically.
- Schema 2 adds the explicit `bootstrap-ready` versus
  `managed-runtime-ready` readiness fields; a schema-1 result cannot be
  mistaken for the new two-phase result.

## Architecture support

- `x86_64-linux` — required.
- `aarch64-linux` — required where the host matrix includes ARM targets
  (Apple Silicon local VM hosts, ARM remote servers). Both are declared as
  `nixosConfigurations` outputs in `nix/flake.nix`.

## Pinned inputs and build identity

- `nix/flake.nix` pins `nixpkgs` (and any companion input) with a locked
  `flake.lock`. An unchanged Runtime specification must produce reproducible
  dependency/system identities within Nix/NixOS's own reproducibility
  guarantees.
- Build identity is the built system's store path derivation hash plus the
  NixOS generation number, both surfaced in the health/capability result
  (`buildIdentity`, `generation` — see below). Two Runtimes built from an
  unchanged flake input set report the same `buildIdentity`.

## SSH service and bootstrap prerequisites

- `sshd` enabled by default, password authentication disabled, key-based
  auth only.
- The `mottainai-control` identity (below) is provisioned with an
  authorized-keys mechanism suitable for remote bootstrap; ordinary
  repository-user principals are a separate allocation (later #230 child)
  and are not created by this contract.
- `controlAuthorizedKeys` (module option, empty by default) bakes keys into
  the closure at build time, for a specific installation built directly
  from source. A provider-independent, credential-free published Runtime
  Appliance artifact (Issue #601) cannot use that path without either
  publishing a reusable credential or requiring a rebuild per operator, so
  the contract also defines one bounded first-boot input:
  `mottainai-runtime-bootstrap-authorized-keys.service` looks for a
  separately attached block device labeled `MTNAI_BOOT` containing exactly
  one `authorized_keys` file (bounded size, validated key lines only), and
  — once, before `sshd` starts, and only while no key has been installed
  yet — copies it into `mottainai-control`'s persistent
  `~/.ssh/authorized_keys` (below). This never writes to the canonical
  disk/closure itself; see
  [`docs/architecture/runtime/providers/proxmox`](../../architecture/runtime/providers/proxmox.md).

## `mottainai-control` trusted identity and protected paths

- `mottainai-control` is an explicit system user/group, not an ambient
  root/admin shortcut.
- Its state/configuration paths (control state directory, Nawabari
  session/claim registry, Mottainai brain state) are owned by
  `mottainai-control` with mode that excludes world and repository-user
  read/write access by default.
- Repository principals (allocated by a later #230 child) must not be able
  to read or mutate these paths. This is the reproducible-permissions
  prerequisite the Nawabari sandbox boundary (yohn-jp/nawabari#80) depends
  on; this contract does not move session authority into Mottainai, it only
  makes the filesystem boundary Nawabari assumes actually hold.

## Required runtime services and packages

The canonical appliance contains only the minimum stable surface needed to
boot, access, verify, recover, and bootstrap a managed Runtime:

- Nix with flakes enabled, the archive/toolchain prerequisites used by #626,
  and the independently packageable `mottainai-bootstrap` executable.
- `git`, `openssh`, and `bubblewrap` as stable control/recovery prerequisites.
- The `mottainai-control` identity, SSH service, health/reconcile commands,
  and persistent control-state layout.

Full `mottainai`, `nawabari`, Zellij, and coding-agent CLIs are not appliance
packages. They are resolved into a managed generation from the #624 manifest
through #625/#626 and selected by the later #628 activation boundary. The
absence of those binaries is expected in `bootstrap-ready`.

Exact package/service names are implementation detail of
`nix/modules/runtime.nix`; this document fixes the required _surface_, not
the Nix attribute names, so the module can evolve without a contract-version
bump as long as the surface stays satisfied.

## Persistent vs disposable filesystem layout

- **Persistent, system/control-owned**: `mottainai-control`'s state
  directory, including `managed-packages/`, `bootstrap/`, and
  `managed-runtime/` (desired manifest, bootstrap evidence, activation/recovery
  state), Nawabari session/claim registry, Mottainai brain state, control SSH
  host keys, and — if installed via the bounded bootstrap input above —
  `~/.ssh/authorized_keys`. Survives reboot and Runtime reconciliation.
- **Persistent, repository-user-owned**: repository checkouts, HOME, tool
  and package caches. Survives Runtime reconciliation and is never reverted
  by it. Explicitly outside destructive system-generation replacement.
- **Disposable, system-owned**: everything else under the NixOS system
  closure — replaced wholesale on every generation switch, exactly like
  ordinary NixOS `/nix/store` and root filesystem semantics.

NixOS's non-FHS layout must not be hidden behind an assumption that `/usr`
or a stable FHS path always exists; downstream Nawabari/bubblewrap code
consumes explicit runtime paths/capabilities from the health/capability
result instead.

## Health/capability result

A bounded, machine-readable result (never an environment/secret dump),
shaped by `RuntimeCapabilityResultSchema` in
`src/runtime-contract/contract.ts`:

| Field                | Meaning                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `contractId`         | `mottainai.linux-runtime.v1`                                                                                                 |
| `schemaVersion`      | `2`                                                                                                                          |
| `runtimeIdentity`    | Stable identifier for this Runtime instance (not the build identity)                                                         |
| `architecture`       | `x86_64-linux` \| `aarch64-linux`                                                                                            |
| `buildIdentity`      | Store-path derivation hash for the current system closure                                                                    |
| `generation`         | NixOS system generation number (positive integer — matches `RuntimeGenerationRecord.generation` used by rollback selection)  |
| `stateOwners`        | `{ system: string[]; repositoryUser: string[] }` — the persistent-path boundary above, reported so callers never hardcode it |
| `requiredCompanions` | Bounded list of `{ name, minimumVersion, present }` for Nawabari and other pinned companions                                 |
| `readiness`          | `"bootstrap-ready"` before managed activation, or `"managed-runtime-ready"` after exact-generation health succeeds       |
| `bootstrapReady`     | boolean; true only when the base control/bootstrap checks pass                                                             |
| `managedRuntimeReady`| boolean; true only after #628 activates and health-checks a managed generation                                              |
| `reconciliation`     | `"current" \| "repairable" \| "stale" \| "incompatible"`                                                                     |
| `upgradeRequired`    | boolean                                                                                                                      |

The result is reported by an external Runtime, not generated locally, so
every string and array field carries an explicit maximum
(`MAX_RUNTIME_IDENTITY_LENGTH`, `MAX_STATE_PATH_LENGTH`,
`MAX_STATE_PATHS_PER_OWNER`, `MAX_COMPANIONS`, `MAX_COMPANION_NAME_LENGTH`,
`MAX_COMPANION_VERSION_LENGTH` in `src/runtime-contract/contract.ts`). A
Runtime cannot inflate the parsed result with an unbounded companion list or
oversized path/identity strings; it fails validation instead.

### Managed-runtime readiness projection (Issue #644)

`readiness`, `managedRuntimeReady`, and `reconciliation` are computed in
two layers, invoked read-only from `nix/modules/runtime.nix`'s
`mottainai-runtime-health` service:

1. **`mottainai-bootstrap managed-status --json`**
   (`src/bootstrap/cli.ts`'s `runManagedStatusCommand`, Issue #642's
   bootstrap CLI extended by #644) reads #628's already-persisted
   `managed-runtime/state.json` and `current` pointer through the exact
   same canonical, zod-`.strict()`-validated `readManagedRuntimeStatus`
   (`src/runtime-contract/managed-runtime.ts`) that `reconcile` itself
   uses — never a second, hand-rolled re-check of a few fields. It always
   exits `0` and prints one of exactly three bounded shapes: `{ valid:
   true, present: false }` (no managed-runtime state exists yet — a
   fresh, bootstrap-only appliance); `{ valid: true, present: true,
   ...ManagedRuntimeStatusReport }` (the canonical state parsed
   successfully, including `activationPhase` and the pointer-matched
   `observedGenerationIdentity`/`observedStorePath` #628's own
   `statusFromState` already computes); or `{ valid: false, code,
   message }` (the persisted state failed canonical validation — malformed
   JSON, schema-invalid, an unreadable `current` pointer, or an ambiguous
   pointer/state combination).
2. **`nix/managed-runtime-health.nix`** (`mottainai-managed-runtime-readiness`)
   is a pure `stdin -> stdout` projection of that bounded status into the
   three health fields — no filesystem access of its own, so it cannot be
   pointed at anything other than whatever `managed-status` reports for
   the canonical state root.

Neither layer writes, builds, switches, or re-runs any part of
`reconcileManagedRuntime` — together they only project already-committed
evidence.

A managed generation is reported `managed-runtime-ready` only when the
status report is `{ valid: true, present: true, ... }` AND all of the
following hold simultaneously:

- `activationPhase` is `"idle"` (no activation transaction in progress —
  `docs/contracts/runtime/state`: "`current` is accepted as active only when it
  matches the persisted record and transaction phase");
- `activeGenerationIdentity` is present (schema-guaranteed to be a
  *healthy* record — `ManagedRuntimeGenerationRecordSchema` requires
  `health.state` to be the literal `"healthy"`, so a validated `active`
  record can never be anything else);
- `observedGenerationIdentity`/`observedStorePath` (already computed by
  `statusFromState` matching the real `current` pointer against `active`)
  equal `activeGenerationIdentity`/`activeStorePath` exactly.

Any other case — `valid: false` (schema-invalid/corrupt canonical state),
`present: false` (a fresh, bootstrap-only appliance), a non-idle
activation phase, an absent `active` record, or an observed pointer that
is missing or disagrees with the active generation — fails closed to the
same bounded result a fresh appliance reports: `readiness:
"bootstrap-ready"`, `managedRuntimeReady: false`, `reconciliation:
"current"`.

When a managed generation IS `managed-runtime-ready`, `reconciliation`
further distinguishes whether the active generation still satisfies the
*currently* persisted desired manifest:

- `state.active.desiredManifestSemanticIdentity` equals
  `state.desiredManifestSemanticIdentity` → `reconciliation: "current"`.
- They differ → `reconciliation: "repairable"`. This is the shape a
  rollback leaves behind: `reconcileManagedRuntime` records the *newest
  attempted* desired identity at the top level even when that candidate
  never became active (`src/runtime-contract/managed-runtime.ts`'s
  `stateWithFailure`), while `active` still names the older, healthy,
  known-good generation actually running. The health projection reports
  this divergence rather than silently treating the two identities as
  equal or rewriting either one to match the other
  (`docs/contracts/runtime/state`: "Observed state ... MUST NOT silently rewrite
  canonical desired/active identities").

Neither layer ever performs reconciliation, switching, repair, or
rollback itself (that stays #628's `reconcileManagedRuntime` and the
guest-invokable `mottainai-bootstrap reconcile`, Issue #642); together
they only report what is already true.

## Update, rollback, and rebuild semantics

- Base appliance updates use the canonical NixOS image/module path. Managed
  application updates build and activate a separate #625 generation through
  #626/#628; they do not switch or rebuild the base NixOS closure.
- Rollback targets the most recent generation whose recorded health result
  had `reconciliation` in `{"current", "repairable"}`; a generation that
  never reported a healthy result is never a rollback target. This
  selection rule is proven deterministically by the fixture in
  `src/runtime-contract/contract.test.ts` (`planRollback`), independent of
  a live NixOS VM.
- Repository-user-owned persistent state (above) is never touched by
  rollback or reconciliation.

## Test layer

- **Nix evaluation/build checks** and **NixOS VM tests**
  (`nix/tests/runtime.nix`) prove SSH service, `mottainai-control` identity,
  bootstrap package/service availability, managed-package absence from the
  base PATH, protected control paths, readiness-aware health response, and
  restart behavior. `nix/tests/runtime-appliance.nix` additionally checks the
  image closure and the bootstrap source/managed-version boundary. These
  require a Nix-capable pipeline; they are not part of `pnpm verify` (see
  ADR-0002 consequences).
- **`nix/tests/managed-runtime-health.nix`** (`nix build
  .#checks.<system>.managed-runtime-health`, wired into
  `.github/workflows/ci.yml`'s `runtime-contract` job as an explicit build
  step — `nix flake check --no-build` alone does not execute a check's
  build) is a real `runCommand` build proving the readiness-projection
  RULES above given an already-validated (or already-rejected)
  `managed-status`-shaped status report fed directly on stdin — a fresh
  bootstrap-only appliance, a healthy active generation, a rollback-shaped
  desired/active divergence, and invalid/inconsistent state (`valid:
  false`, an in-flight activation transaction, a mismatched or absent
  observed pointer) — with no filesystem/sandbox access at all, since the
  script under test performs none either. Real canonical schema validation
  itself is proven separately, directly against
  `readManagedRuntimeStatus`, in `src/bootstrap/cli.test.ts`'s
  `managed-status` coverage (including a schema-invalid-but-field-complete
  case: every field present and well-typed except one `.strict()`-rejected
  unknown key) and `src/runtime-contract/managed-runtime.test.ts`.
- **Deterministic rollback fixture** and **contract-shape tests**
  (`src/runtime-contract/contract.test.ts`) run under the existing
  `node --test` suite and require no Nix toolchain.
- **Package-level contract-version understanding**: a `node --test` case
  asserts the released Mottainai client rejects an unrecognized major
  contract id and accepts a schema version at or above its declared
  minimum, so a future incompatible Runtime contract change is caught by
  `pnpm test` rather than discovered in the field.

## Distribution/delivery evidence (Issues #601/#603)

The contract above defines the guest; it does not define how a copy of it
reaches an operator. Four separate evidence layers exist and must not be
conflated:

- **Stable release distribution** (GHCR OCI Artifact, automated): the
  `runtime-appliance` job in [`.github/workflows/publish.yml`](../../../.github/workflows/publish.yml)
  checks out the exact published release tag, runs
  `nix build .#checks.x86_64-linux.appliance-boundary` and
  `nix build .#runtime-appliance-image` with the locked flake inputs, so the
  #627 bootstrap-only closure is checked before publication. It then generates
  and verifies the existing bounded raw manifest, compresses the canonical raw
  disk with fixed zstd settings, verifies the compressed digest and size, and
  re-verifies the raw manifest after decompression. It publishes the raw
  transport, manifest, and bounded release metadata as three typed layers of
  the non-container artifact described in
  [`docs/architecture/runtime/appliance-oci`](../../architecture/runtime/appliance-oci.md). The registry
  descriptor's `sha256:` digest is the canonical distribution identity;
  `v<package-version>` and `contract-v1` are convenience locators only. No
  GitHub Release asset is uploaded or mutated, so npm publication and GitHub
  Release notes/source metadata remain separate release surfaces.
- **Build evidence** (GitHub Actions artifact, automated): `nix build .#runtime-appliance-image`
  evaluates and builds the same `nixosModules.runtime` this contract defines,
  projected to a self-bootable disk, and `scripts/build-runtime-appliance-manifest.mjs`
  emits/verifies the bounded `mottainai.linux-runtime-appliance.v1` manifest
  (`src/runtime-contract/appliance-manifest.ts`) before the disk is uploaded
  by the `runtime-appliance-artifact` CI job. The retention-bound Actions
  artifact is CI/build evidence only, not the stable distribution surface. This
  proves the artifact was built and is internally consistent; it does not
  prove it boots on real virtualization hardware.
- **Manual integration evidence** (Proxmox, currently manual):
  [`docs/architecture/runtime/providers/proxmox`](../../architecture/runtime/providers/proxmox.md) records
  boot/network/SSH/bootstrap-readiness/health/persistence proof for the
  canonical raw disk recovered from the exact digest-pinned GHCR transport
  envelope on a real Proxmox/QEMU/KVM host. Managed application health is a
  separate post-bootstrap phase; this proof is not automated and does not make
  Proxmox a required or supported Runtime provider.
- **Provider support evidence** (later #600/#261): a supported Runtime
  provider (Lima locally, a future Proxmox provider) additionally proves
  reconciliation semantics, capability validation, and fail-closed behavior
  through Mottainai's own provider adapter. Neither of the two evidence
  layers above satisfies this on its own.

## Non-goals (inherited from #231)

- Choosing or implementing the host VM launcher.
- SSH target discovery/remote UI tunneling.
- Allocating repository UID/GID principals.
- Requiring user repositories to contain flakes or use Nix for project
  dependencies.
- Reverting mutable repository-user package installations during ordinary
  Runtime reconciliation.
- Building a general-purpose NixOS distribution.
