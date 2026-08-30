{ pkgs
, runtimeApplianceImage
, bootstrapPackage
, source
}:

# Build-time proof for Issue #627's physical base/managed boundary. The
# appliance image is the only closure inspected here; the managed package
# derivations remain separate inputs to the flake and are never added to this
# image.
pkgs.runCommand "mottainai-runtime-appliance-boundary"
  {
    exportReferencesGraph = [ "appliance-closure" runtimeApplianceImage ];
    bootstrapStorePath = bootstrapPackage;
    sourceRoot = source;
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

    # The bootstrap derivation has a stable component identity and its source
    # projection does not read the managed root package metadata. Therefore a
    # managed Mottainai version-only edit is outside the base derivation's
    # inputs by construction; managed version/source changes remain #625/#626
    # generation inputs instead. Keep this structural assertion in the same
    # build check as the physical closure boundary.
    grep -Eq '^[[:space:]]*version = "1\.0\.0";' "$sourceRoot/nix/bootstrap.nix" \
      || { echo "FAIL: bootstrap component identity is not stable" >&2; exit 1; }
    if grep -Eq 'builtins\.(readFile|fromJSON).*package\.json' "$sourceRoot/nix/bootstrap.nix"; then
      echo "FAIL: bootstrap derivation reads managed package.json metadata" >&2
      exit 1
    fi
    if sed -n '/^[[:space:]]*sourceFiles = \[/,/^[[:space:]]*\];/p' "$sourceRoot/nix/bootstrap.nix" | grep -qF '"package.json"'; then
      echo "FAIL: managed package.json is included in the bootstrap source projection" >&2
      exit 1
    fi

    touch "$out"
  ''
