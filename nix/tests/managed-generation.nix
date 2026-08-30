{ pkgs, lib, mkManagedGeneration, mottainaiPackage, nawabariPackage }:

# Pure-evaluation proof that nix/managed-generation.nix fails deterministically
# for exactly the cases Issue #625 requires (PR #634 review: "add real
# projection tests for both packages, not only fabricated metadata identity
# tests"). Runs at `nix build .#checks.<system>.managed-generation`, no
# KVM/nixosTest infrastructure required — every assertion here is decided by
# Nix evaluation alone (`builtins.tryEval`, forcing `.generation.outPath`),
# not by actually realizing the mottainai/nawabari derivations, so this stays
# fast even though it exercises the real resolveEntry/requireMatchingVersion
# logic against the real pkgs.mottainai / pkgs.nawabari derivations — not a
# stand-in.

let
  forceGeneration = manifest:
    let
      result = mkManagedGeneration { system = pkgs.stdenv.hostPlatform.system; inherit manifest; };
    in
    builtins.tryEval (builtins.unsafeDiscardStringContext result.generation.outPath);

  baseManifest = {
    contractId = "mottainai.managed-package-manifest.v1";
    schemaVersion = 1;
    activation.generation = 1;
    packages = [ ];
  };

  mottainaiEntry = {
    packageId = "mottainai";
    kind = "nix-flake-package";
    version = mottainaiPackage.version;
    source = {
      flakeRef = "nix#mottainai";
      sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    };
  };

  nawabariEntry = {
    packageId = "nawabari";
    kind = "nix-flake-package";
    version = nawabariPackage.version;
    source = {
      flakeRef = "nix/packages/nawabari.nix";
      sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    };
  };

  correctMottainai = forceGeneration (baseManifest // { packages = [ mottainaiEntry ]; });
  correctNawabari = forceGeneration (baseManifest // { packages = [ nawabariEntry ]; });

  wrongVersionMottainai = forceGeneration (
    baseManifest // { packages = [ (mottainaiEntry // { version = "0.0.0-does-not-exist"; }) ]; }
  );
  wrongVersionNawabari = forceGeneration (
    baseManifest // { packages = [ (nawabariEntry // { version = "0.0.0-does-not-exist"; }) ]; }
  );

  unsupportedPackageId = forceGeneration (
    baseManifest // {
      packages = [
        {
          packageId = "zellij";
          kind = "nix-flake-package";
          version = "1.0.0";
          source = {
            flakeRef = "nix#zellij";
            sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
          };
        }
      ];
    }
  );

  unsupportedKind = forceGeneration (
    baseManifest // { packages = [ (mottainaiEntry // { kind = "npm-package"; }) ]; }
  );

  assertions = [
    {
      name = "correct mottainai version resolves and evaluates successfully";
      condition = correctMottainai.success;
    }
    {
      name = "correct nawabari version resolves and evaluates successfully";
      condition = correctNawabari.success;
    }
    {
      name = "a requested mottainai version that does not match the resolved recipe fails deterministically";
      condition = !wrongVersionMottainai.success;
    }
    {
      name = "a requested nawabari version that does not match the resolved recipe fails deterministically";
      condition = !wrongVersionNawabari.success;
    }
    {
      name = "an unsupported packageId fails deterministically";
      condition = !unsupportedPackageId.success;
    }
    {
      name = "an unsupported kind fails deterministically";
      condition = !unsupportedKind.success;
    }
  ];

  failed = builtins.filter (a: !a.condition) assertions;
in
if failed != [ ] then
  throw "nix/tests/managed-generation.nix: failed assertions: ${lib.concatMapStringsSep ", " (a: a.name) failed}"
else
  pkgs.runCommand "managed-generation-projection-test" { } ''
    echo "all ${toString (builtins.length assertions)} managed generation projection assertions passed" > "$out"
  ''
