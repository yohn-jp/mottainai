# Canonical Runtime Appliance Lima delivery probe (Issue #655)

This probe is the physical-delivery pre-adoption experiment for Issue #655 and
parent architecture decision #600, following the Lima lifecycle probe in
[docs/testing/integration/lima-validation-probe](lima-validation-probe.md) (#649). It answers
one narrower question: can the _exact_ raw disk built by
`nix build .#runtime-appliance-image` boot and remain usable when Lima consumes
it directly, rather than Lima's own `template:alpine` base image?

It is a research/evidence harness only. It does not implement a Lima provider,
and it does not build a surrogate NixOS guest configuration. The only appliance
input it accepts is the exact `runtime-appliance-image` raw disk, verified
byte-for-byte against its manifest before Lima is invoked.

## Pre-run readiness hypothesis

Repository inspection and Lima's documented guest-readiness model indicate a
specific compatibility risk that the native run must resolve:

- Lima's `Running`/SSH-readiness path uses guest-side readiness markers such as
  `/run/lima-boot-done` and `/run/lima-ssh-ready`, normally established by
  Lima guest provisioning.
- The canonical Runtime Appliance intentionally does not include cloud-init or
  a Lima-specific guest bootstrap. It has its own provider-independent,
  bounded first-boot SSH-key mechanism using a block device labeled
  `MTNAI_BOOT`.
- Adding cloud-init or a Lima-specific boot script solely to satisfy Lima would
  change canonical guest semantics and is outside Issue #655.

This is a **hypothesis to verify on a real Linux/KVM host**, not a completed
native finding. Fixture tests can prove that the probe records this failure
shape correctly; they cannot prove that real Lima takes that path on the
canonical appliance.

If the native run shows `limactl start` cannot reach its required state and the
returned evidence establishes that this readiness boundary is the exact
incompatibility, Issue #655's explicit stop condition applies: document the
incompatibility and do not create a Lima-specific NixOS fork. If Lima reaches
`Running`, the probe continues normally and records that result instead.

## What the probe measures

The probe attempts the following without modifying canonical guest semantics:

1. Verify the exact appliance disk size and SHA-256 against its bounded
   manifest.
2. Ask Lima to consume that disk through documented/public `images:`
   configuration.
3. Attach an `additionalDisks:` key-carrier disk labeled `MTNAI_BOOT`, using
   the appliance's existing first-boot SSH-key contract.
4. Run `limactl start` and record its actual result and machine-readable Lima
   state without treating a fixture expectation as native evidence.
5. When Lima exposes an SSH local port, attempt direct SSH to the appliance and
   run `nix --version`.
6. If SSH succeeds, write a persistent sentinel under
   `/var/lib/mottainai-control/`, request a guest reboot, reconnect, and verify
   the sentinel survived.
7. Attempt cleanup and retain bounded machine-readable evidence and bounded
   command logs.

The evidence keeps Lima's own reported state separate from direct guest
usability. A native run may therefore distinguish a provider-readiness failure
from a guest that is independently reachable; neither conclusion is claimed
until the native evidence exists.

## Run on a native Linux/KVM host

Prerequisites:

- native Linux on `x86_64` or `aarch64`;
- a Lima installation providing `limactl` and its QEMU driver;
- a user that can open `/dev/kvm` read/write;
- Node.js 24 or later;
- `ssh` and `ssh-keygen`;
- `mkfs.vfat` and `mcopy` (Debian/Ubuntu: `dosfstools` and `mtools`);
- Nix with flakes enabled.

The probe does not install packages, change `/dev/kvm` permissions, or edit
Lima configuration outside its isolated `LIMA_HOME`. The one `sudo -n
systemctl reboot` is issued _inside the guest_ through the existing
`mottainai-control` sudo rule.

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

Exit status `0` means the guest-usability checks reached by the native run
(direct SSH, `nix --version`, and sentinel-survives-reboot) passed. Exit status
`1` means a prerequisite, disk-identity, Lima/guest-usability, or cleanup check
failed. Exit status `2` means usage or an unexpected probe error.

Do not infer a general Lima incompatibility from fixture tests or from the exit
status alone. Review the returned `steps`, `lima_reported_running`, and
`appliance_boot_blocked_diagnostic` fields together with the bounded logs.

## Isolation and cleanup

Each run creates fresh temporary `LIMA_HOME`, `HOME`, and `XDG_CACHE_HOME`
locations for child `limactl` processes and a fresh ephemeral SSH keypair. The
instance name defaults to `mottainai-655-appliance-probe`. Cleanup attempts
`limactl delete --force` regardless of outcome and verifies post-delete
absence with public `limactl list --format json` output. If cleanup cannot be
confirmed, preserve the diagnostic and temporary state location recorded by
the probe.

## Evidence to return

Return these files without editing them:

```text
./lima-appliance-boot-evidence.json
./lima-appliance-boot-logs/
```

The JSON evidence records the appliance manifest identity and recomputed disk
digest, Lima version, host OS/architecture/KVM observations, each attempted
step and its observed result, `lima_reported_running`, any bounded blocked
diagnostic, and the overall result. The log directory is supplementary
diagnostic evidence only.

## Acceptance interpretation

Only a **real Linux/KVM execution** can satisfy the physical-delivery evidence
requirement. There are two legitimate native outcomes under Issue #655:

- the canonical appliance is usable through Lima and the reached SSH/Nix/reboot
  checks pass; or
- the evidence identifies the exact Lima/canonical-guest incompatibility that
  would require changing canonical guest semantics, in which case work stops
  and the incompatibility is documented.

Fixture-driven unit tests prove only the harness, parsing, isolation, and
fail-closed evidence behavior. They are not native acceptance evidence.

## Non-goals

No managed Mottainai, Nawabari, or Zellij installation; no managed-generation,
update, or rollback lifecycle; no #630/#653 golden-path semantics; no production
Lima provider implementation; and no Lima-specific fork of the canonical
Runtime Appliance.
