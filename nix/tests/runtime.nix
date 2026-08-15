{ pkgs, lib, runtimeModule }:

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
      mottainai.runtime = {
        enable = true;
        runtimeIdentity = "test-runtime";
      };
    };

  testScript = ''
    start_all()
    runtime.wait_for_unit("multi-user.target")

    with subtest("sshd is active with password auth disabled"):
        runtime.wait_for_unit("sshd.service")
        runtime.succeed(
            "grep -q '^PasswordAuthentication no' /etc/ssh/sshd_config"
            " || sshd -T | grep -qi '^passwordauthentication no'"
        )

    with subtest("mottainai-control identity exists and owns its state dir"):
        runtime.succeed("id mottainai-control")
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

    with subtest("health/capability result is bounded JSON matching the contract"):
        runtime.succeed("systemctl start mottainai-runtime-health.service")
        output = runtime.succeed("journalctl -u mottainai-runtime-health.service -o cat -n 50")
        assert '"contractId": "mottainai.linux-runtime.v1"' in output
        assert '"schemaVersion": 1' in output
        assert '"generation": "' not in output, "generation must be numeric JSON, not a quoted string"
        assert "MOTTAINAI_" not in output.upper().replace("MOTTAINAI_RUNTIME_HEALTH", "")

    with subtest("health service restarts cleanly"):
        runtime.succeed("systemctl restart mottainai-runtime-health.service")
        runtime.succeed(
            "systemctl is-active --quiet mottainai-runtime-health.service"
            " || systemctl show -p Result mottainai-runtime-health.service | grep -q Result=success"
        )
  '';
}
