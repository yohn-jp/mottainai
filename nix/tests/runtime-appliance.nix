{ pkgs
, lib
, nixpkgs
, mkManagedGeneration
, canonicalAppliance
, runtimeApplianceImage
, bootstrapPackage
, source
}:

# Build-time proof for Issue #627's physical base/managed boundary. The
# appliance image is the only closure inspected here; managed package
# derivations remain separate inputs to the flake and are never added to this
# image.

let
  currentMottainaiVersion =
    (import ../mottainai.nix { inherit pkgs source; }).version;
  alternateSource = ./fixtures/alt-mottainai-source;
  alternateMottainaiVersion =
    (import ../mottainai.nix { inherit pkgs; source = alternateSource; }).version;

  # These are two real #624/#626 managed inputs with the same package shape,
  # differing only in the resolved Mottainai version/source metadata. Each
  # input is evaluated through the real #625 managed-generation projection
  # before the canonical base appliance derivation is selected below.
  managedInputA = {
    source = source;
    version = currentMottainaiVersion;
    sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  };
  managedInputB = {
    source = alternateSource;
    version = alternateMottainaiVersion;
    sourceSha256 = "1111111111111111111111111111111111111111111111111111111111111111";
  };

  managedManifest = managedInput: {
    contractId = "mottainai.managed-package-manifest.v1";
    schemaVersion = 1;
    activation.generation = 1;
    packages = [
      {
        packageId = "mottainai";
        kind = "nix-flake-package";
        version = managedInput.version;
        source = {
          flakeRef = "nix#mottainai";
          sourceSha256 = managedInput.sourceSha256;
        };
      }
    ];
  };

  # `managedGeneration.generation.drvPath` forces the real managed input and
  # source metadata to be evaluated. The canonical appliance is then extended
  # with that input as an evaluation-only module argument, without changing any
  # Runtime option. If the base appliance accidentally consumed managed
  # version/source metadata, these separately constructed image drvPaths would
  # differ.
  applianceFor = managedInput:
    canonicalAppliance.extendModules {
      specialArgs = { managedMottainaiInput = managedInput; };
      modules = [
        ({ managedMottainaiInput, ... }:
          assert managedMottainaiInput.version != "";
          assert managedMottainaiInput.sourceSha256 != "";
          { })
      ];
    };

  canonicalBaseFor = managedInput:
    let
      managedGeneration = mkManagedGeneration {
        system = pkgs.stdenv.hostPlatform.system;
        manifest = managedManifest managedInput;
        mottainaiSource = managedInput.source;
      };
      managedGenerationDrvPath =
        builtins.unsafeDiscardStringContext managedGeneration.generation.drvPath;
    in
    builtins.seq managedGenerationDrvPath (import ../runtime-appliance-image.nix {
      inherit lib nixpkgs pkgs;
      appliance = applianceFor managedInput;
    });

  baseApplianceA = canonicalBaseFor managedInputA;
  baseApplianceB = canonicalBaseFor managedInputB;
  baseDrvPathA = builtins.unsafeDiscardStringContext baseApplianceA.drvPath;
  baseDrvPathB = builtins.unsafeDiscardStringContext baseApplianceB.drvPath;
  canonicalBaseDrvPath =
    builtins.unsafeDiscardStringContext runtimeApplianceImage.drvPath;
in
if baseDrvPathA != baseDrvPathB then
  throw ''
    nix/tests/runtime-appliance.nix: managed Mottainai version/source metadata changed the canonical base appliance derivation:
    ${baseDrvPathA} != ${baseDrvPathB}
  ''
else if baseDrvPathA != canonicalBaseDrvPath then
  throw ''
    nix/tests/runtime-appliance.nix: managed-input scenarios did not produce the canonical base appliance derivation:
    ${baseDrvPathA} != ${canonicalBaseDrvPath}
  ''
else
pkgs.runCommand "mottainai-runtime-appliance-boundary"
  {
    # Both scenarios must materialize the canonical appliance. Since their
    # exact drvPaths are equal, Nix builds one shared base derivation here;
    # the equality assertion above is what proves that sharing is valid.
    buildInputs = [ runtimeApplianceImage baseApplianceA baseApplianceB ];
    exportReferencesGraph = [ "appliance-closure" baseApplianceA ];
    bootstrapStorePath = bootstrapPackage;
  }
  ''
    # The bootstrap package is a real base-system input.
    grep -qF "$bootstrapStorePath" appliance-closure \
      || { echo "FAIL: appliance closure does not contain the #626 bootstrap package" >&2; exit 1; }

    # These are the managed application outputs, not bootstrap prerequisites.
    if grep -Eq '/nix/store/[a-z0-9]+-mottainai-[0-9]' appliance-closure; then
      echo "FAIL: full Mottainai package is present in the base appliance closure" >&2
      grep -E '/nix/store/[a-z0-9]+-mottainai-[0-9]' appliance-closure >&2
      exit 1
    fi
    if grep -Eq '/nix/store/[a-z0-9]+-nawabari-[0-9]' appliance-closure; then
      echo "FAIL: Nawabari package is present in the base appliance closure" >&2
      grep -E '/nix/store/[a-z0-9]+-nawabari-[0-9]' appliance-closure >&2
      exit 1
    fi
    if grep -Eq '/nix/store/[a-z0-9]+-zellij-[0-9]' appliance-closure; then
      echo "FAIL: Zellij package is present in the base appliance closure" >&2
      grep -E '/nix/store/[a-z0-9]+-zellij-[0-9]' appliance-closure >&2
      exit 1
    fi
    if grep -Eiq '/nix/store/[a-z0-9]+-[^ ]*coding-agent[^ ]*' appliance-closure; then
      echo "FAIL: coding-agent package is present in the base appliance closure" >&2
      grep -Ei '/nix/store/[a-z0-9]+-[^ ]*coding-agent[^ ]*' appliance-closure >&2
      exit 1
    fi

    test -f ${baseApplianceA}/runtime-appliance-inputs.json
    test -f ${baseApplianceB}/runtime-appliance-inputs.json
    test -f ${runtimeApplianceImage}/runtime-appliance-inputs.json
    echo "canonical base appliance drvPath is identical for both managed input variants: ${baseDrvPathA}" >&2
    touch "$out"
  ''
