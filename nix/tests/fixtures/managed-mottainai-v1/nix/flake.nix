{
  description = "Issue #703 repository-owned managed Mottainai fixture source (version 1.0.0)";

  # Pinned to the exact same nixpkgs revision as ../../../../flake.lock —
  # deliberately not a second independent pin, and no impure environment
  # seam of any kind: only the repository test construction's own already
  # pinned nixpkgs. Only needed for pkgs.runCommandNoCC's coreutils
  # (mkdir/chmod); the fixture itself still performs no compilation and
  # reaches the network only through the ordinary, already-cached nixpkgs
  # dependency every other check in this repository resolves the same way.
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
        pkgs.runCommandNoCC "mottainai-${version}" { inherit version; } script // { src = ../.; };
      mkMottainaiFromPayload =
        { system, source, payload, payloadSha256 }:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.runCommandNoCC "mottainai-${version}-payload" {
          inherit version payloadSha256;
          payloadPath = payload;
        } ''
          actual="$(sha256sum "$payloadPath" | awk '{print $1}')"
          test "$actual" = "$payloadSha256"
          mkdir -p "$out/bin" "$out/share/mottainai"
          printf '%s\n' "${version}" > "$out/bin/mottainai-version"
          cat > "$out/bin/mottainai" <<'MOTTAINAI_PAYLOAD_FIXTURE_EOF'
          #!/bin/sh
          if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
            cat "$(dirname "$0")/mottainai-version"
            exit 0
          fi
          exit 1
          MOTTAINAI_PAYLOAD_FIXTURE_EOF
          chmod +x "$out/bin/mottainai"
          printf '{"packageName":"mottainai","packageVersion":"%s","sha256":"%s"}\n' "$version" "$actual" > "$out/share/mottainai/canonical-payload.json"
        '' // { src = source; canonicalPayloadSha256 = payloadSha256; };
    in
    {
      packages.x86_64-linux.mottainai = mkMottainai "x86_64-linux";
      packages.aarch64-linux.mottainai = mkMottainai "aarch64-linux";
      lib.mkMottainaiFromPayload = mkMottainaiFromPayload;
    };
}
