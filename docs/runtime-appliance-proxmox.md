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

## 0. The canonical disk is imported and booted unmodified

The canonical Runtime module ships with `controlAuthorizedKeys = []` by
default so "a fresh generic Runtime cannot be accessed accidentally"
(`nix/modules/runtime.nix`). A publicly downloadable CI artifact must keep
that default — baking a real key into a broadly distributed image would be
publishing a reusable credential, which Issue #601 explicitly forbids. That
means the artifact as downloaded has no SSH access and no root password
(`PermitRootLogin no`, `PasswordAuthentication no`, no root password set)
by design.

The exact bytes you downloaded and verified in §1 are what gets imported
into Proxmox in §3 — this proof never writes to
`mottainai-runtime-appliance.raw`, mounts it, or otherwise touches it after
verification. Getting SSH access instead uses the Runtime contract's
bounded first-boot input
(`docs/linux-runtime-contract.md#ssh-service-and-bootstrap-prerequisites`,
`nix/modules/runtime.nix`'s `mottainai-runtime-bootstrap-authorized-keys`
service): before first boot, build a second, tiny, throwaway disk
containing exactly one `authorized_keys` file and attach it to the VM
alongside the untouched canonical disk (§2–§3). On first boot, the guest
itself finds that disk by filesystem label, validates the key line(s) on
it, and installs them into `mottainai-control`'s persistent
`~/.ssh/authorized_keys` — never into `/etc/ssh/authorized_keys.d` (part of
the immutable closure) and never onto the canonical disk. This is the same
generic, provider-independent mechanism regardless of which QEMU/KVM host
runs it; nothing here is Proxmox-specific guest behavior.

## 1. Download and verify the exact Actions artifact

From the `runtime-appliance-artifact` job of the relevant GitHub Actions
run, download the `mottainai-runtime-appliance-x86_64-linux` artifact. It
contains:

- `mottainai-runtime-appliance.raw` — the canonical self-bootable disk.
- `runtime-appliance-manifest.json` — its bounded
  `mottainai.linux-runtime-appliance.v1` manifest.

Verify the disk you downloaded is byte-identical to what CI built and
verified. This is the only digest check this proof needs — the disk is
never written to afterward, in §2 or any later step:

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

## 2. Build a separate, tiny SSH-bootstrap disk (the canonical disk is never touched)

Requires `e2fsprogs` (already present on any Proxmox host). Generate a
throwaway key for this proof if you do not already have one:

```sh
ssh-keygen -t ed25519 -N '' -f ./proxmox-runtime-key -C proxmox-runtime-appliance-proof
```

Build a small, separate raw disk — labeled exactly `MTNAI_BOOT`, per
`nix/modules/runtime.nix` — containing only your public key. This file is
independent of, and never touches, `mottainai-runtime-appliance.raw`:

```sh
truncate -s 4M mottainai-runtime-bootstrap.raw
mkfs.ext4 -L MTNAI_BOOT mottainai-runtime-bootstrap.raw

sudo modprobe nbd max_part=1
sudo qemu-nbd --connect=/dev/nbd0 mottainai-runtime-bootstrap.raw
sudo mount /dev/nbd0 /mnt
sudo cp ./proxmox-runtime-key.pub /mnt/authorized_keys
sudo umount /mnt
sudo qemu-nbd --disconnect /dev/nbd0
```

Record in your evidence that this bootstrap disk is the only place your key
was written, and that `mottainai-runtime-appliance.raw`'s SHA-256 (§1) is
unchanged after this step.

## 3. Import into Proxmox

Pick an unused `<vmid>` and a storage target `<storage>` (e.g. `local-lvm`)
already configured on the host; adjust the bridge name if not `vmbr0`. The
canonical disk becomes `scsi0`; the bootstrap disk from §2 is imported and
attached separately as `scsi1` and only ever read once, at first boot:

```sh
qm create <vmid> \
  --name mottainai-runtime-appliance \
  --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci \
  --bios seabios \
  --ostype l26

qm importdisk <vmid> mottainai-runtime-appliance.raw <storage>
qm importdisk <vmid> mottainai-runtime-bootstrap.raw <storage>
qm set <vmid> --scsi0 <storage>:vm-<vmid>-disk-0
qm set <vmid> --scsi1 <storage>:vm-<vmid>-disk-1
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
- The `mottainai-runtime-appliance.raw` SHA-256 from §1, and confirmation it
  is unchanged after §2–§6 — the canonical disk is imported and booted
  byte-identical to the Actions artifact throughout this proof.
- Proxmox VE version, host architecture, and the exact `qm` VM
  configuration (`qm config <vmid>`, including both `scsi0`/`scsi1`).
- Boot, network, SSH, version, health, and reboot-persistence output from
  §4–§6.

## Non-goals not exercised by this proof

Per Issue #601: no automatic Proxmox API provisioning, no Proxmox provider
implementation, no self-hosted runner, no nested virtualization, and no
Mottainai-owned QEMU packaging. This proof exercises the existing canonical
`nixosModules.runtime` guest exactly as CI built it, through Proxmox's own
supported disk-import path.
