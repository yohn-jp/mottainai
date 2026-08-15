# Canonical local Runtime

`mottainai init --runtime` owns one local Runtime profile,
`mottainai-local-runtime-v1`. Ensuring the Runtime is opt-in and separate from
MCP client registration: plain `mottainai init` only sets up the MCP
configuration/clients, so hosts without a hardware accelerator (CI, containers,
sandboxes) can still complete client setup. `--runtime` is required to
additionally ensure the local Runtime.

The profile is intentionally not a user-selectable provider: QEMU is always the
machine substrate, with `KVM` on Linux, `HVF` on macOS, and `WHPX` on Windows.
If the required accelerator is unavailable, `--runtime` fails with an
actionable diagnostic rather than silently skipping Runtime provisioning. It
never selects TCG, WSL/WSL2, a host-native process, or an arbitrary system
QEMU installation.

The state root is user-owned and platform-native (`XDG_STATE_HOME` on Linux,
`~/Library/Application Support` on macOS, and `%LOCALAPPDATA%` on Windows).
The state contains one stable machine id, the pinned QEMU build identity, the
locked #231 Runtime image identity, the private QMP endpoint, the fixed SSH
forward (`127.0.0.1:48321`), and the SSH host-key record. State writes are
atomic and serialized by a recoverable per-machine lock; an interrupted
operation cannot cause a disk or identity reset.

QEMU and the Runtime image are lazy release artifacts. Their manifests contain
SHA-256 integrity records, source provenance, GPL corresponding-source data,
runtime-library/firmware requirements, and the #231 contract/build identity.
The release image is a projection of `nix/flake.nix`; the TypeScript machine
adapter does not define a second guest configuration. Host-side lifecycle uses
the private QMP socket only. Guest health and reconciliation use the versioned
SSH contract (`mottainai-runtime-health` and the bounded
`mottainai-runtime-reconcile` command); QEMU Guest Agent is not used.

The v1 lifecycle is bounded and explicit: absent, creating, booting, reachable,
reconciling, ready, incompatible, repairable, and recreate-required. A
corrupt image, changed SSH host key, incompatible Runtime contract, or missing
accelerator is an error rather than a destructive guess.

Release staging runs the locked Nix output first and then uses
`scripts/build-runtime-image-manifest.mjs` to record kernel/initrd/disk hashes,
the lockfile digest, and the pinned SSH host key. The reusable
`.github/workflows/runtime-qemu-artifacts.yml` matrix builds QEMU 9.2.2 from
the pinned upstream source on each supported host, and
`scripts/build-runtime-qemu-manifest.mjs` stages the executable, firmware,
runtime libraries (or records a static-link dependency mode), license files,
and provenance into a deterministic archive. The generated sidecar manifest
contains only real hashes and is verified by
`scripts/verify-runtime-qemu-artifact.mjs` before an OS-specific integration
job consumes it. `scripts/runtime-qemu-boot-smoke.mjs` is an artifact-level
process smoke primitive; it does not claim KVM/HVF/WHPX or guest-boot evidence.
