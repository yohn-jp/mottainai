{ lib, nixpkgs, pkgs, appliance }:

# Self-bootable delivery projection of the same canonical nixosModules.runtime
# system consumed by runtime-image.nix. runtime-image.nix's disk has no
# partition table or bootloader by design: it is paired with the kernel/
# initrd it ships and booted by passing those directly to QEMU (-kernel/
# -initrd), the local Runtime adapter's and golden path's projection.
#
# A manual QEMU/KVM host such as Proxmox instead boots a single imported disk
# through UEFI firmware with no external -kernel/-initrd flags
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
  partitionTableType = "efi";
  diskImage = import (nixpkgs + "/nixos/lib/make-disk-image.nix") {
    inherit config lib pkgs;
    name = "mottainai-runtime-appliance-disk-${system}";
    format = "raw";
    inherit partitionTableType;
    # The current nixpkgs builder invokes mkfs.vfat without -F 32; its default
    # 256M ESP is therefore auto-detected as FAT16. Keep the supported EFI
    # layout while making the ESP unambiguously FAT32.
    bootSize = "600M";
    installBootLoader = true;
    diskSize = "auto";
    additionalSpace = "256M";
    copyChannel = false;
    deterministic = true;
  };
in
assert lib.assertMsg (partitionTableType == "efi") ''
  The canonical Runtime Appliance must use the nixpkgs EFI image layout; legacy MBR images are unsupported.
'';
assert lib.assertMsg config.boot.loader.grub.enable ''
  The canonical Runtime Appliance must enable GRUB for UEFI boot.
'';
assert lib.assertMsg config.boot.loader.grub.efiSupport ''
  The canonical Runtime Appliance must build GRUB with EFI support.
'';
assert lib.assertMsg (config.boot.loader.grub.device == "nodev") ''
  The canonical Runtime Appliance must not install BIOS GRUB to a disk device.
'';
assert lib.assertMsg config.boot.loader.grub.efiInstallAsRemovable ''
  The canonical Runtime Appliance must install the UEFI removable/fallback boot path.
'';
assert lib.assertMsg (!config.boot.loader.efi.canTouchEfiVariables) ''
  The canonical Runtime Appliance must not depend on EFI variables for boot discovery.
'';
pkgs.runCommand "mottainai-runtime-appliance-image-${system}" {
  nativeBuildInputs = [ pkgs.coreutils ];
  preferLocalBuild = true;
} ''
  mkdir -p "$out"
  install -Dm0644 ${diskImage}/nixos.img "$out/mottainai-runtime-appliance.raw"

  # Completed by build-runtime-appliance-manifest.mjs, which adds the source
  # revision and release metadata these Nix-only inputs cannot name
  # themselves, plus the disk's size/digest. Managed application package
  # metadata is not a claim that those packages are in this base closure.
  # This file's own fields are emitted by Nix so the manifest cannot silently
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
