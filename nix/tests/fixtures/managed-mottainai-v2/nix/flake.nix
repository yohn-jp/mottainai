{
  description = "Issue #703 repository-owned managed Mottainai fixture source (version 2.0.0)";

  # Deliberately no inputs and no coreutils/bash of any kind: this fixture
  # must build with no compilation and no network access, and this guest's
  # bash/coreutils closures have proven not to be self-contained enough for
  # the sandboxed builder to use directly (missing PATH entries, symlinked
  # /run/current-system paths outside the sandbox, and — once given real
  # Nix store context — a bash closure that itself pulled in a stdenv
  # bootstrap rebuild the guest has no network path to complete). Node.js
  # is the one guest-present executable this whole reconcile flow already
  # depends on and runs successfully (the very process executing this
  # build), so this fixture uses it as its builder and does every
  # filesystem operation through Node's own fs API — no mkdir/sed/chmod/sh
  # subprocess at all. MOTTAINAI_FIXTURE_NODE is set by
  # nix/tests/runtime-appliance-golden-path.nix from this exact guest's
  # own packaged bootstrap CLI wrapper (the same store path the driver
  # script itself already runs on), via the impure build environment
  # (builtins.getEnv, under the same --impure evaluation the production
  # build already requires).
  outputs =
    { self }:
    let
      version = "2.0.0";
      # builtins.storePath (not a plain string) so this evaluates with
      # real Nix store context: a plain builtins.getEnv string has no
      # context, so the sandboxed builder would never see it as a build
      # dependency and the Nix sandbox would never mount it, even though
      # the path itself is genuinely present on this guest.
      nodePath = builtins.storePath (builtins.getEnv "MOTTAINAI_FIXTURE_NODE");
      script = ''
        const fs = require("fs");
        const path = require("path");
        const binDir = path.join(process.env.out, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const lines = [
          "#!/bin/sh",
          "if [ \"$#\" -eq 1 ] && [ \"$1\" = \"--version\" ]; then",
          "  printf '%s\\n' \"${version}\"",
          "  exit 0",
          "fi",
          "echo \"mottainai: unsupported argument\" >&2",
          "exit 1",
          "",
        ];
        fs.writeFileSync(path.join(binDir, "mottainai"), lines.join("\n"), { mode: 0o755 });
      '';
      # `src` is added onto the derivation's own result attrset (not passed
      # as a derivation input, so it is never a build dependency the
      # sandboxed builder above needs) so `nix/managed-generation.nix`'s
      # `sourceStorePath` projection (every resolved entry's `${r.drv.src}`)
      # can report the exact fixture source tree this build resolved from —
      # `../.` here is this flake.nix file's own parent directory, i.e. the
      # fixture root containing package.json, the same relative-path
      # pattern nix/flake.nix's `mkMottainai = pkgs: import ./mottainai.nix
      # { inherit pkgs; source = ../.; };` already uses to resolve HEAD's
      # own Mottainai source tree from its own nix/flake.nix.
      mkMottainai =
        system:
        derivation {
          name = "mottainai-${version}";
          inherit system version;
          builder = "${nodePath}";
          args = [ "-e" script ];
        } // { src = ../.; };
    in
    {
      packages.x86_64-linux.mottainai = mkMottainai "x86_64-linux";
      packages.aarch64-linux.mottainai = mkMottainai "aarch64-linux";
    };
}
