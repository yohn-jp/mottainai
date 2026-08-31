{ pkgs, lib }:

# Issue #644: the pure, read-only projection of Issue #628's canonical
# `managed-runtime/state.json` + `current` pointer into the three
# managed-runtime fields of the mottainai.linux-runtime.v1 health/capability
# result (readiness, managedRuntimeReady, reconciliation).
#
# Factored out of nix/modules/runtime.nix's healthScript into its own
# derivation, taking the managed-runtime directory as a plain argument
# rather than reading `cfg.stateDir` directly, so nix/tests/managed-runtime-health.nix
# can build and run it against fixture state directories at
# `nix build .#checks.<system>.managed-runtime-health` — no NixOS module
# evaluation and no KVM/nixosTest infrastructure required, mirroring how
# nix/tests/managed-generation.nix exercises nix/managed-generation.nix
# directly.
#
# This never writes, builds, switches, or re-runs any part of #628's
# reconcileManagedRuntime state machine (docs/runtime-lifecycle.md,
# docs/runtime-state.md "Observed state ... MUST NOT silently rewrite
# canonical desired/active identities"). Absence, malformed content, an
# in-flight activation transaction, or a `current` pointer that disagrees
# with the persisted active record all fail closed to the same
# bootstrap-ready / managedRuntimeReady:false / reconciliation:"current"
# result a fresh appliance with no managed generation reports — "current
# is accepted as active only when it matches the persisted record and
# transaction phase" (docs/runtime-state.md).
pkgs.writeShellApplication {
  name = "mottainai-managed-runtime-readiness";
  runtimeInputs = [ pkgs.coreutils pkgs.jq ];
  text = ''
    set -euo pipefail

    if [ "$#" -ne 1 ]; then
      echo "usage: mottainai-managed-runtime-readiness <managed-runtime-directory>" >&2
      exit 1
    fi
    managed_runtime_dir="$1"
    state_file="$managed_runtime_dir/state.json"
    current_pointer="$managed_runtime_dir/current"

    readiness="bootstrap-ready"
    managed_runtime_ready=false
    reconciliation="current"

    # A fresh appliance (or one whose managed generation was never
    # activated) has no state.json yet; that is not a failure, it is the
    # ordinary bootstrap-ready case. jq failing to parse the file (absent,
    # empty, malformed JSON) fails closed to the same result.
    if [ -r "$state_file" ] && state_json="$(jq -c '.' "$state_file" 2>/dev/null)" && [ -n "$state_json" ]; then
      activation_phase="$(printf '%s' "$state_json" | jq -r '.activation.phase // empty')"
      active_health_state="$(printf '%s' "$state_json" | jq -r '.active.health.state // empty')"
      active_store_path="$(printf '%s' "$state_json" | jq -r '.active.storePath // empty')"
      desired_identity="$(printf '%s' "$state_json" | jq -r '.desiredManifestSemanticIdentity // empty')"
      active_desired_identity="$(printf '%s' "$state_json" | jq -r '.active.desiredManifestSemanticIdentity // empty')"

      current_target=""
      if [ -L "$current_pointer" ]; then
        current_target="$(readlink -f "$current_pointer" 2>/dev/null || echo "")"
      fi

      # #628's own invariant: current is accepted as active only when it
      # matches the persisted record AND no activation transaction is in
      # progress (an in-flight prepared/switched/rollback phase is neither
      # proven healthy nor a stable observation).
      if [ "$activation_phase" = "idle" ] \
        && [ "$active_health_state" = "healthy" ] \
        && [ -n "$active_store_path" ] \
        && [ -n "$current_target" ] \
        && [ "$current_target" = "$active_store_path" ]; then
        readiness="managed-runtime-ready"
        managed_runtime_ready=true
        # The active generation is healthy and selected either way; whether
        # it also satisfies the CURRENTLY desired manifest (which may have
        # moved since, e.g. after a rollback restored an older known-good
        # generation) is a separate axis (docs/runtime-state.md "Observed
        # state ... MUST NOT silently rewrite canonical desired/active
        # identities to match whatever happens to be observed") — reported
        # via reconciliation, never by rewriting either identity here.
        if [ -n "$desired_identity" ] && [ "$desired_identity" = "$active_desired_identity" ]; then
          reconciliation="current"
        else
          reconciliation="repairable"
        fi
      fi
    fi

    printf '{"readiness":"%s","managedRuntimeReady":%s,"reconciliation":"%s"}\n' \
      "$readiness" "$managed_runtime_ready" "$reconciliation"
  '';
}
