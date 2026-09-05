{ mottainaiFlake ? builtins.getFlake (toString ../.) }:

# Concrete manual-deployment override for the Issue #572 golden path.
#
# This does not define a second guest configuration authority: it imports
# the same `nixosModules.runtime` and the same nixpkgs input the canonical
# `nix/flake.nix` uses, and only supplies the per-installation values the
# module leaves unset by design (`runtimeIdentity`, `controlAuthorizedKeys`)
# so a generic Runtime build stays inaccessible until an operator opts in
# here. See docs/operations/runtime/nix-golden-path.md for the exact build/boot/SSH
# sequence that consumes this file.

let
  nixpkgs = mottainaiFlake.inputs.nixpkgs;
  system = builtins.currentSystem;

  runtimeIdentity = builtins.getEnv "MOTTAINAI_GOLDEN_PATH_RUNTIME_IDENTITY";
  authorizedKey = builtins.getEnv "MOTTAINAI_GOLDEN_PATH_SSH_KEY";
  sshHostPortRaw = builtins.getEnv "MOTTAINAI_GOLDEN_PATH_SSH_HOST_PORT";
  sshHostPort = if sshHostPortRaw == "" then 2222 else nixpkgs.lib.toInt sshHostPortRaw;
in
assert runtimeIdentity != "";
assert authorizedKey != "";
nixpkgs.lib.nixosSystem {
  inherit system;
  modules = [
    (nixpkgs + "/nixos/modules/virtualisation/qemu-vm.nix")
    mottainaiFlake.nixosModules.runtime
    { nixpkgs.overlays = [ mottainaiFlake.overlays.default ]; }
    {
      mottainai.runtime = {
        enable = true;
        runtimeIdentity = runtimeIdentity;
        controlAuthorizedKeys = [ authorizedKey ];
      };

      boot.loader.grub.enable = nixpkgs.lib.mkDefault false;
      fileSystems."/" = nixpkgs.lib.mkDefault {
        device = "/dev/disk/by-label/nixos";
        fsType = "ext4";
      };
      system.stateVersion = "24.05";
      virtualisation.memorySize = 2048;
      virtualisation.cores = 2;
      virtualisation.graphics = false;

      # Golden-path proof needs a fixed forwarded SSH port on the host loopback
      # so the documented `ssh -p <port>` step in the deployment doc is exact;
      # defaults to 2222, overridable via MOTTAINAI_GOLDEN_PATH_SSH_HOST_PORT
      # when that port is already in use on the build host.
      virtualisation.forwardPorts = [
        { from = "host"; host.port = sshHostPort; guest.port = 22; }
      ];
    }
  ];
}
