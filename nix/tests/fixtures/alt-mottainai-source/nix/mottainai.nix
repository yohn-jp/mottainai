{ pkgs, source }:

# Issue #702 regression fixture: a minimal, dependency-free stand-in for a
# tagged release's own nix/mottainai.nix. Built with the raw `derivation`
# builtin rather than `pkgs.stdenv.mkDerivation`, so this fixture needs no
# nixpkgs package at all beyond `pkgs.stdenv.hostPlatform.system` — nothing
# here is reachable from HEAD's own nix/mottainai.nix. Signature matches the
# real `nix/mottainai.nix` (`{ pkgs, source }:`) so both
# nix/tests/managed-generation.nix's pure `import`-based resolution and a
# real production `builtins.getFlake`-based resolution (which would call
# this same file through this fixture's own flake, were one added) can
# resolve it uniformly. The exact shape of `bin/mottainai` this produces is
# never exercised by a real build: the nix-eval-only proofs in
# nix/tests/managed-generation.nix and nix/tests/runtime-appliance.nix only
# need this derivation's `version` and store path, both computable without
# ever running this builder (the same property those tests already rely on
# for the real mottainai/nawabari/zellij recipes).

let
  package = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  version = package.version;
  system = pkgs.stdenv.hostPlatform.system;
in
derivation {
  name = "mottainai-${version}";
  inherit system version;
  builder = "/bin/sh";
  PATH = "/bin:/usr/bin";
  args = [
    "-c"
    ''
      mkdir -p "$out/bin"
      printf '#!/bin/sh\necho "%s"\n' "$version" > "$out/bin/mottainai"
      chmod +x "$out/bin/mottainai"
    ''
  ];
} // { inherit version; src = source; }
