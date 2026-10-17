# OCI runtime recovery: Jinushi cancellation boundary

## Result

The Wave 1 `podman exec` wrapper does not provide a reliable container-process cleanup guarantee. Fresh no-init Debian trials returned Jinushi receipts with `outcome=cancelled`, `cleanup=complete`, `evidenceIncomplete=false`, and `forced=false`, while the wrapper was gone and the in-container child was either still live or remained a zombie under container PID 1. The exact historical Wave 1 PID cannot be classified because its state and start time were not recorded before its container was removed. Equivalent child processes had different states at five seconds across runs: one remained live, while others were zombies.

This is a lifecycle/API boundary, not an established Jinushi defect. Jinushi accepts a local executable and owns the host process tree it creates. It does not expose a Podman container or remote exec-process API. Mottainai must retain container creation, removal, resource policy, and any container-scoped recovery decision; a Jinushi cleanup receipt alone cannot certify that an OCI exec process or its PID entry has been reaped.

## Measured behavior

The final run used rootless Podman 5.8.8 with crun 1.30.1 on NixOS kernel 6.18.52, as uid 1000 in a VMware guest. It used Debian image index digest `sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5` in a private VFS graphroot and an isolated Jinushi state directory. Podman reported rootless mode and the systemd cgroup manager. Each container was created with a unique name and label, a full 64-character ID, 512 MiB memory, one CPU, and a 128-process limit. No privileged mode, host PID namespace, host socket, shared production container, or host policy edit was used. The temporary Debian-only signature policy was already authorized and owned by the coordinating task; the digest was pinned, but the image signature was not independently verified.

The no-init cancellation samples were:

| Trial | Cancel request after marker | Container shell | Child at 0–5 s after cancel | Jinushi receipt |
| --- | ---: | --- | --- | --- |
| Immediate | 140 ms | inner PID 2 / host PID 164185 disappeared | inner PID 3 / host PID 164186, start time 1858641, state `Z` through 5 s; PPID changed from shell 164185 to container init 164102 | generation 6, cancelled, exit 1, cleanup complete, no force, evidence complete |
| Delayed | 945 ms after an 800 ms wait | inner PID 2 / host PID 164569 disappeared | inner PID 3 / host PID 164570, start time 1859450, state `Z` through 5 s; PPID changed from shell 164569 to container init 164493 | generation 6, cancelled, exit 1, cleanup complete, no force, evidence complete |

Both targets retained the same PID plus `/proc` start time during observation, so neither was PID reuse or a short sampling delay. The exact Wave 1 PID `3332` remains unclassifiable from its original evidence. A separate immediate trial at 145 ms remained live (`S`) through 5 seconds (`/tmp/mottainai-oci-recovery-b-live.ZSnceJIQ`); the two no-init rows in `/tmp/mottainai-oci-recovery-b-live.VBPeuknC` were both zombies. Delayed repetitions at 944–982 ms produced zombies. The variation is why the old `HPID=?` row cannot be interpreted from a process-list line alone.

In the baseline container, shell and child shared host process group 164185 and the container cgroup `libpod-<full-CID>.scope/container`; the Jinushi-owned Podman wrapper PID/process group was 164149 in its separate `podman-164149.scope`. In the other samples, the same separation held. After the shell exited, the child was reparented to container PID 1, outside Jinushi's per-Run subreaper tree. Full-ID container removal then made the host child PID absent. That removal is Mottainai-owned container cleanup, not per-exec cancellation success.

The bounded `podman run --init` comparison used separate containers with the same image, limits, and cancellation timings. Podman inspect reported PID 1 as `/run/podman-init`, and `podman top` showed `podman-init` as PID 1. At both immediate and delayed timings, the shell and child were already absent at the first post-cancel sample. The observed result differs under `--init`, but this comparison does not isolate reaping from its changed signal-forwarding and process topology. It does not establish `--init` as a repair or as a portable production contract; the option needs a separate runtime decision.

Other checks passed for the outer command/lifecycle path:

- A `podman exec` command emitted stdout and stderr markers (36 bytes each) and Jinushi observed exit code 23.
- `podman stop --time 1` while a supervised exec was active returned success; Podman reported the container exited with code 137 and Jinushi recorded a terminal `exited` Run, exit 137, cleanup complete.
- An explicit `podman kill --signal KILL` produced the same observed container/run exit code 137 and cleanup result. This checks forced container termination, not a Podman daemon crash.
- Jinushi events recorded accepted, starting, running, output, termination/cancel request, terminating, and terminal events. They did not identify which in-container PID received a signal. `forced=false` says Jinushi did not escalate its owned host Run to SIGKILL; it is not per-container signal-delivery evidence.

The isolated raw evidence for the final corrected script run is `/tmp/mottainai-oci-recovery-b-live.71oRKSTm`. It includes versions and Podman info, image metadata, full CIDs, Jinushi submissions/receipts/events/output, before/after process snapshots, container inspect/top output, command log, and cleanup record. An independent fresh run of the unchanged script is `/tmp/mottainai-oci-recovery-b-live.ei5L0mbw`; it reproduced both no-init zombie observations and both `--init` absent-process observations. The earlier live immediate child is in `/tmp/mottainai-oci-recovery-b-live.ZSnceJIQ`.

## Jinushi contract and repair boundary

The installed Jinushi binary is `/nix/store/a8gq62lad67pgdzyf5jp2si33zphhpq3-jinushi-13afd8f/bin/jinushi`, SHA-256 `f5ba762f019cf3f4a1a1502823d24ae46064b129a6f5db08d00a12419515e007`. Its source checkout is `/home/sophia/src/jinushi` at `13afd8f0c284b28a2899ab41721aaee1fab67389`. GitHub main was rechecked at `f24d62a073a6933acba0a3416efc1087423efd64`; the comparison from the installed source contains only `.github/workflows/gofmt-autofix.yml`, so the examined Linux execution code is unchanged. The latest release is v0.1.1 at `44c5003b85442680b28a60cfa0f2e54890b04cc4`.

Jinushi `Terminate` sends SIGTERM, waits its configured grace period, then escalates to SIGKILL only if the owned process has not exited. The Linux backend scans descendants of the per-Run child subreaper, validates PID/start identity and boot identity, and uses pidfd signaling. Its wait loop checks that cgroup or subreaper-owned process tree; the subreaper path reaps zombies adopted by that subreaper and excludes zombie states from active processes. The supervisor marks cleanup complete when this physical termination result is complete. These source paths describe the boundary directly: [process.go](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/backend/linux/process.go#L120-L155), [backend.go](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/backend/linux/backend.go#L608-L628), [proc.go tree ownership](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/backend/linux/proc.go#L188-L230), [proc.go zombie handling](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/backend/linux/proc.go#L262-L286), [process.go tree wait](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/backend/linux/process.go#L476-L503), and [service.go termination](https://github.com/yohn-jp/jinushi/blob/f24d62a073a6933acba0a3416efc1087423efd64/internal/supervisor/service.go#L1354-L1370).

The live command used only the public `run`, `inspect`, `await`, `events`, `output`, and generation-fenced `cancel` operations. The Run argv was the host Podman CLI invocation; `containerId` was an opaque correlation value. Neither that public request nor its receipt binds an inner PID, PID namespace, container cgroup, or container lifecycle. The observed cleanup receipt therefore proves the local Jinushi-owned process tree ended, not that every process entry under the container PID namespace was reaped. No source repair in Jinushi is recommended from this evidence.

The minimum Wave 2 decision is an Mottainai-owned OCI execution/cancellation binding: keep the immutable full container ID and host/inner process identity, define which runtime operation owns per-run cancellation and container cleanup, and independently verify the expected process/container state before reporting AgentRun cleanup. Decide whether an init process is required only after validating its forwarding/reaping behavior against the accepted runtime contract. Do not expose Jinushi's host control socket to a container or transfer container create/remove/resource authority to Jinushi.

## Reproduction and validation

From the task worktree, the final run used:

```sh
bash -n scripts/poc/oci-recovery-b.sh
nix shell nixpkgs#python3 --command scripts/poc/oci-recovery-b.sh
```

The script uses fixed Podman/crun/Jinushi Nix store binaries, creates one isolated graphroot and a separate Jinushi supervisor, then exercises normal exit, immediate and bounded delayed cancellation with and without `--init`, container stop, and container SIGKILL. It preserves evidence under the printed `/tmp/mottainai-oci-recovery-b-live.*` path. Cleanup verifies each container's exact full ID, generated name, and unique label; it stops/removes only those containers, requires `podman ps --all --no-trunc` to succeed with no remaining containers, and only then removes its private graphroot. The isolated Jinushi supervisor is stopped with a PID/starttime/argv/uid-fenced pidfd SIGTERM. Failure to verify either cleanup boundary retains the private state and returns nonzero.

On HEAD `152da3c3a61900fa65db8b0abce44fdcb170b73b`, `pnpm typecheck`, `pnpm test` (773 passed, 0 failed), and `pnpm build` all exited 0. The final script passed `bash -n`; the full live probe and `git diff --check` also exited 0. The cancellation component is still a **FAIL** for generic no-init `podman exec` cleanup despite the successful wrapper receipt; the `--init` rows are comparison evidence only. The historical Wave 1 PID classification is **BLOCKED** by the missing original `/proc` identity samples. No production Mottainai, Jinushi, host-policy, or runtime files were changed; this leaf adds only the report and reproduction script.
