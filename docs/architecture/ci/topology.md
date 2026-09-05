# CI topology

Architecture authority: [#764](https://github.com/yohn-jp/mottainai/issues/764). This document defines the intended CI ownership and certification topology for Mottainai. It refines the merge-integrity model established by #347; it does not weaken or replace it.

The workflow YAML is an implementation of this document. Where current workflow behavior differs from this document, the workflow is migration debt rather than an alternate architecture.

## Design rule

CI validates **contracts that a change can invalidate**, at the **least expensive certification tier sufficient to reject or certify that change**.

A broad directory is not automatically a product contract. An implementation path may consume one contract without redefining every artifact beneath it. In particular, `host-bootstrap/**` is not equivalent to “the Nix Runtime, VM, image, and Appliance all changed.”

This produces two complementary rules:

1. **PR CI is rejection-oriented.** A required PR gate exists only when its failure is sufficient reason to reject the proposed commit.
2. **Integration strength is tiered, not deleted.** Expensive cross-boundary proofs that do not need to block every relevant PR move to trusted `main`, release, or external certification instead of being dropped.

## Meaning of green

A green PR means the proposed commit satisfies every merge-integrity contract it can invalidate:

- repository governance remains valid;
- supported source/build/package surfaces remain valid where changed;
- product behavior remains valid where changed;
- Runtime, VM, Appliance, or bootstrap contracts are validated only when the change can invalidate them;
- no required proof has been replaced by an informational or best-effort success.

Green does **not** mean that every deployable artifact in the repository has been rebuilt, every VM path has booted, or every external provider has been recertified for every commit. Those are different evidence classes with different owners.

## Certification tiers

| Tier | Trigger / trust boundary | Purpose | Typical evidence |
| --- | --- | --- | --- |
| PR merge integrity | `pull_request` | Reject a proposed change before merge using the smallest sufficient fail-closed proof set | governance, static/build, focused product/package tests, host-bootstrap tests, Nix evaluation/build, targeted VM test, targeted Appliance build/manifest |
| Canonical integration | trusted `push` to `main` | Prove that affected canonical components compose after merge | real canonical Runtime Appliance composition, OCI-shaped consumption, standalone bootstrap composition, production Lima composition through guest health, Appliance golden path, canonical artifact eligibility |
| Release certification / publication | exact governed release/tag | Prove and publish immutable release artifacts from exact release identity | canonical npm payload verification, exact tagged Appliance rebuild/verification, release metadata/digests, immutable publication |
| External support certification | bounded manual/trusted real-host evidence | Prove the deployment chain across real host/provider boundaries | #261 Linux x86_64 + KVM + Lima + QEMU + Route 4 -> 1 evidence |

The tiers form a proof hierarchy, not a sequence that every PR must execute. PR CI proves the affected rejection contracts. `main` proves canonical cross-boundary integration when relevant. Release proves exact publishable identity. #261 proves the external host/provider boundary that hosted repository CI cannot claim.

## Contract ownership classes

The implementation may use different job names, but change selection must preserve these semantic classes.

| Ownership class | Owns | Representative paths / inputs | Primary PR proof |
| --- | --- | --- | --- |
| `governance` | Issue/PR/repository policy and authoritative merge formatting | `.github/inari/**`, governance workflow/scripts | authoritative governance gate |
| `node-static` | TypeScript/source build correctness and architecture rules | `src/**`, TypeScript config, correctness lint/build scripts | typecheck, correctness lint, architecture check, build |
| `product` | bounded application behavior and managed workflow semantics | `src/**`, integration fixtures/suites, product-contract helpers | focused integration/product contract |
| `package` | shipped npm/CLI/MCP payload behavior | `src/**`, pack/smoke/package scripts, `package.json`, lockfile | canonical package/packed artifact smoke |
| `host-bootstrap` | standalone Rust `mottainai-init`, Route 4 host convergence, Route 3 control-plane/reconciliation behavior | `host-bootstrap/**` | fmt/test/clippy, portable musl build, hermetic descriptor/reconciliation/composition tests |
| `runtime-nix` | Route 2 Nix closure, managed generation, Nix package catalog, Runtime system semantics | `nix/mottainai.nix`, `nix/managed-generation.nix`, `nix/managed-runtime-health.nix`, `nix/packages/**`, relevant `nix/modules/**`, `nix/flake.*`, Route 2 checks | locked flake evaluation, required derivation/package builds, managed-generation/Route 2/health checks |
| `runtime-vm` | NixOS guest boot/runtime behavior that requires a VM proof | guest/system modules and VM-specific checks such as `nix/tests/runtime.nix` | Runtime VM derivation plus bounded NixOS VM test |
| `runtime-appliance` | canonical self-bootable Runtime Appliance artifact and bounded manifest identity | `nix/runtime-appliance-image.nix`, Appliance-specific tests, Appliance manifest/OCI build scripts, shared Appliance contract definitions | canonical Appliance derivation build + bounded manifest generation/verification |
| `release-publication` | durable exact-release publication and immutable release metadata | release workflow/scripts and release metadata contracts | release-only exact-tag rebuild/verify/publish |

This table is intentionally contract-oriented. Exact path filters are implementation details and can evolve. When a path is shared by multiple contracts, it belongs to every true consumer. The solution to an ambiguous shared contract is explicit overlapping ownership, not a return to one global `runtime` bucket.

### Dependency and invalidation edges

The important dependency direction is:

```text
Route 4 host bootstrap
        |
        v
Route 3 Lima / Runtime Appliance control plane
        |
        v
Route 2 Nix Runtime / managed generation
        |
        v
Route 1 canonical npm payload
```

This deployment dependency does **not** imply that every change at an outer route invalidates the artifacts of every inner route.

Examples:

- changing Rust error handling or reconciliation state transitions in `host-bootstrap/**` invalidates `host-bootstrap`; it does not change the bytes or semantics of `nix/runtime-appliance-image.nix`;
- changing an Appliance manifest schema shared by TypeScript and Rust invalidates both `runtime-appliance` and the relevant `host-bootstrap` consumer tests;
- changing a NixOS guest module invalidates `runtime-nix`, and when the behavior is boot/runtime-specific it also invalidates `runtime-vm` and potentially the derived Appliance;
- changing `nix/runtime-appliance-image.nix` invalidates `runtime-appliance` and necessarily consumes the underlying Runtime system closure, but it does not require unrelated Node integration suites;
- changing workflow selection logic conservatively invalidates every class whose selection semantics that workflow can change.

## PR validation matrix

The target PR behavior is the union of the validation classes selected by the changed contracts.

| Change type | Required PR evidence | Evidence intentionally not required solely because of this change |
| --- | --- | --- |
| docs-only, no governed executable contract | governance / documentation checks as applicable | Rust, Nix, VM, Appliance builds |
| Node/source behavior | static + affected product/package contracts | Nix VM/Appliance unless a shared Runtime contract changed |
| host-bootstrap-only control-plane change | host-bootstrap Rust + hermetic descriptor/reconciliation/composition contract tests | canonical Nix Runtime system rebuild, VM boot, canonical Appliance rebuild, real canonical Appliance golden path |
| Route 2 / managed-generation / Nix package change | Nix evaluation/build + affected package/generation/closure checks | VM or Appliance proof unless guest/VM/Appliance semantics are invalidated |
| VM/guest-semantic change | Nix prerequisites + VM derivation/test | full real canonical Appliance composition unless Appliance contract also changed |
| Appliance-defining change | Nix prerequisites + canonical Appliance build + bounded manifest verification | full real-canonical-Appliance OCI/bootstrap/golden-path composition on the PR |
| shared Appliance contract change | Appliance build/manifest proof + every affected consumer contract test, including Rust consumer tests where applicable | unrelated product suites |

### Appliance proof boundary

An Appliance-defining PR must not merge merely because a fixture passes. It must prove that the **canonical Appliance derivation itself builds** and that the **bounded manifest matches the produced canonical artifact**.

The more expensive cross-boundary proof is different: take the real canonical Appliance, shape/resolve it through the production distribution/composition boundary, exercise the standalone bootstrap against it, and run the complete Appliance golden path. That is canonical integration evidence and belongs on affected trusted `main` pushes.

This distinction preserves pre-merge artifact correctness without turning every Route 3/4 control-plane edit into a full system certification run.

## Trusted `main` canonical integration

For affected Runtime/VM/Appliance/bootstrap integration changes, trusted `main` owns the full canonical composition proof. The intended evidence includes, as applicable:

1. build/identify the real canonical Runtime Appliance from the merged revision;
2. generate and verify its bounded manifest;
3. construct/consume the OCI-shaped representation used by the production resolution boundary;
4. prove standalone `mottainai-init` resolves and verifies the real canonical artifact;
5. run the production Lima composition path through `limactl create --plain`, the
   production MTNAI_BOOT attachment, Lima SSH, and canonical
   `mottainai-runtime-health`;
6. run the complete Runtime Appliance golden path against the merged canonical components;
7. permit canonical artifact publication only after the relevant integration proof succeeds.

A failed `main` integration run is a product integration failure that must be repaired immediately. It is not evidence that every earlier PR should have run the entire canonical composition chain. The PR should have run every rejection proof owned by its changed contracts; `main` owns the cross-contract composition proof.

Independent `main` SHAs must remain able to validate concurrently. Only a stateful publication boundary may be narrowly serialized when required.

## Release certification and publication

Release is not a reuse of “whatever passed on PR” or a mutable `main` artifact. A release is bound to an exact release/tag/source identity.

The release path must independently verify the publishable artifacts it owns, including their exact revision, package/artifact identity, digest/metadata, and immutable publication behavior. PR and `main` evidence may increase confidence but do not replace exact release verification.

## External real-host certification

[#261](https://github.com/yohn-jp/mottainai/issues/261) remains the authority for the complete published Route 4 -> 3 -> 2 -> 1 chain on real Linux x86_64 with usable KVM, Lima, and QEMU/provider behavior.

Hosted CI, a NixOS VM test, or a hermetic Lima/bootstrap fixture must not be described as real-host support certification. Conversely, #261 should not be used as a reason to make every PR reproduce provider-level integration that repository CI can prove more cheaply at a lower boundary.

## Required-check semantics

Contract targeting must not make branch protection nondeterministic.

The externally required merge-gate surface should remain stable even if the internal CI DAG becomes more granular. The implementation may use one stable aggregate Runtime merge gate or another deterministic aggregation pattern, but the following must hold:

- every selected internal proof failure makes the owning merge gate fail;
- an unselected proof resolves deterministically rather than disappearing or remaining pending;
- changing internal job decomposition does not silently create a branch-protection enforcement gap;
- check names are changed only as a deliberate coordinated migration, not as an incidental side effect of optimization.

## Cache policy

Caching is an optimization layer, never a proof authority.

- A cache hit may avoid recomputing a derivation whose inputs identify the same result.
- A cache miss must still produce a correct CI result.
- Untrusted PRs must not gain authority to publish trusted binary-cache entries.
- Broad opaque caches that can hide missing build inputs are not acceptable.
- Nix binary substitution, if introduced, should follow topology correction and measurement. It is not a substitute for removing unnecessary validation.

## Latency objectives

Latency targets are service-level objectives for architecture review. They never authorize deleting a rejection contract.

Target critical-path order of magnitude after #766-#768:

| PR / tier | Target |
| --- | ---: |
| ordinary Node/package PR | <= 3 min |
| host-bootstrap-only PR | <= 3 min |
| direct Route 2 / Nix Runtime PR | <= 5 min |
| VM- or Appliance-defining PR | <= 8 min where the canonical artifact must actually build |
| trusted `main` full canonical Runtime Appliance integration | <= 15 min, outside PR merge latency |

If a targeted contract cannot meet its SLO without weakening correctness, preserve the contract and measure the actual limiter. Only then consider binary caches, runner decomposition, or larger runners.

## Worked example: PR #763

PR #763 changed exactly:

```text
docs/architecture/runtime/lima-orchestration
host-bootstrap/src/deployment_descriptor.rs
host-bootstrap/src/error.rs
host-bootstrap/src/lib.rs
host-bootstrap/src/lima.rs
host-bootstrap/src/main.rs
host-bootstrap/tests/reconciliation.rs
```

The behavioral change was Route 3/standalone Rust bootstrap convergence: descriptor verification/derivation, managed-generation intent, reconciliation/readiness, and bounded functional smoke. It did not edit `nix/**`, Runtime VM tests, `nix/runtime-appliance-image.nix`, or the Appliance build scripts.

Under the target ownership graph, #763 selects:

- governance;
- `host-bootstrap` Rust format/test/clippy and portable build;
- hermetic descriptor/reconciliation/composition tests for the Route 3/4 control-plane behavior.

It does **not**, solely from those paths, select:

- canonical `runtime-system`, `runtime-vm`, or `runtime-image` rebuilds;
- managed Runtime package catalog rebuilds unrelated to the consumed contract;
- Runtime NixOS VM boot tests;
- canonical Runtime Appliance disk rebuild;
- real-canonical-Appliance OCI fixture construction;
- full Runtime Appliance golden-path certification.

The current workflow did select the full Runtime chain because `host-bootstrap/**` is included in the broad `runtime` path filter. That is the migration defect addressed by #766, not intended CI semantics.

## Current implementation debt

[#766](https://github.com/yohn-jp/mottainai/issues/766), [#767](https://github.com/yohn-jp/mottainai/issues/767), and [#768](https://github.com/yohn-jp/mottainai/issues/768) closed the broad `runtime` ownership filter, the single monolithic `Nix Runtime evaluation / image / VM test` job, and the PR-tier full canonical Appliance composition run. Change detection selects `runtime_nix`/`runtime_vm`/`runtime_appliance`/`host_bootstrap` as explicit overlapping classes; PR validation runs as independently skippable `runtime-nix`, `runtime-vm`, and `runtime-appliance` jobs behind a stable aggregate `Nix Runtime evaluation / image / VM test` merge gate; and the `runtime-appliance` job itself now selects a different certification tier per event (see "PR/trusted-main tier split within `runtime-appliance`" below).

No known event-tier migration debt remains from #764-#768. A future cache/multi-runner optimization Issue may still follow once representative latencies are measured against the SLO table below, but that is out of scope for the topology migration itself.

### PR/trusted-main tier split within `runtime-appliance`

The `runtime-appliance` job runs the same steps regardless of which event selected it, but individual steps are gated by `github.event_name` so the two tiers stay structurally distinct in one job definition rather than duplicated across two:

| Step | PR (Appliance-defining) | Trusted `main` (affected) |
| --- | --- | --- |
| build the canonical Appliance disk | yes | yes |
| generate/verify the bounded manifest | yes | yes |
| build the OCI-shaped fixture | no | yes |
| standalone `mottainai-init` composition verification | no | yes |
| production Lima composition through canonical guest health | no | yes |
| Runtime Appliance golden path | no | yes |

A trusted `main` push runs this full chain whenever `runtime_nix`, `runtime_vm`, or `runtime_appliance` changed, and also when only `host_bootstrap` changed (the cross-boundary composition proof between standalone `mottainai-init` and the real canonical Appliance is exactly the boundary a host-bootstrap-only change can invalidate, even though it does not warrant the canonical Appliance rebuild on the PR itself). `scripts/ci-runtime-contract-gates.mjs`/`.test.mjs` verify both the job-level event-tier selection and this step-level tier split deterministically, without running GitHub Actions.

### Evidence (Issue #768)

Removed from the PR critical path for an Appliance-defining PR: installing the Rust toolchain, building the local OCI-shaped fixture from the real disk, running the standalone `mottainai-init` real-artifact composition test, and the networked (`--option sandbox relaxed`) Runtime Appliance golden-path check. Those were the most expensive steps in the job (a real disk-backed Rust integration test and a KVM-backed guest boot with outbound HTTPS resolution), run serially after the Nix Runtime and canonical Appliance build/manifest work that remains on the PR. Removing them moves the Appliance-defining PR path toward this document's `<= 8 min` SLO instead of paying full cross-boundary certification latency on every such PR.

Trusted `main` now performs strictly more work per affected push than before: previously only the golden-path check ran on `main`; now the same build, manifest, OCI-shaped fixture, standalone `mottainai-init` composition, and golden path all run together, and canonical artifact publication (`runtime-appliance-artifact`) only starts after that full chain succeeds. The dominant cost is unchanged (the same KVM-backed golden-path guest boot that previously ran alone on `main`), so this remains within the `<= 15 min` trusted-`main` SLO in this document; this is a structural/step-composition analysis, not a measured wall-clock run, since no representative trusted-`main` push exists yet on the branch introducing this change.

## Migration plan

- [x] [#766](https://github.com/yohn-jp/mottainai/issues/766) — split change detection by contract ownership and remove blanket `host-bootstrap/** -> full runtime` invalidation.
- [x] [#767](https://github.com/yohn-jp/mottainai/issues/767) — decompose PR Runtime validation into targeted Nix, VM, Appliance, and bootstrap-composition gates.
- [x] [#768](https://github.com/yohn-jp/mottainai/issues/768) — move full real-canonical-Appliance composition/golden-path certification to affected trusted `main` pushes and gate canonical publication on it.

After these changes, measure representative Node, host-bootstrap, Nix Runtime, VM, Appliance, and trusted-main critical paths from real workflow runs. Create a cache/runner optimization Issue only if the remaining measured latency still justifies one.
