{ pkgs, lib, mkManagedGeneration, mottainaiSource, nawabariPackage }:

# Pure-evaluation proof that nix/managed-generation.nix fails deterministically
# for exactly the cases Issue #625 requires (PR #634 review: "add real
# projection tests for both packages, not only fabricated metadata identity
# tests"). Runs at `nix build .#checks.<system>.managed-generation`, no
# KVM/nixosTest infrastructure required — every assertion here is decided by
# Nix evaluation alone (`builtins.tryEval`, forcing `.generation.outPath`,
# which computes a derivation's store path deterministically from its inputs
# without realizing/building it), not by actually building the mottainai/
# nawabari derivations, so this stays fast even though it exercises the real
# resolveEntry/requireMatchingVersion logic against the real recipes — not a
# stand-in.
#
# Also proves the PR #634 review's second finding is fixed: the projection
# is not coupled to this flake's own checkout as Mottainai's only possible
# source. `mkManagedGeneration` now requires an explicit `mottainaiSource`
# argument (nix/managed-generation.nix "Source resolution boundary"); the
# "an externally supplied alternate source resolves successfully" /
# "the current checkout's source is rejected for a version it cannot
# produce" pair below exercises that boundary directly, not just the
# same-source path every other assertion here uses.

let
  defaultMottainaiSource = mottainaiSource;

  forceGeneration =
    { manifest, mottainaiSource ? defaultMottainaiSource }:
    let
      result = mkManagedGeneration {
        system = pkgs.stdenv.hostPlatform.system;
        inherit manifest mottainaiSource;
      };
    in
    builtins.tryEval (builtins.unsafeDiscardStringContext result.generation.outPath);

  baseManifest = {
    contractId = "mottainai.managed-package-manifest.v1";
    schemaVersion = 1;
    activation.generation = 1;
    packages = [ ];
  };

  # The version nix/mottainai.nix resolves from `mottainaiSource` — reading
  # package.json is a cheap evaluation-time operation, not a build, so this
  # stays fast like the rest of this file.
  currentMottainaiVersion = (import ../mottainai.nix { inherit pkgs; source = mottainaiSource; }).version;

  mottainaiEntry = {
    packageId = "mottainai";
    kind = "nix-flake-package";
    version = currentMottainaiVersion;
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

  correctMottainai = forceGeneration { manifest = baseManifest // { packages = [ mottainaiEntry ]; }; };
  correctNawabari = forceGeneration { manifest = baseManifest // { packages = [ nawabariEntry ]; }; };

  wrongVersionMottainai = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = "0.0.0-does-not-exist"; }) ]; };
  };
  wrongVersionNawabari = forceGeneration {
    manifest = baseManifest // { packages = [ (nawabariEntry // { version = "0.0.0-does-not-exist"; }) ]; };
  };

  unsupportedPackageId = forceGeneration {
    manifest = baseManifest // {
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
    };
  };

  unsupportedKind = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { kind = "npm-package"; }) ]; };
  };

  # Decoupling proof (PR #634 review, second finding): a source tree that is
  # provably not this flake's checkout: ./fixtures/alt-mottainai-source is a
  # separate tracked tree with its own package.json declaring a version
  # (0.0.1-fixture-alt-source) that this checkout's own package.json does
  # not have. A manifest requesting exactly that version resolves
  # successfully only if `mottainaiSource` is genuinely threaded through to
  # nix/mottainai.nix's version resolution — a projection that silently
  # fell back to this flake's own checkout (this file's `mottainaiSource`
  # default, or a hardcoded `../.` the way the pre-fix code had) would
  # resolve the current checkout's version instead and fail this exact
  # version-match assertion.
  altSourceVersion =
    (import ../mottainai.nix {
      inherit pkgs;
      source = ./fixtures/alt-mottainai-source;
    }).version;
  externalSourceIsGenuinelyUsed = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = altSourceVersion; }) ]; };
    mottainaiSource = ./fixtures/alt-mottainai-source;
  };

  # The same alternate source, but the manifest requests the *current
  # checkout's* version rather than the fixture's own — must fail, proving
  # the version-match check is genuinely evaluated against whatever source
  # was supplied, not just always trivially satisfied.
  externalSourceStillEnforcesVersionMatch = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = currentMottainaiVersion; }) ]; };
    mottainaiSource = ./fixtures/alt-mottainai-source;
  };

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
    {
      # Proves PR #634 review's decoupling requirement directly: a manifest
      # requesting a version that only ./fixtures/alt-mottainai-source
      # declares (not this checkout) resolves successfully when that
      # fixture is supplied as mottainaiSource — impossible if the
      # projection were still hardcoded to this flake's own checkout.
      name = "an externally supplied, non-checkout mottainaiSource is genuinely used to resolve the build, proving the projection is not coupled to the current repository checkout";
      condition = externalSourceIsGenuinelyUsed.success;
    }
    {
      # Same fixture, but requesting this checkout's own version instead of
      # the fixture's — must still fail, proving the version-match check
      # above isn't trivially satisfied once an external source is wired in.
      name = "requesting the current checkout's version against an externally supplied source still fails deterministically";
      condition = !externalSourceStillEnforcesVersionMatch.success;
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
