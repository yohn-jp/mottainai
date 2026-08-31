{
  description = "Mottainai Linux Runtime — canonical NixOS system layer (mottainai.linux-runtime.v1)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;

      # The managed Mottainai and Nawabari derivations remain flake package
      # outputs for #625/#626 generation builds. They are intentionally not
      # overlaid into the canonical appliance system: the base system gets
      # only the independently packageable bootstrap component below.
      #
      # Mottainai is built from this flake checkout's tracked repository source.
      # Tagged release builds therefore consume the exact tagged source without
      # depending on a package that must first exist in npm.
      mkMottainai = pkgs: import ./mottainai.nix {
        inherit pkgs;
        source = ../.;
      };
      mkNawabari = pkgs: import ./packages/nawabari.nix {
        inherit (pkgs) lib stdenvNoCC fetchurl makeWrapper nodejs_24;
      };
      # Standalone bootstrap package (Issue #626) — the only application-facing
      # package embedded by the bootstrap-only appliance (#627).
      mkBootstrapFromSource = source: pkgs: import ./bootstrap.nix {
        inherit (pkgs) lib stdenvNoCC fetchurl makeWrapper nodejs_24 typescript git;
        inherit source;
      };
      mkBootstrap = pkgs: mkBootstrapFromSource ../. pkgs;
      runtimeOverlay = final: prev: {
        mottainai-bootstrap = mkBootstrap final;
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
          # Issue #626/#627: standalone bootstrap CLI package, embedded in
          # the base appliance without the full managed application closure.
          mottainai-bootstrap = mkBootstrap pkgs;
        }
      );

      # Function output (Issue #625): the managed-package-manifest.v1
      # manifest a caller wants projected is runtime input, not something a
      # pinned flake package output can take a parameter for, so this is
      # exposed as a callable function rather than a fixed
      # `packages.<system>.*` derivation. scripts/build-managed-generation.mjs
      # is the caller (`nix eval --impure` against this attribute), reading
      # the manifest from a file the flake itself never touches.
      #
      # `mottainaiSource` is the resolved exact Mottainai source tree the
      # manifest's requested version should be built from — required, no
      # default to this flake's own checkout. Resolving *which* source that
      # is (a tagged release checkout, a fetched tarball, whatever a fresh
      # bootstrap appliance downloads) is Issue #626's job, not #625's: this
      # function only projects "manifest + already-resolved exact source"
      # into a deterministic Nix generation, exactly the boundary #625 owns
      # (see docs/managed-generation.md "Source resolution boundary").
      # `nix#mottainai` (`packages.<system>.mottainai`) remains available as a
      # managed-generation recipe and builds from the exact source supplied
      # to that generation path; it is not a canonical base-system input.
      lib.mkManagedGeneration =
        { system, manifest, mottainaiSource }:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        import ./managed-generation.nix {
          inherit pkgs manifest;
          inherit (nixpkgs) lib;
          buildMottainai = source: import ./mottainai.nix { inherit pkgs source; };
          mottainaiSource = mottainaiSource;
          nawabariPackage = mkNawabari pkgs;
        };

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
          runtime-appliance-golden-path = import ./tests/runtime-appliance-golden-path.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            runtimeModule = self.nixosModules.runtime;
            runtimeOverlay = runtimeOverlay;
          };
          managed-generation = import ./tests/managed-generation.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            mkManagedGeneration = self.lib.mkManagedGeneration;
            # This flake's own checkout, standing in for whatever exact
            # source Issue #626 will resolve in production — the point of
            # this test is that the projection accepts an externally
            # supplied source at all, not that this particular source is
            # canonical.
            mottainaiSource = ../.;
            nawabariPackage = mkNawabari pkgs;
          };
          bootstrap = import ./tests/bootstrap.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            bootstrapPackage = mkBootstrap pkgs;
            mottainaiPackage = mkMottainai pkgs;
          };
          managed-runtime-health = import ./tests/managed-runtime-health.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            managedRuntimeReadinessScript = import ./managed-runtime-health.nix {
              inherit pkgs;
              inherit (nixpkgs) lib;
            };
          };
          appliance-boundary = import ./tests/runtime-appliance.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
            inherit nixpkgs;
            mkManagedGeneration = self.lib.mkManagedGeneration;
            canonicalAppliance = self.applianceConfigurations.${system};
            runtimeApplianceImage = import ./runtime-appliance-image.nix {
              inherit (nixpkgs) lib;
              inherit nixpkgs pkgs;
              appliance = self.applianceConfigurations.${system};
            };
            bootstrapPackage = mkBootstrap pkgs;
            source = ../.;
          };
        }
      );
    };
}
