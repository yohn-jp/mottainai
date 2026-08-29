{ pkgs }:

let
  inherit (pkgs) lib;

  pname = "mottainai";
  version = "0.6.0";
  sourceRevision = "eb47e9270eb17132139cec9b74b8de399569263a";
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_9;
  nodeSrc = pkgs.srcOnly nodejs;
  nodeGyp = "${nodejs}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js";
  caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  pnpmLock = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/yohn-jp/mottainai/${sourceRevision}/pnpm-lock.yaml";
    hash = "sha256-oCwMCOEeO5eZqpbHd4JCvs/42l7BUFtZEuDdw+ktAYc=";
  };

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
    outputHash = "sha256-YBKawcrsBZvpE+ek6Mh8jQwuKhaObepWe3C4XOUgb9w=";
  };
in
pkgs.stdenv.mkDerivation {
  inherit pname version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/mottainai/-/mottainai-${version}.tgz";
    hash = "sha256-SmuK7osmlK+EAnM48fXnSNv8Wp51JBjQ8SghH04Cf3E=";
  };

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
    tar -xzf "$src" --strip-components=1 -C source
    cp ${pnpmLock} source/pnpm-lock.yaml
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

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    mkdir -p "$packageRoot"
    cp -a . "$packageRoot/"
    rm -f "$packageRoot/pnpm-lock.yaml"

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
