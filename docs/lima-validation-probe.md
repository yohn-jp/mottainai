# Lima Linux/KVM validation probe

This probe is the pre-adoption validation for Issue #649 and parent architecture decision #600. It is a research harness only; it does not implement the Lima provider or the Runtime Appliance.

## Run on a native Linux/KVM host

Prerequisites:

- native Linux on `x86_64` or `aarch64` (the guest architecture follows the host architecture);
- a Lima installation providing `limactl` and its QEMU driver;
- a user that can open `/dev/kvm` read/write;
- Node.js 22.13 or later;
- network access for Lima's built-in `template:alpine` image on the first run.

The probe does not install packages, change `/dev/kvm` permissions, edit Lima configuration, or require `sudo`.

Obtain the repository and check out the exact review commit or branch, then run one command from the repository root:

```bash
git clone https://github.com/yohn-jp/mottainai.git
cd mottainai
git checkout docs/649-lima-lifecycle-reconciliation
node scripts/lima-validation-probe.mjs \
  --output ./lima-validation-evidence.json \
  --logs ./lima-validation-logs
```

For a script copied outside a Git checkout, pass the source revision explicitly:

```bash
node lima-validation-probe.mjs \
  --revision <mottainai-commit> \
  --output ./lima-validation-evidence.json \
  --logs ./lima-validation-logs
```

Exit status `0` means every probe check passed. Exit status `1` means a prerequisite, lifecycle, identity, acceleration, or cleanup check failed. Exit status `2` means usage or an unexpected probe error.

## Isolation and cleanup

Each run creates a fresh temporary `LIMA_HOME`, `HOME`, and `XDG_CACHE_HOME` for the child `limactl` processes. The instance name defaults to `mottainai-649-probe`. The guest is created from Lima's public `template:alpine` with native architecture, `vmType: qemu`, one CPU, 1 GiB memory, an 8 GiB disk, and `--plain`. Plain mode disables host filesystem mounts, port forwarding, containerd, and the Lima guest agent; no host home directory is mounted.

The probe attempts `limactl delete --force mottainai-649-probe` in its final phase, including after an ordinary probe failure, and verifies post-delete absence with public `limactl list --format json`. The temporary Lima state is removed only after both checks succeed. If cleanup fails, the evidence records `isolated_state_removed: false` and the temporary `LIMA_HOME` path; preserve that diagnostic for review. The evidence and bounded command logs are intentionally left at the paths passed to `--output` and `--logs`.

The probe never reads Lima instance files, private sockets, QEMU process state, or internal Go APIs. It does not start, stop, or configure QEMU directly.

## What is observed

The probe uses these [public Lima surfaces](https://lima-vm.io/docs/reference/):

| Purpose                         | Public interface                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| availability/version            | `limactl --version`                                                                                     |
| machine-readable state          | [`limactl list --all-fields --format json [INSTANCE]`](https://lima-vm.io/docs/reference/limactl_list/) |
| creation and lifecycle          | `limactl create`, `start`, `stop`, `restart`, `delete --force`                                          |
| guest health/recovery           | `limactl shell <INSTANCE> /bin/true`                                                                    |
| KVM selection/error observation | `limactl --log-format json --log-level debug start/restart`                                             |

KVM validation has two independent gates:

1. the invoking user must be able to open the native `/dev/kvm` character device read/write;
2. Lima's documented JSON logging controls must expose QEMU arguments selecting `accel=kvm`, and the captured Lima log must contain no KVM initialization error or `falling back to tcg` diagnostic.

If the debug JSON does not expose QEMU arguments, if its output is ambiguous, or if the accelerator cannot be determined, the probe fails closed. This is deliberate: the probe does not substitute private-state polling or direct QEMU/QMP inspection for missing public evidence. The accelerator observation is recorded as `virtualization.actual_acceleration`. The `--plain` isolation behavior and `LIMA_HOME` override are documented by Lima's [plain-mode](https://lima-vm.io/docs/config/plain/) and [environment-variable](https://lima-vm.io/docs/config/environment-variables/) references.

The primary evidence is one bounded JSON document. It contains the Mottainai revision, probe version, host OS and architecture, Lima version, KVM observations, every lifecycle step's expected and observed state, exit status, duration, public instance identity, pass/fail state, and short diagnostics. Each child stream is separately retained under `--logs`, capped at 64 KiB per stream, and marked as truncated in the command result when applicable.

The lifecycle sequence is:

1. host prerequisites and Lima version;
2. missing-instance lookup;
3. create and stopped inspection;
4. start, KVM observation, and running inspection;
5. repeated start/ensure and two concurrent start calls;
6. guest shell health check;
7. stop, repeated stop, and stopped inspections;
8. start, restart, stable-identity inspection, and guest recovery check;
9. final stop, stopped inspection, forced cleanup, and evidence retention.

The probe also runs deterministic local guard fixtures for unsupported VM type, ambiguous status, and incomplete inspection. These fixtures prove the harness's fail-closed logic; they are not native Linux/KVM acceptance evidence.

## Evidence to return

Return these files without editing them:

```text
./lima-validation-evidence.json
./lima-validation-logs/
```

The JSON file is the review entry point. The log directory is supplementary diagnostic evidence only. Do not return any other `$HOME`, `.lima`, socket, PID, or host configuration files.

## Acceptance boundary

Automated fixture tests in this repository verify parsing, fail-closed guards, KVM-log interpretation, prerequisite observation, command isolation, and the lifecycle harness using fake `limactl` output. They do not pass the Issue's native Linux/KVM acceptance criteria.

The real acceptance decision remains pending until a human runs the command above on a native Linux/KVM host and returns the evidence JSON plus separate bounded logs. A successful local test run or mocked probe run must not be interpreted as proof that Lima uses KVM on the target host.
