{ pkgs, source, canonicalPayload ? null, canonicalPayloadSha256 ? null }:

assert
  canonicalPayload == null
  || (canonicalPayloadSha256 != null && builtins.match "^[0-9a-f]{64}$" canonicalPayloadSha256 != null);

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

  # Issue #702: this recipe is a release-owned package boundary. HEAD's
  # nix/flake.nix `mkMottainai` only ever calls this file with
  # `source = ../.` (this same checkout's own tree), and a tagged release
  # carries its own copy of this file pinned to its own lockfile's hash —
  # `nix/managed-generation.nix` resolves a release's `nix#mottainai`
  # output from that release's own flake, never by calling HEAD's copy of
  # this file with a foreign source substituted in. A single fixed-output
  # hash for the current lockfile is therefore correct by construction:
  # there is no historical-lockfile mapping to own here, and adding or
  # changing a future HEAD dependency never requires touching a historical
  # release's hash.
  pnpmDepsOutputHash = "sha256-ccysyuFPNAuEX2RDD/q7HRCfd5KZ6MJH/yCmDAd6s34=";

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
    outputHash = pnpmDepsOutputHash;
  };

  # Route 1's sole pack operation for local Nix builds. Release workflows
  # provide `canonicalPayload` from their already-packed artifact instead;
  # this derivation is lazy in that case and therefore cannot create a second
  # application payload behind the release artifact's back.
  generatedCanonicalPayload = pkgs.stdenv.mkDerivation {
    pname = "${pname}-canonical-payload";
    inherit version;
    src = source;

    nativeBuildInputs = [ nodejs pnpm nodejs.python pkgs.gnumake ];
    dontConfigure = true;

    unpackPhase = ''
      runHook preUnpack
      mkdir source
      cp -a "$src"/. source/
      chmod -R u+w source
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
      export pnpm_config_pm_on_fail=ignore
      export pnpm_config_minimum_release_age=0
      mkdir -p "$HOME" "$TMPDIR/pnpm-store"
      cp -R ${pnpmDeps}/. "$TMPDIR/pnpm-store/"
      chmod -R u+w "$TMPDIR/pnpm-store"
      pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir "$TMPDIR/pnpm-store"
      pnpm rebuild node-pty --store-dir "$TMPDIR/pnpm-store"
      pnpm run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      # Use the same checked-in canonical pack surface as the release workflow;
      # Nix is only the local producer when no release-local payload is given.
      node scripts/pack-canonical-payload.mjs --output-dir "$out" > "$TMPDIR/pack-identity.json"
      payload="$(find "$out" -maxdepth 1 -type f -name 'mottainai-*.tgz' -print -quit | xargs -r basename)"
      test -s "$out/$payload"
      sha256sum "$out/$payload" | awk '{print $1}' > "$out/payload.sha256"
      runHook postInstall
    '';
  };

  payloadPath =
    if canonicalPayload == null then
      "${generatedCanonicalPayload}/mottainai-${version}.tgz"
    else
      canonicalPayload;
  payloadSha256 =
    if canonicalPayloadSha256 == null then
      "$(cat ${generatedCanonicalPayload}/payload.sha256)"
    else
      canonicalPayloadSha256;
in
pkgs.stdenv.mkDerivation {
  inherit pname version;
  src = source;

  nativeBuildInputs = [
    nodejs
    pnpm
    nodejs.python
    pkgs.gnumake
    pkgs.jq
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

  # The application payload has already been built and packed by Route 1.
  # Route 2 only verifies and consumes it; no build or pack command belongs in
  # this derivation.
  buildPhase = ''
    runHook preBuild
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    mkdir -p "$packageRoot"

    payload="${payloadPath}"
    expected_payload_sha256="${payloadSha256}"
    actual_payload_sha256="$(sha256sum "$payload" | awk '{print $1}')"
    test "$actual_payload_sha256" = "$expected_payload_sha256" \
      || { echo "canonical Route 1 payload sha256 mismatch: $actual_payload_sha256 != $expected_payload_sha256" >&2; exit 1; }
    tar -xzf "$payload" --strip-components=1 -C "$packageRoot"

    # Metadata and entrypoints are part of the shared payload boundary. The
    # source checkout supplies lockfile/dependency inputs only; its package
    # metadata must agree with the tarball that Route 2 just consumed.
    node - "$packageRoot/package.json" "$src/package.json" <<'NODE'
const fs = require("node:fs");
const [payloadPath, sourcePath] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
for (const key of ["name", "version", "bin"]) {
  if (JSON.stringify(payload[key]) !== JSON.stringify(source[key])) {
    throw new Error(`canonical payload metadata mismatch for ''${key}`);
  }
}
if (payload.name !== "mottainai") throw new Error(`unexpected payload package ''${payload.name}`);
NODE

    # Install only production dependencies around the already-packed payload;
    # devDependencies never enter the Route 2 output.
    export HOME="$TMPDIR/home"
    export PATH="${nodejs}/lib/node_modules/npm/bin/node-gyp-bin:$PATH"
    export npm_config_nodedir="${nodeSrc}"
    export npm_config_node_gyp="${nodeGyp}"
    export SSL_CERT_FILE="${caBundle}"
    export NODE_EXTRA_CA_CERTS="${caBundle}"
    export pnpm_config_pm_on_fail=ignore
    export pnpm_config_minimum_release_age=0
    mkdir -p "$HOME"
    pnpmStore="$TMPDIR/pnpm-store"
    mkdir -p "$pnpmStore"
    cp -R ${pnpmDeps}/. "$pnpmStore/"
    chmod -R u+w "$pnpmStore"
    rm -rf node_modules
    pnpm install --prod --offline --frozen-lockfile --ignore-scripts --store-dir "$pnpmStore"
    pnpm rebuild node-pty --store-dir "$pnpmStore"
    cp -a node_modules "$packageRoot/node_modules"
    rm -rf "$packageRoot/node_modules/.cache"

    mkdir -p "$out/share/mottainai"
    jq -n \
      --arg contractId "mottainai.canonical-application-payload.v1" \
      --arg packageName "${pname}" \
      --arg packageVersion "${version}" \
      --arg sha256 "$actual_payload_sha256" \
      '{ contractId: $contractId, schemaVersion: 1, packageName: $packageName, packageVersion: $packageVersion, sha256: $sha256 }' \
      > "$out/share/mottainai/canonical-payload.json"

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

  # Expose the Route 1 identity only for the payload-consuming boundary. The
  # ordinary source recipe deliberately carries no payload evidence.
  passthru = {
    canonicalPayloadSha256 = if canonicalPayload == null then null else canonicalPayloadSha256;
  };

  meta = {
    description = "Coding-agent orchestration and MCP context runtime";
    homepage = "https://github.com/yohn-jp/mottainai";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = lib.platforms.linux;
  };
}
