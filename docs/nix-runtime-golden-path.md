# Nix Runtime manual golden path (Issue #572)

Concrete, reproducible manual deployment proof for the canonical
`mottainai.linux-runtime.v1` NixOS configuration
([`docs/linux-runtime-contract.md`](linux-runtime-contract.md),
[ADR-0002](decisions/0002-linux-runtime-contract.md)): build the Runtime
image, boot it with the existing QEMU Runtime machinery
(`nixosConfigurations.<system>.config.system.build.vm`), SSH in as
`mottainai-control`, exercise Mottainai/Nawabari/Zellij against a cloned
repository, and verify control and repository state survive a VM restart.

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

## 4. SSH as `mottainai-control` (acceptance criterion 4)

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i /tmp/golden-path-key -p 2222 mottainai-control@127.0.0.1 'id'
# => uid=998(mottainai-control) gid=998(mottainai-control) groups=998(mottainai-control)
```

## 5. Mottainai / Nawabari / Zellij / health usable (acceptance criterion 5)

```sh
ssh ... 'mottainai --version && nawabari --version && zellij --version'
ssh ... 'mottainai-runtime-health'
```

`mottainai-runtime-health` is invoked directly as the binary (not via
`systemctl start`, which `mottainai-control` is deliberately not authorized
to trigger — only the bounded `mottainai-runtime-reconcile` wrapper has a
passwordless sudo rule per `nix/modules/runtime.nix`). It reports the
`runtimeIdentity` supplied in step 2, the build's store-path
`buildIdentity`, and `nawabari` present in `requiredCompanions`.

## 6. Clone a repository and invoke Mottainai (acceptance criterion 6)

The control identity's home (`/var/lib/mottainai-control`, mode `0700`,
system/control-owned persistent state) is writable by `mottainai-control`;
the shared `/var/lib/mottainai/repositories` root is `root:root 0755` by
design — per-repository UID/GID principal allocation is explicitly a later
#230 child, not this contract, so this proof clones under the control
identity's own home:

```sh
ssh ... '
  git clone --depth 1 https://github.com/yohn-jp/mottainai.git ~/golden-path-demo
  cd ~/golden-path-demo
  mottainai --version
  mottainai --help
  nawabari session create --label golden-path-demo
'
```

`nawabari session create` records the session in the control state
directory (`/var/lib/mottainai-control`), exercising the same
Nawabari-standalone-execution surface Mottainai's Manager uses.

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
# leave a state marker and force it to disk before power-cycling
ssh ... 'echo golden-path-marker > ~/reboot-state-marker.txt && sync'

# host side: stop the VM process, then relaunch against the same disk
pkill -f run-nixos-vm
NIX_DISK_IMAGE=/tmp/golden-path.qcow2 ./result-vm/bin/run-nixos-vm
# wait for "nixos login:" again, then:

ssh ... '
  cat ~/reboot-state-marker.txt
  cd ~/golden-path-demo && git log -1 --oneline
  cd ~/golden-path-demo-<session-worktree-suffix> && nawabari session id
  mottainai-runtime-health
'
```

Verified in this proof run: the marker file, the cloned repository's
`git log`, the Nawabari session id resolved from its managed worktree, and
`mottainai-runtime-health`'s `runtimeIdentity`/`buildIdentity` were all
byte-identical before and after the restart.

## Non-goals not exercised by this proof

Per Issue #572: no automatic `mottainai runtime ensure` provisioning, no
automatic SSH key injection, no automatic repository sync, no host-to-guest
RPC beyond the health/reconcile commands above, no automatic NixOS
upgrade/rollback, and no QEMU artifact/lifecycle redesign — this proof
exercises the existing `system.build.vm` QEMU path exactly as-is.
