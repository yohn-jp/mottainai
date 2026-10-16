# Wave 1 recovery — OCI adoption decision

**Final decision: integrated certification BLOCKED; Podman adoption HOLD; Wave 2 must not start.** Default OCI strict execution remains FAIL. Recovery identified the procfs rejection and classified cancellation leftovers, but a security decision and supported execution/tracking contracts remain prerequisites. No production repair, mask relaxation, owner-repository change, or integrated PASS is claimed.

## Authority and revisions

- Repository: `yohn-jp/mottainai`; accepted target: `nixos-dev`, including its VMware environment.
- Latest main fetched for this recovery: `152da3c3a61900fa65db8b0abce44fdcb170b73b`. It happens to match the historical base; this was verified, not assumed.
- Coordinator base: the same main revision; branch `docs/998-oci-recovery-decision`, [Issue #998](https://github.com/yohn-jp/mottainai/issues/998).
- A: `docs/996-oci-sandbox-recovery`, [Issue #996](https://github.com/yohn-jp/mottainai/issues/996), independently based on that main.
- B: `docs/997-oci-cancel-recovery`, [Issue #997](https://github.com/yohn-jp/mottainai/issues/997), independently based on that main.
- Root AGENTS, organization governance/skills, canonical runtime/public APIs and the user's accepted recovery scope apply. Inari remains suspended; GitHub operations use explicitly authorized `gh`.
- #281 requires supported rootless behavior or explicit unsupported evidence; #984 retains Tsukai AgentRun, Jinushi physical-process and Nawabari workspace ownership.

## Phase 0 preservation

[Issue #994](https://github.com/yohn-jp/mottainai/issues/994) and [PR #995](https://github.com/yohn-jp/mottainai/pull/995) preserve the original Wave 1 **FAIL**. The PR is ready for review and has not been merged.

- BASE_SHA: `152da3c3a61900fa65db8b0abce44fdcb170b73b`.
- HEAD_SHA: `72474d7cce9849337ebb4175470645ab6730d752`.
- Published branch: `chore/994-preserve-oci-wave1-fail`.
- Files: `OCI_RUNTIME_COMPATIBILITY_REPORT.md` (164 lines), `scripts/poc/oci-worker-a.sh` (251), `scripts/poc/oci-worker-b.sh` (216); 631 added lines.
- Only historical publication-status wording changed. Script hashes are `5e4fabd55906adcf715ede659a703c61a5d2a85c435e2f1c2dcfeed0e336e06d` (A) and `4c071a87cae5b734ed696b98e39546d4fb34bbea7496820db42a6633a8d234da` (B).
- Shell syntax, whitespace, exact scope, published branch governance and private-key/token/credential pattern checks passed. Actual bounded deletion, policy identity and PID-fenced supervisor cleanup were reviewed. Historical live exit 1 remains FAIL. Snapshot policy required all three validation checklist items; frozen install, `pnpm run typecheck` and `pnpm run build` passed at artifact HEAD with Node v24.21.0/pnpm 11.25.0. Tests records focused publication checks; the full production suite was not run.
- Nawabari requires owned and published branch names to match. The original worktree was retained, and publication used a new owned conventional branch at the same commit with explicit claim release/reacquisition. No ownership guard or force-push was bypassed.
- Initial CI rejected the missing template marker, noncanonical Validation content and then an incomplete optional-item checklist. PR metadata was corrected using the exact errors, and required checks were executed before marking completion; artifact content and FAIL assertions were unchanged. CI and real-host certification are separate.

Both recoveries explicitly reference this immutable commit. Neither treats unmerged PR #995 as part of main.

## Host and immutable inputs

Coordinator observations are recorded in `/tmp/mottainai-oci-recovery-root-host.txt`.

| Item | Observed value |
| --- | --- |
| Host / user | `nixos-dev`, uid 1000 (`sophia`), nonroot |
| OS | NixOS 26.05 Yarara, `26.05.10304.6d663c0533ff` |
| Kernel / virtualization | Linux `6.18.52`, x86_64 / VMware |
| systemd | `260 (260.4)` |
| cgroups | `cgroup2fs`; `user@1000.service Delegate=yes`, controllers `cpu memory pids` |
| Podman / crun | `5.8.8` / `1.30.1`, crun commit `079ff6a7a16d029460af882f9ea44674e6a510b6` |
| Host Nawabari | `0.13.0`; OCI probe targets released `0.14.0` |
| Historical OCI tools | Debian 13.7 trixie, Node 24.17.0, bubblewrap package `0.12.0-1~deb13u1` |
| Jinushi tested source | `13afd8f0c284b28a2899ab41721aaee1fab67389`, no supported version flag |

Tool provisioning uses Nixpkgs `39ad350a0602fa0a58a544344e3e9187526ea45c5`, not a NixOS generation/configuration change. Debian is pinned to index digest `sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5`; the platform RepoDigest is `sha256:d405c1e1d9eecbf30022d23766a0eea235e7f499aa33e357dfd29271a839f82a`.

During the probes, the coordinator exclusively owned the already-authorized temporary `/home/sophia/.config/containers/policy.json`. Its default rejected images and its sole unsigned-image exception was `docker.io/library/debian`. Workers did not mutate it. Creation used exclusive/no-follow flags and mode 0600; restoration checked inode/owner/mode/size/hash. This was not image-signature authentication; the file is now absent as recorded below.

## Recovery A: strict procfs rejection

[PR #1000](https://github.com/yohn-jp/mottainai/pull/1000), HEAD `fd189fee125e29dc7496cddc91cd71fec205b3f4`, adds only `OCI_RUNTIME_RECOVERY_A.md` (43 lines) and `scripts/poc/oci-recovery-a.sh` (278). It is independently based on main, ready for review and unmerged. Its local typecheck/build and fast tests (773 passed/0 failed) passed; shell syntax and final real-host reproduction passed. Its explicit ownership census rejects the shell path as unowned. The latest PR-contract check observed before the report-only follow-up passed; subsequent CI is not claimed complete.

The default OCI seccomp allowlist includes `mount`, `fsopen`, `fsconfig`, `fsmount` and `unshare`. Container user namespaces can be created. A nested user/mount/private-PID namespace had a full inner capability set but `mount -t proc proc <private-empty-dir>` exited 32 with `fsmount() failed: VFS: Mount too revealing.` The equivalent host namespace proc mount succeeded. Nawabari strict run exited 3 with `SANDBOX_EXECUTION_FAILED`, specifically `bwrap: Can't mount proc on /proc: Operation not permitted`.

Saved OCI config `3e61e7a5378b1b795357b1d19f4fe7ade617851904cb94887f7c0d8f4634d1a4` records proc masks/read-only overlays. Root independently inspected this config and the integrity-verified Nawabari 0.14.0 package. Its mandatory launcher uses `--proc /proc`; the readiness probe omits that mount. `doctor strict_ready=true` therefore did not establish strict execution. Linux documents restrictions on user-namespace proc mounts when existing entries are hidden or protected by other mounts ([procfs mount restrictions](https://cdn.kernel.org/doc/html/latest/filesystems/proc.html#mount-restrictions)). The diagnostic narrows the cause to proc visibility restrictions; no per-path comparison establishes a sufficient secure correction.

Landlock was unavailable in the container (`abi=null`, reduced defense), and the cgroup v2 mount was read-only. Outer `memory.max=536870912`, `cpu.max=100000 100000`, `pids.max=128` were read back. These are configured limits, not measured enforcement or per-session delegation. Host systemd delegation alone does not prove container-to-Nawabari delegation.

Sol's final independent replay used script SHA-256 `f6f8712c461162e1c04b74064862d088bf6ffeec64b81527c2b067c833375437`. Raw evidence is `/tmp/mottainai-oci-recovery-a-evidence.1lhki0wq`, log `/tmp/mottainai-oci-recovery-root-a-final.log`, OCI config SHA-256 `f33b2bf9a990c248d4abaf15a42834033a1045b029c1b727d99a6aa58110cec5`. Session `01a123c3-987a-7e70-9243-c436ac948923` was created at BASE; public strict run from its managed worktree reproduced exit 3/proc EPERM, and the independent nested proc probe reproduced exit 32. The script returned 0 because it correctly reproduced FAIL and reclaimed its state. OCI rootless/private PID/default seccomp and empty security/capability overrides were asserted. `/proc/self/uid_map` was `0 1000 1; 1 100000 65536`; `gid_map` was `0 100 1; 1 100000 65536`. Those maps were observed in the rootless namespace, not present as OCI `linux.uidMappings/gidMappings` (both null).

Two earlier coordinator artifact replays ended before the target strict launch: HEAD-only bundle cloning caused `DETACHED_HEAD`; after a named branch and explicit FHS runtime candidates were supplied, calling from main caused `PROTECTED_WORKTREE`. The artifact was corrected to run from the returned, path-checked managed session worktree. These are reproduction-script defects, not additional OCI failure causes; no guard was bypassed and no runtime source was changed. The final replay above supersedes neither the historical FAIL nor these recorded attempts.

The bounded comparison proposal is a **DECISION_REQUIRED**, unexecuted experiment: recreate one disposable rootless container with only `--security-opt=unmask=` for these 15 paths:

```text
/proc/acpi /proc/kcore /proc/keys /proc/latency_stats /proc/sched_debug
/proc/scsi /proc/timer_list /proc/timer_stats /proc/interrupts
/proc/asound /proc/bus /proc/fs /proc/irq /proc/sys /proc/sysrq-trigger
```

Retain private PID/user namespaces, default seccomp/capabilities, all non-proc masks, no host mounts/control socket, and the same image/limits. Removing proc masking/read-only overlays expands exposed kernel information/control, especially `/proc/sys`; this requires the user's security approval under Recovery A and Hard STOP item 2. Rollback removes only the comparison container and recreates it without that option; no global configuration change is proposed. This is neither an adoption configuration nor proof that all secure alternatives fail. No seccomp disabling, capability addition, privileged container, host PID sharing, root elevation or compat downgrade was performed.

## Recovery B: cancellation ownership

[PR #999](https://github.com/yohn-jp/mottainai/pull/999), HEAD `594ae4465a82c2a89ad9c1c0c7c9f8d78379896b`, adds only `OCI_RUNTIME_RECOVERY_B.md` (56 lines) and `scripts/poc/oci-recovery-b.sh` (434 lines). The script SHA-256 is `d677e1f893fc57a55a34606e42d14e1e6aebe2e5be2311c396f124c4d8441473`. It is independently based on main and remains unmerged.

Sol independently executed the exact stable script on the real host. Raw evidence is `/tmp/mottainai-oci-recovery-b-live.ei5L0mbw`; command log is `/tmp/mottainai-oci-recovery-root-b.log`.

| Trial | Measured result | Assessment |
| --- | --- | --- |
| Normal exec | stdout/stderr 36 bytes each, exit 23 | Component PASS |
| No-init immediate cancel | 144 ms; child host PID 167650, start ticks 1870631; `Z` at 0/100 ms/1 s/5 s | Cleanup guarantee FAIL |
| No-init delayed cancel | 955 ms after an 800 ms wait; PID 168038, start ticks 1871440; `Z` at all samples | Cleanup guarantee FAIL |
| Init immediate/delayed | 149/954 ms; shell/child absent at first and subsequent samples | Comparison observed; generic contract unproven |
| Container stop / explicit KILL | container and host wrapper exit 137 | Observation component PASS |
| Exact owned container removal | all sampled child identities absent afterward | Container cleanup PASS; not per-exec cancel proof |

Jinushi returned `cancelled`, `cleanup=complete`, `evidenceIncomplete=false` while no-init child zombies were adopted by container PID 1. Earlier worker evidence `/tmp/mottainai-oci-recovery-b-live.ZSnceJIQ` additionally records a live `S` child at 145 ms through five seconds (PID 158621, start ticks 1837661). Stable PID/start-time identities rule out reuse in these observations. Original Wave 1 PID 3332 remains **BLOCKED** for retrospective classification because its state/start time were never captured.

Root independently verified the actual Jinushi source at `13afd8f0c284b28a2899ab41721aaee1fab67389`, including pidfd identity fencing, descendant scanning, zombie handling, termination wait and supervisor cleanup publication. Fresh GitHub main was `f24d62a073a6933acba0a3416efc1087423efd64`; its diff contains only a gofmt workflow, so execution code is unchanged. Latest release was v0.1.1 at `44c5003b85442680b28a60cfa0f2e54890b04cc4`. Tested binary SHA-256: `f5ba762f019cf3f4a1a1502823d24ae46064b129a6f5db08d00a12419515e007`.

The public run/inspect/await/events/output/cancel contract owns the host argv process tree. Its termination algorithm waits for its cgroup/subreaper-owned tree and reaps adopted zombies. `podman exec` creates a distinct container-side process topology; a child reparented to container PID 1 leaves that tree. `cleanup complete` therefore proves Jinushi's local ownership cleanup, not container-wide reaping. No Jinushi defect requiring an owner-repository patch was established. `forced=false` is not proof of which inner PID received a signal. The stop/KILL trials are externally commanded container termination, not a Podman daemon crash or a typed Jinushi container-cause event.

`--init` changes both forwarding and reaping/topology. Its observed success does not establish a portable per-exec cancellation contract. A supported execution/cancellation binding must define immutable container ID, process PID/start identity and namespace/cgroup scope, operation ownership and independently checked postconditions. Container creation/deletion/resource authority remains Mottainai's.

## Integration acceptance and API blockers

| Required check | Status | Evidence / limit |
| --- | --- | --- |
| Rootless, nonprivileged container create/start/stop/remove | PASS | Disposable real containers with private PID namespace |
| Nawabari session creation | PASS | Real Debian/Nawabari 0.14.0 |
| Nawabari strict Agent Process | FAIL | Mandatory proc mount denied |
| Two simultaneous strict sessions | BLOCKED | Strict launch prerequisite failed |
| Sibling filesystem denial | BLOCKED | No successful protected session |
| Unauthorized host-file denial | BLOCKED | Historical container-boundary evidence retained; fresh strict-session proof unavailable |
| Landlock availability | FAIL | Reduced-defense reported; no weakening or substitution |
| Per-session cgroup delegation and CPU/memory/PID enforcement | BLOCKED | Read-only container cgroup mount; only outer settings read back |
| Jinushi stdout/stderr and exit code | PASS | Actual public CLI plus host wrapper |
| Generic per-exec cancel cleanup | FAIL | Live/zombie no-init leftovers despite host cleanup receipt |
| Container stop/forced termination observation | PASS | Exit 137; no typed container-cause integration claim |
| Process identity recording and fenced probe cleanup | PASS (probe) | PID/start snapshots, pidfd supervisor cleanup, full CID/name/label fences; no adversarial reuse injection |
| Nawabari → host Jinushi delegated tracking | BLOCKED | No supported public launch/observe/cancel seam |
| Tsukai AgentRun durable container/session/physical Run binding | BLOCKED | Not implemented or proven by this PoC |
| Integrated re-certification | BLOCKED | Necessary secure configuration and public contracts absent |

Nawabari 0.14.0 publicly exports only `./state`, `./contract`, `./manifest` and `package.json`. Its internal readiness callbacks return a boolean; they are not a host supervisor transport. Root verified launcher code, callback signatures and local cgroup readiness against npm tarball SRI `sha512-zCPsnYBf9jyR98vZ7MtX0tZyXAI5xxhhGg540Y+8Lz2e4Wc4jJQChv5P5xyXvwsmtfazkQFSTpUN99yCjiyEvg==`. Supported host-Jinushi delegation is missing independently of the proc mount failure. Successful `podman exec` wrapper receipts cannot replace it.

Current Mottainai's Tsukai/Pi construction creates a fixed host command and correlates `tsukai.agentRunId`; it does not establish durable container/session/physical-Jinushi-Run identity. No unsupported internal Nawabari API was adopted, and no host Jinushi socket was mounted into a container.

## Validation, cleanup and stopping point

Workers' source investigation and probes are separate from product CI. Recovery B ran `pnpm typecheck`, `pnpm test` (773 passed/0 failed), `pnpm build`, shell syntax, whitespace and its own live probe. Root reviewed the actual current B diff and independently reran its exact script; exit 0 means reproduction/classification and owned cleanup completed, not OCI compatibility PASS. Phase 0's corrected latest PR-contract run `38018195689` passed; earlier metadata failures remain visible. Recovery B's first PR-contract run failed with `GOVERNANCE_TEMPLATE_MARKER_MISSING`; its correct marker was moved from the body beginning to the footer, and the subsequent contract check passed.

**Remote CI remains FAIL for artifact scripts.** Phase 0 `standards-self-check` job `114113109031` rejected unowned `scripts/poc/oci-worker-a.sh` and `scripts/poc/oci-worker-b.sh`. B's job `114114570011` rejected `scripts/poc/oci-recovery-b.sh`. Logs are `/tmp/mottainai-wave1-standards-failed.log` and `/tmp/mottainai-recovery-b-standards-failed.log`. Existing `.github/workflows/ci.yml` ownership classes/gates do not register these shell PoCs; markdown reports are already exempt under the canonical census. No exemption, catch-all filter, weakened census, new CI class or bypass was added. The artifacts are preserved in unmerged PRs, with this publication blocker explicit. A genuine executable CI owner/gate must be agreed before merging these scripts; passing public-PR metadata is not passing all CI or host certification.

The coordinator ran frozen install, `pnpm typecheck`, `pnpm build`, `pnpm test:ci-ownership` (29 passed/0 failed), shell syntax and credential-pattern/whitespace/exact-scope checks in this report-only worktree. Logs are `/tmp/mottainai-oci-recovery-decision-{install,typecheck,build,ownership}.log`. The ownership tests here cover the actual report branch; they do not certify other branches containing unowned scripts. No full production/integration suite or mock substituted for real-host acceptance. This report's committed HEAD and PR are recorded in Issue #998's publication comment to avoid self-referencing a commit hash inside its own content.

Owned OCI stores/containers from A and B were reclaimed, including the two failed artifact replays. Root's B probe removed all seven containers; its supervisor PID 167124 and the final worker B supervisor PID 163638 are absent. Final A CID `5ef6b62adc888df443601b0ab644b4cf597f20c46c3461935c244d41f1445eb9` was removed and its isolated inventory was empty. The owned A/B state-directory checks were empty. Policy restoration on `2026-10-10T03:04:16Z` compared dev/inode/uid/gid/mode/size/SHA-256 against the exclusive-create record, then removed only the matching temporary file. `/home/sophia/.config/containers/policy.json` is absent and its pre-existing parent directory is preserved. Cleanup evidence is `/tmp/mottainai-oci-recovery-cleanup.json`; raw reports/logs/source archives remain for audit. Existing host configuration, containers and persistent data were not altered. No privileged follow-up or new cross-authority repair was performed.

**Decision:** HOLD rather than REJECT because the measured default failures do not prove incompatibility with every permissible secure configuration. ACCEPT is unavailable because strict execution, mandatory tracking/cancellation contracts and integrated isolation/enforcement evidence are missing. Phase 2 production repair and Phase 3 integrated re-certification were not performed. Hard STOP items 2 and 3 apply; no Phase 0/recovery PR is merged and no merged-main repair is assumed.

Required decisions before another authorized recovery are: approve or reject the exact proc-visibility comparison; agree supported Nawabari cgroup/process-tracking delegation to host Jinushi; define the per-exec cancellation and Tsukai identity binding with each owner. After lawful repairs are available in one actual configuration, all conditional checks still require real-host integrated execution. Git Persistence, Resource Grant, OCI Provisioner, Manager UI, Runtime Primary and QEMU/KVM remain outside this session.
