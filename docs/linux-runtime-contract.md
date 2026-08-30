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
The desired-state record of which managed packages a Runtime generation
should contain is a separate contract, documented in
[`docs/managed-package-manifest.md`](managed-package-manifest.md)
(`mottainai.managed-package-manifest.v1`, Issue #624).

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
  [`docs/runtime-appliance-proxmox.md`](runtime-appliance-proxmox.md).

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
  control SSH host keys, and — if installed via the bounded bootstrap input
  above — `~/.ssh/authorized_keys`). Survives Runtime reconciliation.
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

## Distribution/delivery evidence (Issues #601/#603)

The contract above defines the guest; it does not define how a copy of it
reaches an operator. Four separate evidence layers exist and must not be
conflated:

- **Stable release distribution** (GitHub Release, automated): the
  `runtime-appliance` job in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
  checks out the exact published release tag, runs
  `nix build .#runtime-appliance-image` with the locked flake inputs, generates
  and verifies the existing bounded raw manifest, compresses the canonical raw
  disk with fixed zstd settings, verifies the compressed digest and size, and
  re-verifies the raw manifest after decompression. It publishes
  `mottainai-runtime-appliance.raw.zst`,
  `runtime-appliance-manifest.json`, and the bounded
  `runtime-appliance-release-metadata.json` as assets of that GitHub Release.
  The raw disk and its manifest remain the canonical appliance identity; zstd
  is only the distribution transport envelope. npm publication remains a
  separate release job and package surface.
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
  [`docs/runtime-appliance-proxmox.md`](runtime-appliance-proxmox.md) records
  boot/network/SSH/version/health/persistence proof for the canonical raw disk
  recovered from the exact downloaded GitHub Release transport envelope on a
  real Proxmox/QEMU/KVM host. This proves the built artifact runs; it is not
  automated and does not make Proxmox a required or supported Runtime provider.
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
