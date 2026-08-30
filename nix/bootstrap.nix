{ lib, stdenvNoCC, fetchurl, makeWrapper, nodejs_24, typescript, source }:

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
# This package is intentionally NOT wired into nix/modules/runtime.nix or
# any appliance/runtime closure here — proving standalone packageability is
# Issue #626's job; embedding it into the base Runtime Appliance and
# removing the full `mottainai` package from that closure is Issue #627's.

let
  pname = "mottainai-bootstrap";
  package = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  version = package.version;
  nodejs = nodejs_24;

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
  typesNodeVersion = "22.20.1";
  typesNodeSha512 = "sha512-EANqOCF9QFyra+4pfxUcX9STKJpCLjMbObVzljIJomAWSnuSIEAvyzEU53GaajbXJEgdh0iEcPL+DGvpUd4k1Q==";

  typesNodeTarball = fetchurl {
    url = "https://registry.npmjs.org/@types/node/-/node-${typesNodeVersion}.tgz";
    hash = typesNodeSha512;
  };
in
stdenvNoCC.mkDerivation {
  inherit pname version;
  src = source;

  # nixpkgs' own `typescript` package is a build-time-only tool here: it
  # compiles src/bootstrap/** but is never referenced by the installed
  # output, so it does not appear in the resulting closure — unlike the npm
  # `typescript` package in this repository's own `dependencies`, which
  # nix/mottainai.nix's full pnpm-install recipe would otherwise pull in.
  nativeBuildInputs = [ nodejs makeWrapper typescript ];

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
      src/runtime-contract/managed-generation-build.ts \
      src/runtime-contract/managed-generation.ts \
      src/runtime-contract/managed-package-manifest.ts \
      src/atomic-file.ts \
      src/boundary.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    mkdir -p "$packageRoot/node_modules"
    cp -a dist/. "$packageRoot/"
    cp -a "$TMPDIR/node_modules/zod" "$packageRoot/node_modules/zod"

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
