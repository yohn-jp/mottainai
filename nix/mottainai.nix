{ pkgs, source }:

let
  inherit (pkgs) lib;

  pname = "mottainai";
  package = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  version = package.version;
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.pnpm;
  nodeSrc = pkgs.srcOnly nodejs;
  nodeGyp = "${nodejs}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js";
  caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  pnpmLock = source + "/pnpm-lock.yaml";

  pnpmDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "${pname}-pnpm-deps";
    inherit version;

    dontUnpack = true;
    nativeBuildInputs = [ nodejs pnpm ];
    SSL_CERT_FILE = caBundle;
    NODE_EXTRA_CA_CERTS = caBundle;

    buildPhase = ''
      runHook preBuild

      workdir="$TMPDIR/${pname}-pnpm-deps"
      mkdir -p "$workdir" "$out"
      cp ${pnpmLock} "$workdir/pnpm-lock.yaml"
      cd "$workdir"
      export pnpm_config_minimum_release_age=0
      # Fetches dev dependencies too: `pnpm run build` (tsc) below needs
      # typescript and @types/node, which --prod would exclude. installPhase
      # reinstalls with --prod against this same store to produce the
      # shipped, dev-dependency-free node_modules.
      pnpm fetch --frozen-lockfile --ignore-scripts --store-dir "$out"

      # Older pnpm stores stamp each cached package's index.json with a
      # checkedAt wall-clock timestamp. pnpm 11 stores the same metadata in
      # an SQLite index, whose row insertion order also depends on fetch
      # completion order. Normalize both sources of nondeterminism.
      find "$out" -path '*/files/*-index.json' -print0 \
        | xargs -0 --no-run-if-empty sed -i -E 's/"checkedAt":[0-9]+/"checkedAt":0/g'

      indexDb="$out/v11/index.db"
      if test -f "$indexDb"; then
        INDEX_DB="$indexDb" node <<'NODE'
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const indexDb = process.env.INDEX_DB;
const source = new DatabaseSync("file://" + indexDb + "?immutable=1");
const rows = source.prepare(
  "SELECT key, data FROM package_index ORDER BY key"
).all();
const canonicalDb = indexDb + ".canonical";
const target = new DatabaseSync(canonicalDb);

target.exec(`
  PRAGMA page_size=4096;
  PRAGMA auto_vacuum=0;
  PRAGMA journal_mode=DELETE;
  PRAGMA synchronous=OFF;
  CREATE TABLE package_index (
    key TEXT PRIMARY KEY,
    data BLOB NOT NULL
  ) WITHOUT ROWID;
`);

const insert = target.prepare(
  "INSERT INTO package_index (key, data) VALUES (?, ?)"
);
let checkedAtCount = 0;
target.exec("BEGIN");
for (const row of rows) {
  const data = Buffer.from(row.data);
  for (let offset = 0; offset + 8 < data.length; offset++) {
    if (data[offset] !== 0xcb) continue;
    const value = data.readDoubleBE(offset + 1);
    if (value >= 1e12 && value < 1e13) {
      data.fill(0, offset + 1, offset + 9);
      checkedAtCount++;
    }
  }
  insert.run(row.key, data);
}
target.exec("COMMIT; ANALYZE package_index;");
target.close();
source.close();

if (checkedAtCount === 0) {
  throw new Error("pnpm index.db did not contain checkedAt timestamps");
}
fs.renameSync(canonicalDb, indexDb);
NODE
      fi

      runHook postBuild
    '';

    dontInstall = true;
    # fixupPhase (shebang patching, RPath shrinking) rewrites cached package
    # files to reference this build's store paths, which a fixed-output
    # derivation must not do; this store is inert cache content, not a
    # runnable output, so skip fixup entirely.
    dontFixup = true;
    outputHashMode = "recursive";
    outputHash = "sha256-OyPBWgRlrnbPjLGx6/8WQThz2xiXJU2RVBi4Cp6G1bI=";
  };
in
pkgs.stdenv.mkDerivation {
  inherit pname version;
  src = source;

  nativeBuildInputs = [
    nodejs
    pnpm
    nodejs.python
    pkgs.gnumake
    pkgs.makeWrapper
  ];

  dontConfigure = true;

  unpackPhase = ''
    runHook preUnpack

    mkdir source
    cp -a "$src"/. source/
    chmod -R u+w source
    # This derivation always installs its own dependencies from the
    # pnpmDeps fixed-output store (buildPhase below); a node_modules
    # that happened to already exist in $src (e.g. an impure mottainaiSource
    # pointing at a live checkout with a host-installed node_modules, as
    # scripts/verify-managed-generation-catalog.mjs's Issue #662 CI proof
    # does) must never be carried into the build — pnpm's own removal of a
    # pre-existing node_modules prompts interactively and aborts under
    # --offline in a sandboxed, non-TTY build regardless of a CI env var,
    # since the Nix build sandbox does not inherit the caller's environment.
    rm -rf source/node_modules
    cd source

    runHook postUnpack
  '';

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR/home"
    export PATH="${nodejs}/lib/node_modules/npm/bin/node-gyp-bin:$PATH"
    export npm_config_nodedir="${nodeSrc}"
    export npm_config_node_gyp="${nodeGyp}"
    export SSL_CERT_FILE="${caBundle}"
    export NODE_EXTRA_CA_CERTS="${caBundle}"
    # The repository's packageManager field is documentation for developers;
    # the pinned nixpkgs pnpm is the build tool and must not bootstrap another
    # pnpm release or touch the network.
    export pnpm_config_pm_on_fail=ignore
    export pnpm_config_minimum_release_age=0
    mkdir -p "$HOME"

    # pnpm 11 updates its SQLite store index even for offline installs. Work
    # from a writable copy so the fixed-output store remains immutable while
    # the build and production-only reinstall share the same dependencies.
    pnpmStore="$TMPDIR/pnpm-store"
    mkdir -p "$pnpmStore"
    cp -R ${pnpmDeps}/. "$pnpmStore/"
    chmod -R u+w "$pnpmStore"

    pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir "$pnpmStore"
    pnpm rebuild node-pty --store-dir "$pnpmStore"
    pnpm run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    mkdir -p "$packageRoot"

    # Build from the exact tracked source, but install the same bounded file
    # surface declared by package.json rather than copying the repository.
    pnpm pack --pack-destination "$TMPDIR"
    tar -xzf "$TMPDIR/${pname}-${version}.tgz" --strip-components=1 -C "$packageRoot"

    # buildPhase's node_modules carries devDependencies (typescript,
    # @types/node) needed only by `pnpm run build`; reinstall --prod so the
    # shipped package doesn't carry them.
    rm -rf node_modules
    pnpm install --prod --offline --frozen-lockfile --ignore-scripts --store-dir "$pnpmStore"
    pnpm rebuild node-pty --store-dir "$pnpmStore"
    cp -a node_modules "$packageRoot/node_modules"
    rm -rf "$packageRoot/node_modules/.cache"

    # pnpm stamps these generated state files with wall-clock timestamps,
    # which otherwise makes this derivation's output non-reproducible.
    find "$packageRoot" -name '.modules.yaml' -print0 \
      | xargs -0 --no-run-if-empty sed -i -E 's/"prunedAt": "[^"]*"/"prunedAt": "1970-01-01T00:00:00.000Z"/'
    find "$packageRoot" -name '.pnpm-workspace-state-v1.json' -print0 \
      | xargs -0 --no-run-if-empty sed -i -E 's/"lastValidatedTimestamp": [0-9]+/"lastValidatedTimestamp": 0/'

    for command in mottainai mtnai; do
      makeWrapper ${nodejs}/bin/node "$out/bin/$command" \
        --add-flags "$packageRoot/dist/index.js" \
        --run 'if [ "''${1-}" = "--version" ]; then printf "%s\\n" "${version}"; exit 0; fi'
    done
    makeWrapper ${nodejs}/bin/node "$out/bin/mottainai-mcp" \
      --add-flags "$packageRoot/dist/mcp.js"

    runHook postInstall
  '';

  # Issue #662: every managed Runtime package catalog entry needs a bounded
  # smoke check, mirroring nix/packages/nawabari.nix's own installCheckPhase.
  # installPhase's makeWrapper already special-cases `--version` to print the
  # exact package version without starting the full CLI.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$($out/bin/mottainai --version)" = "${version}"
    runHook postInstallCheck
  '';

  meta = {
    description = "Coding-agent orchestration and MCP context runtime";
    homepage = "https://github.com/yohn-jp/mottainai";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = lib.platforms.linux;
  };
}
