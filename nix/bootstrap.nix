{ lib, stdenvNoCC, fetchurl, makeWrapper, nodejs_24, typescript, git, source }:

# Minimal standalone packaging of Issue #626's bootstrap CLI
# (src/bootstrap/**), proving it is independently Nix-packageable without
# pulling in the full `mottainai` package's own dependency closure.
#
# Deliberately NOT modeled on nix/mottainai.nix's `pnpm install
# --frozen-lockfile` recipe: that recipe installs every root `dependencies`
# entry (@modelcontextprotocol/sdk, @xterm/*, node-pty, tree-sitter*,
# typescript, ws) regardless of what bootstrap actually imports. Bootstrap's
# entire runtime import graph (src/bootstrap/** plus the
# src/runtime-contract/** modules it composes: managed-package-manifest.ts,
# managed-generation.ts, managed-generation-build.ts; plus src/atomic-file.ts
# and src/boundary.ts) uses only `zod` and Node built-ins. This recipe is
# modeled on nix/packages/nawabari.nix's single-dependency `fetchurl`
# pattern instead: pin zod directly, do not touch pnpm-lock.yaml at
# Nix-eval time (this repository's Nix files never parse it), skip the
# rest of the workspace entirely.
#
# The zod version/hash pin below is a second, independently-maintained
# authority against pnpm-lock.yaml's own resolved zod entry — kept in sync
# by src/bootstrap/nix-dependency-pin.test.ts, which fails loudly the
# moment they diverge. Update both together.
#
# This package is embedded in the bootstrap-only base Runtime Appliance by
# Issue #627. The source projection below is deliberately narrow so a change
# to the managed Mottainai package metadata does not change this derivation.

let
  pname = "mottainai-bootstrap";
  # This is the bootstrap component's identity, not the version of any
  # managed application package. It must remain independent from the root
  # package.json version, which is a managed-generation input.
  version = "1.0.0";
  nodejs = nodejs_24;

  # Keep the bootstrap derivation's source closure independent from the full
  # repository. In particular, package.json, application sources, lockfile,
  # and unrelated tests must not become inputs to the base appliance merely
  # because the bootstrap package is built from the repository checkout.
  # The Nix projection files are included because a deployed bootstrap CLI
  # must be able to invoke #625 without a repository checkout.
  sourceFiles = [
    "src/bootstrap/main.ts"
    "src/bootstrap/cli.ts"
    "src/bootstrap/build.ts"
    "src/bootstrap/errors.ts"
    "src/bootstrap/paths.ts"
    "src/bootstrap/source-resolution.ts"
    "src/bootstrap/state.ts"
    "src/bootstrap/unreadable-manifest.ts"
    "src/runtime-contract/managed-generation-build.ts"
    "src/runtime-contract/managed-generation.ts"
    "src/runtime-contract/contract.ts"
    "src/runtime-contract/managed-package-manifest.ts"
    "src/runtime-contract/managed-runtime.ts"
    "src/runtime-contract/managed-runtime-state.ts"
    "src/atomic-file.ts"
    "src/boundary.ts"
    "nix/flake.nix"
    "nix/flake.lock"
    "nix/managed-generation.nix"
    "nix/mottainai.nix"
    "nix/bootstrap.nix"
    "nix/packages/nawabari.nix"
  ];

  bootstrapSource = builtins.path {
    name = "${pname}-source";
    path = source;
    filter = path: _type:
      let
        sourcePath = toString source;
        candidatePath = toString path;
        relativePath =
          if candidatePath == sourcePath then
            ""
          else
            builtins.substring (builtins.stringLength sourcePath + 1) (-1) candidatePath;
        isRelevantPath = file:
          relativePath == file
          || lib.hasPrefix "${file}/" relativePath
          || lib.hasPrefix "${relativePath}/" file;
      in
      relativePath == "" || builtins.any isRelevantPath sourceFiles;
  };

  # Kept in sync with pnpm-lock.yaml's resolved `zod@<version>:` entry by
  # src/bootstrap/nix-dependency-pin.test.ts.
  zodVersion = "3.25.76";
  zodSha512 = "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==";

  zodTarball = fetchurl {
    url = "https://registry.npmjs.org/zod/-/zod-${zodVersion}.tgz";
    hash = zodSha512;
  };

  # Build-time-only type declarations for Node built-ins (tsc needs these to
  # resolve `node:*` imports); never referenced by the installed output, so
  # this does not appear in the runtime closure — same reasoning as the
  # nixpkgs `typescript` nativeBuildInput above. Kept in sync with
  # pnpm-lock.yaml's resolved `@types/node@<version>:` entry by
  # src/bootstrap/nix-dependency-pin.test.ts.
  typesNodeVersion = "24.13.3";
  typesNodeSha512 = "sha512-Dh8vAsV36ig5wa9OX4pXvMc9D3Veibfw2wix0CUwYODLD8nkj9UsLjASr49nPg+2eKzxhBV+v7L8pXvT4e639Q==";

  typesNodeTarball = fetchurl {
    url = "https://registry.npmjs.org/@types/node/-/node-${typesNodeVersion}.tgz";
    hash = typesNodeSha512;
  };
in
stdenvNoCC.mkDerivation {
  inherit pname version;
  src = bootstrapSource;

  # nixpkgs' own `typescript` package is a build-time-only tool here: it
  # compiles src/bootstrap/** but is never referenced by the installed
  # output, so it does not appear in the resulting closure — unlike the npm
  # `typescript` package in this repository's own `dependencies`, which
  # nix/mottainai.nix's full pnpm-install recipe would otherwise pull in.
  nativeBuildInputs = [ nodejs makeWrapper typescript git ];

  # Only the bootstrap file subtree is meaningful input here; unpackPhase
  # copies the whole checkout (cheap — this is source, not a build
  # artifact) but buildPhase/installPhase below touch nothing outside
  # src/bootstrap/** and its direct src/ dependencies.
  unpackPhase = ''
    runHook preUnpack
    mkdir source
    cp -a "$src"/. source/
    chmod -R u+w source
    cd source
    # The filtered source intentionally excludes the repository package.json.
    # Keep NodeNext compilation in ESM mode without making the managed package
    # metadata an input to this base derivation.
    printf '{"type":"module"}\n' > package.json
    runHook postUnpack
  '';

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    # Compile only the TypeScript this package actually ships: bootstrap's
    # own module subtree plus the runtime-contract modules it imports.
    # Using the repository's own tsconfig target/module settings (ES2022,
    # NodeNext) without invoking the full `tsc -p tsconfig.build.json`
    # project build, which would attempt to compile every src/**/* file
    # including ones with dependencies (xterm, node-pty, tree-sitter) this
    # closure must exclude.
    mkdir -p "$TMPDIR/node_modules/zod" "$TMPDIR/node_modules/@types/node"
    tar -xzf ${zodTarball} -C "$TMPDIR/node_modules/zod" --strip-components=1
    tar -xzf ${typesNodeTarball} -C "$TMPDIR/node_modules/@types/node" --strip-components=1

    tsc \
      --outDir dist \
      --rootDir src \
      --target ES2022 \
      --module NodeNext \
      --moduleResolution NodeNext \
      --strict \
      --esModuleInterop \
      --skipLibCheck \
      --resolveJsonModule \
      --typeRoots "$TMPDIR/node_modules/@types" \
      --types node \
      src/bootstrap/main.ts \
      src/bootstrap/cli.ts \
      src/bootstrap/build.ts \
      src/bootstrap/errors.ts \
      src/bootstrap/paths.ts \
      src/bootstrap/source-resolution.ts \
      src/bootstrap/state.ts \
      src/bootstrap/unreadable-manifest.ts \
      src/runtime-contract/managed-generation-build.ts \
      src/runtime-contract/managed-generation.ts \
      src/runtime-contract/contract.ts \
      src/runtime-contract/managed-package-manifest.ts \
      src/runtime-contract/managed-runtime.ts \
      src/runtime-contract/managed-runtime-state.ts \
      src/atomic-file.ts \
      src/boundary.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    mkdir -p "$packageRoot/node_modules"
    # Preserve the deterministic ESM marker created by unpackPhase. The
    # repository's managed package.json is intentionally not copied; this
    # package's module mode is a bootstrap implementation detail.
    install -Dm0644 package.json "$packageRoot/package.json"
    cp -a dist/. "$packageRoot/"
    cp -a "$TMPDIR/node_modules/zod" "$packageRoot/node_modules/zod"

    # Issue #625's Nix projection (nix/managed-generation.nix,
    # nix/mottainai.nix, nix/packages/nawabari.nix) plus the flake wiring
    # that exposes lib.mkManagedGeneration (nix/flake.nix, nix/flake.lock)
    # — copied in so the packaged bootstrap CLI can invoke `nix build`
    # against its OWN copy without a repository checkout anywhere on the
    # deployed host (PR review finding P0-1: `buildManagedGeneration`
    # resolves `''${repoRoot}/nix` via `builtins.getFlake`, and this package
    # previously shipped no `nix/` directory at all, silently requiring
    # `--repo-root` to point at a real checkout that a fresh Appliance does
    # not have). Verified in isolation (a git-tracked directory containing
    # only this exact file list, no repository root above it) that
    # `flake.lib.mkManagedGeneration` evaluates and builds correctly:
    # nixpkgs.legacyPackages/nixpkgs.lib are Nix-store-resolved via the
    # pinned flake input, not the surrounding checkout, and
    # mkManagedGeneration never forces mkMottainai's `source = ../.`
    # binding (only reachable through packages.<system>.mottainai, which
    # this projection never touches) — Nix's laziness means that binding is
    # simply never evaluated when only lib.mkManagedGeneration is invoked.
    nixProjectionRoot="$packageRoot/nix-projection/nix"
    mkdir -p "$nixProjectionRoot/packages"
    cp "$src/nix/flake.nix" "$nixProjectionRoot/flake.nix"
    cp "$src/nix/flake.lock" "$nixProjectionRoot/flake.lock"
    cp "$src/nix/managed-generation.nix" "$nixProjectionRoot/managed-generation.nix"
    cp "$src/nix/mottainai.nix" "$nixProjectionRoot/mottainai.nix"
    cp "$src/nix/bootstrap.nix" "$nixProjectionRoot/bootstrap.nix"
    cp "$src/nix/packages/nawabari.nix" "$nixProjectionRoot/packages/nawabari.nix"
    # A git repository, not just a plain directory: builtins.getFlake
    # requires its target to be a git (or other supported VCS) working tree
    # to resolve `?dir=nix` as a flake, matching how the real repository
    # checkout satisfies this today.
    (
      cd "$packageRoot/nix-projection"
      export HOME="$TMPDIR/git-home-for-nix-projection"
      mkdir -p "$HOME"
      git init --quiet
      git -c user.email=bootstrap@localhost -c user.name=bootstrap add -A
      git -c user.email=bootstrap@localhost -c user.name=bootstrap commit --quiet -m "bootstrap Nix projection snapshot"
    )

    makeWrapper "${nodejs}/bin/node" "$out/bin/mottainai-bootstrap" \
      --add-flags "$packageRoot/bootstrap/main.js"

    runHook postInstall
  '';

  meta = {
    description = "Minimal bootstrap package/build entrypoint for a fresh Runtime Appliance (Issue #626)";
    homepage = "https://github.com/yohn-jp/mottainai";
    license = lib.licenses.mit;
    mainProgram = "mottainai-bootstrap";
    platforms = lib.platforms.linux;
  };
}
