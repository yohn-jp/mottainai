{ pkgs, lib, managedRuntimeReadinessScript }:

# Issue #644: real-build proof for nix/managed-runtime-health.nix's
# read-only projection of #628's managed-runtime/state.json + current
# pointer into readiness/managedRuntimeReady/reconciliation. Runs as
# `nix build .#checks.<system>.managed-runtime-health` — a plain
# `runCommand` executing the packaged script against fixture state
# directories, no NixOS module evaluation and no KVM/nixosTest
# infrastructure required, mirroring nix/tests/bootstrap.nix's style of
# proving a real built binary's behavior rather than only its Nix
# expression shape.
#
# Covers the four cases Issue #644's acceptance criteria name: a fresh
# bootstrap-only appliance (no state.json at all), a healthy active managed
# generation whose current pointer matches, a healthy active generation
# whose desired identity has diverged from the currently persisted desired
# manifest (the shape left behind by a rollback — docs/runtime-state.md:
# reconcile's own top-level desiredManifestSemanticIdentity moves to the
# attempted candidate even when that candidate never became active), and
# invalid/inconsistent state (malformed JSON, an in-flight activation
# transaction, and a current pointer that disagrees with the persisted
# active record) — each must fail closed to the same bounded
# non-managed-ready result a fresh appliance reports.

let
  healthyRecord = {
    generationIdentity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    storePath = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mottainai-managed-generation";
    desiredManifestSemanticIdentity = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    compatibilityContractVersion = 1;
    health = {
      state = "healthy";
      checkedAt = "2026-01-01T00:00:00.000Z";
    };
  };

  baseState = {
    contractId = "mottainai.managed-runtime-state.v1";
    schemaVersion = 1;
    desiredManifestSemanticIdentity = healthyRecord.desiredManifestSemanticIdentity;
    active = healthyRecord;
    activation = {
      phase = "idle";
    };
    updatedAt = "2026-01-01T00:00:00.000Z";
  };

  # A rollback-shaped divergence: `active` is still the old, healthy,
  # known-good generation, but the top-level desiredManifestSemanticIdentity
  # has already moved to a newer (failed) candidate — exactly the field
  # reconcileManagedRuntime's stateWithFailure leaves behind
  # (src/runtime-contract/managed-runtime.ts), never rewritten back to
  # match `active` merely because a health check observes it.
  divergentState = baseState // {
    desiredManifestSemanticIdentity = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  };

  inFlightState = baseState // {
    activation = {
      phase = "prepared";
      candidate = {
        generationIdentity = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        storePath = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-mottainai-managed-generation";
        desiredManifestSemanticIdentity = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        compatibilityContractVersion = 1;
      };
    };
  };

  writeFixture =
    name:
    { state ? null, currentTarget ? null }:
    ''
      mkdir -p ${name}
      ${lib.optionalString (state != null) ''
        cat > ${name}/state.json <<'STATE_JSON'
        ${builtins.toJSON state}
        STATE_JSON
      ''}
      ${lib.optionalString (currentTarget != null) ''
        ln -s ${lib.escapeShellArg currentTarget} ${name}/current
      ''}
    '';

  assertResult =
    name:
    {
      expectedReadiness,
      expectedManagedRuntimeReady,
      expectedReconciliation,
    }:
    ''
      result="$(mottainai-managed-runtime-readiness ${name})"
      expected='{"readiness":"${expectedReadiness}","managedRuntimeReady":${expectedManagedRuntimeReady},"reconciliation":"${expectedReconciliation}"}'
      if [ "$result" != "$expected" ]; then
        echo "FAIL (${name}): expected $expected, got $result" >&2
        exit 1
      fi
    '';
in
pkgs.runCommand "mottainai-managed-runtime-health-smoke"
  {
    nativeBuildInputs = [ managedRuntimeReadinessScript ];
  }
  ''
    set -euo pipefail

    # 1. Fresh bootstrap-only appliance: no managed-runtime directory at all.
    mkdir -p fresh
    ${assertResult "fresh" {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 2. Healthy active generation, idle transaction, current pointer
    # matches the active store path, desired identity matches active's.
    ${writeFixture "healthy" { state = baseState; currentTarget = healthyRecord.storePath; }}
    ${assertResult "healthy" {
      expectedReadiness = "managed-runtime-ready";
      expectedManagedRuntimeReady = "true";
      expectedReconciliation = "current";
    }}

    # 3. Rollback-divergent: active is healthy and current, but the
    # persisted desired identity has moved past what is actually active —
    # still managed-runtime-ready (a healthy generation IS running), but
    # reconciliation reports repairable rather than current, and neither
    # identity is rewritten to hide the divergence.
    ${writeFixture "divergent" { state = divergentState; currentTarget = healthyRecord.storePath; }}
    ${assertResult "divergent" {
      expectedReadiness = "managed-runtime-ready";
      expectedManagedRuntimeReady = "true";
      expectedReconciliation = "repairable";
    }}

    # 4a. Invalid/inconsistent: malformed state.json fails closed.
    mkdir -p malformed
    printf '{ not valid json' > malformed/state.json
    ln -s ${lib.escapeShellArg healthyRecord.storePath} malformed/current
    ${assertResult "malformed" {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4b. Invalid/inconsistent: an in-flight activation transaction (not
    # idle) is never reported as managed-runtime-ready, even though `active`
    # still names a previously healthy generation.
    ${writeFixture "in-flight" { state = inFlightState; currentTarget = healthyRecord.storePath; }}
    ${assertResult "in-flight" {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4c. Invalid/inconsistent: current pointer disagrees with the
    # persisted active record.
    ${writeFixture "mismatched-pointer" { state = baseState; currentTarget = "/nix/store/cccccccccccccccccccccccccccccccc-unexpected"; }}
    ${assertResult "mismatched-pointer" {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    # 4d. Invalid/inconsistent: active recorded, idle phase, but no current
    # pointer at all (never symlinked).
    mkdir -p no-pointer
    cat > no-pointer/state.json <<'STATE_JSON'
    ${builtins.toJSON baseState}
    STATE_JSON
    ${assertResult "no-pointer" {
      expectedReadiness = "bootstrap-ready";
      expectedManagedRuntimeReady = "false";
      expectedReconciliation = "current";
    }}

    touch "$out"
  ''
