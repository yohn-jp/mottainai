# Nix Runtime manual golden path (Issue #572)

Concrete, reproducible manual deployment proof for the canonical
`mottainai.linux-runtime.v1` NixOS configuration
([`docs/linux-runtime-contract.md`](linux-runtime-contract.md),
[ADR-0002](decisions/0002-linux-runtime-contract.md)): build the Runtime
image, boot it with the existing QEMU Runtime machinery
(`nixosConfigurations.<system>.config.system.build.vm`), SSH in as
`mottainai-control`, prove the base reaches `bootstrap-ready` without the
managed application packages, and verify control state survives a VM restart.

See also [`docs/runtime-appliance-proxmox.md`](runtime-appliance-proxmox.md)
for the equivalent manual golden path against a self-bootable Runtime
Appliance disk imported into Proxmox instead of this repository's local
QEMU VM path (Issue #601).

This does not introduce a second guest configuration authority.
[`nix/deployments/golden-path.nix`](../nix/deployments/golden-path.nix)
imports the same `nixosModules.runtime` and the same pinned `nixpkgs` input
as `nix/flake.nix`, and only supplies the per-installation values the module
leaves unset by design: `runtimeIdentity` and `controlAuthorizedKeys`.

## 0. Prerequisites

- Nix with flakes enabled.
- `qemu-system-x86_64` on `PATH`.
- An SSH keypair for the golden-path proof (throwaway, not a real operator
  key):

  ```sh
  ssh-keygen -t ed25519 -N '' -f /tmp/golden-path-key -C golden-path-test
  ```

## 1. Build the canonical Runtime image (acceptance criterion 1)

```sh
nix build ./nix#runtime-image
ls result/   # kernel, initrd, runtime-disk.raw, runtime-image-inputs.json
```

## 2. Concrete deployment override (acceptance criterion 2)

`nix/deployments/golden-path.nix` reads `runtimeIdentity` and the SSH
authorized key from environment variables so no real values are hardcoded
into a generic build, and defaults the forwarded SSH host port to `2222`
(override with `MOTTAINAI_GOLDEN_PATH_SSH_HOST_PORT` if that port is
already in use on the build host):

```sh
export MOTTAINAI_GOLDEN_PATH_RUNTIME_IDENTITY=golden-path-demo-01
export MOTTAINAI_GOLDEN_PATH_SSH_KEY="$(cat /tmp/golden-path-key.pub)"
export MOTTAINAI_GOLDEN_PATH_SSH_HOST_PORT=2222   # optional override

nix build --impure \
  --expr '(import ./nix/deployments/golden-path.nix {}).config.system.build.vm' \
  -o result-vm
```

`--impure` is required only because the override reads the two environment
variables above (`builtins.getEnv`); it does not otherwise depend on
impure/ambient state. Confirm the identity actually landed in the built
configuration:

```sh
nix eval --impure \
  --expr '(import ./nix/deployments/golden-path.nix {}).config.mottainai.runtime.runtimeIdentity'
# => "golden-path-demo-01"
```

## 3. Boot through the existing QEMU Runtime path (acceptance criterion 3)

`config.system.build.vm` is the same NixOS `qemu-vm.nix` projection the
canonical `nix#runtime-vm` flake output uses — this override only changes
which values are baked into that same machinery, not the machinery itself.

```sh
NIX_DISK_IMAGE=/tmp/golden-path.qcow2 ./result-vm/bin/run-nixos-vm
```

- If `/dev/kvm` is accessible, QEMU boots KVM-accelerated.
- If not, QEMU logs `Could not access KVM kernel module: Permission denied`
  and falls back to TCG (pure software emulation — noticeably slower to
  reach the login prompt, but the guest behavior proved below is identical).
  **Report this fallback distinctly from build/test results** (acceptance
  criterion 9): it is an environment limitation of the host running the
  proof, not a defect in the Nix build or the Runtime contract.

Wait for `nixos login:` on the console, then in another terminal:
The guest's `mottainai-runtime-bootstrap-ready.service` must be active before
the bootstrap health result is considered usable.

## 4. SSH as `mottainai-control` (acceptance criterion 4)

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i /tmp/golden-path-key -p 2222 mottainai-control@127.0.0.1 'id'
# => uid=998(mottainai-control) gid=998(mottainai-control) groups=998(mottainai-control)
```

## 5. Bootstrap readiness and health (acceptance criterion 5)

```sh
ssh ... 'mottainai-bootstrap status --json'
ssh ... 'mottainai-runtime-health'
```

`mottainai-runtime-health` is invoked directly as the binary (not via
`systemctl start`, which `mottainai-control` is deliberately not authorized
to trigger — only the bounded `mottainai-runtime-reconcile` wrapper has a
passwordless sudo rule per `nix/modules/runtime.nix`). It must report
`"readiness": "bootstrap-ready"`, `"bootstrapReady": true`, and
`"managedRuntimeReady": false`. `mottainai`, `nawabari`, and `zellij` must
not resolve from the base PATH. Their eventual managed-generation presence is
verified only after #628 activation.

## 6. Reconcile the canonical managed generation (post-#628 path)

The base only provides the #626 build surface. Once the #624 manifest and #628
activation path are available, the control identity's home
(`/var/lib/mottainai-control`, mode `0700`, system/control-owned persistent
state) is the location for bootstrap and activation evidence. The supported
guest-invokable operation is `reconcile`: it resolves the exact manifest
sources, builds and verifies a generation, atomically selects it, and performs
managed-runtime health. A managed generation is never installed by a boot
script:

```sh
ssh ... '
  mottainai-bootstrap reconcile --system x86_64-linux --json
  mottainai-bootstrap managed-status --json
  mottainai-runtime-health
'
```

`reconcile` and `managed-status` use the canonical control-state paths and do
not accept a caller-selected state or manifest path. Only the completed
reconcile result and the later health projection may report
`"readiness": "managed-runtime-ready"`; bootstrap build evidence alone is not
managed-runtime readiness. The automated provider-independent proof is the
`nix#checks.x86_64-linux.runtime-appliance-golden-path` derivation, executed in
CI alongside the existing Runtime VM contract test. It uses real Mottainai
release tags, records bounded JSON evidence, and covers upgrade, reboot,
rollback, and persistent-unmanaged versus ephemeral state semantics.

## 7. Verify state survives a VM restart (acceptance criterion 7)

Rebooting the guest itself is intentionally not something
`mottainai-control` can trigger (`systemctl reboot` returns `Access denied`,
and the account's only passwordless-sudo command is the bounded
`mottainai-runtime-reconcile` wrapper — this is the contract's own security
boundary, not a limitation of this proof). Guest lifecycle is a host/operator
action, consistent with the contract's "host VM launcher" non-goal. Prove
persistence by power-cycling the VM process against the same disk image,
which is the manual-deployment equivalent of a reboot for a `raw`/`qcow2`
Runtime disk:

```sh
# leave a control-state marker and force it to disk before power-cycling
ssh ... 'echo golden-path-marker > ~/reboot-state-marker.txt && sync'

# host side: stop the VM process, then relaunch against the same disk
pkill -f run-nixos-vm
NIX_DISK_IMAGE=/tmp/golden-path.qcow2 ./result-vm/bin/run-nixos-vm
# wait for "nixos login:" again, then:

ssh ... '
  cat ~/reboot-state-marker.txt
  mottainai-bootstrap status --json
  mottainai-bootstrap managed-status --json
  mottainai-runtime-health
'
```

Verify the marker, bootstrap evidence, and health `runtimeIdentity` /
`buildIdentity` are unchanged after the restart. If a managed generation was
activated, also verify its persisted #628 active/previous state and exact
managed readiness after the restart.

## Non-goals not exercised by this proof

Per Issue #572: no automatic Runtime provisioning, no
automatic SSH key injection, no automatic repository sync, no host-to-guest
RPC beyond the health/reconcile commands above, no automatic NixOS
upgrade/rollback, and no QEMU artifact/lifecycle redesign — this proof
exercises the existing `system.build.vm` QEMU path exactly as-is.
