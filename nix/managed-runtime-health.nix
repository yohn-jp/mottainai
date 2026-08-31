{ pkgs, lib }:

# Issue #644 (review response): a pure, read-only projection of
# `mottainai-bootstrap managed-status --json`'s bounded, canonically
# zod-validated output (src/bootstrap/cli.ts's runManagedStatusCommand,
# backed by src/runtime-contract/managed-runtime.ts's
# readManagedRuntimeStatus / ManagedRuntimeStateSchema `.strict()`) into
# the three managed-runtime fields of the mottainai.linux-runtime.v1
# health/capability result (readiness, managedRuntimeReady,
# reconciliation).
#
# This is deliberately a pure stdin -> stdout text transformation with no
# filesystem access of its own: readiness now depends on the SAME
# canonical schema validation `managed-status` and `reconcile` already
# use, rather than a hand-rolled re-check of a handful of jq-extracted
# fields (an earlier revision of this file read managed-runtime/state.json
# and current directly with jq predicates, which could not distinguish a
# structurally invalid/non-canonical state from a valid one as long as the
# few fields it happened to check were present). Because
# `mottainai-bootstrap managed-status` always targets the canonical
# `/var/lib/mottainai-control/managed-runtime` state root (Issue #642: no
# state-path override in production), this script cannot itself be pointed
# at a fixture directory — nix/modules/runtime.nix pipes the real
# packaged binary's output into it (`managed-status --json | this-script`);
# nix/tests/managed-runtime-health.nix instead feeds this script literal
# `managed-status`-shaped JSON directly on stdin, which needs no
# filesystem/sandbox access at all and is exactly what CI actually
# executes.
#
# Never writes, builds, switches, or re-runs any part of
# reconcileManagedRuntime. Any input that isn't the well-formed
# `{ valid: true, present: true, ... }` shape — absent, malformed JSON,
# `valid: false` (schema-invalid/corrupt canonical state), `present:
# false` (a fresh, bootstrap-only appliance), a non-idle activation phase,
# an unhealthy/absent active record, or an observed pointer that doesn't
# match the active generation — fails closed to the same bounded result a
# fresh appliance reports: bootstrap-ready / managedRuntimeReady:false /
# reconciliation:"current".
pkgs.writeShellApplication {
  name = "mottainai-managed-runtime-readiness";
  runtimeInputs = [ pkgs.coreutils pkgs.jq ];
  text = ''
    set -euo pipefail

    readiness="bootstrap-ready"
    managed_runtime_ready=false
    reconciliation="current"

    status_json="$(cat)"
    if jq -e '.' >/dev/null 2>&1 <<<"$status_json" \
      && [ "$(jq -r '.valid // false' <<<"$status_json")" = "true" ] \
      && [ "$(jq -r '.present // false' <<<"$status_json")" = "true" ]; then
      activation_phase="$(jq -r '.activationPhase // empty' <<<"$status_json")"
      active_generation_identity="$(jq -r '.activeGenerationIdentity // empty' <<<"$status_json")"
      observed_generation_identity="$(jq -r '.observedGenerationIdentity // empty' <<<"$status_json")"
      observed_store_path="$(jq -r '.observedStorePath // empty' <<<"$status_json")"
      active_store_path="$(jq -r '.activeStorePath // empty' <<<"$status_json")"
      desired_identity="$(jq -r '.state.desiredManifestSemanticIdentity // empty' <<<"$status_json")"
      active_desired_identity="$(jq -r '.state.active.desiredManifestSemanticIdentity // empty' <<<"$status_json")"

      # #628's own invariant, already applied by statusFromState when it
      # computed observedGenerationIdentity/observedStorePath: the current
      # pointer is accepted as active only when it resolves to exactly the
      # persisted active generation AND no activation transaction is in
      # progress.
      if [ "$activation_phase" = "idle" ] \
        && [ -n "$active_generation_identity" ] \
        && [ -n "$observed_generation_identity" ] \
        && [ "$observed_generation_identity" = "$active_generation_identity" ] \
        && [ -n "$observed_store_path" ] \
        && [ "$observed_store_path" = "$active_store_path" ]; then
        readiness="managed-runtime-ready"
        managed_runtime_ready=true
        # The active generation is healthy and selected either way (a
        # bounded status report never includes an unhealthy generation as
        # `active` -- #628's own state machine only ever commits a
        # candidate to `active` after a successful health result); whether
        # it also satisfies the CURRENTLY desired manifest (which may have
        # moved since, e.g. after a rollback restored an older known-good
        # generation) is a separate axis, reported via reconciliation,
        # never by rewriting either identity here.
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
