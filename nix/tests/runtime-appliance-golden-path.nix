{ pkgs, lib, runtimeApplianceImage }:

# Issue #630's thin, provider-independent proof. The node is only a QEMU
# harness: its root disk is the actual canonical Runtime Appliance image
# output, and all lifecycle operations below use the production SSH/control
# boundary inside that image.
let
  system = pkgs.stdenv.hostPlatform.system;
  canonicalDiskImage = "${runtimeApplianceImage}/mottainai-runtime-appliance.raw";
  applianceInputs = builtins.fromJSON (
    builtins.unsafeDiscardStringContext (
      builtins.readFile "${runtimeApplianceImage}/runtime-appliance-inputs.json"
    )
  );
  canonicalBuildIdentity = applianceInputs.nixSystemClosure;
  canonicalSourceJson = builtins.toJSON applianceInputs.canonicalSource;
  mottainaiVersionV1 = "0.7.0";
  mottainaiVersionV2 = "0.7.1";
  # NAR hashes of the exact trees produced by the source resolver's
  # tar --strip-components=1 --no-same-owner --no-same-permissions extraction.
  mottainaiSourceSha256V1 = "9226d16d4690470e3e10d17846246c108ba77de1a73853bcf0a9f23d41118a96";
  mottainaiSourceSha256V2 = "f0f0a87a63170240666f66b5f3a8fafed0715ce0cc9157a469b0d72aaefbb0ce";
  nawabariVersion = "0.6.1";
  nawabariSourceSha256 = "1ce810f330b293eee02591c4bb75ee8b489668d53cdbea3aca754e08475b33ba";
in
assert applianceInputs.contractId == "mottainai.linux-runtime-appliance.v1";
assert applianceInputs.schemaVersion == 1;
assert applianceInputs.architecture == system;
assert applianceInputs.canonicalSource.output == "applianceConfigurations.${system}.config.system.build.toplevel";
(pkgs.testers.nixosTest {
  name = "mottainai-runtime-appliance-golden-path";

  nodes.golden =
    { ... }:
    {
      # This is deliberately not a NixOS test system assembled from
      # production Runtime module. It is the QEMU driver for the already-built canonical
      # self-bootable appliance disk.
      virtualisation.diskImage = canonicalDiskImage;
      virtualisation.directBoot.enable = false;
      virtualisation.useBootLoader = true;
      virtualisation.useBIOSBoot = true;
      virtualisation.installBootLoader = false;
      virtualisation.mountHostNixStore = false;
      virtualisation.writableStore = false;
      # Prevent qemu-vm from replacing the appliance's on-disk filesystem
      # contract with a test-generated filesystem map.
      virtualisation.fileSystems = lib.mkForce { };
      fileSystems."/" = {
        device = "/dev/disk/by-label/nixos";
        fsType = "ext4";
      };
      virtualisation.diskSize = 16384;
      virtualisation.emptyDiskImages = [ 16 ];
      virtualisation.memorySize = 2048;
      virtualisation.cores = 2;
      # The appliance gets its address from the standard QEMU user network;
      # this is only a host-side SSH forward, not a replacement guest network
      # configuration.
      virtualisation.forwardPorts = [
        {
          from = "host";
          host.address = "127.0.0.1";
          host.port = 22222;
          guest.address = "10.0.2.15";
          guest.port = 22;
        }
      ];
    };

  testScript =
    { nodes, ... }:
    ''
    import json
    import os
    import shlex
    import subprocess
    import time

    canonical_disk = ${builtins.toJSON canonicalDiskImage}
    root_overlay = os.path.join(str(golden.state_dir), "canonical-root-overlay.qcow2")
    bootstrap_raw = os.path.join(str(golden.state_dir), "bootstrap.raw")
    bootstrap_disk = os.path.join(str(golden.state_dir), "empty0.qcow2")
    bootstrap_key = os.path.join(str(golden.state_dir), "bootstrap-ed25519")
    qemu_img = "${nodes.golden.virtualisation.qemu.package}/bin/qemu-img"
    mkfs = "${pkgs.e2fsprogs}/bin/mkfs.ext4"
    debugfs = "${pkgs.e2fsprogs}/bin/debugfs"
    ssh_keygen = "${pkgs.openssh}/bin/ssh-keygen"

    manifest_path = "/var/lib/mottainai-control/managed-packages/manifest.json"
    persistent_sentinel = "/var/lib/mottainai-control/unmanaged/UNMANAGED_MARKER"
    ephemeral_sentinel = "/tmp/issue-630-ephemeral-sentinel"

    def run_host(command):
        result = subprocess.run(command, check=False, capture_output=True, text=True)
        assert result.returncode == 0, (
            "host command failed: " + " ".join(command) +
            "\nstdout: " + result.stdout[-1000:] +
            "\nstderr: " + result.stderr[-1000:]
        )
        return result.stdout

    # Make the canonical raw image immutable backing storage for the VM's
    # writable disk. The overlay is created outside the Nix store; the base
    # appliance itself is never copied, rebuilt, or modified.
    run_host([
        qemu_img, "create", "-f", "qcow2", "-F", "raw", "-b",
        canonical_disk, root_overlay, "16G",
    ])
    overlay_info = json.loads(run_host([qemu_img, "info", "--output=json", root_overlay]))
    assert overlay_info["format"] == "qcow2"
    assert os.path.realpath(overlay_info["backing-filename"]) == canonical_disk
    canonical_disk_size = os.stat(canonical_disk).st_size
    canonical_disk_sha256 = run_host(["sha256sum", canonical_disk]).split()[0]

    # The published appliance intentionally has no NixOS test backdoor and no
    # baked-in credential. Supply the production MTNAI_BOOT block device with
    # one ephemeral test key, then use the appliance's real SSH/control path.
    run_host([ssh_keygen, "-q", "-t", "ed25519", "-N", "", "-f", bootstrap_key])
    run_host([qemu_img, "create", "-f", "raw", bootstrap_raw, "16M"])
    run_host([mkfs, "-L", "MTNAI_BOOT", bootstrap_raw])
    run_host([
        debugfs, "-w", "-R",
        "write " + bootstrap_key + ".pub authorized_keys", bootstrap_raw,
    ])
    run_host([qemu_img, "convert", "-f", "raw", "-O", "qcow2", bootstrap_raw, bootstrap_disk])
    os.environ["NIX_DISK_IMAGE"] = root_overlay

    ssh_command = [
        "${pkgs.openssh}/bin/ssh",
        "-i", bootstrap_key,
        "-p", "22222",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=5",
        "mottainai-control@127.0.0.1",
    ]

    def wait_for_ssh():
        # This bounded loop waits only for transport/service readiness after
        # QEMU boot or reboot. Each lifecycle assertion and reconcile command
        # below executes exactly once; no failure is hidden by retries.
        deadline = time.monotonic() + 180
        last_error = ""
        while time.monotonic() < deadline:
            result = subprocess.run(
                ssh_command + ["true"], check=False, capture_output=True,
                text=True, timeout=6,
            )
            if result.returncode == 0:
                return
            last_error = (result.stderr or result.stdout)[-500:]
            time.sleep(1)
        raise AssertionError("SSH readiness timed out: " + last_error)

    def guest(command, timeout=300):
        result = subprocess.run(
            ssh_command + [command], check=False, capture_output=True,
            text=True, timeout=timeout,
        )
        if result.returncode != 0:
            raise AssertionError(
                "guest command failed (" + str(result.returncode) + "): " + command +
                "\nstdout: " + result.stdout[-2000:] +
                "\nstderr: " + result.stderr[-2000:]
            )
        return result.stdout

    def guest_failure(command, timeout=900):
        result = subprocess.run(
            ssh_command + [command], check=False, capture_output=True,
            text=True, timeout=timeout,
        )
        assert result.returncode != 0, "guest command unexpectedly succeeded: " + command
        return result.stdout

    def control(command, timeout=300):
        return guest(command, timeout)

    def control_failure(command, timeout=900):
        return guest_failure(command, timeout)

    def guest_json(command, timeout=300):
        return json.loads(control(command, timeout))

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

    def unhealthy_manifest():
        # Empty packages are schema-valid desired state, but production
        # reconcileHealthCheck rejects an empty generation because no managed
        # executable can be proven healthy. This activates a real Nix
        # generation and exercises production rollback without mutating a
        # store path or weakening any health rule.
        return {
            "contractId": "mottainai.managed-package-manifest.v1",
            "schemaVersion": 1,
            "activation": {"generation": 3},
            "packages": [],
        }

    def write_manifest(manifest):
        text = json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
        command = (
            "install -m 0600 /dev/null " + shlex.quote(manifest_path) +
            " && printf '%s' " + shlex.quote(text) +
            " > " + shlex.quote(manifest_path)
        )
        control(command)

    def reconcile():
        return guest_json("mottainai-bootstrap reconcile --system ${system} --json", 900)

    def managed_status():
        return guest_json("mottainai-bootstrap managed-status --json")

    def runtime_health():
        return guest_json("mottainai-runtime-health")

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
    wait_for_ssh()
    base_appliance_identity = control("readlink -f /run/current-system").strip()
    assert base_appliance_identity == ${builtins.toJSON canonicalBuildIdentity}

    with subtest("fresh canonical appliance is bootstrap-ready and has no managed packages"):
        control("systemctl is-active --quiet mottainai-runtime-bootstrap-ready.service")
        guest_failure("command -v mottainai")
        guest_failure("command -v nawabari")
        guest_failure("command -v zellij")
        # Keep closure evidence bounded: report only a forbidden match, never
        # the complete closure or a full build log.
        forbidden = r"/nix/store/[a-z0-9]+-(mottainai|nawabari|zellij)-[0-9]"
        control(
            "if nix-store -qR " + shlex.quote(base_appliance_identity) +
            " | grep -Eq " + shlex.quote(forbidden) + "; then exit 1; fi"
        )
        bootstrap_status = guest_json("mottainai-bootstrap status --json")
        assert bootstrap_status["contractId"] == "mottainai.bootstrap-state.v1"
        assert bootstrap_status["schemaVersion"] == 1
        assert bootstrap_status["present"] is False
        health = runtime_health()
        assert health["runtimeIdentity"] == "unset"
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
        assert guest(shlex.quote(store_v1) + "/bin/mottainai --version").strip() == "${mottainaiVersionV1}"
        assert guest(shlex.quote(store_v1) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
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
        assert guest(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert guest(shlex.quote(store_v2) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        status_v2 = managed_status()
        health_v2 = runtime_health()
        assert_managed_ready(health_v2, status_v2, desired_v2, active_v2)
        assert health_v2["buildIdentity"] == base_appliance_identity

    with subtest("persistent-unmanaged and ephemeral sentinel semantics are recorded"):
        control("install -d -m 0755 " + shlex.quote(os.path.dirname(persistent_sentinel)))
        control("printf '%s' persistent-unmanaged-sentinel > " + shlex.quote(persistent_sentinel))
        control("printf '%s' ephemeral-sentinel > " + shlex.quote(ephemeral_sentinel))
        control("sync")

    with subtest("reboot preserves desired and active state, readiness, and base identity"):
        golden.reboot()
        wait_for_ssh()
        assert control("readlink -f /run/current-system").strip() == base_appliance_identity
        status_after_reboot = managed_status()
        health_after_reboot = runtime_health()
        assert_managed_ready(health_after_reboot, status_after_reboot, desired_v2, active_v2)
        assert guest(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert guest(shlex.quote(store_v2) + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        reconcile_after_reboot = reconcile()
        assert reconcile_after_reboot["outcome"] == "noop"
        assert reconcile_after_reboot["active"]["generationIdentity"] == active_v2
        assert control("grep -qx persistent-unmanaged-sentinel " + shlex.quote(persistent_sentinel))
        persistent_evidence = "survived"
        ephemeral_exit = subprocess.run(
            ssh_command + ["test -f " + shlex.quote(ephemeral_sentinel)],
            check=False, capture_output=True, text=True, timeout=30,
        ).returncode
        ephemeral_survived = ephemeral_exit == 0

    with subtest("unmanaged state is absent from managed evidence and ephemeral policy is explicit"):
        bounded_status = json.dumps(status_after_reboot, sort_keys=True)
        bounded_health = json.dumps(health_after_reboot, sort_keys=True)
        assert persistent_sentinel not in bounded_status
        assert persistent_sentinel not in bounded_health
        assert "ephemeral" not in bounded_status.lower()
        assert "ephemeral" not in bounded_health.lower()

    with subtest("unhealthy next generation rolls back deterministically"):
        write_manifest(unhealthy_manifest())
        failure_output = control_failure("mottainai-bootstrap reconcile --system ${system} --json")
        failure_result = json.loads(failure_output)
        assert failure_result["code"] == "health_failure"
        rollback_status = managed_status()
        rollback_health = runtime_health()
        assert rollback_status["failure"]["code"] == "health_failure"
        assert rollback_status["failure"]["phase"] == "rollback-pending"
        assert rollback_status["activeGenerationIdentity"] == active_v2
        assert rollback_status["observedGenerationIdentity"] == active_v2
        assert rollback_status["desiredManifestSemanticIdentity"] != desired_v2
        assert rollback_health["readiness"] == "managed-runtime-ready"
        assert rollback_health["managedRuntimeReady"] is True
        assert rollback_health["reconciliation"] == "repairable"
        assert control("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip() == store_v2
        assert guest(shlex.quote(store_v2) + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        assert control("grep -qx persistent-unmanaged-sentinel " + shlex.quote(persistent_sentinel))
        assert control("readlink -f /run/current-system").strip() == base_appliance_identity

    final_disk_sha256 = run_host(["sha256sum", canonical_disk]).split()[0]
    assert final_disk_sha256 == canonical_disk_sha256

    evidence = {
        "canonicalAppliance": {
            "contractId": "mottainai.linux-runtime-appliance.v1",
            "schemaVersion": 1,
            "architecture": "${system}",
            "nixSystemClosure": ${builtins.toJSON canonicalBuildIdentity},
            "canonicalSource": ${canonicalSourceJson},
            "disk": {
                "path": canonical_disk,
                "format": "raw",
                "sizeBytes": canonical_disk_size,
                "sha256": canonical_disk_sha256,
                "backingPathVerified": True,
                "unchangedAfterLifecycle": final_disk_sha256 == canonical_disk_sha256,
            },
        },
        "baseAppliance": {
            "runtimeIdentity": health_after_reboot["runtimeIdentity"],
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
                "packageIds": ["mottainai", "nawabari"],
                "packages": {
                    "mottainai": {"version": "${mottainaiVersionV1}", "sourceSha256": "${mottainaiSourceSha256V1}"},
                    "nawabari": {"version": "${nawabariVersion}", "sourceSha256": "${nawabariSourceSha256}"},
                },
            },
            "v2": {
                "desiredGenerationIdentity": desired_v2,
                "activeGenerationIdentity": active_v2,
                "storePath": store_v2,
                "packageIds": ["mottainai", "nawabari"],
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
                "managedRuntimeReady": rollback_health["managedRuntimeReady"],
            },
        },
        "postReboot": {
            "desiredGenerationIdentity": status_after_reboot["desiredManifestSemanticIdentity"],
            "activeGenerationIdentity": status_after_reboot["activeGenerationIdentity"],
            "readiness": health_after_reboot["readiness"],
            "managedRuntimeReady": health_after_reboot["managedRuntimeReady"],
        },
        "sentinels": {
            "persistentUnmanaged": persistent_evidence,
            "ephemeral": {"policy": "not-guaranteed", "survivedReboot": ephemeral_survived},
        },
    }
    print("ISSUE_630_GOLDEN_PATH_EVIDENCE " + json.dumps(evidence, sort_keys=True))
    '';
}).overrideTestDerivation (_: {
  # Reconcile intentionally resolves the real tagged source over HTTPS from
  # inside the guest. The outer Nix build sandbox removes the network
  # namespace before QEMU starts, so CI must run this derivation with
  # `sandbox = relaxed`; the guest remains the system under test.
  __noChroot = true;
})
