{ config, lib, pkgs, ... }:

# Canonical Mottainai Linux Runtime module — implements the
# mottainai.linux-runtime.v1 contract (docs/linux-runtime-contract.md,
# ADR-0002). One module produces both fresh Runtime builds and the
# description used to reconcile an existing Runtime; do not fork this into a
# second imperative provisioning path for the same surface.

let
  cfg = config.mottainai.runtime;

  contractId = "mottainai.linux-runtime.v1";
  schemaVersion = 1;

  # System/control-owned vs repository-user-owned persistent state boundary.
  # Reported verbatim in the health/capability result so callers never
  # hardcode it (docs/linux-runtime-contract.md "Persistent vs disposable
  # filesystem layout").
  systemStatePaths = [ cfg.stateDir ];
  repositoryUserStatePaths = [ cfg.repositoryStateDir ];

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
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -euo pipefail

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
        "reconciliation": "current",
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
          minimumVersion = "0.2.0";
        }
      ];
      description = ''
        Companion executables the health/capability result reports on.
        Nawabari is pinned to the minimum standalone-execution version this
        repository documents (docs/nawabari-execution.md); Mottainai does
        not auto-install it, an operator installs the compatible standalone
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
      "d ${cfg.repositoryStateDir} 0755 root root -"
    ];

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
      healthScript
      reconcileScript
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
      serviceConfig = {
        Type = "oneshot";
        User = cfg.controlUser;
        ExecStart = "${healthScript}/bin/mottainai-runtime-health";
        StandardOutput = "journal";
      };
    };
  };
}
