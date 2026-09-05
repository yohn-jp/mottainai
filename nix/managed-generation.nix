{ pkgs, lib, mottainaiPackage, nawabariPackage, zellijPackage, manifest }:

# Deterministic projection of a mottainai.managed-package-manifest.v1
# manifest (src/runtime-contract/managed-package-manifest.ts, Issue #624)
# into a buildable managed Nix generation (Issue #625). Consumes the
# existing nix/mottainai.nix / nix/packages/nawabari.nix recipes rather
# than inventing a second package-resolution path — this file only
# projects manifest entries onto them, it does not build a general package
# framework.
#
# Package resolution vs. generation projection boundary (PR #634 review,
# sharpened by Issue #702): this file only *projects* manifest entries onto
# already-resolved package derivations — `mottainaiPackage`, like
# `nawabariPackage`/`zellijPackage` below, arrives pre-built. It does not
# decide *which* source `mottainaiPackage` was built from, nor how. Two
# earlier designs got this boundary wrong in opposite ways:
#
# - Pre-#634: this file always built `mkMottainai pkgs` internally
#   (`nix/flake.nix`'s `source = ../.`, this flake's own checkout, fixed).
#   That made the projection incapable of building any Mottainai version
#   other than whatever this exact checkout happened to be — impossible to
#   satisfy from a fresh bootstrap appliance building a manifest-requested
#   release that isn't this checkout's own tagged version.
# - #634 through #702: this file instead took a `mottainaiSource` (an
#   already-resolved exact source tree, e.g. a historical tagged release)
#   plus a `buildMottainai = source: import ./mottainai.nix { inherit pkgs
#   source; }` function — HEAD's own `nix/mottainai.nix` (its current
#   Node.js 24 toolchain/nixpkgs pin) partially applied over `pkgs`, then
#   called against whatever foreign source was supplied. That combined
#   "HEAD's current recipe" with "a foreign release's source" in a way
#   neither side owns on its own, and forced HEAD to carry a permanent
#   `pnpm-lock.yaml content hash -> outputHash` table spanning every
#   historical lockfile it might ever be asked to reinterpret.
#
# `mottainaiPackage` now arrives pre-resolved: the caller (Issue #626's
# production driver, `src/runtime-contract/managed-generation-build.ts`)
# resolves it from `mottainaiSource`'s own `nix/flake.nix` via
# `builtins.getFlake`, at that caller's own already-impure `nix build
# --impure` call site — never inside this file. That split is required, not
# stylistic: `builtins.getFlake` on an unlocked local path is an impure
# operation Nix refuses in pure evaluation, and `nix flake check`
# (`.github/workflows/ci.yml`) evaluates `checks.<system>.managed-generation`
# / `checks.<system>.appliance-boundary` — both of which exercise this file
# — without `--impure`. Keeping this file's own signature pure-resolvable
# (a plain pre-built derivation argument, exactly like `nawabariPackage`/
# `zellijPackage` always were) is what makes both true at once: HEAD is
# still resolved from HEAD's own flake, a historical release is still
# resolved from that release's own flake, and `nix flake check` still
# evaluates cleanly. `nix/tests/managed-generation.nix` resolves its own
# `mottainaiPackage` values the same pure way its checks require (a plain
# `import` of a source tree's own `nix/mottainai.nix`, never HEAD's copy of
# that file) — see that file's own comments for why that is still a
# meaningful proof despite not exercising `builtins.getFlake` itself.
# Nawabari is unaffected by any of this: `nix/packages/nawabari.nix`
# already resolves its own source internally via `fetchurl` and is
# received here pre-built, same as before.
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

  # Route 2's application closure owns the external executables used by the
  # supported Mottainai surface. They are deliberately not resolved from the
  # host PATH and are not manifest entries: the manifest names application
  # packages, while this fixed catalog closes the lower-level execution
  # prerequisites those packages require. The pinned nixpkgs input supplies
  # their exact versions and store identities.
  runtimeDependencies = [
    {
      packageId = "git";
      command = "git";
      version = pkgs.git.version;
      drv = pkgs.git;
    }
    {
      packageId = "ripgrep";
      command = "rg";
      version = pkgs.ripgrep.version;
      drv = pkgs.ripgrep;
    }
  ];

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

  resolveEntry = entry:
    if entry.kind != "nix-flake-package" then
      unsupportedPackage entry "unsupported managed package kind"
    else if entry.packageId == "mottainai" then
      if entry.source.flakeRef != "nix#mottainai" then
        unsupportedPackage entry "no recipe available for this flakeRef"
      else
        requireMatchingVersion entry mottainaiPackage
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
  inherit runtimeDependencies;

  # A single buildEnv distinct from any appliance/system closure: this is
  # the "managed generation" build artifact itself, independent of
  # runtime-appliance-image.nix / runtime-system. The application packages
  # and the explicit Route 2 runtime dependency catalog share this boundary.
  generation = pkgs.buildEnv {
    name = "mottainai-managed-generation";
    paths = (map (r: r.drv) resolved) ++ (map (dependency: dependency.drv) runtimeDependencies);
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

  # Only the payload-consuming Mottainai boundary emits this evidence. A
  # source-based derivation has no canonical Route 1 identity and therefore
  # cannot accidentally claim to have consumed one.
  applicationPayload =
    let
      mottainaiEntries = builtins.filter (entry: entry.packageId == "mottainai") manifest.packages;
    in
    if mottainaiEntries != [ ]
      && mottainaiPackage ? canonicalPayloadSha256
      && mottainaiPackage.canonicalPayloadSha256 != null
    then {
      packageName = "mottainai";
      packageVersion = mottainaiPackage.version;
      sha256 = mottainaiPackage.canonicalPayloadSha256;
    }
    else null;

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
        applicationPayloadJson = builtins.toJSON applicationPayload;
        generationStorePath = "${generation}";
      }
      ''
        jq -n \
          --argjson contractId ${lib.escapeShellArg (builtins.toJSON contractId)} \
          --argjson schemaVersion ${lib.escapeShellArg (builtins.toJSON compatibilityContractVersion)} \
          --argjson requestedIdentity "$requestedIdentityJson" \
          --argjson resolvedIdentity "$resolvedIdentityJson" \
          --argjson applicationPayload "$applicationPayloadJson" \
          --arg generationStorePath "$generationStorePath" \
          --argjson packages '[${packageStorePathEntries}]' \
          '{
            contractId: $contractId,
            schemaVersion: $schemaVersion,
            compatibilityContractVersion: $schemaVersion,
            requestedIdentity: $requestedIdentity,
            resolvedIdentity: $resolvedIdentity,
            nixOutput: { storePath: $generationStorePath, packages: $packages }
          } + (if $applicationPayload == null then {} else { applicationPayload: $applicationPayload } end)' > "$out"
      '';
}
