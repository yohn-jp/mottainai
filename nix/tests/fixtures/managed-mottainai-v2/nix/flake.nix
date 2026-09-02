{
  description = "Issue #703 repository-owned managed Mottainai fixture source (version 2.0.0)";

  # Deliberately no inputs: this fixture must build with no compilation and
  # no network access. A bare `builder = "/bin/sh"` has no PATH inside the
  # Nix build sandbox (nix/tests/fixtures/alt-mottainai-source only gets
  # away with that because it is a pure-evaluation-only fixture that is
  # never actually built), and pulling in nixpkgs (even just
  # pkgs.bash/pkgs.coreutils) for a real build risks needing a stdenv
  # bootstrap closure that is not guaranteed to already be cached on a
  # guest with no general internet access. Instead this flake reads the
  # already-verified, already-present-on-this-guest bash/coreutils paths
  # from the impure build environment (the same --impure evaluation
  # src/runtime-contract/managed-generation-build.ts's own `nix build
  # --impure` already requires) — set by
  # nix/tests/runtime-appliance-golden-path.nix before invoking reconcile,
  # from this exact guest's own `command -v`.
  outputs =
    { self }:
    let
      version = "2.0.0";
      coreutilsBinDir = builtins.getEnv "MOTTAINAI_FIXTURE_COREUTILS_DIR";
      bashPath = builtins.getEnv "MOTTAINAI_FIXTURE_BASH";
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
          builder = bashPath;
          args = [ "-c" script ];
          PATH = coreutilsBinDir;
        } // { src = ../.; };
    in
    {
      packages.x86_64-linux.mottainai = mkMottainai "x86_64-linux";
      packages.aarch64-linux.mottainai = mkMottainai "aarch64-linux";
    };
}
