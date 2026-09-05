# Route 4 -> Route 1 deployment operation book

Status: **normative chronological execution authority** for the canonical local deployment/convergence path.

Architecture authority: [ADR-0003](decisions/0003-layered-declarative-deployment.md). Route implementation vehicles remain defined by [deployment-route-implementation.md](deployment-route-implementation.md). Field-level schemas remain authoritative in their own contract documents; this operation book owns **execution order, producer/consumer handoffs, and the proof required before the next operation may begin**.

Initial audit baseline: `main@5b8f3fc3b8dc82c7977e70c1379168d63a7cafb4` (Issue #848). Open defects are called out explicitly. A gap in this document is never permission to weaken the target contract or to normalize broken current behavior.

## 1. Purpose

The deployment architecture is cumulative:

```text
Route 4: standalone host bootstrap
    -> Route 3: Lima-managed canonical NixOS Runtime Appliance
        -> Route 2: managed Nix Runtime/application generation
            -> Route 1: canonical Mottainai npm application payload
```

Architecture documents answer **what each route owns**. This document answers the stricter operational question:

> Given one selected immutable Mottainai release, what happens next, in what exact order, why does each operation exist, what authority supplies its inputs, what state may it mutate, what proves success, and what exact condition permits the next handoff?

The canonical chain is not successful because every component can build independently. It is successful only when every producer/consumer edge below is proven and the exact Route 1 payload is functionally ready inside the intended active managed generation.

## 2. Reading rules

Every operation has a stable ID. Bugs, tests, CI gates, and certification evidence should cite these IDs instead of referring vaguely to "Route 3" or "bootstrap".

Status values used below:

- **implemented** — the current production path implements the operation at the named boundary.
- **partial** — part of the operation exists, but a required authority/handoff/proof is missing.
- **gap** — the target operation is not correctly connected in production; an Issue owns the defect.
- **certification** — repository code can prepare or inspect it, but the final proof belongs to real-host Issue #261.

For every step, "fail closed" means: do not silently substitute an ambient identity, do not invent a missing digest, do not weaken a schema, do not mutate an incompatible/ambiguous state, and do not claim readiness from an intermediate state.

## 3. Authorities: one owner for each fact

| Authority | Owns | Must not be replaced by |
| --- | --- | --- |
| Release deployment descriptor (`mottainai.deployment.v1`) | selected release/tag/source revision and the immutable identity graph for Routes 1-4 | compiled release identities, mutable tags, operator archaeology |
| Standalone `mottainai-init` | Route 4 host discovery/provisioning/reconciliation and Route 3 orchestration intent | Node/npm/Nix scripts on the fresh host |
| Route 4 provider profile | exact supported Lima/QEMU prerequisite identities and compatibility requirements | ambient `PATH`, unrecorded distro packages |
| Lima | VM lifecycle, QEMU command construction/device topology, provider SSH transport | Mottainai-owned QMP/direct-QEMU production lifecycle |
| QEMU provider artifacts | external system/image/data bytes required by the selected Lima profile | whichever QEMU happens to resolve first on the host |
| Runtime Appliance OCI + `mottainai.linux-runtime-appliance.v1` manifest | exact provider-independent bootstrap-only guest disk bytes/provenance | a Lima-specific guest build or mutable OCI tag |
| `mottainai.linux-runtime.v1` guest health | live bootstrap/managed Runtime readiness | Lima `Running`, SSH success, or `--version` alone |
| `mottainai.managed-package-manifest.v1` | desired managed application package state | currently installed binaries or ambient guest `PATH` |
| `mottainai.managed-generation.v1` | realized Nix generation identity/store outputs | a workflow-specific identity formula |
| Route 1 canonical payload identity | exact packed Mottainai application tarball consumed by Route 2 | a second independently defined application build |
| `mottainai-bootstrap` / managed-runtime state machine | guest build/activation/rollback transaction | host-side reimplementation of Nix generation switching |

## 4. Durable state registry

Later operations may consume a state record only if the earlier producing operation is identified here and the record still verifies.

### Host-side managed state

Default root: `$XDG_STATE_HOME/mottainai/host-bootstrap/`, otherwise `$HOME/.local/state/mottainai/host-bootstrap/`.

| State | Producer | Consumers | Required meaning |
| --- | --- | --- | --- |
| `bootstrap.lock` | R4-08 / R3-02 | every host-side mutating operation | one non-blocking writer boundary for provider/QEMU/Appliance/Runtime state |
| `state.json` | R4-10 | R4-10, R4-14, `runtime ensure` | exact managed Lima artifact/materialization identity |
| `cache/<artifact>.tar.gz` | R4-10 | provider re-verification/recovery | verified immutable Lima archive bytes |
| `providers/<artifact>/` + `active` | R4-10 | all `SystemLimaCli` operations | exact managed Lima executable selected by Route 4 |
| `qemu.json` | R4-12 | R4-12, R4-13, `runtime ensure` | exact QEMU system/image/data provenance accepted for this host/profile |
| `qemu/<version>/bin` + `share/qemu` | R4-12 | Lima child environment | one coherent verified QEMU executable + firmware/data closure |
| `lima-home/` | R4-14 | Lima lifecycle/SSH transport | isolated Lima home; no implicit use of the user's normal Lima state |
| `lima-home/_config/user(.pub)` | R4-14 | R3-06, Lima SSH transport | single Lima control key authority for the managed instance |
| `appliances/<digest>/...` | R3-05 | R3-08 onward | verified raw canonical Runtime Appliance materialized from exact OCI digest |
| `runtime/<instance>/lima.yaml` | R3-08 | R3-09 onward | exact product intent rendered for Lima |
| `runtime/<instance>/state.json` | R3-08/R3-10 | R3-09 onward | managed instance provenance/config identity; ambient instances are not adopted |
| `MTNAI_BOOT` carrier state | R3-06/R3-07 | R3-08/R3-12 | exact validated public key carrier attached to the canonical guest; **gap #840** |

### Guest persistent control state

| State | Producer | Consumers | Required meaning |
| --- | --- | --- | --- |
| `mottainai-control` `~/.ssh/authorized_keys` | R3-12 first boot | subsequent provider SSH sessions | first accepted `MTNAI_BOOT` key persisted before `sshd`; key drift must not be silently repaired |
| `/var/lib/mottainai-control/managed-packages/manifest.json` | R3-15 / R2-01 | managed reconcile/build | canonical desired package manifest |
| `/var/lib/mottainai-control/managed-runtime/state.json` | R2-06/R2-07 | health/status/reconcile | canonical desired/active/transaction state |
| managed Runtime `current` pointer | R2-06 | R2-07, guest health, Route 1 execution | active Nix generation store path that must agree with persisted active identity |

## 5. End-to-end sequence at a glance

```text
selected exact release
  |
  | R4-01..R4-05: verify descriptor/bootstrap and derive provider intent
  v
supported host profile
  |
  | R4-06..R4-14: validate host, materialize/verify Lima+QEMU, bind isolated provider
  v
verified Route 4 provider handoff
  |
  | R3-01..R3-08: resolve canonical Appliance + credential carrier + Lima config
  v
managed Lima instance
  |
  | R3-09..R3-13: create/start/SSH and prove canonical bootstrap health
  v
bootstrap-ready canonical NixOS guest
  |
  | R3-14/R3-15 delegates desired state to guest authority
  v
Route 2
  |
  | R2-01..R2-08: validate, build, verify, activate, health/rollback generation
  v
exact healthy active generation
  |
  | R1-01..R1-04: prove payload identity and representative CLI/MCP behavior
  v
managed-runtime-ready + functional Mottainai
  |
  | R3-16 / R4-15: aggregate bounded evidence; unchanged rerun must be no-op
  v
#261 external real Linux/KVM certification
```

## 6. Route 4 operation ledger — selected release to verified provider handoff

| ID | Trigger / purpose | Owner and input authority | Action / state mutation | Success evidence and next handoff | Fail closed / recovery | Current implementation / proof | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **R4-01 Select release** | Operator chooses one exact release; prevent mutable/latest ambiguity. | Release surface; tag is a locator, descriptor is identity graph. | Acquire the release descriptor and its detached SHA-256 sidecar. No managed state mutation. | Exact descriptor bytes and sidecar are available. -> R4-02. | Missing descriptor/sidecar stops the chain. | Release workflow publishes `mottainai-deployment-v1.json` + sidecar. | implemented |
| **R4-02 Verify descriptor bytes** | Before parsing any artifact locator/identity. | Detached descriptor SHA-256. | Bound-read descriptor; hash exact bytes; compare sidecar. | Content identity proven. -> R4-03. | Mismatch, malformed/oversized sidecar/document => `deployment_descriptor_invalid`. | `read_verified_descriptor_bytes`. | implemented |
| **R4-03 Verify descriptor compatibility** | After byte identity, before interpreting semantics. | Consumer-supported contract/profile/architecture policy; descriptor `contractId/schemaVersion/profile/architecture`. | Require supported deployment contract and profile. No mutation. | Semantic compatibility proven. -> R4-04. | Authentic but unsupported future schema/profile must fail. | Rust consumer currently reads only a subset. **#843**. | **gap** |
| **R4-04 Verify standalone bootstrap identity** | Before executing downloaded host bootstrap. | Release asset sidecar + descriptor `route4.mottainaiInit` identity. | Verify `mottainai-init-linux-x86_64` bytes before execution and bind evidence to selected release. | Exact host bootstrap executable selected. -> R4-05. | Never execute mismatched bytes. | Publish workflow/host-bootstrap docs provide sidecar verification; descriptor also records digest. | implemented/partially composed |
| **R4-05 Derive Route 4 provider requirements** | Before provider inspection/provisioning; avoid two release authorities. | Descriptor `route4.provider`. | Project supported Lima/QEMU/provisioning requirements from selected descriptor. | One exact provider requirement object exists. -> R4-06. | Unsupported profile or identity fails before mutation. | Runtime consumer currently drops `route4` and later uses compiled defaults. **#842**. QEMU data artifact absent from descriptor identity. **#847**. | **gap** |
| **R4-06 Validate host profile** | Before downloads/mutation. | Route 4 compatibility profile + observed host. | Observe OS, architecture, kernel/KVM existence/type/current-user access. | Linux `x86_64`, usable `/dev/kvm`, required capability proven. -> R4-07. | No TCG fallback; unsupported/inaccessible KVM fails with bounded evidence. | Host probe / Route 4 bootstrap. | implemented; #261 real proof |
| **R4-07 Validate all host-side provider prerequisites** | Before Lima can discover them late. | Selected provider contract. | Validate or provision every external host facility consumed by selected Lima profile, including host OpenSSH tooling if it remains a precondition. | Provider prerequisites are complete and explicit. -> R4-08. | Missing undeclared ambient dependency must not surface only after VM creation. | Lima 2.2.0 resolves host `ssh`/`ssh-keygen`; Route 4 does not currently close/declare it. **#846**. | **gap** |
| **R4-08 Acquire writer authority** | Immediately before host managed-state mutation. | Managed state root ownership/mode + `bootstrap.lock`. | Create/validate state root as allowed; acquire one non-blocking lock. | Writer authority held for complete mutation transaction. -> R4-09. | Unsafe permissions or lock contention fails; never mutate first and lock later. | `ensure_managed_root` + `BootstrapLock`. | implemented |
| **R4-09 Inspect provider state** | Each bootstrap/reconcile. | R4-05 provider requirement + managed provider/QEMU state. | Inspect managed Lima/QEMU state, cache/staging, active links; classify missing/satisfied/repairable/incompatible/ambiguous. | Deterministic plan selected. -> R4-10/R4-11. | Ambient Lima/QEMU is not silently canonical. | `inspect_provider`, `inspect_qemu`. Current inspection still uses compiled provider authority in downstream runtime path: #842. | partial |
| **R4-10 Materialize/verify Lima** | Missing/repairable exact provider. | Descriptor-selected Lima artifact identity. | Download to bounded `.part`, verify size/digest, extract only declared binary, verify executable/version, atomically promote provider/cache/active/state. | `state.json` proves exact active Lima. -> R4-11. | Corrupt/wrong version/arch/symlink/unsafe archive fails; interrupted staging is restart-safe. | Provider download/materialization. | implemented, but selected authority gap #842 |
| **R4-11 Materialize QEMU artifacts** | Missing/repairable QEMU closure. | Descriptor-selected QEMU system/image/data identities. | Download/verify system, image and firmware/data archives; safely extract into one managed closure. | Exact candidate closure materialized. -> R4-12. | No mixed installations; archive traversal/symlink/corruption fail. | QEMU implementation has three pinned artifacts; descriptor misses data identity: #847. | partial |
| **R4-12 Activate and re-verify complete QEMU closure** | After materialization and on every unchanged reconcile. | Accepted QEMU contract + activated bytes. | Verify executable ELF/version/digests and activated firmware/data closure; write/consume `qemu.json`. | Complete closure remains identical to accepted release/provider identity. -> R4-13. | Post-activation firmware replacement must be detected, not accepted by presence/non-empty checks. | Executables strongly verified; activated data re-verification **#826**. Release-level data binding **#847**. | **gap** |
| **R4-13 Bind Lima to verified QEMU** | Every `limactl` operation. | R4-10 active Lima + R4-12 verified QEMU. | Launch only managed `limactl`; controlled child env sets verified QEMU path/data and puts managed directories first. | Provider process cannot silently resolve another ambient QEMU. -> R4-14. | Identity/path construction failure blocks lifecycle. | `SystemLimaCli::run` sets `QEMU_SYSTEM_X86_64`, `QEMU_DATA_DIR`, controlled `PATH`. | implemented |
| **R4-14 Establish isolated Lima/SSH authority** | Before first managed instance creation. | Managed `LIMA_HOME`; selected SSH host-tool contract. | Use isolated `lima-home`; establish/persist the single Lima internal key authority needed by provider SSH. | Stable private/public key pair exists and later R3 credential delivery can bind the same public key. -> R3-01. | No `~/.ssh` key adoption; missing/drifted key with existing guest must fail closed, not silently rotate. | Isolated `LIMA_HOME` exists; OpenSSH prerequisite/key lifecycle incomplete **#846/#840**. | partial/gap |
| **R4-15 Route 4 provider handoff invariant** | Immediately before Route 3 mutation. | R4-05 requirement + R4-10/12/14 observed identities. | Assert selected release provider requirement equals managed Lima/QEMU/SSH provider state. No new authority is created here. | **Handoff invariant H4-3:** exact release-selected provider prerequisites are verified and reusable; only then Route 3 may create/start a VM. | Any provider/profile/key ambiguity blocks Route 3. | Final cross-check incomplete until #842/#847/#846. | **gap** |

### Route 4 current CLI spelling

Today the production surface is split into two invocations:

```text
mottainai-init [--json] [--state-directory ...]
    # provider/QEMU bootstrap

mottainai-init runtime ensure --descriptor mottainai-deployment-v1.json \
    [--sidecar ...] [--instance-name ...] [--json] [--state-directory ...]
    # Route 3+ convergence
```

This spelling is not itself an authority. In particular, the first invocation currently selects provider requirements from compiled defaults while the descriptor is consumed only by the second invocation. #842 owns closing that identity split. A future CLI may combine the operations without changing this operation order.

## 7. Route 3 operation ledger — verified provider to canonical guest and managed-runtime handoff

| ID | Trigger / purpose | Owner and input authority | Action / state mutation | Success evidence and next handoff | Fail closed / recovery | Current implementation / proof | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **R3-01 Project release Runtime intent** | `runtime ensure --descriptor` after descriptor verification. | Selected descriptor Route 3 Appliance + Route 2 managed generation. | Project immutable Appliance reference and desired managed-package manifest/generation identity into bounded Runtime intent. | One exact target instance/appliance/generation intent. -> R3-02. | Missing/wrong-typed required fields fail. | `runtime_spec_from_descriptor`; route2/3 projection exists, compatibility/provider projection gaps #842/#843. | partial |
| **R3-02 Acquire shared host writer lock and classify Runtime state** | Before Appliance/config/instance mutation. | Same `bootstrap.lock` and state root as Route 4. | Hold lock across Appliance resolution, config/state writes, and external Lima lifecycle mutation; inspect Runtime provenance. | One writer; existing state classified. -> R3-03. | Lock bound to another root, unsafe state, or concurrent writer fails. | `ensure_runtime_locked`. | implemented |
| **R3-03 Resolve Appliance by immutable OCI digest** | Target Appliance not already verified locally. | Descriptor `route3.appliance.digest` + registry/repository. | Fetch exact OCI manifest by digest, never accept mutable tag as identity. | Expected OCI manifest obtained. -> R3-04. | Digest/registry/manifest retrieval mismatch fails. | `HttpOciSource` / Appliance resolver. | implemented |
| **R3-04 Verify OCI artifact contract and layer identities** | Before decompression/use. | OCI descriptor + Appliance manifest/release metadata contract. | Verify artifact type, exact layer set/media types, compressed layer digest/size, release metadata lineage. | Transport bytes/provenance proven. -> R3-05. | Extra/missing/wrong type/digest/revision layers fail. | `runtime-appliance-oci` contract + Rust appliance resolver. | implemented |
| **R3-05 Materialize and verify canonical raw Appliance** | After transport verification. | `mottainai.linux-runtime-appliance.v1` raw SHA/size. | Decompress raw disk under `appliances/<digest>`; verify exact raw size/SHA; persist provenance atomically. | Canonical provider-independent boot disk ready. -> R3-06. | Partial/corrupt materialization never becomes active. | `ensure_appliance`; real byte-equality proof on trusted main exists. | implemented |
| **R3-06 Build MTNAI_BOOT credential carrier** | Before first instance create. | R4-14 managed Lima public key; guest MTNAI_BOOT contract. | Validate exact public key set; create small credential-only filesystem labeled `MTNAI_BOOT` containing exactly `authorized_keys`. | Carrier bytes/identity are known. -> R3-07. | Never use ambient `~/.ssh`; malformed/oversized keys fail; key rotation with an existing guest must be explicit. | Production carrier is missing. **#840**. | **gap** |
| **R3-07 Import/verify carrier through Lima public disk API** | Carrier exists, before YAML/create. | R3-06 carrier bytes + managed Lima. | Use supported Lima disk management (`limactl disk import <name> <raw>` for imported raw bytes), then verify imported disk exists/is the intended identity before referencing it. | Lima-managed additional disk is available by name. -> R3-08. | Do not treat command exit alone as proof; Lima 2.2.0 `disk import` has an upstream copy-error path that can return success. | Must be implemented as part of #840; direct host-path `additionalDisks` is not the Lima contract. | **gap #840** |
| **R3-08 Render exact Lima configuration and provenance** | All immutable Runtime inputs ready. | R3-05 disk, R3-07 credential disk, bounded CPU/memory/mount intent, R4 provider binding. | Render `vmType: qemu`, canonical raw `images` entry/digest, explicit mounts only, `ssh.loadDotSSHPubKeys: false`, `additionalDisks` credential name; persist config + identity before create. | Config/provenance fully describes the instance product intent. -> R3-09. | Broad HOME/workspace mounts, ambient SSH credentials, or untracked credential/provider identity are forbidden. | Current config omits credential disk (#840); provenance must include credential identity when added. | partial/gap |
| **R3-09 Classify existing Lima instance** | Before create/start on every ensure. | Lima public `list --all-fields --format json` + managed runtime state/config identity. | Classify missing, running-compatible, stopped-compatible, incompatible, ambiguous; never adopt same-name ambient instance without provenance. | Deterministic lifecycle action chosen. -> R3-10/R3-11/R3-13. | Unsupported status, wrong vmType/config/appliance/provenance fails. | `LimaCli::list_all` and Runtime state reconciliation. | implemented; credential/provider identity must join comparison after gaps close |
| **R3-10 Create missing canonical instance** | Classification `missing`. | R3-08 exact config. | Invoke public `limactl create` for managed instance in **plain mode**, preserving Lima VM/QEMU topology ownership. | Instance exists with exact managed provenance. -> R3-11. | No cloud-init guest fork or direct QEMU lifecycle. | Production create currently omits `--plain`. **#841**. | **gap** |
| **R3-11 Start or preserve instance lifecycle** | Newly created or stopped-compatible; running-compatible is no-op. | Lima public lifecycle. | `limactl start` only when needed; never recreate compatible stopped/running instance solely to converge. | Provider lifecycle reaches running/SSH phase. -> R3-12. | Broken/ambiguous state fails instead of destructive recreation. | `SystemLimaCli::start`. Timeout diagnostic loses provider output: **#845**. | implemented + diagnostic gap |
| **R3-12 Establish provider SSH to `mottainai-control`** | VM running and sshd available. | Same key authority from R4-14/R3-06; Lima SSH transport. | Lima connects to guest over bounded forwarded SSH, using managed internal private key whose public half was delivered by MTNAI_BOOT. | Guest command transport works. -> R3-13. | `Permission denied`, key drift, missing host SSH tool fail with actionable bounded evidence; never broaden credentials. | Structurally blocked by #840; host prerequisite #846; timeout diagnostics #845. | **gap** |
| **R3-13 Prove canonical bootstrap health** | SSH transport works. | Guest `mottainai-runtime-health` (`mottainai.linux-runtime.v1`). | Execute canonical health command and validate bounded schema; require `bootstrapReady=true`. | Canonical base Appliance/control/bootstrap substrate is ready. -> R3-14. | Lima `Running`, login prompt, SSH success, or malformed health cannot substitute. | Production health boundary implemented in `lima.rs`. | implemented but unreachable on real Lima until #840/#841 |
| **R3-14 Determine managed-generation action** | Bootstrap-ready guest and descriptor requests managed generation. | Descriptor expected generation identity + guest canonical managed status. | Read canonical managed status. If exact expected generation is already healthy/active, skip mutation; otherwise prepare desired reconciliation. | Exact-active -> R3-16; otherwise -> R3-15/R2-01. | Different healthy generation is not accepted as desired. | `converge_managed_generation`. | implemented hermetically |
| **R3-15 Delegate desired state to guest reconcile authority** | Exact desired generation not active. | Descriptor-derived managed package manifest + expected generation identity. | Write canonical manifest to guest control state and invoke packaged `mottainai-bootstrap reconcile --system x86_64-linux --json`. Host stops making build/switch decisions here. | Control transfers to Route 2/managed-runtime state machine. -> R2-01. | Host must not implement a second Nix package/generation manager. | Production transport path implemented. | implemented hermetically |
| **R3-16 Verify final managed Runtime and emit Route 3 evidence** | Route 2 returns success or exact generation was already active. | Guest health/status + expected generation identity + Route 1 functional evidence. | Re-run canonical health; require exact active identity, `managedRuntimeReady=true`, then bounded packaged functional smoke. | **Handoff/final invariant:** intended generation is healthy and functional. Return bounded evidence to Route 4/caller. | `bootstrapReady` alone, wrong generation, or functional smoke failure cannot pass. | Current code checks managed readiness + CLI/MCP smoke; trusted-main production Lima composition missing **#844**; #261 collects final real-host proof. | partial proof gap |

## 8. Route 2 operation ledger — guest desired state to healthy active Nix generation

R3-15 invokes these operations but does not own them. Route 2/managed-runtime code executes inside the canonical guest.

| ID | Trigger / purpose | Owner and input authority | Action / state mutation | Success evidence and next handoff | Fail closed / recovery | Current implementation / proof | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **R2-01 Parse desired manifest and compatibility** | Guest `mottainai-bootstrap reconcile` receives persisted manifest. | `mottainai.managed-package-manifest.v1` contract. | Strict-parse contract/schema/package IDs/kinds/source hashes; enforce Runtime compatibility before build. | Bounded projectable desired state. -> R2-02. | Unknown/extra/malformed/unsupported fields or incompatible Runtime fail before build. | Managed-package parser + bootstrap reconcile. | implemented |
| **R2-02 Resolve exact package sources** | Valid desired state needs build inputs. | Manifest `(packageId, version, flakeRef, sourceSha256)`; release-owned Mottainai source recipe. | Resolve exact source objects; Mottainai source uses that release source tree's own `nix#mottainai` recipe; Nawabari/Zellij use declared recipes. | Concrete package derivations/source store paths. -> R2-03. | Ambient installed package or HEAD recipe applied to foreign release is not authority. | `managed-generation-build.ts`, source resolution. | implemented |
| **R2-03 Produce/consume the canonical Mottainai application payload** | Mottainai package derivation is evaluated. | Route 1 canonical pack surface and exact release source. | In release construction, consume the already-packed canonical Route 1 tarball. In a source-only local/guest build, the release-owned Nix recipe may lazily generate that same canonical pack surface; resulting Nix output must still satisfy the expected generation identity. | Mottainai package output contains `share/mottainai/canonical-payload.json` and exact application bytes. -> R2-04. | A changed payload hash changes/fails the package/generation output; Route 2 must not silently install a different package body. | `nix/mottainai.nix`; release round-trip gate proves canonical release composition. | implemented; final explicit evidence belongs R1-01/#261 |
| **R2-04 Build complete managed Runtime generation** | Resolved package derivations available. | Managed manifest + fixed Route 2 dependency catalog. | Build generation containing managed app packages plus declared lower-level runtime dependencies (Node/native runtime, `git`, `rg`, etc.). | Nix output/store metadata generated. -> R2-05. | Host/guest ambient `PATH` is not a substitute for required closure entries. | `nix/managed-generation.nix`. | implemented |
| **R2-05 Verify realized identities** | Nix build produced metadata. | Manifest + realized metadata/source store paths. | Verify declared source NAR hashes, resolved versions and canonical `generationIdentityOf()` over semantic manifest + realized output store paths; compare with selected expected generation identity. | Exact expected generation artifact proven. -> R2-06. | Source/version/generation mismatch fails before activation. | `managed-generation.ts` / `managed-generation-build.ts`; release identity fixes #823/#824/#837 already landed. | implemented |
| **R2-06 Begin transactional activation** | Exact built candidate ready. | Managed-runtime state machine. | Persist candidate/transaction phase; switch managed `current` pointer only through canonical activation boundary. | Candidate becomes observable active state or transaction remains recoverable. -> R2-07. | Interrupted mutation must be resumable/diagnosable; never claim active from pointer alone. | `reconcileManagedRuntime` / runtime state contract. | implemented |
| **R2-07 Health candidate and rollback on failure** | Candidate activated. | Canonical health + persisted previous healthy generation. | Run generation health; on failure restore most recent valid healthy target according to rollback policy; persist failure/desired divergence truthfully. | Healthy exact generation active, or deterministic rollback with repairable desired/active divergence. -> R2-08. | Unhealthy candidate never becomes successful final state. | Managed Runtime reconciliation/rollback. | implemented |
| **R2-08 Report active generation to Route 3** | Activation transaction idle. | Canonical managed-status + `current` pointer + active record. | Report observed active identity/store path; guest health projects `managedRuntimeReady` only when pointer/record/phase agree. | Exact expected identity returned to R3-16. | In-flight/missing/mismatched pointer fails readiness. | `managed-status`, managed-runtime-health projection. | implemented |

## 9. Route 1 operation ledger — exact application payload to functional Mottainai

Route 1 is not "npm was installable somewhere". At this point it is the exact canonical application payload inside the active Route 2 generation.

| ID | Trigger / purpose | Owner and input authority | Action / state mutation | Success evidence and next handoff | Fail closed / recovery | Current implementation / proof | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **R1-01 Prove active canonical payload identity** | R2 exact generation is active. | Descriptor `route1.payload.sha256`, Route 2 package's `share/mottainai/canonical-payload.json`, generation identity. | Observe the active Mottainai package's canonical payload identity and bind it to the selected release evidence. | Exact Route 1 payload identity proven. -> R1-02. | Version alone is insufficient; wrong payload digest must fail. | Release/Route 2 build embeds payload evidence and expected generation transitively binds output; #261 requires explicit final evidence. | implemented identity mechanism; explicit external evidence at #261 |
| **R1-02 CLI identity probe** | Exact payload active. | Packaged `mottainai` entrypoint. | Run bounded `mottainai --version` as identity/entrypoint sanity check. | Expected release version. -> R1-03. | Never call this functional readiness by itself. | Route 3 functional smoke / Route 2 closure checks. | implemented |
| **R1-03 Representative CLI/runtime operation** | CLI entrypoint available. | Route 2 closure dependencies. | Execute representative Mottainai behavior that requires declared runtime tooling (the Route 2 closure proof uses real search with `rg`). | Application behavior works without ambient host dependency leakage. -> R1-04. | Missing declared dependency must fail, not fall back silently. | `route2-runtime-closure` proof; real deployed functional evidence is part of #261. | implemented proof, external final certification |
| **R1-04 MCP protocol readiness** | Active package/closure functional. | Packaged `mottainai-mcp`. | Start stdio entrypoint and complete bounded MCP initialization/request smoke. | **Final application invariant H2-1:** exact selected Route 1 payload is usable inside exact healthy Route 2 generation. -> R3-16/R4 final evidence. | Process start alone is insufficient; protocol failure fails final readiness. | Route 2 closure + Route 3 functional smoke; #261 final real-host evidence. | implemented proof, external final certification |

## 10. Mandatory handoff invariants

These are the highest-value review points. No route may proceed merely because the component immediately before it returned exit code 0.

### H4-3 — Route 4 -> Route 3

Before VM creation:

- selected descriptor compatibility is proven;
- exact release-selected provider profile is known;
- managed Lima identity matches it;
- complete QEMU system/image/data closure matches it and still verifies;
- KVM capability is usable;
- all selected provider host prerequisites are explicit;
- isolated Lima/SSH authority is stable;
- Lima will actually execute against the verified QEMU closure.

Current gaps: #826, #842, #843, #846, #847.

### H3-B — Route 3 provider -> canonical guest bootstrap

Before guest reconciliation:

- exact canonical Appliance OCI/raw identity is verified;
- `MTNAI_BOOT` contains the exact managed Lima public key and is attached through Lima's supported public disk contract;
- production instance creation uses the provider mode appropriate for the provider-independent Appliance (plain mode);
- provider SSH reaches `mottainai-control` without ambient key adoption;
- `mottainai-runtime-health` reports `bootstrapReady=true`.

Current gaps: #840, #841, #845, #846. Trusted-main proof gap: #844.

### H3-2 — Route 3 -> Route 2

Before managed generation build/activation:

- desired manifest is derived from the selected descriptor;
- expected generation identity is the descriptor's canonical managed-generation identity;
- guest Runtime compatibility is proven;
- host orchestration delegates build/switch/rollback to `mottainai-bootstrap` rather than reimplementing it.

Current release producer/consumer identity defects #823/#824 were fixed and production round-trip gate #837 is merged; #843 still governs descriptor consumer compatibility.

### H2-1 — Route 2 -> Route 1

Before declaring application readiness:

- exact expected managed generation identity is active and healthy;
- the active Mottainai package is produced from the canonical Route 1 pack surface and its payload identity is tied to the selected release;
- declared Route 2 runtime dependencies are resolved from the generation, not ambient host/guest PATH;
- representative CLI behavior and packaged MCP protocol behavior succeed.

Final explicit active payload evidence is required by #261 even though the expected generation identity transitively binds the realized Mottainai package output.

## 11. Reconciliation and failure operation book

The happy path is insufficient. Every rerun/restart/interruption must select one deterministic branch.

| ID | Situation | Required operation | Forbidden behavior | Evidence / owner |
| --- | --- | --- | --- | --- |
| **L-01 Unchanged full rerun** | Same release/provider/Appliance/config/key/generation already current. | Re-verify immutable/provenance state; perform no download/build/create/start/switch except bounded observation. | Recreate VM, rotate keys, rebuild generation, redownload verified artifacts without cause. | Route 4/3 evidence `changed=false`; #261 repeats full ensure. |
| **L-02 Stopped compatible instance** | Managed provenance matches, Lima status `Stopped`. | Start same instance, re-establish SSH, recheck health/generation. | Delete/recreate merely because stopped. | Route 3 reconciliation tests + #261. |
| **L-03 Running compatible instance** | Provenance matches, status `Running`. | Do not call create/start; recheck canonical guest health and exact generation. | Treat Lima Running as final health. | Route 3 evidence. |
| **L-04 Interrupted provider/QEMU provisioning** | `.part`/staging/incomplete managed state exists. | Classify repairable; discard/rebuild only bounded managed staging; promote only after verification. | Adopt partial artifacts. | Route 4 state machine. |
| **L-05 Interrupted Appliance materialization** | Partial compressed/raw state. | Never expose as verified `appliances/<digest>`; resume/recreate from immutable OCI source. | Boot partial disk. | Appliance state/provenance. |
| **L-06 Interrupted generation activation** | Managed runtime transaction phase non-idle. | Canonical state machine recovers or fails closed; health remains not managed-ready until pointer/state agree. | Accept `current` pointer alone. | Managed-runtime state/health. |
| **L-07 Candidate generation unhealthy** | Build succeeded, health failed. | Roll back to most recent recorded healthy generation; retain desired/active divergence as repairable truth. | Mark candidate active/healthy or erase attempted desired identity. | Managed runtime rollback evidence. |
| **L-08 Provider/config/Appliance drift** | Existing instance/state differs from selected requirement. | Classify incompatible/ambiguous and stop for explicit resolution. | Silent destructive recreation/adoption. | Route 3 state + Lima observation. |
| **L-09 SSH key drift/loss** | Existing guest persists key A; host managed Lima key is missing/changed to B. | Fail closed with explicit credential-state diagnostic and defined recovery procedure. | Silently generate B and loop on public-key failure; broaden to `~/.ssh`. | Gap jointly exposed by #840/#846; operation must be fixed before #261. |
| **L-10 Host restart** | Same managed state root survives, processes stopped. | Re-open/verify provider/QEMU/key state, reconcile same instance, recheck active generation. | Treat restart as a new unidentified installation. | #261 restart/reconnect evidence. |
| **L-11 Unsupported/ambiguous host** | Wrong OS/arch, KVM unavailable, unsafe permissions, multiple ambiguous providers. | Return bounded deterministic unsupported/ambiguous result before unsafe mutation. | TCG fallback, implicit sudo, guessing. | Route 4 host/provider classification. |
| **L-12 External command timeout** | Lima/QEMU/provider command exceeds bound. | Terminate/reap deterministically; retain bounded actionable provider output. | Return only a generic timeout after discarding captured root cause. | **#845**. |

## 12. Proof tiers: which layer proves which operation

No one test substitutes for all boundaries.

| Proof tier | Required role | Must cover | Must not claim |
| --- | --- | --- | --- |
| PR merge integrity | reject local contract defects cheaply | unit/schema/state-machine tests, Rust host-bootstrap tests, Nix generation/runtime checks selected by true ownership | real host/provider support |
| Trusted `main` canonical integration | prove affected canonical components compose | real canonical Appliance + production artifact resolution and, for the Route 4/3 boundary, production Lima configuration/lifecycle/SSH handoff | external fresh-host support if hosted environment cannot establish it |
| Release certification/publication | prove exact tagged release identities | canonical Route 1 payload, Route 2 generation/source identity, Appliance publication, init artifact, deployment descriptor and producer->consumer round-trip | future mutable tag identity |
| #261 external real-host certification | prove actual supported environment | published standalone init -> exact descriptor/provider -> real Linux/KVM/Lima/QEMU -> canonical Appliance -> managed generation -> exact Route 1 payload -> functional CLI/MCP; unchanged rerun/restart evidence | a replacement for repository CI |

Current trusted-main composition proves real Appliance OCI/materialization and a direct-QEMU golden path but skips the production Lima adapter connection; **#844** owns closing that proof gap.

## 13. Known gap map

| Issue | Affected operation(s) | Why it blocks a complete chain |
| --- | --- | --- |
| **#826** verify activated QEMU data closure | R4-12, H4-3 | downloaded data identity is not enough if activated firmware can drift later |
| **#840** attach MTNAI_BOOT SSH key disk | R3-06, R3-07, R3-08, R3-12, H3-B | canonical guest has no operator key without the bounded carrier |
| **#841** create canonical Appliance in Lima plain mode | R3-10, R3-11, H3-B | after SSH works, normal Lima waits for cloud-init-owned `/run/lima-ssh-ready` the canonical guest does not produce |
| **#842** consume Route 4 provider profile | R4-05, R4-09, R4-15, H4-3 | selected release provider identity is currently dropped and replaced by compiled defaults |
| **#843** descriptor compatibility fail-closed | R4-03, R3-01 | authentic bytes do not prove this binary understands a future schema/profile |
| **#844** trusted-main production Lima composition | proof of R3-06..R3-13 | current "full composition" can stay green while the production Lima connection is broken |
| **#845** preserve Lima timeout diagnostics | R3-11/R3-12, L-12 | provider root cause is captured then discarded, making failures non-actionable |
| **#846** close implicit OpenSSH dependency | R4-07, R4-14, R3-12, L-09 | selected Lima provider consumes host `ssh`/`ssh-keygen` outside the declared fresh-host contract |
| **#847** bind QEMU data artifact into deployment identity | R4-05, R4-11/R4-12, H4-3 | release descriptor cannot identify the complete required QEMU closure |
| **#261** final real Linux/KVM certification | all handoffs | only final external boundary can publish support evidence for the complete real provider chain |

## 14. Review checklist for any deployment change

A deployment PR is incomplete until reviewers can answer all applicable questions:

1. Which operation ID does this change modify?
2. Does it change an input authority or only consume an existing one?
3. Is a second identity/validation algorithm being introduced?
4. What durable state does it write, and which later operation consumes that state?
5. Is the state part of the idempotency comparison?
6. What happens to an existing already-created instance/generation after the change?
7. Which exact failure becomes `missing`, `repairable`, `incompatible`, `ambiguous`, or `unsupported`?
8. Does a timeout retain enough bounded evidence to identify the failed operation?
9. Is an ambient `PATH`, HOME, SSH credential, mutable tag, or provider default being silently adopted?
10. Which PR proof rejects a local defect?
11. Which trusted-main/release proof verifies the producer/consumer handoff?
12. Does #261 need to be rerun before a support claim changes?

If any answer is unknown, the change has uncovered an operation-book gap. File a focused Issue at the owning operation before declaring the chain complete.

## 15. Canonical completion condition

The strongest local deployment is complete only when all of the following are simultaneously true:

```text
selected descriptor bytes/compatibility verified
AND exact standalone init identity verified
AND selected Route 4 provider profile == verified managed Lima/QEMU/data/SSH provider state
AND KVM/profile prerequisites proven
AND exact canonical Appliance OCI/raw identity materialized
AND exact managed SSH public key delivered through MTNAI_BOOT
AND Lima created/reconciled the provider-independent guest through the supported plain provider mode
AND provider SSH reaches mottainai-control
AND guest reports bootstrapReady=true
AND descriptor-requested managed generation is the exact healthy active generation
AND Route 2 closure contains its declared runtime dependencies
AND active Mottainai package is tied to the descriptor's canonical Route 1 payload identity
AND representative packaged CLI behavior succeeds
AND packaged MCP protocol smoke succeeds
AND guest reports managedRuntimeReady=true for that exact generation
```

Route 4 success is therefore Route 3 success; Route 3 success includes Route 2 success; Route 2 success includes the exact functional Route 1 payload. Materialization, boot, SSH, `Running`, and `--version` are intermediate evidence only.

## 16. External certification boundary

After repository-level gaps above are closed, [Issue #261](https://github.com/yohn-jp/mottainai/issues/261) reruns this exact operation order on one fresh real Linux `x86_64` host with usable KVM, using the **published** standalone bootstrap and selected release artifacts. Evidence should cite operation IDs and record the authority/result at every handoff instead of presenting one undifferentiated end-to-end pass/fail.

A defect discovered during #261 is fixed at its owning operation, receives focused regression coverage at the cheapest sufficient proof tier, and then the affected sequence plus #261 is rerun. The certification Issue is not a substitute for fixing a missing operation or connection in the product.
