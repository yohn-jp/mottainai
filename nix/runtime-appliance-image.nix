{ lib, nixpkgs, pkgs, appliance }:

# Self-bootable delivery projection of the same canonical nixosModules.runtime
# system consumed by runtime-image.nix. runtime-image.nix's disk has no
# partition table or bootloader by design: it is paired with the kernel/
# initrd it ships and booted by passing those directly to QEMU (-kernel/
# -initrd), the local Runtime adapter's and golden path's projection.
#
# A manual QEMU/KVM host such as Proxmox instead boots a single imported disk
# through firmware (BIOS/UEFI) with no external -kernel/-initrd flags
# available, so it needs a disk that can boot itself. This file adds only
# that bootloader/partition-table delivery concern on top of the same
# `appliance` NixOS system evaluation (nix/flake.nix `applianceConfigurations`,
# which imports nothing but `nixosModules.runtime` plus the standard
# nixpkgs QEMU-guest profile) — it does not declare a second NixOS module or
# guest configuration; the Runtime module and its evaluated system remain the
# only system authority.

let
  system = pkgs.stdenv.hostPlatform.system;
  config = appliance.config;
  diskImage = import (nixpkgs + "/nixos/lib/make-disk-image.nix") {
    inherit config lib pkgs;
    name = "mottainai-runtime-appliance-disk-${system}";
    format = "raw";
    partitionTableType = "legacy";
    installBootLoader = true;
    diskSize = "auto";
    additionalSpace = "256M";
    copyChannel = false;
    deterministic = true;
  };
in
pkgs.runCommand "mottainai-runtime-appliance-image-${system}" {
  nativeBuildInputs = [ pkgs.coreutils ];
  preferLocalBuild = true;
} ''
  mkdir -p "$out"
  install -Dm0644 ${diskImage}/nixos.img "$out/mottainai-runtime-appliance.raw"

  # Completed by build-runtime-appliance-manifest.mjs, which adds the
  # Mottainai source revision and Mottainai/Nawabari package identity these
  # Nix-only inputs cannot name themselves, plus the disk's size/digest. This
  # file's own fields are emitted by Nix so the manifest cannot silently
  # point at a second system definition.
  cat > "$out/runtime-appliance-inputs.json" <<EOF
  {
    "contractId": "mottainai.linux-runtime-appliance.v1",
    "schemaVersion": 1,
    "architecture": "${system}",
    "nixSystemClosure": "${config.system.build.toplevel}",
    "canonicalSource": {
      "flake": "nix/flake.nix",
      "output": "applianceConfigurations.${system}.config.system.build.toplevel"
    }
  }
  EOF
''
