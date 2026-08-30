{ lib
, stdenvNoCC
, fetchurl
, makeWrapper
, nodejs_24
}:

stdenvNoCC.mkDerivation rec {
  pname = "nawabari";
  version = "0.6.1";

  src = fetchurl {
    url = "https://registry.npmjs.org/nawabari/-/nawabari-${version}.tgz";
    hash = "sha512-tfQ+BIuJhr35IrlxE/JlbsqdFFyKfIgRNz/KUx89bYck2Ri5skoc5JFyTPp524fiA+bUdEUmjHPFEzUX5dAaqg==";
  };

  sourceRoot = "package";
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    packageRoot="$out/lib/node_modules/${pname}"
    install -d "$packageRoot" "$out/bin"
    cp -R . "$packageRoot/"
    makeWrapper "${nodejs_24}/bin/node" "$out/bin/nawabari" \
      --add-flags "$packageRoot/dist/index.js"

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$($out/bin/nawabari --version)" = "${version}"
    runHook postInstallCheck
  '';

  meta = {
    description = "Stable local Git session CLI";
    homepage = "https://github.com/yohn-jp/nawabari";
    license = lib.licenses.mit;
    mainProgram = "nawabari";
    platforms = lib.platforms.linux;
  };
}
