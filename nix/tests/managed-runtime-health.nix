{ pkgs, lib, managedRuntimeReadinessScript }:

# Issue #644 (review response): real-build proof for
# nix/managed-runtime-health.nix's pure stdin -> stdout projection of
# `mottainai-bootstrap managed-status --json`'s bounded output into
# readiness/managedRuntimeReady/reconciliation. Runs as
# `nix build .#checks.<system>.managed-runtime-health` in CI's
# runtime-contract job (see .github/workflows/ci.yml's explicit
# `nix build ... .#checks.x86_64-linux.managed-runtime-health` step --
# `nix flake check --no-build` alone does not execute a check's build,
# only evaluate it).
#
# This feeds literal `managed-status`-shaped JSON directly on stdin --
# no bootstrap package build, no managed-runtime state fixture
# directories, no filesystem/sandbox access at all, since the script
# under test performs none either. Real schema validation itself (the
# thing a caller actually depends on for "is this state canonically
# valid") is proven separately and directly against
# readManagedRuntimeStatus/ManagedRuntimeStateSchema in
# src/runtime-contract/managed-runtime.test.ts and
# src/bootstrap/cli.test.ts (managed-status's own schema-invalid-but-
# field-complete coverage) -- this check only proves the readiness
# projection RULES given an already-validated (or already-rejected)
# status report, matching the division of responsibility
# docs/contracts/runtime/linux-runtime.md's "Managed-runtime readiness projection"
# section documents.

let
  run =
    statusJson:
    ''
      result="$(printf '%s' ${lib.escapeShellArg (builtins.toJSON statusJson)} | mottainai-managed-runtime-readiness)"
    '';

  assertResult =
    label: statusJson:
    {
      expectedReadiness,
      expectedManagedRuntimeReady,
      expectedReconciliation,
    }:
    ''
      ${run statusJson}
      expected='{"readiness":"${expectedReadiness}","managedRuntimeReady":${expectedManagedRuntimeReady},"reconciliation":"${expectedReconciliation}"}'
      if [ "$result" != "$expected" ]; then
        echo "FAIL (${label}): expected $expected, got $result" >&2
        exit 1
      fi
    '';

  healthyStatus = extra: {
    valid = true;
    present = true;
    activationPhase = "idle";
    activeGenerationIdentity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    activeStorePath = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mottainai-managed-generation";
    observedGenerationIdentity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    observedStorePath = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mottainai-managed-generation";
    state = {
      desiredManifestSemanticIdentity = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      active.desiredManifestSemanticIdentity = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    };
  } // extra;
in
pkgs.runCommand "mottainai-managed-runtime-health-smoke"
  {
    nativeBuildInputs = [ managedRuntimeReadinessScript ];
  }
  ''
    set -euo pipefail

    # 1. Fresh bootstrap-only appliance: managed-status reports valid,
    # present:false (no managed-runtime state exists yet).
    ${assertResult "fresh" { valid = true; present = false; } {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 2. Healthy active generation, idle transaction, observed pointer
    # matches the active store path and identity, desired identity
    # matches active's.
    ${assertResult "healthy" (healthyStatus { }) {
      expectedReadiness = "managed-runtime-ready";
      expectedManagedRuntimeReady = "true";
      expectedReconciliation = "current";
    }}

    # 3. Rollback-divergent: active is healthy and observed as current,
    # but the persisted desired identity has moved past what is actually
    # active -- still managed-runtime-ready, but reconciliation reports
    # repairable rather than current. `state` is merged explicitly (not
    # via the top-level `//` the other cases use) so
    # state.active.desiredManifestSemanticIdentity survives alongside the
    # overridden top-level desiredManifestSemanticIdentity -- a shallow
    # `//` on `state` itself would silently drop it instead of proving a
    # genuine divergence.
    ${assertResult "divergent" ((healthyStatus { }) // {
      state = (healthyStatus { }).state // {
        desiredManifestSemanticIdentity = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      };
    }) {
      expectedReadiness = "managed-runtime-ready";
      expectedManagedRuntimeReady = "true";
      expectedReconciliation = "repairable";
    }}

    # 4a. Invalid/inconsistent: managed-status itself rejected the
    # persisted state as schema-invalid/corrupt (valid:false) -- fails
    # closed regardless of what code/message accompanies it.
    ${assertResult "invalid" {
      valid = false;
      code = "state_corrupt";
      message = "managed Runtime state is invalid";
    } {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4b. Invalid/inconsistent: an in-flight activation transaction (not
    # idle) is never reported as managed-runtime-ready, even though
    # activeGenerationIdentity still names a previously healthy
    # generation.
    ${assertResult "in-flight" (healthyStatus { activationPhase = "prepared"; }) {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4c. Invalid/inconsistent: the observed pointer identity disagrees
    # with the persisted active record (statusFromState already failed to
    # match them, so observedGenerationIdentity/observedStorePath are
    # simply absent).
    ${assertResult "mismatched-pointer" (healthyStatus {
      observedGenerationIdentity = null;
      observedStorePath = "/nix/store/cccccccccccccccccccccccccccccccc-unexpected";
    }) {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4d. Invalid/inconsistent: no observed pointer at all.
    ${assertResult "no-pointer" (healthyStatus {
      observedGenerationIdentity = null;
      observedStorePath = null;
    }) {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    touch "$out"
  ''
