{ pkgs, lib, runtimeModule, runtimeOverlay }:

# NixOS VM test proving the mottainai.linux-runtime.v1 surface: SSH service,
# mottainai-control identity, package/service availability, protected
# control paths, health response, and restart behavior
# (docs/linux-runtime-contract.md "Test layer"). Requires a Nix-capable
# pipeline (KVM-backed VM test runner); not executed by `pnpm verify`
# (ADR-0002 consequences).

pkgs.testers.nixosTest {
  name = "mottainai-linux-runtime-contract";

  nodes.runtime =
    { ... }:
    {
      imports = [ runtimeModule ];
      nixpkgs.overlays = [ runtimeOverlay ];
      mottainai.runtime = {
        enable = true;
        runtimeIdentity = "test-runtime";
        controlAuthorizedKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForRuntimeContract test" ];
      };
      # A second, blank virtual disk this test formats/labels/populates
      # itself to exercise the bounded first-boot SSH-key bootstrap input
      # (Issue #601) without touching the canonical disk image under test.
      environment.systemPackages = [ pkgs.e2fsprogs ];
      virtualisation.emptyDiskImages = [ 4 ];
    };

  testScript = ''
    start_all()
    runtime.wait_for_unit("multi-user.target")
    build_identity_before_bootstrap = runtime.succeed("readlink -f /run/current-system").strip()

    with subtest("sshd is active with password auth disabled"):
        runtime.wait_for_unit("sshd.service")
        runtime.succeed(
            "grep -q '^PasswordAuthentication no' /etc/ssh/sshd_config"
            " || sshd -T | grep -qi '^passwordauthentication no'"
        )

    with subtest("mottainai-control identity exists and owns its state dir"):
        runtime.succeed("id mottainai-control")
        runtime.succeed("grep -q 'AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForRuntimeContract' /etc/ssh/authorized_keys.d/mottainai-control")
        owner = runtime.succeed("stat -c '%U' /var/lib/mottainai-control").strip()
        assert owner == "mottainai-control", f"unexpected owner: {owner}"
        mode = runtime.succeed("stat -c '%a' /var/lib/mottainai-control").strip()
        assert mode == "700", f"control state dir must be 0700, got {mode}"

    with subtest("control state dir is not repository/world readable"):
        runtime.fail("su -s /bin/sh nobody -c 'ls /var/lib/mottainai-control'")

    with subtest("required packages are present"):
        runtime.succeed("command -v git")
        runtime.succeed("command -v bwrap")
        runtime.succeed("command -v mottainai-runtime-health")
        runtime.succeed("command -v mottainai-runtime-reconcile")

    with subtest("Mottainai, Nawabari, and Zellij binaries resolve and report versions"):
        runtime.succeed("mottainai --version")
        runtime.succeed("nawabari --version")
        runtime.succeed("zellij --version")

    with subtest("health/capability result is bounded JSON matching the contract"):
        runtime.succeed("systemctl start mottainai-runtime-health.service")
        output = runtime.succeed("journalctl -u mottainai-runtime-health.service -o cat -n 50")
        assert '"contractId": "mottainai.linux-runtime.v1"' in output
        assert '"schemaVersion": 1' in output
        assert '"generation": "' not in output, "generation must be numeric JSON, not a quoted string"
        assert "MOTTAINAI_" not in output.upper().replace("MOTTAINAI_RUNTIME_HEALTH", "")
        assert '"name":"nawabari"' in output
        assert '"present":true' in output

    with subtest("health service restarts cleanly"):
        runtime.succeed("systemctl restart mottainai-runtime-health.service")
        runtime.succeed(
            "systemctl is-active --quiet mottainai-runtime-health.service"
            " || systemctl show -p Result mottainai-runtime-health.service | grep -q Result=success"
        )

    # These bootstrap subtests hot-write a filesystem directly to an
    # already-attached block device against an already-running guest, which
    # does not by itself trigger udev to (re-)probe and publish
    # /dev/disk/by-label/MTNAI_BOOT — a real boot instead coldplugs an
    # already-labeled disk before this service starts, so the symlink is
    # already settled by then. A targeted `udevadm trigger --settle
    # /dev/vdb` was tried here first and did not reproduce that coldplug
    # probe (trigger's positional argument selects by /sys path, not a
    # /dev device node, so it silently matched nothing); a system-wide
    # `udevadm trigger --settle`, confirmed by explicitly waiting for the
    # symlink itself, is used instead after every rewrite of the bootstrap
    # disk's content below.
    #
    # These subtests also use `systemctl restart`, not `start`, on the
    # bootstrap service: it already ran once at real boot (the blank /dev/vdb
    # had no MTNAI_BOOT device yet, so it harmlessly no-op'd and exited 0),
    # leaving it "active (exited)" — `start` on an already-active
    # Type=oneshot + RemainAfterExit unit does not re-run ExecStart at all.
    # `restart` forces a fresh ConditionPathExists check and a fresh
    # ExecStart attempt every time, which is what exercising several
    # successive bootstrap-disk contents within one boot requires; a real
    # single boot only ever needs the one natural start.

    with subtest("a mixed valid/invalid input line rejects the whole bootstrap input, installing nothing"):
        runtime.succeed("mkfs.ext4 -L MTNAI_BOOT /dev/vdb")
        runtime.succeed("mkdir -p /mnt/bootstrap && mount /dev/vdb /mnt/bootstrap")
        runtime.succeed(
            "printf '%s\\n%s\\n'"
            " 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMixedValidKeyForRuntimeContract valid'"
            " 'this-is-not-a-valid-ssh-public-key-line'"
            " > /mnt/bootstrap/authorized_keys"
        )
        runtime.succeed("umount /mnt/bootstrap")
        runtime.succeed("udevadm trigger --settle")
        runtime.wait_until_succeeds("test -e /dev/disk/by-label/MTNAI_BOOT")
        runtime.fail("systemctl restart mottainai-runtime-bootstrap-authorized-keys.service")
        runtime.succeed("test ! -e /var/lib/mottainai-control/.ssh")

    with subtest("more than 16 valid keys rejects the whole bootstrap input instead of truncating"):
        runtime.succeed("mount /dev/vdb /mnt/bootstrap")
        too_many_keys = "\n".join(
            f"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITooManyKeysTest{i:02d} key{i}" for i in range(1, 18)
        )
        runtime.succeed(f"cat > /mnt/bootstrap/authorized_keys <<'KEYS_EOF'\n{too_many_keys}\nKEYS_EOF")
        runtime.succeed("umount /mnt/bootstrap")
        runtime.succeed("udevadm trigger --settle")
        runtime.wait_until_succeeds("test -e /dev/disk/by-label/MTNAI_BOOT")
        runtime.fail("systemctl restart mottainai-runtime-bootstrap-authorized-keys.service")
        runtime.succeed("test ! -e /var/lib/mottainai-control/.ssh")

    with subtest("bounded first-boot SSH key bootstrap installs every validated key into persistent state, not the canonical closure"):
        runtime.succeed("mount /dev/vdb /mnt/bootstrap")
        runtime.succeed(
            "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBootstrapTestKeyForRuntimeContract bootstrap'"
            " > /mnt/bootstrap/authorized_keys"
        )
        runtime.succeed("umount /mnt/bootstrap")
        runtime.succeed("udevadm trigger --settle")
        runtime.wait_until_succeeds("test -e /dev/disk/by-label/MTNAI_BOOT")
        runtime.succeed("systemctl restart mottainai-runtime-bootstrap-authorized-keys.service")
        runtime.succeed(
            "systemctl is-active --quiet mottainai-runtime-bootstrap-authorized-keys.service"
            " || systemctl show -p Result mottainai-runtime-bootstrap-authorized-keys.service | grep -q Result=success"
        )
        runtime.succeed(
            "grep -q 'AAAAC3NzaC1lZDI1NTE5AAAAIBootstrapTestKeyForRuntimeContract'"
            " /var/lib/mottainai-control/.ssh/authorized_keys"
        )
        mode = runtime.succeed("stat -c '%a' /var/lib/mottainai-control/.ssh/authorized_keys").strip()
        assert mode == "600", f"bootstrap authorized_keys must be 0600, got {mode}"
        dir_mode = runtime.succeed("stat -c '%a' /var/lib/mottainai-control/.ssh").strip()
        assert dir_mode == "700", f"bootstrap .ssh dir must be 0700, got {dir_mode}"
        runtime.succeed("sshd -T | grep -qi '\\.ssh/authorized_keys'")

    with subtest("re-running the bootstrap after a key already exists does not clobber later manual key management"):
        runtime.succeed(
            "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIManuallyAddedKeyForRuntimeContract manual'"
            " >> /var/lib/mottainai-control/.ssh/authorized_keys"
        )
        runtime.succeed("systemctl restart mottainai-runtime-bootstrap-authorized-keys.service")
        runtime.succeed(
            "grep -q 'AAAAC3NzaC1lZDI1NTE5AAAAIManuallyAddedKeyForRuntimeContract'"
            " /var/lib/mottainai-control/.ssh/authorized_keys"
        )

    with subtest("the canonical closure/build identity is unaffected by the bootstrap key installation"):
        after = runtime.succeed("readlink -f /run/current-system").strip()
        assert after == build_identity_before_bootstrap, (
            "installing a bootstrap SSH key must never rebuild or mutate the canonical system closure"
        )
  '';
}
