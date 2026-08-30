{ pkgs, source }:

let
  inherit (pkgs) lib;

  pname = "mottainai";
  package = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  version = package.version;
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_9;
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
      pnpm fetch --prod --frozen-lockfile --ignore-scripts --store-dir "$out"

      # pnpm stamps each cached package's index.json with a checkedAt
      # wall-clock timestamp, which otherwise makes this fixed-output
      # derivation's hash non-reproducible across fetches.
      find "$out/v3/files" -name '*-index.json' -print0 \
        | xargs -0 sed -i -E 's/"checkedAt":[0-9]+/"checkedAt":0/g'

      runHook postBuild
    '';

    dontInstall = true;
    outputHashMode = "recursive";
    outputHash = "sha256-WTW1NEqAT2FFFqvn+ddKapRZqwMXYhqnRg0C7ote77A=";
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
    mkdir -p "$HOME"

    pnpm install --prod --offline --frozen-lockfile --ignore-scripts --store-dir ${pnpmDeps}
    pnpm rebuild node-pty --store-dir ${pnpmDeps}
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
    cp -a node_modules "$packageRoot/node_modules"
    rm -rf "$packageRoot/node_modules/.cache"

    # pnpm stamps node_modules/.modules.yaml with a prunedAt wall-clock
    # timestamp, which otherwise makes this derivation's output non-reproducible.
    find "$packageRoot" -name '.modules.yaml' -print0 \
      | xargs -0 --no-run-if-empty sed -i -E 's/^prunedAt: .*$/prunedAt: unset/'

    for command in mottainai mtnai; do
      makeWrapper ${nodejs}/bin/node "$out/bin/$command" \
        --add-flags "$packageRoot/dist/index.js" \
        --run 'if [ "''${1-}" = "--version" ]; then printf "%s\\n" "${version}"; exit 0; fi'
    done
    makeWrapper ${nodejs}/bin/node "$out/bin/mottainai-mcp" \
      --add-flags "$packageRoot/dist/mcp.js"

    runHook postInstall
  '';

  meta = {
    description = "Coding-agent orchestration and MCP context runtime";
    homepage = "https://github.com/yohn-jp/mottainai";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = lib.platforms.linux;
  };
}
