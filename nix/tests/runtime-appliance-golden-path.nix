{ pkgs, lib, runtimeModule, runtimeOverlay }:

# Issue #630's thin, provider-independent guest proof. The test deliberately
# uses the production bootstrap command's canonical source resolution: the
# manifests name the immutable GitHub release tags below, and reconcile is
# invoked without a source, state, or repository override.
let
  system = pkgs.stdenv.hostPlatform.system;
  mottainaiVersionV1 = "0.7.0";
  mottainaiVersionV2 = "0.7.1";
  # NAR hashes of the exact trees produced by the source resolver's
  # tar --strip-components=1 --no-same-owner --no-same-permissions extraction.
  mottainaiSourceSha256V1 = "9226d16d4690470e3e10d17846246c108ba77de1a73853bcf0a9f23d41118a96";
  mottainaiSourceSha256V2 = "f0f0a87a63170240666f66b5f3a8fafed0715ce0cc9157a469b0d72aaefbb0ce";
  nawabariVersion = "0.6.1";
  nawabariSourceSha256 = "1ce810f330b293eee02591c4bb75ee8b489668d53cdbea3aca754e08475b33ba";
in
pkgs.testers.nixosTest {
  name = "mottainai-runtime-appliance-golden-path";

  nodes.golden =
    { ... }:
    {
      imports = [ runtimeModule ];
      nixpkgs.overlays = [ runtimeOverlay ];
      mottainai.runtime = {
        enable = true;
        runtimeIdentity = "runtime-appliance-golden-path";
      };
      # Match the canonical QEMU Runtime sizing while leaving enough
      # persistent Nix store space for the two real managed builds.
      virtualisation.memorySize = 2048;
      virtualisation.cores = 2;
      virtualisation.diskSize = 8192;
      # nixosTest normally clears the guest route and nameservers to make
      # tests hermetic. This proof intentionally exercises #626's production
      # HTTPS source resolver against the real release tags, so restore the
      # standard QEMU user-network route only for this test harness.
      networking.interfaces.eth0.ipv4.addresses = lib.mkAfter [
        {
          address = "10.0.2.15";
          prefixLength = 24;
        }
      ];
      networking.defaultGateway = lib.mkForce "10.0.2.2";
      networking.nameservers = lib.mkForce [ "10.0.2.3" ];
    };

  testScript = ''
    import json
    import shlex

    manifest_path = "/var/lib/mottainai-control/managed-packages/manifest.json"
    repository_state_root = "/var/lib/mottainai/repositories"
    persistent_sentinel = repository_state_root + "/issue-630-unmanaged/UNMANAGED_MARKER"
    ephemeral_sentinel = "/tmp/issue-630-ephemeral-sentinel"

    def control(command):
        return golden.succeed("su -l mottainai-control -c " + shlex.quote(command))

    def control_failure(command):
        return golden.fail("su -l mottainai-control -c " + shlex.quote(command))

    def managed_manifest(version, source_sha256, activation_generation):
        return {
            "contractId": "mottainai.managed-package-manifest.v1",
            "schemaVersion": 1,
            "activation": {"generation": activation_generation},
            "packages": [
                {
                    "packageId": "mottainai",
                    "kind": "nix-flake-package",
                    "version": version,
                    "source": {
                        "flakeRef": "nix#mottainai",
                        "sourceSha256": source_sha256,
                    },
                },
                {
                    "packageId": "nawabari",
                    "kind": "nix-flake-package",
                    "version": "${nawabariVersion}",
                    "source": {
                        "flakeRef": "nix/packages/nawabari.nix",
                        "sourceSha256": "${nawabariSourceSha256}",
                    },
                },
            ],
        }

    def write_manifest(manifest):
        # The production path remains the authority; this only supplies the
        # operator's desired-state file as root, then restores its canonical
        # control-user ownership and mode.
        text = json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
        golden.succeed(
            "install -m 0600 -o mottainai-control -g mottainai-control /dev/null "
            + shlex.quote(manifest_path)
        )
        golden.succeed("printf '%s' " + shlex.quote(text) + " > " + shlex.quote(manifest_path))

    def reconcile():
        return json.loads(
            control("mottainai-bootstrap reconcile --system ${system} --json")
        )

    def managed_status():
        return json.loads(control("mottainai-bootstrap managed-status --json"))

    def runtime_health():
        return json.loads(golden.succeed("mottainai-runtime-health"))

    def assert_managed_ready(health, status, expected_desired, expected_active):
        assert health["readiness"] == "managed-runtime-ready"
        assert health["managedRuntimeReady"] is True
        assert status["valid"] is True
        assert status["present"] is True
        assert status["desiredManifestSemanticIdentity"] == expected_desired
        assert status["activeGenerationIdentity"] == expected_active
        assert status["observedGenerationIdentity"] == expected_active
        assert status["activationPhase"] == "idle"

    golden.start(allow_reboot=True)
    golden.wait_for_unit("multi-user.target")
    golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
    base_appliance_identity = golden.succeed("readlink -f /run/current-system").strip()

    with subtest("fresh canonical appliance is bootstrap-ready and has no managed packages"):
        golden.fail("command -v mottainai")
        golden.fail("command -v nawabari")
        golden.fail("command -v zellij")
        # Keep closure evidence bounded: report only a forbidden match, never
        # the complete closure or a full build log.
        forbidden = r"/nix/store/[a-z0-9]+-(mottainai|nawabari|zellij)-[0-9]"
        golden.succeed(
            "if nix-store -qR "
            + shlex.quote(base_appliance_identity)
            + " | grep -Eq "
            + shlex.quote(forbidden)
            + "; then exit 1; fi"
        )
        bootstrap_status = json.loads(control("mottainai-bootstrap status --json"))
        assert bootstrap_status["contractId"] == "mottainai.bootstrap-state.v1"
        assert bootstrap_status["schemaVersion"] == 1
        assert bootstrap_status["present"] is False
        health = runtime_health()
        assert health["runtimeIdentity"] == "runtime-appliance-golden-path"
        assert health["buildIdentity"] == base_appliance_identity
        assert health["readiness"] == "bootstrap-ready"
        assert health["bootstrapReady"] is True
        assert health["managedRuntimeReady"] is False

    manifest_v1 = managed_manifest(
        "${mottainaiVersionV1}", "${mottainaiSourceSha256V1}", 1
    )
    manifest_v2 = managed_manifest(
        "${mottainaiVersionV2}", "${mottainaiSourceSha256V2}", 2
    )
    assert manifest_v1["packages"][1] == manifest_v2["packages"][1]
    assert manifest_v1["packages"][0]["packageId"] == "mottainai"
    assert manifest_v2["packages"][0]["packageId"] == "mottainai"

    with subtest("canonical manifest reconcile activates healthy Mottainai and Nawabari"):
        write_manifest(manifest_v1)
        reconcile_v1 = reconcile()
        assert reconcile_v1["ok"] is True
        assert reconcile_v1["outcome"] == "initialized"
        desired_v1 = reconcile_v1["desiredManifestSemanticIdentity"]
        active_v1 = reconcile_v1["active"]["generationIdentity"]
        store_v1 = reconcile_v1["active"]["storePath"]
        assert reconcile_v1["active"]["packageIds"] == ["mottainai", "nawabari"]
        assert reconcile_v1["active"]["desiredManifestSemanticIdentity"] == desired_v1
        assert golden.succeed(shlex.quote(store_v1) + "/bin/mottainai --version").strip() == "${mottainaiVersionV1}"
        assert golden.succeed(shlex.quote(store_v1) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        status_v1 = managed_status()
        health_v1 = runtime_health()
        assert_managed_ready(health_v1, status_v1, desired_v1, active_v1)
        assert health_v1["buildIdentity"] == base_appliance_identity

    with subtest("only Mottainai version changes and activates a new managed generation"):
        write_manifest(manifest_v2)
        reconcile_v2 = reconcile()
        assert reconcile_v2["ok"] is True
        assert reconcile_v2["outcome"] == "updated"
        desired_v2 = reconcile_v2["desiredManifestSemanticIdentity"]
        active_v2 = reconcile_v2["active"]["generationIdentity"]
        store_v2 = reconcile_v2["active"]["storePath"]
        assert desired_v2 != desired_v1
        assert active_v2 != active_v1
        assert store_v2 != store_v1
        assert reconcile_v2["active"]["packageIds"] == ["mottainai", "nawabari"]
        assert golden.succeed(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert golden.succeed(shlex.quote(store_v2) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        status_v2 = managed_status()
        health_v2 = runtime_health()
        assert_managed_ready(health_v2, status_v2, desired_v2, active_v2)
        assert health_v2["buildIdentity"] == base_appliance_identity

    with subtest("persistent-unmanaged and ephemeral sentinel semantics are recorded"):
        golden.succeed("install -d -m 0755 -o root -g root " + shlex.quote(repository_state_root + "/issue-630-unmanaged"))
        golden.succeed("printf '%s' persistent-unmanaged-sentinel > " + shlex.quote(persistent_sentinel))
        golden.succeed("printf '%s' ephemeral-sentinel > " + shlex.quote(ephemeral_sentinel))
        golden.succeed("sync")

    with subtest("reboot preserves desired and active state, readiness, and base identity"):
        golden.reboot()
        golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
        assert golden.succeed("readlink -f /run/current-system").strip() == base_appliance_identity
        status_after_reboot = managed_status()
        health_after_reboot = runtime_health()
        assert_managed_ready(health_after_reboot, status_after_reboot, desired_v2, active_v2)
        assert golden.succeed(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert golden.succeed(shlex.quote(store_v2) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        reconcile_after_reboot = reconcile()
        assert reconcile_after_reboot["outcome"] == "noop"
        assert reconcile_after_reboot["active"]["generationIdentity"] == active_v2
        assert golden.succeed("grep -qx persistent-unmanaged-sentinel " + shlex.quote(persistent_sentinel))
        persistent_evidence = "survived"
        ephemeral_exit, _ = golden.execute("test -f " + shlex.quote(ephemeral_sentinel))
        ephemeral_survived = ephemeral_exit == 0

    with subtest("unmanaged state is absent from managed evidence and ephemeral policy is explicit"):
        bounded_status = json.dumps(status_after_reboot, sort_keys=True)
        bounded_health = json.dumps(health_after_reboot, sort_keys=True)
        assert persistent_sentinel not in bounded_status
        assert persistent_sentinel not in bounded_health
        assert "ephemeral" not in bounded_status.lower()
        assert "ephemeral" not in bounded_health.lower()

    with subtest("unhealthy next generation rolls back deterministically"):
        # Re-declaring v1 is a semantic change from active v2. The v1 output
        # was healthy before; making its exact binary non-executable creates a
        # real post-switch health failure without changing production logic.
        write_manifest(managed_manifest(
            "${mottainaiVersionV1}", "${mottainaiSourceSha256V1}", 3
        ))
        golden.succeed("chmod 000 " + shlex.quote(store_v1 + "/bin/mottainai"))
        control_failure("mottainai-bootstrap reconcile --system ${system} --json")
        rollback_status = managed_status()
        rollback_health = runtime_health()
        assert rollback_status["failure"]["code"] == "health_failure"
        assert rollback_status["failure"]["phase"] == "rollback-pending"
        assert rollback_status["activeGenerationIdentity"] == active_v2
        assert rollback_status["observedGenerationIdentity"] == active_v2
        assert rollback_status["desiredManifestSemanticIdentity"] == desired_v1
        assert rollback_health["readiness"] == "managed-runtime-ready"
        assert rollback_health["managedRuntimeReady"] is True
        assert rollback_health["reconciliation"] == "repairable"
        assert golden.succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip() == store_v2
        assert golden.succeed(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert golden.succeed("grep -qx persistent-unmanaged-sentinel " + shlex.quote(persistent_sentinel))
        assert golden.succeed("readlink -f /run/current-system").strip() == base_appliance_identity

    evidence = {
        "baseAppliance": {
            "runtimeIdentity": "runtime-appliance-golden-path",
            "buildIdentity": base_appliance_identity,
        },
        "bootstrap": {
            "contractId": "mottainai.bootstrap-state.v1",
            "schemaVersion": 1,
        },
        "managed": {
            "v1": {
                "desiredGenerationIdentity": desired_v1,
                "activeGenerationIdentity": active_v1,
                "storePath": store_v1,
                "packages": {
                    "mottainai": {"version": "${mottainaiVersionV1}", "sourceSha256": "${mottainaiSourceSha256V1}"},
                    "nawabari": {"version": "${nawabariVersion}", "sourceSha256": "${nawabariSourceSha256}"},
                },
            },
            "v2": {
                "desiredGenerationIdentity": desired_v2,
                "activeGenerationIdentity": active_v2,
                "storePath": store_v2,
                "packages": {
                    "mottainai": {"version": "${mottainaiVersionV2}", "sourceSha256": "${mottainaiSourceSha256V2}"},
                    "nawabari": {"version": "${nawabariVersion}", "sourceSha256": "${nawabariSourceSha256}"},
                },
            },
            "rollback": {
                "activeGenerationIdentity": rollback_status["activeGenerationIdentity"],
                "desiredGenerationIdentity": rollback_status["desiredManifestSemanticIdentity"],
                "failureCode": rollback_status["failure"]["code"],
                "readiness": rollback_health["readiness"],
            },
        },
        "sentinels": {
            "persistentUnmanaged": persistent_evidence,
            "ephemeral": {"policy": "not-guaranteed", "survivedReboot": ephemeral_survived},
        },
    }
    print("ISSUE_630_GOLDEN_PATH_EVIDENCE " + json.dumps(evidence, sort_keys=True))
  '';
}
