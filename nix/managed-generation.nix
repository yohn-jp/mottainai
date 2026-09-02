{ pkgs, lib, mottainaiSource, nawabariPackage, zellijPackage, manifest }:

# Deterministic projection of a mottainai.managed-package-manifest.v1
# manifest (src/runtime-contract/managed-package-manifest.ts, Issue #624)
# into a buildable managed Nix generation (Issue #625). Consumes the
# existing nix/mottainai.nix / nix/packages/nawabari.nix recipes rather
# than inventing a second package-resolution path — this file only
# projects manifest entries onto them, it does not build a general package
# framework.
#
# Source resolution boundary (PR #634 review): `mottainaiSource` is an
# already-resolved exact source tree this projection is handed — it does
# not decide *which* source that is. Earlier this file received a
# pre-built `mottainaiPackage` fixed to this flake's own checkout
# (`nix/flake.nix`'s `mkMottainai pkgs` with `source = ../.`), which made
# the whole projection incapable of building any Mottainai version other
# than whatever this exact checkout happens to be — impossible to satisfy
# from a fresh bootstrap appliance building a manifest-requested release.
# Resolving *how* to obtain that source (a tagged release checkout, a
# fetched tarball, a bootstrap appliance's download) is Issue #626's job —
# package-manager UX and manifest-to-source-fetching — not implemented
# here. Nawabari is unaffected: `nix/packages/nawabari.nix` already
# resolves its own source internally via `fetchurl` and is received here
# pre-built, same as before.
#
# Release-owned recipe boundary (Issue #702): a release owns its own build
# recipe, toolchain, nixpkgs pin, and fixed-output dependency hash — HEAD
# must not reinterpret a foreign source tree using its own `./mottainai.nix`.
# An earlier revision of this file took a `buildMottainai` function
# (`source: import ./mottainai.nix { inherit pkgs source; }`, HEAD's own
# recipe partially applied over `pkgs`) and called it with whatever
# `mottainaiSource` was supplied — including a historical tagged release's
# source tree. That combined "HEAD's current recipe + historical source" in
# a way neither HEAD nor the historical release ever owns on its own, and
# forced HEAD to carry a permanent `lockfile hash -> outputHash` table for
# every historical lockfile it might be asked to reinterpret. This file no
# longer takes `buildMottainai` at all: `mottainaiSource`'s own
# `nix#mottainai` package output is resolved directly from that source
# tree's own `nix/flake.nix` (below), so HEAD is resolved from HEAD's own
# flake and a historical release is resolved from that release's own
# flake — the same single resolution path either way, never a HEAD-only
# shortcut that could silently diverge from it.
#
# Source-integrity verification (manifest sourceSha256 vs. the exact
# source tree each derivation actually built from) is deliberately not
# attempted inside this Nix expression: converting between an SRI hash and
# manifest sourceSha256's lowercase-hex sha256 form needs `nix path-info`
# (an external command) against a realized store path, which is not
# reachable from pure Nix-language evaluation. This file instead exposes
# each resolved entry's `sourceStorePath` (the exact store path Nix
# resolved as that derivation's `src`) so scripts/build-managed-generation.mjs
# can run `nix path-info --json` against it after the build and compare its
# narHash to the manifest's declared sourceSha256, failing closed on a
# mismatch before ever reporting the build as successful.
#
# Kept separate from nix/runtime-appliance-image.nix by construction: this
# derivation's output never references the appliance's disk image or NixOS
# system closure, so changing only the managed package manifest never
# forces `runtime-appliance-image` to rebuild (Issue #625 acceptance
# criterion; see docs/managed-generation.md "Independence from the bootable
# appliance").
#
# Issue #662 completes the first supported managed Runtime package catalog
# by adding Zellij: `zellijPackage` is received pre-built the same way
# `nawabariPackage` is (no per-manifest-entry construction needed, since
# nixpkgs already resolves the whole recipe) — `nix/flake.nix`'s `mkZellij`
# delegates directly to the pinned nixpkgs `zellij-unwrapped` derivation
# rather than a repository-owned recipe, per this Issue's constraint to
# prefer existing high-quality nixpkgs packages over reinventing one.
# `coding-agent-cli` remains a #624-recognized identity with no projection
# here: Issue #662 only projects a package once Mottainai claims first-class
# support for it, which is not yet the case.

let
  contractId = "mottainai.managed-generation.v1";
  compatibilityContractVersion = 1;

  supportedPackageIds = [ "mottainai" "nawabari" "zellij" ];

  system = pkgs.stdenv.hostPlatform.system;

  unsupportedPackage = entry: reason:
    throw "managed generation projection: unsupported managed package entry packageId=${entry.packageId} kind=${entry.kind} flakeRef=${entry.source.flakeRef}: ${reason}";

  # Fails closed when the manifest's requested exact version does not match
  # the version the resolved recipe actually builds (PR #634 review: a
  # manifest requesting mottainai@0.7.2 must never silently succeed by
  # building whatever version nix/mottainai.nix currently pins, e.g. 0.7.1
  # — that would violate Issue #625's exact-identity acceptance criterion).
  # This is a distinct failure from "no recipe available": the recipe
  # exists, but the currently pinned recipe does not build the requested
  # version.
  requireMatchingVersion = entry: drv:
    if entry.version != drv.version then
      throw "managed generation projection: requested version mismatch for packageId=${entry.packageId}: manifest requests version=${entry.version}, but the resolved recipe for flakeRef=${entry.source.flakeRef} builds version=${drv.version}"
    else
      drv;

  # Issue #702: resolves `mottainaiSource`'s own `nix#mottainai` package
  # output from that source tree's own `nix/flake.nix` — never HEAD's
  # `./mottainai.nix` applied to a foreign source. `?dir=nix` mirrors
  # `src/runtime-contract/managed-generation-build.ts`'s own
  # `builtins.getFlake (toString repoRoot + "?dir=nix")` call for HEAD's
  # flake, the same flakeref shape for a path whose flake.nix lives in a
  # `nix/` subdirectory rather than at its root.
  mottainaiFlakeRef = toString mottainaiSource + "?dir=nix";
  mottainaiFlakeResult = builtins.tryEval (builtins.getFlake mottainaiFlakeRef);

  mottainaiPackagesForSystem =
    if !mottainaiFlakeResult.success then
      throw "managed generation projection: mottainai source at ${toString mottainaiSource} does not expose a usable nix flake at nix/flake.nix — a release must own its own nix#mottainai recipe, it is not reinterpreted by HEAD's nix/mottainai.nix"
    else if !(mottainaiFlakeResult.value ? packages) || !(mottainaiFlakeResult.value.packages ? ${system}) then
      throw "managed generation projection: mottainai source at ${toString mottainaiSource} flake exposes no packages.${system} output"
    else
      mottainaiFlakeResult.value.packages.${system};

  # Built lazily, once, only if a manifest entry actually needs it — Nix
  # shares this single reference across the (at most one, #624 forbids
  # duplicate packageId) mottainai entry, so this never rebuilds per entry.
  mottainaiDerivation =
    if !(mottainaiPackagesForSystem ? mottainai) then
      throw "managed generation projection: mottainai source at ${toString mottainaiSource} flake exposes no packages.${system}.mottainai output"
    else
      mottainaiPackagesForSystem.mottainai;

  resolveEntry = entry:
    if entry.kind != "nix-flake-package" then
      unsupportedPackage entry "unsupported managed package kind"
    else if entry.packageId == "mottainai" then
      if entry.source.flakeRef != "nix#mottainai" then
        unsupportedPackage entry "no recipe available for this flakeRef"
      else
        requireMatchingVersion entry mottainaiDerivation
    else if entry.packageId == "nawabari" then
      if entry.source.flakeRef != "nix/packages/nawabari.nix" then
        unsupportedPackage entry "no recipe available for this flakeRef"
      else
        requireMatchingVersion entry nawabariPackage
    else if entry.packageId == "zellij" then
      if entry.source.flakeRef != "nixpkgs#zellij-unwrapped" then
        unsupportedPackage entry "no recipe available for this flakeRef"
      else
        requireMatchingVersion entry zellijPackage
    else
      unsupportedPackage entry "packageId is not projected by this managed generation (supported catalog: mottainai, nawabari, zellij)";

  unsupportedEntries = builtins.filter (entry: !(builtins.elem entry.packageId supportedPackageIds)) manifest.packages;

  resolved = map (entry: { inherit entry; drv = resolveEntry entry; }) manifest.packages;
in
if unsupportedEntries != [ ] then
  unsupportedPackage (builtins.head unsupportedEntries) "packageId is not projected by this managed generation (supported catalog: mottainai, nawabari, zellij)"
else
rec {
  inherit resolved;

  # A single buildEnv distinct from any appliance/system closure: this is
  # the "managed generation" build artifact itself, independent of
  # runtime-appliance-image.nix / runtime-system.
  generation = pkgs.buildEnv {
    name = "mottainai-managed-generation";
    paths = map (r: r.drv) resolved;
  };

  requestedIdentity.packages = map (r: {
    packageId = r.entry.packageId;
    version = r.entry.version;
    sourceSha256 = r.entry.source.sourceSha256;
  }) resolved;

  resolvedIdentity.packages = map (r: {
    packageId = r.entry.packageId;
    resolvedVersion = r.drv.version;
  }) resolved;

  # A runCommand (not writeText) so `generation` and every resolved package
  # derivation are real build inputs of this output — referencing
  # `${generation}` / `${r.drv}` below adds them to this derivation's
  # inputDrvs, so building metadataFile necessarily builds the managed
  # generation and every package it resolves, rather than only computing
  # their store paths without realizing them.
  metadataFile =
    let
      # sourceStorePath: the exact store path Nix resolved as this
      # package's own build source (fetchurl result for nawabari, the
      # repository checkout tree for mottainai) — not the built output.
      # scripts/build-managed-generation.mjs hashes this path with `nix
      # path-info` and compares it against the manifest's declared
      # sourceSha256.
      packageStorePathEntries = lib.concatMapStringsSep ",\n    " (r: ''
        { "packageId": ${builtins.toJSON r.entry.packageId}, "storePath": "${r.drv}", "sourceStorePath": "${r.drv.src}" }'') resolved;
    in
    pkgs.runCommand "managed-generation-metadata.json"
      {
        nativeBuildInputs = [ pkgs.jq ];
        requestedIdentityJson = builtins.toJSON requestedIdentity;
        resolvedIdentityJson = builtins.toJSON resolvedIdentity;
        generationStorePath = "${generation}";
      }
      ''
        jq -n \
          --argjson contractId ${lib.escapeShellArg (builtins.toJSON contractId)} \
          --argjson schemaVersion ${lib.escapeShellArg (builtins.toJSON compatibilityContractVersion)} \
          --argjson requestedIdentity "$requestedIdentityJson" \
          --argjson resolvedIdentity "$resolvedIdentityJson" \
          --arg generationStorePath "$generationStorePath" \
          --argjson packages '[${packageStorePathEntries}]' \
          '{
            contractId: $contractId,
            schemaVersion: $schemaVersion,
            compatibilityContractVersion: $schemaVersion,
            requestedIdentity: $requestedIdentity,
            resolvedIdentity: $resolvedIdentity,
            nixOutput: { storePath: $generationStorePath, packages: $packages }
          }' > "$out"
      '';
}
