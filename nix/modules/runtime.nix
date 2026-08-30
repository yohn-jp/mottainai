{ config, lib, pkgs, ... }:

# Canonical Mottainai Linux Runtime module — implements the
# mottainai.linux-runtime.v1 contract (docs/linux-runtime-contract.md,
# ADR-0002). One module produces both fresh Runtime builds and the
# description used to reconcile an existing Runtime; do not fork this into a
# second imperative provisioning path for the same surface.

let
  cfg = config.mottainai.runtime;

  contractId = "mottainai.linux-runtime.v1";
  schemaVersion = 2;

  # System/control-owned vs repository-user-owned persistent state boundary.
  # Reported verbatim in the health/capability result so callers never
  # hardcode it (docs/linux-runtime-contract.md "Persistent vs disposable
  # filesystem layout"). These paths are base-appliance state, not part of a
  # managed application generation.
  systemStatePaths = [
    cfg.stateDir
    "${cfg.stateDir}/managed-packages"
    "${cfg.stateDir}/bootstrap"
    "${cfg.stateDir}/managed-runtime"
  ];
  repositoryUserStatePaths = [ cfg.repositoryStateDir ];

  bootstrapExecutable = "${pkgs.mottainai-bootstrap}/bin/mottainai-bootstrap";

  bootstrapReadinessScript = pkgs.writeShellApplication {
    name = "mottainai-runtime-bootstrap-ready";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -euo pipefail

      # writeShellApplication constrains PATH to its declared inputs. The
      # bootstrap executable and its Nix/tar prerequisites are system
      # packages, so expose the current system profile explicitly.
      PATH="/run/current-system/sw/bin:$PATH"

      for state_path in \
        ${lib.escapeShellArg cfg.stateDir} \
        ${lib.escapeShellArg "${cfg.stateDir}/managed-packages"} \
        ${lib.escapeShellArg "${cfg.stateDir}/bootstrap"} \
        ${lib.escapeShellArg "${cfg.stateDir}/managed-runtime"}; do
        test -d "$state_path"
        test -r "$state_path"
        test -w "$state_path"
      done

      test -x ${lib.escapeShellArg bootstrapExecutable}
      command -v nix >/dev/null 2>&1
      command -v tar >/dev/null 2>&1
      nix --version >/dev/null

      # A fresh appliance has no bootstrap state yet. `status` must still be
      # executable and return its bounded "present: false" result; a later
      # successful build is recorded under the same persistent root.
      ${lib.escapeShellArg bootstrapExecutable} status --json >/dev/null
    '';
  };

  companionCheck = companion: ''
    if command -v ${lib.escapeShellArg companion.name} >/dev/null 2>&1; then
      present=true
    else
      present=false
    fi
    printf '{"name":%s,"minimumVersion":%s,"present":%s}' \
      ${lib.escapeShellArg (builtins.toJSON companion.name)} \
      ${lib.escapeShellArg (builtins.toJSON companion.minimumVersion)} \
      "$present"
  '';

  healthScript = pkgs.writeShellApplication {
    name = "mottainai-runtime-health";
    runtimeInputs = [ pkgs.coreutils pkgs.jq ];
    text = ''
      set -euo pipefail

      # Companions are installed via environment.systemPackages, not this
      # script's own runtimeInputs (writeShellApplication otherwise pins PATH
      # to only its declared inputs, hiding system-installed companions from
      # command -v below).
      PATH="/run/current-system/sw/bin:$PATH"

      # This service is the base/bootstrap health surface. It deliberately
      # succeeds before any managed application generation exists; the
      # managed-runtime-ready phase is owned by the later activation boundary.
      ${bootstrapReadinessScript}/bin/mottainai-runtime-bootstrap-ready

      # Issue #628's managed-runtime state.json/current pointer are the sole
      # authority for managed-application readiness (docs/runtime-state.md
      # "current is accepted as active only when it matches the persisted
      # record"). This reads that already-persisted evidence read-only —
      # it never writes, builds, switches, or re-runs any part of Issue
      # #628's reconcileManagedRuntime state machine, so a health check can
      # never itself mutate managed-runtime state. Absence of a managed
      # generation (a fresh appliance, matching every existing base-only
      # deployment) falls through to the original bootstrap-ready result
      # unchanged.
      readiness="bootstrap-ready"
      managed_runtime_ready=false
      reconciliation="current"
      managed_runtime_state_file=${lib.escapeShellArg "${cfg.stateDir}/managed-runtime/state.json"}
      managed_runtime_current_pointer=${lib.escapeShellArg "${cfg.stateDir}/managed-runtime/current"}
      if [ -r "$managed_runtime_state_file" ] && command -v jq >/dev/null 2>&1; then
        activation_phase="$(jq -r '.activation.phase // "idle"' "$managed_runtime_state_file" 2>/dev/null || echo "unknown")"
        active_health_state="$(jq -r '.active.health.state // "none"' "$managed_runtime_state_file" 2>/dev/null || echo "unknown")"
        active_store_path="$(jq -r '.active.storePath // ""' "$managed_runtime_state_file" 2>/dev/null || echo "")"
        current_target=""
        if [ -L "$managed_runtime_current_pointer" ]; then
          current_target="$(readlink -f "$managed_runtime_current_pointer" 2>/dev/null || echo "")"
        fi
        if [ "$activation_phase" = "idle" ] \
          && [ "$active_health_state" = "healthy" ] \
          && [ -n "$active_store_path" ] \
          && [ "$current_target" = "$active_store_path" ]; then
          readiness="managed-runtime-ready"
          managed_runtime_ready=true
        fi
      fi

      generation_link=/nix/var/nix/profiles/system
      if [ -L "$generation_link" ]; then
        generation="$(readlink "$generation_link" | sed -E 's/^system-([0-9]+)-link$/\1/')"
      elif [ -e /run/current-system ]; then
        # nixosTest boots the initial system closure directly and does not
        # create a Nix profile generation. Treat that closure as generation 1;
        # installed systems continue to report the profile's exact number.
        generation=1
      else
        generation=
      fi
      case "$generation" in
        "" | *[!0-9]*)
          echo "mottainai-runtime-health: could not resolve a numeric system generation" >&2
          exit 1
          ;;
      esac
      build_identity="$(readlink -f /run/current-system 2>/dev/null || echo "unknown")"

      companions="["
      first=true
      ${lib.concatMapStringsSep "\n" (
        companion:
        ''
        if [ "$first" = true ]; then first=false; else companions="$companions,"; fi
        companions="$companions$(${companionCheck companion})"
        ''
      ) cfg.companions}
      companions="$companions]"

      cat <<JSON
      {
        "contractId": "${contractId}",
        "schemaVersion": ${toString schemaVersion},
        "runtimeIdentity": ${builtins.toJSON cfg.runtimeIdentity},
        "architecture": "${pkgs.stdenv.hostPlatform.system}",
        "buildIdentity": "$build_identity",
        "generation": $generation,
        "stateOwners": {
          "system": ${builtins.toJSON systemStatePaths},
          "repositoryUser": ${builtins.toJSON repositoryUserStatePaths}
        },
        "requiredCompanions": $companions,
        "readiness": "$readiness",
        "bootstrapReady": true,
        "managedRuntimeReady": $managed_runtime_ready,
        "reconciliation": "$reconciliation",
        "upgradeRequired": false
      }
      JSON
    '';
  };

  reconcileScript = pkgs.writeShellApplication {
    name = "mottainai-runtime-reconcile";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      set -euo pipefail
      # The module remains the sole Runtime authority. This bounded command
      # only reactivates its health/reconciliation service; it never accepts
      # arbitrary shell or Nix expressions from the host.
      systemctl restart mottainai-runtime-health.service
    '';
  };

  # Bounded first-boot SSH-key bootstrap input (Issue #601): lets a
  # provider-independent, credential-free published Runtime Appliance disk
  # accept an operator's own key without rebuilding the canonical image or
  # baking a reusable credential into it. The canonical disk/closure this
  # Runtime boots from is never written to — the key travels on a
  # separate, small, operator-supplied block device and lands only in
  # persistent control state (below), never in /etc/ssh/authorized_keys.d
  # or the Nix store. This is intentionally narrow — one file, one bounded
  # size, validated key lines only — not a general user-data/cloud-init
  # execution surface, and not specific to any one provider.
  bootstrapAuthorizedKeysLabel = "MTNAI_BOOT";
  bootstrapAuthorizedKeysDir = "${cfg.stateDir}/.ssh";
  bootstrapAuthorizedKeysFile = "${bootstrapAuthorizedKeysDir}/authorized_keys";

  bootstrapAuthorizedKeysScript = pkgs.writeShellApplication {
    name = "mottainai-runtime-bootstrap-authorized-keys";
    runtimeInputs = [ pkgs.coreutils pkgs.util-linux pkgs.gnugrep ];
    text = ''
      set -euo pipefail

      device="/dev/disk/by-label/${bootstrapAuthorizedKeysLabel}"
      if [ ! -e "$device" ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: no $device present; nothing to do"
        exit 0
      fi

      mount_dir="$(mktemp -d)"
      trap 'umount "$mount_dir" 2>/dev/null || true; rmdir "$mount_dir" 2>/dev/null || true' EXIT
      mount -o ro "$device" "$mount_dir"

      source_file="$mount_dir/authorized_keys"
      if [ ! -f "$source_file" ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: $device has no authorized_keys file; nothing to do"
        exit 0
      fi

      size="$(stat -c %s "$source_file")"
      if [ "$size" -gt 8192 ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: $source_file exceeds the 8KiB bound; refusing" >&2
        exit 1
      fi

      # Fail closed on the complete input: every non-empty line must match
      # the supported SSH public-key grammar, or the whole bootstrap input
      # is refused — an invalid line is never silently dropped, and a count
      # over the 16-key bound is refused outright, never silently truncated.
      key_pattern='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+( .*)?$'
      key_count=0
      invalid_count=0
      keys=""
      while IFS= read -r line || [ -n "$line" ]; do
        [ -z "$line" ] && continue
        if printf '%s\n' "$line" | grep -Eq "$key_pattern"; then
          key_count=$((key_count + 1))
          keys="$keys$line"$'\n'
        else
          invalid_count=$((invalid_count + 1))
        fi
      done < "$source_file"

      if [ "$invalid_count" -gt 0 ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: $source_file contains $invalid_count line(s) that are not a valid SSH public key; refusing the whole bootstrap input" >&2
        exit 1
      fi
      if [ "$key_count" -eq 0 ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: no key lines found in $source_file; refusing" >&2
        exit 1
      fi
      if [ "$key_count" -gt 16 ]; then
        echo "mottainai-runtime-bootstrap-authorized-keys: $source_file contains $key_count keys, exceeding the 16-key bound; refusing" >&2
        exit 1
      fi

      install -d -m 0700 -o ${lib.escapeShellArg cfg.controlUser} -g ${lib.escapeShellArg cfg.controlUser} \
        ${lib.escapeShellArg bootstrapAuthorizedKeysDir}
      staged="$(mktemp)"
      printf '%s' "$keys" > "$staged"
      install -m 0600 -o ${lib.escapeShellArg cfg.controlUser} -g ${lib.escapeShellArg cfg.controlUser} \
        "$staged" ${lib.escapeShellArg bootstrapAuthorizedKeysFile}
      rm -f "$staged"

      echo "mottainai-runtime-bootstrap-authorized-keys: installed $key_count bootstrap key(s) for ${lib.escapeShellArg cfg.controlUser}"
    '';
  };
in
{
  options.mottainai.runtime = {
    enable = lib.mkEnableOption "the Mottainai Linux Runtime contract (mottainai.linux-runtime.v1)";

    runtimeIdentity = lib.mkOption {
      type = lib.types.str;
      default = "unset";
      description = "Stable identifier for this Runtime instance, distinct from its build identity.";
    };

    controlUser = lib.mkOption {
      type = lib.types.str;
      default = "mottainai-control";
      description = "Trusted system identity that owns Mottainai/Nawabari control state.";
    };

    controlAuthorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        SSH public keys allowed to operate the trusted control identity.
        Image builders provide the per-installation key; the default remains
        empty so a fresh generic Runtime cannot be accessed accidentally.
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/mottainai-control";
      description = ''
        System/control-owned persistent state: Nawabari session/claim
        registry, Mottainai brain state, control SSH host keys. Owned by
        controlUser, mode 0700 — not world- or repository-readable.
      '';
    };

    repositoryStateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/mottainai/repositories";
      description = ''
        Repository-user-owned persistent state root (repository checkouts,
        HOME, tool/package caches). Outside destructive system-generation
        replacement; never reverted by ordinary Runtime reconciliation.
        Repository UID/GID principal allocation itself is a later #230
        child and is not implemented by this module.
      '';
    };

    companions = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; };
            minimumVersion = lib.mkOption { type = lib.types.str; };
          };
        }
      );
      default = [
        {
          name = "nawabari";
          minimumVersion = "0.6.1";
        }
      ];
      description = ''
        Companion executables the health/capability result reports on.
        Nawabari metadata matches the pinned Runtime package version this
        repository documents (docs/nawabari-execution.md); Mottainai does not
        auto-install it, an operator installs the compatible standalone
        executable explicitly.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.controlUser} = { };
    users.users.${cfg.controlUser} = {
      isSystemUser = true;
      group = cfg.controlUser;
      home = cfg.stateDir;
      createHome = true;
      description = "Mottainai trusted control identity (mottainai.linux-runtime.v1)";
      shell = pkgs.bashInteractive;
      openssh.authorizedKeys.keys = cfg.controlAuthorizedKeys;
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0700 ${cfg.controlUser} ${cfg.controlUser} -"
      "d ${cfg.stateDir}/managed-packages 0700 ${cfg.controlUser} ${cfg.controlUser} -"
      "d ${cfg.stateDir}/bootstrap 0700 ${cfg.controlUser} ${cfg.controlUser} -"
      "d ${cfg.stateDir}/managed-runtime 0700 ${cfg.controlUser} ${cfg.controlUser} -"
      "d ${cfg.repositoryStateDir} 0755 root root -"
    ];

    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    services.openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "no";
      };
    };

    environment.systemPackages = [
      pkgs.git
      pkgs.openssh
      pkgs.bubblewrap
      pkgs.nix
      pkgs.gnutar
      pkgs.cacert
      pkgs.jq
      pkgs.mottainai-bootstrap
      healthScript
      reconcileScript
      bootstrapReadinessScript
    ];

    security.sudo.extraRules = [
      {
        users = [ cfg.controlUser ];
        commands = [
          {
            command = "${reconcileScript}/bin/mottainai-runtime-reconcile";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];

    systemd.services.mottainai-runtime-health = {
      description = "Mottainai Runtime bounded health/capability result (mottainai.linux-runtime.v1)";
      after = [ "mottainai-runtime-bootstrap-ready.service" ];
      requires = [ "mottainai-runtime-bootstrap-ready.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        User = cfg.controlUser;
        ExecStart = "${healthScript}/bin/mottainai-runtime-health";
        StandardOutput = "journal";
      };
    };

    # This is an explicit base-appliance phase. It must be active before the
    # health result is emitted, while remaining independent of any managed
    # Mottainai/Nawabari generation.
    systemd.services.mottainai-runtime-bootstrap-ready = {
      description = "Mottainai Runtime bootstrap-ready phase (mottainai.linux-runtime.v1)";
      after = [ "network-online.target" "mottainai-runtime-bootstrap-authorized-keys.service" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        User = cfg.controlUser;
        RemainAfterExit = true;
        ExecStart = "${bootstrapReadinessScript}/bin/mottainai-runtime-bootstrap-ready";
      };
    };

    # Runs once, before sshd starts accepting connections, and only while no
    # bootstrap key has been installed yet (ConditionPathExists "!..."): a
    # later manually-managed authorized_keys is never overwritten by a
    # bootstrap device left attached or reattached on a subsequent boot.
    systemd.services.mottainai-runtime-bootstrap-authorized-keys = {
      description = "Mottainai Runtime bounded first-boot SSH key bootstrap (mottainai.linux-runtime.v1)";
      before = [ "sshd.service" ];
      wantedBy = [ "multi-user.target" ];
      unitConfig.ConditionPathExists = "!${bootstrapAuthorizedKeysFile}";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${bootstrapAuthorizedKeysScript}/bin/mottainai-runtime-bootstrap-authorized-keys";
      };
    };
  };
}
