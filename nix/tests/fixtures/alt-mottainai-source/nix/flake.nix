{
  description = "Issue #702 regression fixture: a release-owned nix#mottainai recipe that is genuinely its own — not HEAD's nix/mottainai.nix, and not built from HEAD's nixpkgs pin. nix/tests/managed-generation.nix and nix/tests/runtime-appliance.nix use this fixture to prove nix/managed-generation.nix resolves a supplied mottainaiSource's package output from that source tree's own flake, never by calling HEAD's ./mottainai.nix with a foreign source substituted in.";

  # Deliberately no inputs (not even nixpkgs): this fixture's own
  # nix/mottainai.nix is written against the raw `derivation` builtin
  # instead of `pkgs.stdenv.mkDerivation`, so this flake needs no
  # flake.lock of its own — a historical release's real nix/flake.nix
  # would instead pin its own release-era nixpkgs the same way HEAD's does.
  inputs = { };

  outputs =
    { self }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      mkMottainai = system: import ./mottainai.nix { inherit system; source = ../.; };
    in
    {
      packages = builtins.listToAttrs (
        map (system: {
          name = system;
          value = { mottainai = mkMottainai system; };
        }) supportedSystems
      );
    };
}
