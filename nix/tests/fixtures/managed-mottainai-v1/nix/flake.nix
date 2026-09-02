{
  description = "Issue #703 repository-owned managed Mottainai fixture source (version 1.0.0)";

  # Pinned to the exact same nixpkgs revision as ../../../../flake.lock —
  # deliberately not a second independent pin. Only needed for a real
  # bash/coreutils PATH inside the Nix build sandbox (a bare builder =
  # "/bin/sh" has no PATH there at all — nix/tests/fixtures/alt-mottainai-source
  # only gets away with that because it is a pure-evaluation-only fixture
  # that is never actually built). Deliberately the raw `derivation`
  # builtin with only pkgs.bash/pkgs.coreutils as inputs, not
  # pkgs.stdenv(NoCC).mkDerivation or pkgs.runCommand(NoCC): those pull in
  # this nixpkgs revision's full stdenv bootstrap closure, which is not
  # necessarily already cached on a fresh guest with no general internet
  # access, unlike bash/coreutils themselves.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      version = "1.0.0";
      script = ''
        mkdir -p "$out/bin"
        cat > "$out/bin/mottainai" <<'MOTTAINAI_FIXTURE_EOF'
        #!/bin/sh
        if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
          printf '%s\n' "FIXTURE_VERSION"
          exit 0
        fi
        echo "mottainai: unsupported argument" >&2
        exit 1
        MOTTAINAI_FIXTURE_EOF
        sed -i "s/FIXTURE_VERSION/${version}/" "$out/bin/mottainai"
        chmod +x "$out/bin/mottainai"
      '';
      # `src` is added onto the derivation's own result attrset (not passed
      # as a derivation input, so it is never a build dependency the
      # sandboxed builder above needs) so `nix/managed-generation.nix`'s
      # `sourceStorePath` projection (every resolved entry's `${r.drv.src}`)
      # can report the exact fixture source tree this build resolved from —
      # `../.` here is this flake.nix file's own parent directory, i.e. the
      # fixture root containing package.json, the same relative-path
      # pattern nix/flake.nix's `mkMottainai = pkgs: import ./mottainai.nix
      # { inherit pkgs; source = ../.; };` already uses to resolve HEAD's
      # own Mottainai source tree from its own nix/flake.nix.
      mkMottainai =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        derivation {
          name = "mottainai-${version}";
          inherit system version;
          builder = "${pkgs.bash}/bin/bash";
          args = [ "-c" script ];
          PATH = "${pkgs.coreutils}/bin";
        } // { src = ../.; };
    in
    {
      packages.x86_64-linux.mottainai = mkMottainai "x86_64-linux";
      packages.aarch64-linux.mottainai = mkMottainai "aarch64-linux";
    };
}
