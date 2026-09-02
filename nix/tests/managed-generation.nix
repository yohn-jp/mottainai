{ pkgs, lib, mkManagedGeneration, mottainaiSource, nawabariPackage, zellijPackage }:

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
# source. The "an externally supplied alternate source resolves
# successfully" / "the current checkout's source is rejected for a version
# it cannot produce" pair below exercises that boundary directly, not just
# the same-source path every other assertion here uses.
#
# Issue #702 sharpens that decoupling proof into an ownership proof: it is
# not enough that an external source's *version* differs from HEAD's — the
# resolved package must come from that source's *own* nix/mottainai.nix
# recipe, never from HEAD's copy of that file reinterpreting a foreign
# source tree. `mkManagedGeneration` (nix/flake.nix's `lib.mkManagedGeneration`)
# no longer takes a `mottainaiSource` to resolve internally — it takes an
# already-resolved `mottainaiPackage` derivation, exactly like
# `nawabariPackage`/`zellijPackage` (nix/managed-generation.nix's own
# comments explain why: `builtins.getFlake` cannot appear anywhere this file
# reaches, since `nix flake check` evaluates this whole check without
# `--impure`). `mottainaiPackageFromSource` below resolves that argument the
# only way available under pure evaluation: a plain `import` of a source
# tree's own `nix/mottainai.nix` — never `../mottainai.nix` (HEAD's copy).
# That is a weaker proof than the production driver's `builtins.getFlake`
# resolution (it does not exercise a foreign source's own pinned nixpkgs —
# only its own recipe *file*), but it is not a fallback to the pre-#702 bug
# pattern: the file imported is always the supplied source's own, and
# nix/tests/runtime-appliance-golden-path.nix already proves the full
# getFlake-based, own-nixpkgs-pin resolution end to end against real
# historical tagged releases (v0.7.0/v0.7.1) through the real production
# driver running inside that test's guest VM.
# The drvPath-equality/inequality assertions below (headRecipeIsGenuinelyUsed,
# externalSourceNotReinterpretedByHeadRecipe) and the no-package-output/
# no-historical-hash-registry assertions prove exactly that ownership
# boundary at this pure-evaluation layer.

let
  defaultMottainaiSource = mottainaiSource;

  # Issue #702: resolves a source tree's own `nix/mottainai.nix` — never
  # HEAD's `../mottainai.nix` applied to a foreign source. A plain `import`
  # (not `builtins.getFlake`) so this stays usable from pure evaluation;
  # see this file's header comment for why that is still a meaningful proof
  # of recipe ownership even though it does not resolve that source's own
  # pinned nixpkgs the way the production driver's `builtins.getFlake` call
  # does.
  mottainaiPackageFromSource = source: import (source + "/nix/mottainai.nix") { inherit pkgs source; };

  forceGeneration =
    { manifest, mottainaiSource ? defaultMottainaiSource }:
    builtins.tryEval (
      builtins.unsafeDiscardStringContext
        (mkManagedGeneration {
          system = pkgs.stdenv.hostPlatform.system;
          inherit manifest;
          mottainaiPackage = mottainaiPackageFromSource mottainaiSource;
        }).generation.outPath
    );

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

  zellijEntry = {
    packageId = "zellij";
    kind = "nix-flake-package";
    version = zellijPackage.version;
    source = {
      flakeRef = "nixpkgs#zellij-unwrapped";
      sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    };
  };

  correctMottainai = forceGeneration { manifest = baseManifest // { packages = [ mottainaiEntry ]; }; };
  correctNawabari = forceGeneration { manifest = baseManifest // { packages = [ nawabariEntry ]; }; };
  correctZellij = forceGeneration { manifest = baseManifest // { packages = [ zellijEntry ]; }; };

  wrongVersionMottainai = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = "0.0.0-does-not-exist"; }) ]; };
  };
  wrongVersionNawabari = forceGeneration {
    manifest = baseManifest // { packages = [ (nawabariEntry // { version = "0.0.0-does-not-exist"; }) ]; };
  };
  wrongVersionZellij = forceGeneration {
    manifest = baseManifest // { packages = [ (zellijEntry // { version = "0.0.0-does-not-exist"; }) ]; };
  };

  # coding-agent-cli is a #624-recognized packageId (MANAGED_PACKAGE_IDS)
  # with no #662 projection recipe: Issue #662 only projects a package once
  # Mottainai claims first-class support for it, which is not yet the case.
  # This proves rejection is scoped to "this projection has a recipe", not
  # merely "the manifest layer recognizes the identity" — the same role
  # `zellij` played here before Issue #662 completed its own projection.
  unsupportedPackageId = forceGeneration {
    manifest = baseManifest // {
      packages = [
        {
          packageId = "coding-agent-cli";
          kind = "nix-flake-package";
          version = "1.0.0";
          source = {
            flakeRef = "nix#coding-agent-cli";
            sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
          };
        }
      ];
    };
  };

  unsupportedKind = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { kind = "npm-package"; }) ]; };
  };

  # Decoupling proof (PR #634 review, second finding; sharpened by Issue
  # #702 into "the release's own recipe is used, not HEAD's"):
  # ./fixtures/alt-mottainai-source is a separate tracked tree with its own
  # package.json declaring a version (0.0.1-fixture-alt-source) that this
  # checkout's own package.json does not have, and its own
  # nix/mottainai.nix (a dependency-free recipe using the raw `derivation`
  # builtin, unrelated to HEAD's nix/mottainai.nix or nixpkgs pin — see
  # that fixture's own comments). Read directly from package.json, not via
  # `../mottainai.nix` (HEAD's own recipe) the way the pre-#702 test did —
  # this test must not itself couple back to HEAD's recipe to learn the
  # fixture's version.
  altSourceVersion =
    (builtins.fromJSON (builtins.readFile (./fixtures/alt-mottainai-source + "/package.json"))).version;

  # A manifest requesting exactly that version resolves successfully only
  # if `mottainaiSource` is genuinely threaded through to that source's own
  # recipe — a projection that silently fell back to this flake's own
  # checkout (this file's `mottainaiSource` default, or a hardcoded `../.`
  # the way the pre-#634 code had) would resolve the current checkout's
  # version instead and fail this exact version-match assertion.
  externalSourceGeneration = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = altSourceVersion; }) ]; };
    mottainaiSource = ./fixtures/alt-mottainai-source;
  };
  externalSourceIsGenuinelyUsed = externalSourceGeneration;

  # The same alternate source, but the manifest requests the *current
  # checkout's* version rather than the fixture's own — must fail, proving
  # the version-match check is genuinely evaluated against whatever source
  # was supplied, not just always trivially satisfied.
  externalSourceStillEnforcesVersionMatch = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = currentMottainaiVersion; }) ]; };
    mottainaiSource = ./fixtures/alt-mottainai-source;
  };

  # Resolves the real (entry, drv) pair nix/managed-generation.nix picked
  # for the mottainai packageId, forcing only .drvPath (a derivation's
  # store path is a deterministic function of its inputs — computable
  # without building, same laziness property forceGeneration relies on for
  # .generation.outPath above).
  resolvedMottainaiDrvPath =
    { manifest, mottainaiSource ? defaultMottainaiSource }:
    let
      result = mkManagedGeneration {
        system = pkgs.stdenv.hostPlatform.system;
        inherit manifest;
        mottainaiPackage = mottainaiPackageFromSource mottainaiSource;
      };
    in
    builtins.unsafeDiscardStringContext (builtins.head result.resolved).drv.drvPath;

  # Issue #702 regression: "HEAD source -> HEAD's own package recipe."
  # mottainaiSource defaulting to this checkout must resolve to *exactly*
  # the derivation nix/mottainai.nix (HEAD's Node.js 24 recipe) itself
  # builds for this same source — proving the release-owned resolution
  # path and HEAD's own recipe are not two divergent things that merely
  # happen to agree on a version string.
  headRecipeIsGenuinelyUsed = builtins.tryEval (
    resolvedMottainaiDrvPath { manifest = baseManifest // { packages = [ mottainaiEntry ]; }; }
    == builtins.unsafeDiscardStringContext (import ../mottainai.nix { inherit pkgs; source = mottainaiSource; }).drvPath
  );

  # Issue #702 regression: "historical source -> that release's own
  # nix#mottainai recipe, never HEAD's." Resolving the alternate fixture
  # through the real projection must NOT produce the same derivation HEAD's
  # own nix/mottainai.nix would produce if (the pre-#702 bug) it were
  # called directly against that foreign source — proving the fixture's
  # own recipe, not HEAD's, is what actually got used to build it.
  externalSourceNotReinterpretedByHeadRecipe = builtins.tryEval (
    resolvedMottainaiDrvPath {
      manifest = baseManifest // { packages = [ (mottainaiEntry // { version = altSourceVersion; }) ]; };
      mottainaiSource = ./fixtures/alt-mottainai-source;
    }
    != builtins.unsafeDiscardStringContext (import ../mottainai.nix {
      inherit pkgs;
      source = ./fixtures/alt-mottainai-source;
    }).drvPath
  );

  # Issue #702 acceptance criterion: "A release source without the
  # expected package output fails deterministically."
  # ./fixtures/alt-mottainai-source-no-flake has a package.json but no
  # nix/mottainai.nix at all — it does not own a nix#mottainai recipe, the
  # way a real historical release checkout always would.
  sourceWithoutExpectedPackageOutput = forceGeneration {
    manifest = baseManifest // { packages = [ (mottainaiEntry // { version = "0.0.1-fixture-no-flake"; }) ]; };
    mottainaiSource = ./fixtures/alt-mottainai-source-no-flake;
  };

  # Issue #702 acceptance criterion: "nix/mottainai.nix contains no
  # historical-release lockfile/outputHash mapping" / "no placeholder/fake
  # fixed-output hash remains." A pure string check against the recipe's
  # own source text, not just behavioral — the pre-#702 file could satisfy
  # every build-behavior assertion above while still carrying a dead
  # historical-lockfile table.
  mottainaiRecipeSourceText = builtins.readFile ../mottainai.nix;
  mottainaiRecipeHasNoHistoricalHashRegistry =
    !(lib.hasInfix "knownPnpmDepsHashes" mottainaiRecipeSourceText)
    && !(lib.hasInfix "pnpmLockContentHash" mottainaiRecipeSourceText)
    && !(lib.hasInfix "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" mottainaiRecipeSourceText);

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
      name = "correct zellij version resolves and evaluates successfully";
      condition = correctZellij.success;
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
      name = "a requested zellij version that does not match the resolved recipe fails deterministically";
      condition = !wrongVersionZellij.success;
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
    {
      name = "HEAD's own source resolves via HEAD's own nix/mottainai.nix recipe (Node.js 24), not a divergent resolution path";
      condition = headRecipeIsGenuinelyUsed.success && headRecipeIsGenuinelyUsed.value;
    }
    {
      name = "a historical/external source's resolved package is not HEAD's nix/mottainai.nix reinterpreting that foreign source";
      condition = externalSourceNotReinterpretedByHeadRecipe.success && externalSourceNotReinterpretedByHeadRecipe.value;
    }
    {
      # Issue #702 acceptance criterion: a release source exposing no
      # nix/mottainai.nix (no nix#mottainai package output) must fail
      # deterministically, never silently fall back to HEAD's recipe.
      name = "a mottainaiSource without the expected nix#mottainai package output fails deterministically";
      condition = !sourceWithoutExpectedPackageOutput.success;
    }
    {
      # Issue #702 acceptance criterion: no historical-lockfile mapping and
      # no placeholder/fake fixed-output hash remains in nix/mottainai.nix.
      name = "nix/mottainai.nix carries no historical-lockfile hash registry or placeholder fixed-output hash";
      condition = mottainaiRecipeHasNoHistoricalHashRegistry;
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
