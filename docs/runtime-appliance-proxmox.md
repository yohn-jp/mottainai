# Manual Proxmox Runtime Appliance import/boot (Issue #601)

Exact, reproducible steps to import the canonical Mottainai Runtime
Appliance disk artifact published by GitHub Actions
(`.github/workflows/ci.yml`, job `runtime-appliance-artifact`) into a real
Proxmox VE host and prove it boots, becomes network-reachable, accepts SSH,
runs Mottainai/Nawabari/Zellij, reports Runtime health, and preserves
required persistent state across a reboot.

This is manual integration evidence, distinct from the automated CI build
evidence and from later Runtime-provider support evidence — see
[`docs/linux-runtime-contract.md`](linux-runtime-contract.md#distributiondelivery-evidence-issue-601).
It does not make Proxmox a required or automated Runtime provider, does not
rebuild or mutate the canonical guest definition
(`nix/modules/runtime.nix`), and reuses the same `mottainai.runtime`
module the local Runtime golden path
([`docs/nix-runtime-golden-path.md`](nix-runtime-golden-path.md)) already
proves.

## 0. Why one manual customization step is unavoidable

The canonical Runtime module ships with `controlAuthorizedKeys = []` by
default so "a fresh generic Runtime cannot be accessed accidentally"
(`nix/modules/runtime.nix`). A publicly downloadable CI artifact must keep
that default — baking a real key into a broadly distributed image would be
publishing a reusable credential, which Issue #601 explicitly forbids.

That means the artifact as downloaded has no SSH access and no root
password (`PermitRootLogin no`, `PasswordAuthentication no`, no root
password set) by design. Getting SSH access therefore needs exactly one
bounded, manual, non-automated step: writing your own public key into the
already-built disk's `/etc/ssh/authorized_keys.d/mottainai-control` file
before first boot.

This is a plain filesystem edit of one ordinary `/etc` file on the disk
instance you downloaded — not a Nix rebuild, and not an edit to anything
under `/nix/store` (so the disk's `nixSystemClosure` identity is untouched).
It is the Proxmox-side equivalent of the `controlAuthorizedKeys` value the
existing local golden path already supplies at build time
(`nix/deployments/golden-path.nix`); a generic downloadable artifact can
only supply it after download, since it has no per-installation build step.

## 1. Download and verify the exact Actions artifact

From the `runtime-appliance-artifact` job of the relevant GitHub Actions
run, download the `mottainai-runtime-appliance-x86_64-linux` artifact. It
contains:

- `mottainai-runtime-appliance.raw` — the canonical self-bootable disk.
- `runtime-appliance-manifest.json` — its bounded
  `mottainai.linux-runtime-appliance.v1` manifest.

Verify the disk you downloaded is byte-identical to what CI built and
verified, **before** the customization step in §2:

```sh
jq -r '.image.sha256' runtime-appliance-manifest.json
sha256sum mottainai-runtime-appliance.raw
# the two values above must match
jq '{contractId, schemaVersion, architecture, sourceRevision, nixSystemClosure, mottainaiVersion, nawabariVersion}' \
  runtime-appliance-manifest.json
```

Record the full manifest JSON as part of your evidence — it names the exact
Mottainai source revision, the immutable Nix system/closure identity, and
the compatible Mottainai/Nawabari versions this specific disk was built
from.

## 2. One-time SSH key customization (bounded, manual, not a rebuild)

Requires `qemu-utils` (already present on any Proxmox host: it ships QEMU).
Generate a throwaway key for this proof if you do not already have one:

```sh
ssh-keygen -t ed25519 -N '' -f ./proxmox-runtime-key -C proxmox-runtime-appliance-proof
```

Mount the downloaded disk's single partition and append your public key to
the existing (empty) `mottainai-control` authorized-keys file, then unmount:

```sh
sudo modprobe nbd max_part=8
sudo qemu-nbd --connect=/dev/nbd0 mottainai-runtime-appliance.raw
sudo partprobe /dev/nbd0
sudo mount /dev/nbd0p1 /mnt

sudo tee /mnt/etc/ssh/authorized_keys.d/mottainai-control < ./proxmox-runtime-key.pub

sudo umount /mnt
sudo qemu-nbd --disconnect /dev/nbd0
```

Record in your evidence that this file was empty before this step (a fresh
CI artifact always ships with `controlAuthorizedKeys = []`) and that no
other file was modified.

## 3. Import into Proxmox

Pick an unused `<vmid>` and a storage target `<storage>` (e.g. `local-lvm`)
already configured on the host; adjust the bridge name if not `vmbr0`:

```sh
qm create <vmid> \
  --name mottainai-runtime-appliance \
  --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci \
  --bios seabios \
  --ostype l26

qm importdisk <vmid> mottainai-runtime-appliance.raw <storage>
qm set <vmid> --scsi0 <storage>:vm-<vmid>-disk-0
qm set <vmid> --boot order=scsi0
qm set <vmid> --serial0 socket --vga serial0
```

Record the exact `<vmid>`/storage/bridge values, the Proxmox VE version
(`pveversion`), and host CPU architecture (`uname -m`) as part of your
evidence — these are Proxmox-specific delivery/config details, not
canonical Runtime semantics.

## 4. Boot and network readiness (acceptance criterion 5, part 1)

```sh
qm start <vmid>
qm terminal <vmid>   # or the Proxmox web UI's noVNC/serial console
```

Wait for `nixos login:` on the console. Confirm a DHCP lease was obtained
(visible in the console boot log, or from the Proxmox host's DHCP
server/bridge if you control it).

## 5. SSH access and Mottainai/Nawabari/Zellij/health (acceptance criterion 5, part 2)

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i ./proxmox-runtime-key mottainai-control@<vm-ip> 'id'
# => uid=...(mottainai-control) gid=...(mottainai-control) groups=...(mottainai-control)

ssh ... 'mottainai --version && nawabari --version && zellij --version'
ssh ... 'mottainai-runtime-health'
```

`mottainai-runtime-health`'s output must report
`"contractId": "mottainai.linux-runtime.v1"` and
`"name":"nawabari"`/`"present":true`, exactly as the existing local golden
path proves (`docs/nix-runtime-golden-path.md` step 5) — same module, same
health contract, different host virtualization stack.

## 6. Persistent state across reboot (acceptance criterion 6)

```sh
ssh ... 'echo proxmox-runtime-marker > ~/reboot-state-marker.txt && sync'

qm reboot <vmid>
# wait for "nixos login:" again on the console, then:

ssh ... '
  cat ~/reboot-state-marker.txt
  mottainai-runtime-health
'
```

Confirm the marker file and `mottainai-runtime-health`'s
`buildIdentity`/`runtimeIdentity` are byte-identical before and after the
Proxmox-driven reboot (`qm reboot`, not a guest-initiated
`systemctl reboot` — `mottainai-control` is not authorized to trigger that,
consistent with `nix/modules/runtime.nix`'s security boundary).

## Evidence checklist

Record, alongside console/SSH transcripts:

- The full `runtime-appliance-manifest.json` from §1 (source revision, Nix
  system closure, Mottainai/Nawabari versions, disk digest).
- Confirmation the pre-customization digest matched (§1) and that §2 was
  the only file written before first boot.
- Proxmox VE version, host architecture, and the exact `qm` VM
  configuration (`qm config <vmid>`).
- Boot, network, SSH, version, health, and reboot-persistence output from
  §4–§6.

## Non-goals not exercised by this proof

Per Issue #601: no automatic Proxmox API provisioning, no Proxmox provider
implementation, no self-hosted runner, no nested virtualization, and no
Mottainai-owned QEMU packaging. This proof exercises the existing canonical
`nixosModules.runtime` guest exactly as CI built it, through Proxmox's own
supported disk-import path.
