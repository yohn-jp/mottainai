# Canonical Runtime Appliance Lima boot probe (Issue #655)

This probe is the physical-delivery pre-adoption proof for Issue #655 and
parent architecture decision #600, following the Lima lifecycle proof in
[docs/lima-validation-probe.md](lima-validation-probe.md) (#649). It answers
one narrower question that probe does not: does the _exact_ raw disk built by
`nix build .#runtime-appliance-image` boot and remain usable when Lima
consumes it directly, rather than Lima's own `template:alpine` base image?

It is a research/evidence harness only. It does not implement a Lima
provider, and it does not build a surrogate NixOS guest configuration — the
only input disk it ever boots is the one `nix build .#runtime-appliance-image`
produced, verified byte-for-byte against its published manifest before Lima
ever touches it.

## Result: confirmed incompatibility, not a passing boot

**`limactl start` cannot reach `Running` against the canonical appliance
without changing canonical NixOS guest semantics.** This is not a
configuration bug in this probe; it is how Lima is documented to work:

- Lima's own boot-readiness gate (the `Running` status `limactl start` and
  `limactl list` report) is driven by two guest-side marker files,
  `/run/lima-boot-done` and `/run/lima-ssh-ready`. Both are written by
  Lima's `boot.sh` provisioning scripts, which Lima delivers to the guest
  through a cloud-init NoCloud `cidata.iso` seed and which only run if the
  guest has cloud-init (or an equivalent Lima-aware `lima-init`) installed
  and configured to consume that seed.
- This is unchanged by `--plain` mode: plain mode disables Lima's mounts,
  dynamic port forwarding, containerd, guest agent, and Rosetta, but its own
  documentation states that "the base user and SSH keys are still
  configured" — i.e. plain mode still depends on the same cloud-init-consumed
  provisioning path for guest readiness.
- No documented/public `limactl` flag (`start --timeout`, `--tty`, `--set`,
  or any other) changes what "ready" means or skips this gate.
- The canonical `.#runtime-appliance-image`
  ([nix/runtime-appliance-image.nix](../nix/runtime-appliance-image.nix),
  [nix/modules/runtime.nix](../nix/modules/runtime.nix)) has no cloud-init in
  its closure by design — only the standard `nixos-generators`/NixOS
  `qemu-guest` profile — and never runs Lima's `boot.sh`. It has its own,
  independent, bounded first-boot SSH-key bootstrap (a labeled `MTNAI_BOOT`
  block device consumed once by
  `mottainai-runtime-bootstrap-authorized-keys.service`), which is the
  correct and only key-delivery mechanism for this appliance and must not be
  replaced or duplicated by a Lima-specific one.

Making `limactl start` converge would require adding cloud-init (or a
Lima-specific `lima-init`-equivalent boot script) to the canonical appliance
closure — a change to canonical NixOS guest semantics that both the Issue and
[nix/runtime-appliance-image.nix](../nix/runtime-appliance-image.nix)'s own
comments explicitly forbid. This probe does not make that change. It stops at
the incompatibility and documents it, per the Issue's own instruction.

## What the probe still proves

Lima's `Running` status label is not the same question as "is the appliance
usable." The QEMU `vmType: qemu` driver's default user-mode networking still
establishes an ordinary SSH port-forward (`sshLocalPort`, reported by
`limactl list --all-fields --format json`) from the host to the guest's
sshd, independent of Lima's cloud-init-gated readiness state. This probe:

1. Boots the exact appliance disk through Lima via the documented/public
   `images: [{location: "file://...", arch, digest}]` limayaml field —
   substituting _which bytes_ Lima boots, not any guest-visible behavior.
2. Attaches a small FAT-formatted `additionalDisks` raw disk labeled
   `MTNAI_BOOT` carrying one `authorized_keys` file — the same delivery
   mechanism the canonical appliance's own bootstrap service already expects
   from any block-device source, provider-independent.
3. Records `limactl start`'s expected failure as first-class bounded
   evidence (`limactl-start-readiness-gate`, `lima_reported_running: false`).
4. Independently reaches the guest by plain `ssh` over the QEMU
   host-forwarded `sshLocalPort`, authenticating with the bootstrap key,
   bypassing `limactl shell` (which itself depends on the same blocked
   guest-agent path).
5. Runs `nix --version` over that direct SSH connection.
6. Writes one persistent sentinel file under
   `/var/lib/mottainai-control/`, issues a guest-initiated
   `systemctl reboot` (not `limactl restart`, which is itself gated on the
   same never-converging status machine), and reconnects over SSH to verify
   the sentinel survived.

The probe's overall `pass`/`fail` therefore reflects guest usability
(direct SSH, `nix --version`, sentinel-survives-reboot), not Lima's own
status label — and separately records `lima_reported_running` so the two
questions are never conflated in the evidence.

## Run on a native Linux/KVM host

Prerequisites:

- native Linux on `x86_64` or `aarch64` (the guest architecture follows the
  host architecture);
- a Lima installation providing `limactl` and its QEMU driver;
- a user that can open `/dev/kvm` read/write;
- Node.js 22.13 or later;
- `ssh` and `ssh-keygen` (OpenSSH client);
- `mkfs.vfat` and `mcopy` (Debian/Ubuntu: `dosfstools` and `mtools`) to build
  the small `MTNAI_BOOT` key-carrier disk;
- Nix with flakes enabled, to build the exact appliance disk.

The probe does not install packages, change `/dev/kvm` permissions, edit Lima
configuration outside its own isolated `LIMA_HOME`, or require `sudo` (the
one `sudo -n systemctl reboot` runs _inside the guest_, via the
`mottainai-control` sudo rule the canonical appliance already grants — see
[nix/modules/runtime.nix](../nix/modules/runtime.nix)).

```bash
git clone https://github.com/yohn-jp/mottainai.git
cd mottainai
git checkout test/655-runtime-appliance-lima-boot

nix build .#runtime-appliance-image --print-out-paths > /tmp/image-output.txt
image_output="$(cat /tmp/image-output.txt)"
mottainai_version="$(nix eval --raw .#packages.x86_64-linux.mottainai.version)"
nawabari_version="$(nix eval --raw .#packages.x86_64-linux.nawabari.version)"
source_revision="$(git rev-parse HEAD)"

node scripts/build-runtime-appliance-manifest.mjs \
  --architecture x86_64-linux \
  --image-output "$image_output" \
  --source-revision "$source_revision" \
  --mottainai-version "$mottainai_version" \
  --nawabari-version "$nawabari_version" \
  --output ./lima-appliance-boot-artifact

node scripts/lima-appliance-boot-probe.mjs \
  --manifest ./lima-appliance-boot-artifact/x86_64-linux/runtime-appliance-manifest.json \
  --disk ./lima-appliance-boot-artifact/x86_64-linux/mottainai-runtime-appliance.raw \
  --output ./lima-appliance-boot-evidence.json \
  --logs ./lima-appliance-boot-logs
```

Exit status `0` means the guest usability checks (direct SSH, `nix
--version`, sentinel-survives-reboot) all passed. Exit status `1` means a
prerequisite, disk-identity, or guest-usability check failed, or cleanup
could not be confirmed. `lima_reported_running: false` in the evidence is the
**expected** outcome given the incompatibility above; it does not by itself
mean the run failed. Exit status `2` means usage or an unexpected probe
error.

## Isolation and cleanup

Each run creates a fresh temporary `LIMA_HOME`, `HOME`, and `XDG_CACHE_HOME`
for the child `limactl` processes, and a fresh ephemeral SSH keypair used
only for the appliance's bootstrap-key delivery — the same isolation pattern
as [docs/lima-validation-probe.md](lima-validation-probe.md). The instance
name defaults to `mottainai-655-appliance-probe`. The probe attempts
`limactl delete --force` in its final phase regardless of outcome, and
verifies post-delete absence with public `limactl list --format json`. If
cleanup fails, the evidence records `isolated_state_removed: false` and the
temporary `LIMA_HOME` path; preserve that diagnostic for review.

## Evidence to return

Return these files without editing them:

```text
./lima-appliance-boot-evidence.json
./lima-appliance-boot-logs/
```

The JSON file's top-level fields cover: appliance manifest identity and
recomputed disk digest (`appliance.manifest`, `appliance.disk_verification`),
Lima version (`lima.version`), host OS/architecture/KVM observation
(`host`), every step's expected/observed state and pass/fail
(`steps`), and the overall result including `lima_reported_running` and
`appliance_boot_blocked_diagnostic` (`result`). Each child SSH/Lima command's
raw stdout/stderr is retained under `--logs`.

## Non-goals

Same non-goals as Issue #655 itself: no managed Mottainai, Nawabari, or
Zellij installation; no managed-generation, update, or rollback exercise; no
#630/#653 golden-path lifecycle semantics; no Lima provider implementation in
Mottainai. This probe only proves and bounds the physical delivery question.
