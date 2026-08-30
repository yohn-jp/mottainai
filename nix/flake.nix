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

      # Exposes the Mottainai and Nawabari package derivations as pkgs.mottainai
      # / pkgs.nawabari so the canonical Runtime module can depend on them the
      # same way it already depends on nixpkgs-provided packages like
      # pkgs.zellij, without a second package-resolution path.
      #
      # Mottainai is built from this flake checkout's tracked repository source.
      # Tagged release builds therefore consume the exact tagged source without
      # depending on a package that must first exist in npm.
      mkMottainai = pkgs: import ./mottainai.nix {
        inherit pkgs;
        source = ../.;
      };
      mkNawabari = pkgs: import ./packages/nawabari.nix {
        inherit (pkgs) lib stdenvNoCC fetchurl makeWrapper nodejs_22;
      };
      runtimeOverlay = final: prev: {
        mottainai = mkMottainai final;
        nawabari = mkNawabari final;
      };

      runtimeConfigurations = forEachSystem (
        system:
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            # The qemu-vm module is only the image projection of the same
            # canonical Runtime module; it is not a second guest authority.
            (nixpkgs + "/nixos/modules/virtualisation/qemu-vm.nix")
            self.nixosModules.runtime
            { nixpkgs.overlays = [ runtimeOverlay ]; }
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
      # Self-bootable delivery projection of the same canonical Runtime
      # module, for manual QEMU/KVM hosts (Proxmox) that import one disk
      # through firmware rather than consuming runtime-vm/runtime-image's
      # direct -kernel/-initrd boot. Only the bootloader/partition/QEMU-guest
      # delivery concerns differ from runtimeConfigurations above; the guest
      # module and its overlay are identical, so this is not a second guest
      # authority. See nix/runtime-appliance-image.nix and Issue #601.
      applianceConfigurations = forEachSystem (
        system:
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            (nixpkgs + "/nixos/modules/profiles/qemu-guest.nix")
            self.nixosModules.runtime
            { nixpkgs.overlays = [ runtimeOverlay ]; }
            {
              mottainai.runtime.enable = true;

              boot.loader.grub.enable = true;
              boot.loader.grub.device = "/dev/vda";
              boot.loader.timeout = 0;
              boot.growPartition = true;
              fileSystems."/" = {
                device = "/dev/disk/by-label/nixos";
                fsType = "ext4";
                autoResize = true;
              };
              system.stateVersion = "24.05";
            }
          ];
        }
      );

      # Canonical Runtime module: the single specification consumed both by
      # fresh Runtime image/VM builds (nixosConfigurations, below) and by
      # in-place reconciliation of an existing compatible Runtime. See
      # docs/linux-runtime-contract.md and ADR-0002.
      nixosModules.runtime = import ./modules/runtime.nix;
      nixosModules.default = self.nixosModules.runtime;

      # Exposed so a concrete manual-deployment override
      # (nix/deployments/golden-path.nix) can compose the same package
      # resolution as the canonical nixosConfigurations below, without a
      # second overlay/package authority.
      overlays.default = runtimeOverlay;

      nixosConfigurations = runtimeConfigurations;

      packages = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          mottainai = mkMottainai pkgs;
          nawabari = mkNawabari pkgs;
          runtime-system = runtimeConfigurations.${system}.config.system.build.toplevel;
          runtime-vm = runtimeConfigurations.${system}.config.system.build.vm;
          runtime-image = import ./runtime-image.nix {
            inherit (nixpkgs) lib;
            inherit nixpkgs pkgs;
            runtime = runtimeConfigurations.${system};
          };
          runtime-appliance-image = import ./runtime-appliance-image.nix {
            inherit (nixpkgs) lib;
            inherit nixpkgs pkgs;
            appliance = self.applianceConfigurations.${system};
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
            runtimeOverlay = runtimeOverlay;
          };
        }
      );
    };
}
