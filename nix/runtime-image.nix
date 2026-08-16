{ lib, nixpkgs, pkgs, runtime }:

# This is an image projection of the canonical nixosConfiguration passed by
# the flake. It deliberately does not declare a second NixOS module or guest
# configuration: the Runtime module and its evaluated system remain the only
# system authority.
let
  system = pkgs.stdenv.hostPlatform.system;
  config = runtime.config;
  diskImage = import (nixpkgs + "/nixos/lib/make-disk-image.nix") {
    inherit config lib pkgs;
    name = "mottainai-runtime-disk-${system}";
    format = "raw";
    partitionTableType = "none";
    installBootLoader = false;
    diskSize = "auto";
    additionalSpace = "0M";
    copyChannel = false;
    deterministic = true;
  };
in
pkgs.runCommand "mottainai-runtime-image-${system}" {
  nativeBuildInputs = [ pkgs.coreutils ];
  preferLocalBuild = true;
} ''
  mkdir -p "$out"
  install -Dm0644 ${config.system.build.toplevel}/kernel "$out/kernel"
  install -Dm0644 ${config.system.build.initialRamdisk}/${config.system.boot.loader.initrdFile} "$out/initrd"
  install -Dm0644 ${diskImage}/nixos.img "$out/runtime-disk.raw"

  # The manifest is completed by build-runtime-image-manifest.mjs once the
  # release pipeline has supplied the per-image pinned SSH host key. These
  # inputs and the build identity are emitted by Nix so the manifest cannot
  # silently point at a second system definition.
  cat > "$out/runtime-image-inputs.json" <<EOF
  {
    "contractId": "mottainai.linux-runtime.v1",
    "schemaVersion": 1,
    "architecture": "${system}",
    "buildIdentity": "${config.system.build.toplevel}",
    "canonicalSource": {
      "flake": "nix/flake.nix",
      "output": "nixosConfigurations.${system}.config.system.build.vm"
    }
  }
  EOF
''
