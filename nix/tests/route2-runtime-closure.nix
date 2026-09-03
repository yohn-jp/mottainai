{ pkgs
, lib
, source
, managedGeneration
, managedGenerationMetadata
, mottainaiPackage
, runtimeDependencies
}:

# Issue #752 functional acceptance for Route 2. The test deliberately runs
# outside the developer's environment: the smoke process receives a PATH
# containing only the managed generation, while the test runner itself uses
# the pinned Nix Node.js package. This proves the generated closure, not the
# host's Node/rg/git installation.

let
  runtimeDependenciesJson = builtins.toJSON (map (dependency: {
    inherit (dependency) packageId command version;
    storePath = "${dependency.drv}";
  }) runtimeDependencies);
in
pkgs.runCommand "mottainai-route2-runtime-closure-acceptance" {
  nativeBuildInputs = [ pkgs.nodejs_24 pkgs.jq ];
} ''
  set -euo pipefail

  ${pkgs.nodejs_24}/bin/node ${source}/scripts/route2-runtime-smoke.mjs \
    --generation ${lib.escapeShellArg "${managedGeneration}"} \
    --package-root ${lib.escapeShellArg "${mottainaiPackage}"} \
    --metadata ${lib.escapeShellArg "${managedGenerationMetadata}"} \
    --payload-identity ${lib.escapeShellArg "${mottainaiPackage}/share/mottainai/canonical-payload.json"} \
    --runtime-dependencies ${lib.escapeShellArg runtimeDependenciesJson} \
    --evidence "$out/route2-runtime-closure-evidence.json"

  ${pkgs.jq}/bin/jq -e \
    --arg generation ${lib.escapeShellArg "${managedGeneration}"} \
    --arg payload_contract "mottainai.canonical-application-payload.v1" \
    '.contractId == "mottainai.route2-functional-readiness.v1" and
     .schemaVersion == 1 and
     .route == 2 and
     .readiness == "route2-functional-ready" and
     .canonicalPayload.contractId == $payload_contract and
     .generation.storePath == $generation and
     .functional.cli.status == "success" and
     .functional.mcp.status == "success" and
     .dependencyRemoval.status == "failed-as-expected" and
     ([.generation.runtimeDependencies[] | .command] | sort) == ["git", "rg"]' \
    "$out/route2-runtime-closure-evidence.json"
''
