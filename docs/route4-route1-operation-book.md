# Route 4 → Route 1 operation book

This document is the chronological execution authority for the canonical Mottainai deployment and convergence chain established by ADR-0003.

It answers a stricter question than the route architecture documents: **what happens next, who owns that operation, which identity authorizes it, what state changes, what proves success, and what exact condition permits the next handoff?**

The route model remains cumulative:

```text
Route 4: standalone Rust mottainai-init
  -> establish and verify the supported host/provider boundary
Route 3: Lima-managed canonical NixOS Runtime Appliance
  -> establish guest transport and reconcile the intended managed generation
Route 2: exact Nix managed application/runtime closure
  -> consume the canonical Route 1 payload and declared runtime dependencies
Route 1: canonical npm application payload
  -> functional Mottainai CLI/MCP
```

The route number identifies **ownership**, not a requirement that operations appear in four uninterrupted blocks. Chronologically, Route 3 asks the guest to reconcile Route 2, Route 2 realizes Route 1, and Route 3 then verifies that the resulting generation is active and healthy.

## Status vocabulary

Each operation is marked with one of these states:

- **Implemented** — the production path exists on `main` and the described handoff is represented in current code.
- **Partial** — part of the operation exists, but an open defect prevents the complete handoff from being authoritative or fully proven.
- **Target** — this is the normative operation required by the architecture, but current production behavior is blocked by a linked Issue.

Open defects are not normalized into the documentation as accepted behavior. They are shown as gaps.

## Authority map

| Authority | Owns | Must not become |
| --- | --- | --- |
| Selected immutable deployment descriptor | Release identity graph across Routes 1–4 | A mutable `latest` catalog or advisory metadata |
| `mottainai-init` / host-bootstrap | Host capability inspection, managed provider/tool acquisition, verification, host-side orchestration state | A VM/QEMU lifecycle or device-topology engine |
| Lima | VM creation/start/stop/provider transport/QEMU command construction/device attachment | Release/package identity authority |
| QEMU contract/profile | Exact external system/image/data artifacts used by Lima | An independently guessed runtime selected from ambient PATH |
| Canonical NixOS Runtime Appliance | Provider-independent guest/bootstrap/health semantics | A Lima-specific guest fork |
| `mottainai-bootstrap` + managed-runtime state machine | Desired manifest reconciliation, Nix build, activation, rollback, active generation state | Host/provider lifecycle authority |
| `generationIdentityOf()` | Canonical managed-generation semantic identity | A workflow-local identity formula |
| Canonical Route 1 payload | Exact packed Mottainai application bytes consumed by Route 2 | A version-only or source-only substitute |

## Compact chronological sequence

| Step | Operation | Owner | Handoff proof | Current state |
| --- | --- | --- | --- | --- |
| R4-01 | Select release descriptor + sidecar | Operator/release consumer | Exact descriptor bytes identified | Implemented |
| R4-02 | Verify descriptor bytes and compatibility envelope | `mottainai-init` | SHA-256 + supported contract/profile | Partial — #843 |
| R4-03 | Inspect host OS/arch/KVM and declared host prerequisites | `mottainai-init` | Supported host capability evidence | Partial — #846 |
| R4-04 | Derive exact Route 4 provider requirement from descriptor | `mottainai-init` | Selected provider profile | Target — #842/#847 |
| R4-05 | Acquire writer authority over managed host state | `mottainai-init` | `bootstrap.lock` held | Implemented |
| R4-06 | Acquire/verify/materialize Lima | host-bootstrap | Managed Lima identity | Implemented |
| R4-07 | Acquire/verify/materialize QEMU system/image/data closure | host-bootstrap | Complete verified QEMU closure | Partial — #826/#847 |
| R4-08 | Bind Lima subprocesses to the verified QEMU closure | host-bootstrap → Lima | Controlled env/path binding | Implemented |
| R4-09 | Establish isolated Lima home and SSH/key authority | Lima + host-bootstrap | Stable provider credential authority | Partial — #840/#846 |
| R3-01 | Resolve canonical Appliance by immutable OCI identity | host-bootstrap | OCI manifest/layer contract verified | Implemented |
| R3-02 | Materialize and verify canonical raw Appliance disk | host-bootstrap | Raw SHA/size/provenance verified | Implemented |
| R3-03 | Create/import/attach `MTNAI_BOOT` credential carrier | host-bootstrap → Lima | Guest-consumable validated key disk | Target — #840 |
| R3-04 | Render canonical Lima configuration | host-bootstrap | Exact YAML/config identity | Partial — #841 |
| R3-05 | Classify existing Lima instance/provenance | host-bootstrap | missing/satisfied/stopped/incompatible/ambiguous | Implemented; credential identity extends under #840 |
| R3-06 | Create/start/reconcile instance through public Lima API | Lima | Instance reaches provider transport boundary | Partial — #840/#841 |
| R3-07 | Establish SSH transport to `mottainai-control` | Lima | bounded command transport succeeds | Target — #840/#841/#846 |
| R3-08 | Read canonical bootstrap health | guest Runtime | `bootstrapReady=true` in supported Runtime contract | Implemented once transport exists |
| R3-09 | Project desired managed manifest/generation from selected release | host-bootstrap | Exact desired generation intent | Partial — #850 |
| R3-10 | Deliver desired state and invoke guest reconcile | host-bootstrap → guest | canonical manifest accepted | Implemented |
| R2-01 | Resolve exact package sources/recipes | guest `mottainai-bootstrap` | source/version recipe identities | Implemented |
| R1-01 | Obtain and verify selected canonical Route 1 payload | Route 2 package build | exact tarball SHA-256 | Target in live path — #850 |
| R2-02 | Build Mottainai package + managed runtime dependency closure | Nix | realized package/store paths | Partial — #850 for Mottainai payload handoff |
| R2-03 | Verify source NAR identities and resolved versions | managed-generation authority | all requested identities match realized inputs | Implemented |
| R2-04 | Derive canonical generation identity | `generationIdentityOf()` | exact desired generation identity | Implemented; live reproduction blocked by #850 |
| R3-11 | Activate candidate or roll back | guest managed-runtime authority | durable active/current transaction state | Implemented |
| R3-12 | Re-read health and exact active generation | guest + host-bootstrap | `managedRuntimeReady=true` for intended identity | Implemented once preceding gaps are closed |
| R1-02 | Verify active Mottainai package is bound to selected payload | guest/Route 2 evidence | payload SHA equals descriptor Route 1 SHA | Target — #850 |
| R1-03 | Execute packaged CLI functional smoke | host-bootstrap via guest | CLI succeeds from active generation | Implemented |
| R1-04 | Execute packaged MCP protocol smoke | host-bootstrap via guest | bounded MCP `initialize` succeeds | Implemented |
| E2E-01 | Emit complete convergence evidence | `mottainai-init` | selected/observed identities + readiness | Partial — linked gaps |
| E2E-02 | Re-run unchanged desired state | all owners | no mutation apart from verification | Implemented component-wise; #261 certifies complete chain |
| E2E-03 | Restart/reconnect continuity | all owners | same provider/runtime/generation/credential identities | Partial until #840/#846/#261 |
| E2E-04 | Real Linux/KVM certification | #261 | complete external evidence | Pending #261 |

---

# Detailed operations

## R4-01 — Select the immutable release descriptor

**Trigger / preconditions**

A caller chooses one exact Mottainai release and obtains `mottainai-deployment-v1.json` plus its detached `.sha256` sidecar.

**Purpose**

Freeze the release-level identity graph before any provider, Appliance, source, package, or guest mutation begins.

**Owner**

Release consumer/operator for acquisition; the release workflow owns publication.

**Input authority**

The selected immutable GitHub Release assets. Tags/URLs are locators; the descriptor sidecar and descriptor-recorded digests are identities.

**Action**

Persist or provide the exact descriptor and sidecar to `mottainai-init runtime ensure --descriptor`.

**State**

No managed host/provider/guest state may be mutated yet.

**Success evidence**

The exact descriptor bytes and expected SHA-256 are available.

**Fail closed**

Missing descriptor, missing sidecar, malformed sidecar, unbounded document.

**Recovery / idempotency**

Re-acquisition of the identical release asset is read-only and idempotent.

**Next handoff**

Only R4-02 may interpret the descriptor.

**Implementation / proof**

`host-bootstrap/src/deployment_descriptor.rs`; release producer in `.github/workflows/publish.yml`. Release publication additionally runs the production deployment artifact round-trip gate from #832.

## R4-02 — Verify descriptor byte identity and consumer compatibility

**Status: Partial — #843**

**Purpose**

Separate two requirements:

1. these are the exact selected descriptor bytes; and
2. this `mottainai-init` binary understands the descriptor contract/profile it is about to execute.

**Owner**

Standalone Rust descriptor consumer.

**Input authority**

Descriptor sidecar for byte identity; compiled consumer compatibility policy for supported `contractId`, `schemaVersion`, profile, and architecture.

**Action**

Hash the exact descriptor bytes, compare the sidecar, then validate the minimal supported compatibility envelope before projecting route intent.

**Current implementation**

Byte verification exists. The Rust subset deserializer currently reads only Route 2/3 fields and does not require top-level compatibility fields. #843 owns the missing fail-closed compatibility gate.

**Fail closed**

Byte mismatch, unknown contract/version/profile/architecture, missing consumed fields.

**Next handoff**

A semantically supported selected release may enter host/provider inspection.

## R4-03 — Inspect the supported host and all provider prerequisites

**Status: Partial — #846**

**Purpose**

Reject unsupported or unsafe host state before provider/runtime mutation.

**Owner**

`mottainai-init` host-bootstrap.

**Checks**

- Linux host;
- `x86_64` architecture for the supported local profile;
- `/dev/kvm` exists, is a character device, and is read/write accessible to the current user;
- no TCG fallback is accepted;
- every external host facility actually required by the selected Lima profile is declared and validated.

The last point is currently incomplete: Lima 2.2.0 consumes host `ssh` and `ssh-keygen`, while the strongest Route 4 contract does not yet close or explicitly validate that dependency. #846 owns the decision and implementation.

**State mutation**

None except creation of the managed state root needed to acquire the writer lock.

**Success evidence**

Bounded host/KVM/prerequisite observations.

**Fail closed**

Unsupported OS/architecture, inaccessible/missing KVM, undeclared missing provider prerequisite.

## R4-04 — Project the exact Route 4 provider profile

**Status: Target — #842/#847**

**Purpose**

Make the selected release, not compiled coincidental defaults, the provider identity authority.

**Owner**

Rust descriptor consumer + host-bootstrap compatibility validator.

**Input authority**

`route4.provider` in the selected descriptor.

**Required projection**

- Lima version/artifact URL/digest;
- QEMU system artifact;
- QEMU image artifact;
- QEMU firmware/data artifact;
- compatibility requirements (`x86_64`, KVM, supported major versions/provisioning strategy).

Current production drops Route 4 entirely and later uses compiled defaults. #842 fixes consumption. The published provider profile currently omits the QEMU data artifact identity; #847 closes that release graph.

**Next handoff**

Only an explicit supported provider requirement may be materialized.

## R4-05 — Acquire the managed host-bootstrap writer lock

**Status: Implemented**

**Owner**

Host-bootstrap.

**Purpose**

Serialize all writes that can affect provider, QEMU, Appliance, runtime, Lima home, credential, and reconciliation provenance.

**Canonical state root**

`$XDG_STATE_HOME/mottainai/host-bootstrap/` when valid, otherwise `$HOME/.local/state/mottainai/host-bootstrap/`.

**Action**

Acquire the non-blocking `bootstrap.lock` and retain it through the complete mutation transaction.

**Fail closed**

Lock contention becomes bounded `bootstrap_locked`; never wait indefinitely or perform partial mutation without authority.

## R4-06 — Acquire, verify, and materialize Lima

**Status: Implemented**

**Owner**

Host-bootstrap owns artifact acquisition/verification/materialization. Lima owns its runtime behavior after invocation.

**Action**

Download the selected archive into bounded staging, verify immutable digest/shape, extract the declared `limactl`, atomically promote it into managed provider state, and persist provenance.

**State**

`cache/`, `providers/<artifact-id>/`, `active`, provider `state.json`.

**Fail closed**

Digest mismatch, unsafe archive path/type, wrong provider/version/architecture, ambiguous managed/ambient state.

**Idempotency**

An already verified exact managed provider is reused without re-download.

## R4-07 — Acquire and verify the complete QEMU closure

**Status: Partial — #826/#847**

**Owner**

Host-bootstrap for artifacts; Lima remains runtime lifecycle/topology owner.

**Required closure**

- `qemu-system-x86_64` artifact;
- `qemu-img` artifact;
- matching `share/qemu` firmware/data artifact.

**Action**

Acquire bounded immutable archives, verify digests, extract only reviewed files into managed staging, verify x86_64 ELF/version/KVM capability, then atomically activate the complete closure and write `qemu.json`.

**Current gaps**

- #847: release descriptor does not yet bind the data artifact identity.
- #826: reconciliation does not yet cryptographically re-prove the activated expanded data closure; non-empty substituted firmware can pass structural checks.

**Handoff condition**

The selected complete QEMU closure is both release-authorized and currently verified.

## R4-08 — Bind Lima to the verified QEMU identity

**Status: Implemented**

**Owner**

Host-bootstrap establishes process environment; Lima owns command construction and VM lifecycle.

**Action**

Before managed `limactl` invocation, set `QEMU_SYSTEM_X86_64` to the verified executable, place the managed QEMU/Lima directories first in controlled child `PATH`, and supply the managed QEMU data directory.

**Invariant**

An unrelated ambient QEMU may not silently replace the verified provider toolchain.

**Non-goal**

Mottainai never constructs QEMU VM arguments, device topology, or QMP lifecycle.

## R4-09 — Establish isolated Lima home and provider SSH authority

**Status: Partial — #840/#846**

**Purpose**

Create one stable provider-side key authority that both Lima transport and the canonical Appliance can use, without adopting ambient user credentials.

**Owner**

Lima owns its isolated `$LIMA_HOME/_config/user` keypair and SSH transport. Host-bootstrap owns the isolated `LIMA_HOME` placement and the bounded bridge into the guest bootstrap contract.

**Required behavior**

- `ssh.loadDotSSHPubKeys: false` remains authoritative;
- `~/.ssh/*.pub` is not adopted;
- provider key generation/availability is established before guest lifecycle mutation;
- the public key delivered through R3-03 corresponds to the private identity Lima will actually use;
- existing instance + lost/changed host private key is not silently treated as compatible.

# Route 3 — canonical isolated Runtime

## R3-01 — Resolve the canonical Runtime Appliance by immutable OCI identity

**Status: Implemented**

**Owner**

Host-bootstrap OCI/Appliance resolver.

**Input authority**

Selected descriptor Route 3 Appliance registry/repository/digest.

**Action**

Fetch by immutable `sha256:` digest, validate artifact/media types and exact three-layer contract, verify compressed layer/manifest/release metadata relationships.

**Fail closed**

Mutable-only reference, malformed OCI manifest, wrong layer count/type, release metadata inconsistency, digest mismatch.

## R3-02 — Materialize and verify the raw Appliance disk

**Status: Implemented**

**Action**

Decompress the verified transport into managed `appliances/<digest>/`, verify raw size/SHA against the canonical Appliance manifest, then persist materialization provenance.

**Invariant**

The raw Appliance remains provider-independent and credential-free. Provider-specific state is supplied separately.

## R3-03 — Materialize and attach `MTNAI_BOOT`

**Status: Target — #840**

**Purpose**

Bridge the provider-side SSH public key into the canonical guest's already-defined first-boot key contract without modifying the canonical disk.

**Required sequence**

1. obtain the exact provider public key selected in R4-09;
2. validate bounded SSH public-key syntax/content;
3. create a bounded filesystem image carrying root `/authorized_keys` and filesystem label `MTNAI_BOOT`;
4. atomically materialize its host-side artifact/provenance;
5. import it through Lima's public `limactl disk import` surface;
6. verify the import outcome independently rather than trusting exit status alone;
7. reference the Lima-managed disk by **name** in `additionalDisks` with `format: false` so Lima does not overwrite the existing filesystem/label;
8. include key/disk identity in runtime provenance so credential drift cannot be treated as an unchanged configuration.

**Guest consumer**

`mottainai-runtime-bootstrap-authorized-keys.service` in `nix/modules/runtime.nix` discovers label `MTNAI_BOOT`, validates the file, and installs it once into the persistent `mottainai-control` authorized-keys path before SSH use.

**Recovery rule**

If an existing guest has already installed key A and host provider key authority becomes B, do not silently regenerate/re-attach and claim compatibility. The existing instance/key relationship must be classified and repaired explicitly.

## R3-04 — Render production Lima configuration

**Status: Partial — #841**

**Owner**

Host-bootstrap renders bounded public Lima YAML. Lima consumes it.

**Required shape**

- `vmType: qemu`;
- verified canonical raw Appliance under `images`;
- supported CPU/memory;
- no implicit host mounts;
- explicit requested mounts only;
- `mountType: 9p` where required by current adapter contract;
- `ssh.loadDotSSHPubKeys: false`;
- `additionalDisks` contains the imported `MTNAI_BOOT` disk;
- canonical Appliance creation uses Lima **plain mode**.

**Why plain mode**

The canonical NixOS Appliance intentionally does not implement Lima's cloud-init/cidata readiness sentinel such as `/run/lima-ssh-ready`. Lima must provide VM/SSH transport, while Mottainai's guest health contract owns product readiness. #841 fixes the production create invocation.

**Evidence**

Exact rendered YAML is persisted and hashed into runtime configuration identity/provenance.

## R3-05 — Classify existing runtime/provider state

**Status: Implemented, extended by #840**

**Owner**

Host-bootstrap Runtime reconciliation.

**Classifications**

- **missing** — no target instance/state exists; bounded creation allowed;
- **satisfied/running-compatible** — exact managed provenance matches; do not recreate/start unnecessarily; still re-check guest health;
- **stopped-compatible** — exact provenance matches; start and continue health reconciliation;
- **repairable interrupted managed transaction** — only when enough managed provenance exists to resume safely;
- **incompatible** — identity/config/profile differs; automatic recreation is not used to hide drift;
- **ambiguous** — instance/provider state exists but ownership/identity cannot be proved;
- **unsupported** — host/profile outside supported contract.

Runtime provenance must eventually include the credential carrier/key identity established by #840, not only Appliance digest and rendered YAML hash.

## R3-06 — Create/start/reconcile through Lima

**Status: Partial — #840/#841**

**Owner**

Lima is the sole production VM lifecycle owner.

**Action**

For a missing instance, persist the intended managed configuration/provenance before invoking the public Lima create/start API so an interruption can be recognized. For stopped-compatible state, invoke start. For running-compatible state, do not create/start again.

**Production API boundary**

`limactl list`, `create`, `start`, and `shell`; no reading or mutating Lima private sockets/state as product authority.

**Diagnostic contract**

Timeout/failure output must remain bounded but actionable; #845 fixes the current timeout branch that discards captured provider stderr/stdout.

## R3-07 — Establish bounded SSH transport

**Status: Target — #840/#841/#846**

**Purpose**

Reach the canonical control user over the provider transport using exactly the managed provider credential authority.

**Handoff condition**

`limactl shell` can execute a bounded command as the intended guest user. VM `Running` alone is not readiness.

**Fail closed**

Authentication failure, undeclared host SSH dependency, Lima-specific readiness sentinel requirement, unreachable guest.

## R3-08 — Verify canonical bootstrap health

**Status: Implemented once R3-07 exists**

**Owner**

Canonical NixOS guest owns the health result. Host-bootstrap only consumes it.

**Action**

Invoke `mottainai-runtime-health` through the Lima shell transport and parse the bounded `mottainai.linux-runtime.v1` result.

**Required initial handoff**

Supported contract/schema + `bootstrapReady: true`. `bootstrapReady` is progress, not final deployment success.

**Fail closed**

Malformed/unsupported health contract, inaccessible command, incompatible Runtime, or false bootstrap readiness.

## R3-09 — Project desired managed generation from the selected release

**Status: Partial — #850**

**Owner**

Standalone descriptor consumer projects release intent; guest managed-runtime authority performs the build/reconcile.

**Required intent**

- canonical managed package manifest entries and exact source NAR identities;
- selected expected `managedGenerationIdentity`;
- canonical Route 1 payload locator/identity needed to reproduce the release-bound Mottainai package realization.

Current Rust projection supplies the manifest + expected generation identity but drops Route 1 entirely. #850 closes this live consumer gap.

## R3-10 — Deliver desired state and invoke guest reconciliation

**Status: Implemented**

**Owner split**

Host-bootstrap transports the desired manifest and invokes the command. The guest's `mottainai-bootstrap reconcile` remains the sole build/activation/rollback authority.

**Action**

First inspect canonical managed status. If the intended generation is already active and healthy, do nothing. Otherwise write the canonical persisted managed manifest to the guest control-state path and invoke reconciliation for the supported system.

# Route 2 / Route 1 realization inside guest reconciliation

## R2-01 — Resolve exact managed package recipes and sources

**Status: Implemented**

**Owner**

Managed-generation/source-resolution code invoked by `mottainai-bootstrap`.

**Mottainai source authority**

The manifest's `sourceSha256` is the NAR SHA-256 of the exact release source tree Nix resolves and builds. The release source owns its own `nix/flake.nix`, recipe, nixpkgs pin, and dependency hash; HEAD must not reinterpret historical sources with a newer recipe.

**Other package authority**

Nawabari and Zellij use their explicitly supported fixed recipes/delegated nixpkgs identities.

**Fail closed**

Unsupported package/kind/flakeRef, source integrity mismatch, unavailable release recipe/output.

## R1-01 — Obtain the exact canonical Route 1 payload

**Status: Target in live guest path — #850**

**Release behavior already implemented**

The release Route 2 build consumes the exact already-packed canonical tarball through `mkMottainaiFromPayload`, verifies its SHA-256, and records `canonical-payload.json` in the package output.

**Required live behavior**

Guest reconciliation must obtain those same release-bound bytes, verify the descriptor Route 1 SHA-256, and feed them through the same canonical payload-consuming Nix package boundary.

**Current defect**

The guest build currently resolves ordinary `packages.<system>.mottainai`, which uses `mkMottainai` and generates a new tarball from source when `canonicalPayload` is absent. That is not the release-time derivation used to produce the descriptor's canonical generation identity. #850 owns the correction.

## R2-02 — Build the complete managed generation closure

**Status: Partial — #850 for the Mottainai application artifact handoff**

**Owner**

Nix projection `mkManagedGeneration` plus the selected release's Mottainai package recipe.

**Closure contents**

- managed application packages currently supported by the catalog (`mottainai`, `nawabari`, `zellij`);
- fixed lower-level Route 2 dependencies such as `git` and `rg`;
- Node.js/native/package dependencies closed by the Mottainai Nix package.

Ambient host `PATH` is not a substitute for built-in Route 2 dependencies.

## R2-03 — Verify realized source and version identity

**Status: Implemented**

**Owner**

`src/runtime-contract/managed-generation.ts`.

**Checks**

- each realized package has a metadata entry;
- resolved version exactly equals requested version;
- realized source store path NAR SHA equals manifest `sourceSha256`;
- unsupported or inconsistent package resolution fails closed.

Route 1 payload SHA and Route 2 source NAR SHA are deliberately distinct concepts.

## R2-04 — Derive the canonical managed-generation identity

**Status: Implemented authority; live reproduction blocked by #850**

**Owner**

`generationIdentityOf()` is the sole semantic identity authority.

**Inputs**

- manifest semantic identity;
- realized generation/store path;
- sorted realized package store paths.

**Invariant**

Release workflow, descriptor, guest reconciliation, and runtime evidence may transport/verify this identity but may not invent another formula.

**Handoff**

The candidate realization must equal the selected descriptor's intended generation identity before final success can be claimed.

# Return to Route 3 activation

## R3-11 — Activate candidate generation or roll back

**Status: Implemented**

**Owner**

Guest `reconcileManagedRuntime` / `mottainai-bootstrap reconcile`.

**Action**

Persist transaction phase/evidence, build candidate, switch the managed `current` pointer only under the canonical activation state machine, run health checks, commit healthy active state, or return to the most recent healthy generation on failed activation according to the runtime-state contract.

**State boundary**

System/control-owned persistent managed-runtime state may change. Repository-user state is not rewritten by managed generation activation/rollback.

**Crash recovery**

Non-idle/interrupted activation state is explicit durable state; observed state must not silently rewrite desired or active identity records.

## R3-12 — Verify exact active managed generation

**Status: Implemented once preceding gaps are closed**

**Action**

Re-run canonical health/status through the guest boundary and require:

- `managedRuntimeReady: true`;
- idle activation phase;
- healthy active generation;
- observed `current` pointer/store path matches canonical active state;
- intended generation identity equals the active generation identity.

A healthy *different* generation does not satisfy the selected release.

# Route 1 final identity and functionality

## R1-02 — Prove active package payload identity

**Status: Target — #850**

Final convergence evidence must prove that the active Mottainai package is bound to the exact canonical Route 1 payload SHA from the selected descriptor, not only to the same package version or source tree.

The Nix Mottainai package already writes `share/mottainai/canonical-payload.json`; the live route must preserve and verify the release-bound value through activation/evidence.

## R1-03 — Packaged CLI functional readiness

**Status: Implemented**

Run a bounded representative CLI check against the active generation, not an ambient host binary. Identity-only `--version` checks are useful but do not replace functional readiness where the Route 2 closure contract requires real dependency use.

## R1-04 — Packaged MCP functional readiness

**Status: Implemented**

Run the packaged `mottainai-mcp` from the active generation over stdio and complete at least a bounded MCP `initialize` exchange. This proves the application entrypoint and required closure function after activation.

# Final convergence and recovery

## E2E-01 — Emit complete bounded evidence

**Status: Partial until all linked defects close**

Final evidence must connect the selected release to the observed active state and include, at minimum:

- release tag/version/source revision;
- descriptor SHA-256;
- standalone `mottainai-init` identity;
- host architecture/KVM observation;
- exact Lima provider identity;
- exact complete QEMU system/image/data identity;
- canonical Runtime Appliance OCI/raw identity;
- credential/key carrier identity sufficient to prove provider↔guest continuity without exposing private key material;
- desired and active managed-generation identity;
- canonical Route 1 payload SHA;
- `managedRuntimeReady=true`;
- CLI/MCP functional readiness results.

Diagnostics are bounded and must preserve actionable provider failures. #845 covers the current timeout-loss defect.

## E2E-02 — Unchanged re-run/no-op

A second ensure for identical selected release/host/provider/Appliance/credential/runtime intent must perform observation/verification only. It must not re-download verified immutable artifacts, recreate the VM, rotate credentials, rebuild/switch an already matching healthy generation, or rewrite state solely to manufacture freshness.

## E2E-03 — Restart and continuity

After host/client restart or a compatible stopped-instance restart:

- managed Lima provider identity remains the same;
- QEMU closure identity re-verifies;
- Lima home/key authority remains compatible with the guest-installed authorized key;
- Runtime instance provenance remains exact;
- guest persistent managed-runtime state remains valid;
- active generation and Route 1 payload identity remain the selected release's identity;
- stopped-compatible instance is started/rechecked rather than recreated.

Credential loss/drift must fail closed; it is not an excuse to silently rotate a key against an existing guest. #840/#846 establish this lifecycle.

## E2E-04 — Final real Linux/KVM certification

**Authority: #261**

Repository unit/hermetic/trusted-main/release tests must prove software behavior first. #261 remains the final proof that the complete published production chain works on a fresh real Linux `x86_64` host with usable KVM and real Lima/QEMU/network/storage/SSH boundaries.

A product defect found by #261 must be fixed at its owning operation step with regression coverage, then the same certification is re-run. Manual bridging does not count as success.

---

# Durable state and later consumers

| State | Writer | Later consumer | Required invariant |
| --- | --- | --- | --- |
| `state.json` provider materialization | host-bootstrap | later Route 4 runs/runtime ensure | exact managed Lima artifact identity |
| `qemu.json` + managed QEMU closure | host-bootstrap | every Lima invocation/reconciliation | selected complete QEMU identity still verified |
| `active -> providers/...` | host-bootstrap | Lima resolver | no ambient provider substitution |
| `lima-home/_config/user(.pub)` | Lima under isolated home | Lima SSH + R3-03 credential bridge | stable key continuity for existing instance |
| `appliances/<digest>/...` | Appliance resolver | Lima config | raw bytes match selected descriptor/OCI identity |
| `runtime/<instance>/lima.yaml` | host-bootstrap | reconcile classification/Lima | exact intended public config |
| `runtime/<instance>/state.json` | host-bootstrap | later reconcile | Appliance/config/provider/credential provenance agrees |
| Lima-managed `MTNAI_BOOT` disk | host-bootstrap via Lima public disk API | guest first-boot key service | exact validated provider public key, label preserved |
| guest `~mottainai-control/.ssh/authorized_keys` | canonical guest bootstrap service | sshd/Lima transport | persistent installed key matches managed provider authority |
| guest managed manifest | host-bootstrap transport / guest control state | `mottainai-bootstrap reconcile` | canonical persisted desired state |
| guest managed-runtime state + `current` | guest managed-runtime authority | health/status/reconcile | transaction/active pointer consistency |
| active generation `canonical-payload.json` | Nix Mottainai package | final Route 1 evidence | descriptor-bound payload SHA after #850 |

# Reconciliation decision table

| Observation | Allowed action | Forbidden shortcut |
| --- | --- | --- |
| Missing managed provider/tool/artifact | bounded acquisition/materialization | adopt unknown ambient binary |
| Verified unchanged provider/tool/artifact | no-op + reverify | re-download/rewrite without reason |
| Missing Runtime instance | persist intent then create/start | direct QEMU lifecycle outside Lima |
| Running compatible instance | health/reconcile only | recreate because checking is easier |
| Stopped compatible instance | start then health/reconcile | create second instance |
| Existing instance without managed provenance | fail ambiguous | silently adopt it |
| Identity/config/credential mismatch | fail incompatible / explicit repair | mutate state to make records agree |
| Interrupted managed activation | resume/rollback only per durable transaction state | pretend `current` alone is healthy |
| Healthy active intended generation | no-op functional verification | rebuild/switch identical generation |
| Healthy active different generation | reconcile intended state | report success merely because health is green |
| Unsupported contract/profile/host | fail closed | best-effort downgrade/TCG fallback |

# Proof-tier matrix

The same step can have multiple proof tiers. A higher tier does not excuse an absent lower-level deterministic regression.

| Step / boundary | PR/unit/hermetic | Trusted main canonical integration | Release gate | Real-host #261 | Gap |
| --- | --- | --- | --- | --- | --- |
| R4-01/R4-02 descriptor bytes | Rust unit + descriptor tests | production artifact consumers | #832 round-trip | yes | #843 compatibility |
| R4-03 host/KVM prerequisites | Rust host-probe tests | limited hosted observations | standalone artifact smoke | yes | #846 OpenSSH contract |
| R4-04 provider profile | descriptor producer tests | none for live consumer authority | descriptor publication | yes | #842/#847 |
| R4-06 Lima materialization | host-bootstrap tests | artifact/provider CI | standalone release smoke | yes | — |
| R4-07 QEMU closure | host-bootstrap tests | QEMU/runtime checks | standalone release smoke | yes | #826/#847 |
| R4-08 Lima→QEMU binding | Rust contract tests | partial | — | yes | final real proof #261 |
| R4-09/R3-03 credential bridge | mocked components insufficient | production Lima proof required | — | yes | #840/#846 |
| R3-01/R3-02 Appliance OCI/raw | Rust real-artifact byte proof | canonical Appliance build/OCI proof | OCI publication | yes | — |
| R3-04–R3-08 production Lima→guest | unit config/reconcile tests | **required but currently absent** | — | yes | #841/#844 (+ #840) |
| R3-09–R2-04 desired/live generation | TypeScript/Nix contract tests | golden-path/runtime tests | release Route 2 realization | yes | #850 live Route 1 handoff |
| R3-11/R3-12 activation/readiness | managed-runtime tests | Nix VM/golden path | — | yes | depends on preceding boundaries |
| R1-01/R1-02 exact payload identity | release/Nix Route 2 tests | live consumer proof required | exact canonical payload release gate | yes | #850 |
| R1-03/R1-04 CLI/MCP readiness | Route 2 closure/package tests | runtime functional smoke | release smoke | yes | — |
| Complete production Lima composition | individual component tests | target trusted-main proof | — | yes | #844 |
| Bounded provider failure diagnostics | Rust subprocess tests | production failure injection desirable | — | yes | #845 |

# Open gap map

| Issue | Operation steps | Missing connection |
| --- | --- | --- |
| #826 | R4-07 | activated QEMU data closure is not cryptographically reverified during reconciliation |
| #840 | R4-09, R3-03, R3-05, R3-06, R3-07, E2E-03 | provider SSH key is not delivered through `MTNAI_BOOT`; key lifecycle/provenance incomplete |
| #841 | R3-04, R3-06, R3-07 | production Lima create does not use canonical plain-mode readiness boundary |
| #842 | R4-02, R4-04, R4-06–R4-08 | descriptor Route 4 identity is dropped and compiled defaults become a second authority |
| #843 | R4-02 | authentic but unsupported descriptor schema/profile can be consumed as an older subset |
| #844 | proof-tier matrix / R3-03–R3-08 | trusted-main canonical integration skips production Lima composition |
| #845 | R3-06, E2E-01 | timeout path discards bounded actionable Lima output |
| #846 | R4-03, R4-09, R3-07, E2E-03 | host OpenSSH dependency is implicit rather than declared/managed |
| #847 | R4-04, R4-07 | release provider graph omits required QEMU firmware/data artifact identity |
| #850 | R3-09, R1-01, R2-02, R2-04, R1-02, E2E-01 | live guest build drops selected exact Route 1 payload and regenerates it from source |
| #261 | all | final external real Linux/KVM production-chain certification |

# Review rule for future changes

Any change touching one operation in this book must be reviewed in both directions:

1. **producer side** — does the step still emit the identity/state/evidence its documented consumer requires?
2. **consumer side** — does the next step actually consume that exact output rather than re-derive, default, infer, or silently substitute it?

A component test that proves only one side is insufficient for a handoff change. At least one authoritative test must cross the changed producer→consumer boundary. If the production physical boundary cannot run in ordinary PR CI, the lower tier must prove all deterministic semantics and the trusted-main/release/#261 tier must own the remaining physical proof explicitly.

This rule is the core purpose of this operation book: every route transition is reviewable as a concrete edge rather than inferred from independently correct components.
