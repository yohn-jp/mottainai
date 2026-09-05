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
  # Issue #702: read straight from package.json rather than via
  # `../mottainai.nix` (HEAD's own recipe) — this alternate source is a
  # foreign release tree with its own nix/mottainai.nix
  # (nix/tests/fixtures/alt-mottainai-source), and this test must not
  # itself couple back to HEAD's recipe to learn its version.
  alternateMottainaiVersion =
    (builtins.fromJSON (builtins.readFile (alternateSource + "/package.json"))).version;

  # Issue #702: mkManagedGeneration now takes an already-resolved
  # `mottainaiPackage`, not a `mottainaiSource` (nix/managed-generation.nix
  # must stay pure-evaluable for `nix flake check`, so it can never call
  # `builtins.getFlake` itself). Resolve each source's own nix/mottainai.nix
  # by plain `import` here — never HEAD's `../mottainai.nix` applied to a
  # foreign source — the same pure resolution nix/tests/managed-generation.nix
  # uses and explains in its own header comment (including why a
  # `builtins.readDir`-based existence check guards this rather than
  # `builtins.pathExists`/a direct `import` on a possibly-missing path).
  hasMottainaiRecipe = mottainaiSource:
    let
      topEntries = builtins.readDir mottainaiSource;
    in
    (topEntries.nix or null) == "directory"
    && ((builtins.readDir (mottainaiSource + "/nix"))."mottainai.nix" or null) == "regular";

  mottainaiPackageFromSource = mottainaiSource:
    if !(hasMottainaiRecipe mottainaiSource) then
      throw "nix/tests/runtime-appliance.nix: mottainai source at ${toString mottainaiSource} has no nix/mottainai.nix"
    else
      import (mottainaiSource + "/nix/mottainai.nix") { inherit pkgs; source = mottainaiSource; };

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
        mottainaiPackage = mottainaiPackageFromSource managedInput.source;
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
    nativeBuildInputs = [ pkgs.parted pkgs.util-linux ];
    buildInputs = [ runtimeApplianceImage baseApplianceA baseApplianceB ];
    exportReferencesGraph = [ "appliance-closure" baseApplianceA ];
    bootstrapStorePath = bootstrapPackage;
  }
  ''
    # The canonical disk must be the supported UEFI layout: GPT with one
    # FAT32 EFI System Partition and one ext4 root partition. This is also the
    # regression guard that rejects a return to legacy MBR-only output.
    disk_image=${runtimeApplianceImage}/mottainai-runtime-appliance.raw
    partition_table="$(parted --script --machine "$disk_image" unit B print)"
    printf '%s\n' "$partition_table" | grep -q ':gpt:'
    partition_count="$(printf '%s\n' "$partition_table" | awk -F: '$1 ~ /^[0-9]+$/ { count++ } END { print count + 0 }')"
    test "$partition_count" -eq 2

    esp_line="$(printf '%s\n' "$partition_table" | awk -F: '$1 == "1" { print; exit }')"
    root_line="$(printf '%s\n' "$partition_table" | awk -F: '$1 == "2" { print; exit }')"
    test -n "$esp_line"
    test -n "$root_line"
    test "$(printf '%s' "$esp_line" | cut -d: -f5)" = "fat32"
    test "$(printf '%s' "$esp_line" | cut -d: -f6)" = "ESP"
    printf '%s' "$esp_line" | cut -d: -f7 | grep -Eq '(^|,)[[:space:]]*(boot|esp)(,|$)'
    test "$(printf '%s' "$root_line" | cut -d: -f5)" = "ext4"

    esp_start_bytes="$(printf '%s' "$esp_line" | cut -d: -f2 | tr -d B)"
    test "$(blkid -p -o value -s TYPE -O "$esp_start_bytes" "$disk_image")" = "vfat"
    test "$(blkid -p -o value -s VERSION -O "$esp_start_bytes" "$disk_image")" = "FAT32"

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
