# Linux Runtime contract (`mottainai.linux-runtime.v1`)

This document is the field-level authority for the versioned Mottainai
Runtime contract established by
[ADR-0002](decisions/0002-linux-runtime-contract.md). It defines what a
healthy Mottainai Runtime is, which state Mottainai owns, and the bounded
health/capability result `mottainai init` and later Manager/Dashboard
integration consume to decide whether a target is current, repairable,
stale, or incompatible.

The canonical NixOS specification that implements this contract lives in
[`nix/`](../nix). The typed, zod-validated TypeScript view of the
health/capability result lives in
[`src/runtime-contract/contract.ts`](../src/runtime-contract/contract.ts).

## Scope

In scope: the Mottainai-owned Linux system layer of a Runtime target — the
packages, services, users, SSH, and security prerequisites Mottainai
requires to operate. Out of scope, per #231's non-goals: the host VM
launcher, SSH target discovery/tunneling, repository UID/GID principal
allocation, requiring repository projects to use Nix, and reverting mutable
repository-user package installations during ordinary reconciliation.

## Contract identity and versioning

- Contract id: `mottainai.linux-runtime.v1`.
- Schema version: `1` (integer, independent of the contract id's `v1`
  suffix; the suffix names a compatibility generation, the schema version
  names the wire-shape revision within it — mirroring the existing
  `nawabari.standalone-execution.v1` / `schemaVersion` split in
  `src/workflow/nawabari.ts`).
- A Runtime that cannot report a contract id and schema version is treated
  as `unknown`, never assumed compatible.
- A Runtime reporting a lower schema version than the client's minimum is
  `stale` and reconcilable; a higher/unrecognized major contract id is
  `incompatible` and reconciliation must not proceed automatically.

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

Minimum surface needed to run current Mottainai/Nawabari/Manager behavior
(per #231's implementation notes — start from the minimum, not a general
distribution):

- Mottainai runtime service/companion packages.
- Nawabari standalone execution companion (pinned to the version this
  repository's `package.json` declares as a dev dependency; see
  [`docs/nawabari-execution.md`](nawabari-execution.md)).
- `bubblewrap`, referenced as the external OS-sandbox mechanism for
  `mottainai_exec` (README "No built-in OS sandbox" note); this contract
  provisions the package, it does not itself define the sandbox policy.
- `git`, `openssh`, and the base toolchain the pinned Nawabari/Mottainai
  packages require to run.

Exact package/service names are implementation detail of
`nix/modules/runtime.nix`; this document fixes the required _surface_, not
the Nix attribute names, so the module can evolve without a contract-version
bump as long as the surface stays satisfied.

## Persistent vs disposable filesystem layout

- **Persistent, system/control-owned**: `mottainai-control`'s state
  directory (Nawabari session/claim registry, Mottainai brain state,
  control SSH host keys). Survives Runtime reconciliation.
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
| `schemaVersion`      | `1`                                                                                                                          |
| `runtimeIdentity`    | Stable identifier for this Runtime instance (not the build identity)                                                         |
| `architecture`       | `x86_64-linux` \| `aarch64-linux`                                                                                            |
| `buildIdentity`      | Store-path derivation hash for the current system closure                                                                    |
| `generation`         | NixOS system generation number (positive integer — matches `RuntimeGenerationRecord.generation` used by rollback selection)  |
| `stateOwners`        | `{ system: string[]; repositoryUser: string[] }` — the persistent-path boundary above, reported so callers never hardcode it |
| `requiredCompanions` | Bounded list of `{ name, minimumVersion, present }` for Nawabari and other pinned companions                                 |
| `reconciliation`     | `"current" \| "repairable" \| "stale" \| "incompatible"`                                                                     |
| `upgradeRequired`    | boolean                                                                                                                      |

The result is reported by an external Runtime, not generated locally, so
every string and array field carries an explicit maximum
(`MAX_RUNTIME_IDENTITY_LENGTH`, `MAX_STATE_PATH_LENGTH`,
`MAX_STATE_PATHS_PER_OWNER`, `MAX_COMPANIONS`, `MAX_COMPANION_NAME_LENGTH`,
`MAX_COMPANION_VERSION_LENGTH` in `src/runtime-contract/contract.ts`). A
Runtime cannot inflate the parsed result with an unbounded companion list or
oversized path/identity strings; it fails validation instead.

## Update, rollback, and rebuild semantics

- Update/rebuild uses standard NixOS generation switching
  (`nixos-rebuild switch` against the pinned flake, or the fresh-image
  build path for new targets — both driven by the same
  `nix/modules/runtime.nix`).
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
  package/service availability, protected control paths, health response,
  and restart behavior. These require a Nix-capable pipeline; they are not
  part of `pnpm verify` (see ADR-0002 consequences).
- **Deterministic rollback fixture** and **contract-shape tests**
  (`src/runtime-contract/contract.test.ts`) run under the existing
  `node --test` suite and require no Nix toolchain.
- **Package-level contract-version understanding**: a `node --test` case
  asserts the released Mottainai client rejects an unrecognized major
  contract id and accepts a schema version at or above its declared
  minimum, so a future incompatible Runtime contract change is caught by
  `pnpm test` rather than discovered in the field.

## Non-goals (inherited from #231)

- Choosing or implementing the host VM launcher.
- SSH target discovery/remote UI tunneling.
- Allocating repository UID/GID principals.
- Requiring user repositories to contain flakes or use Nix for project
  dependencies.
- Reverting mutable repository-user package installations during ordinary
  Runtime reconciliation.
- Building a general-purpose NixOS distribution.
