{
  description = "Mottainai Linux Runtime — canonical NixOS system layer (mottainai.linux-runtime.v1)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      # Canonical Runtime module: the single specification consumed both by
      # fresh Runtime image/VM builds (nixosConfigurations, below) and by
      # in-place reconciliation of an existing compatible Runtime. See
      # docs/linux-runtime-contract.md and ADR-0002.
      nixosModules.runtime = import ./modules/runtime.nix;
      nixosModules.default = self.nixosModules.runtime;

      nixosConfigurations = forEachSystem (
        system:
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.runtime
            {
              # Minimal boot/filesystem stanza so `nixos-rebuild build` can
              # evaluate this configuration standalone. Concrete host
              # image/hypervisor wiring is the next #230 child's scope, not
              # this contract's.
              boot.loader.grub.enable = nixpkgs.lib.mkDefault false;
              fileSystems."/" = nixpkgs.lib.mkDefault {
                device = "/dev/disk/by-label/nixos";
                fsType = "ext4";
              };
              system.stateVersion = "24.05";
            }
          ];
        }
      );

      checks = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          runtime-vm = import ./tests/runtime.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            runtimeModule = self.nixosModules.runtime;
          };
        }
      );
    };
}
