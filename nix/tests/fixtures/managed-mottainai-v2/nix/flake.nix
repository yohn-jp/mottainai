{
  description = "Issue #703 repository-owned managed Mottainai fixture source (version 2.0.0)";

  # Deliberately no inputs: this fixture must build with no compilation and
  # no network access, so it needs no nixpkgs (or any other) pin at all —
  # only the `derivation` builtin, the same dependency-free approach
  # nix/tests/fixtures/alt-mottainai-source/nix/mottainai.nix already uses
  # for a pure-evaluation fixture.
  outputs =
    { self }:
    let
      version = "2.0.0";
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
        derivation {
          name = "mottainai-${version}";
          inherit system version;
          builder = "/bin/sh";
          args = [ "-c" script ];
          PATH = "/bin:/usr/bin";
        } // { src = ../.; };
    in
    {
      packages.x86_64-linux.mottainai = mkMottainai "x86_64-linux";
      packages.aarch64-linux.mottainai = mkMottainai "aarch64-linux";
    };
}
