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
      runtimeConfigurations = forEachSystem (
        system:
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            # The qemu-vm module is only the image projection of the same
            # canonical Runtime module; it is not a second guest authority.
            (nixpkgs + "/nixos/modules/virtualisation/qemu-vm.nix")
            self.nixosModules.runtime
            {
              mottainai.runtime.enable = true;

              # Minimal boot/filesystem stanza so the canonical Runtime can
              # be evaluated and projected to the QEMU VM output consumed by
              # the local Runtime adapter.
              boot.loader.grub.enable = nixpkgs.lib.mkDefault false;
              fileSystems."/" = nixpkgs.lib.mkDefault {
                device = "/dev/disk/by-label/nixos";
                fsType = "ext4";
              };
              system.stateVersion = "24.05";
              virtualisation.memorySize = 2048;
              virtualisation.cores = 2;
            }
          ];
        }
      );
    in
    {
      # Canonical Runtime module: the single specification consumed both by
      # fresh Runtime image/VM builds (nixosConfigurations, below) and by
      # in-place reconciliation of an existing compatible Runtime. See
      # docs/linux-runtime-contract.md and ADR-0002.
      nixosModules.runtime = import ./modules/runtime.nix;
      nixosModules.default = self.nixosModules.runtime;

      nixosConfigurations = runtimeConfigurations;

      packages = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          mottainai = import ./mottainai.nix { inherit pkgs; };
          nawabari = import ./packages/nawabari.nix {
            inherit (pkgs) lib stdenvNoCC fetchurl makeWrapper nodejs_22;
          };
          runtime-system = runtimeConfigurations.${system}.config.system.build.toplevel;
          runtime-vm = runtimeConfigurations.${system}.config.system.build.vm;
          runtime-image = import ./runtime-image.nix {
            inherit (nixpkgs) lib;
            inherit nixpkgs pkgs;
            runtime = runtimeConfigurations.${system};
          };
        }
      );

      checks = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          nawabari = pkgs.runCommand "nawabari-smoke" {
            nativeBuildInputs = [ self.packages.${system}.nawabari ];
          } ''
            test "$(nawabari --version)" = "0.6.1"
            touch "$out"
          '';
          runtime-vm = import ./tests/runtime.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            runtimeModule = self.nixosModules.runtime;
          };
        }
      );
    };
}
