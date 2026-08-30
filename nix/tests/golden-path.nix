{ pkgs, lib, nixpkgs, mkManagedGeneration, runtimeModule, runtimeOverlay, source, nawabariPackage }:

# Deliberately wired into `nix/flake.nix` as `packages.<system>.golden-path-vm`,
# not `checks.<system>.*` (unlike every other file in this directory):
# `virtualisation.additionalPaths` below needs genV1/genV2/sourceV1/sourceV2
# actually realized to register them as valid in the guest's Nix store, and
# constructing a NixOS VM test's driver/boot-script config forces deep
# evaluation of the whole node closure (unlike an ordinary package, which
# `nix flake check`'s `--no-build` pass only checks shallowly, i.e.
# `type == "derivation"`, never forcing `.drvPath`). Both combined broke
# `nix flake check --no-build --all-systems` — CI's cheap universal gate —
# for the whole flake when this lived under `checks`, not just for this one
# check. `packages.<system>.*` gets the same shallow, safe treatment there
# that every other package in this flake already relies on.
#
# Issue #630's end-to-end Runtime Appliance golden path: the same canonical
# guest module nix/tests/runtime.nix already proves (mottainai.linux-runtime.v1),
# driven through one continuous, real, unmocked lifecycle across a real guest
# boot and reboot:
#
#   fresh appliance boot
#   -> BOOTSTRAP_READY with full Mottainai/Nawabari absent from base
#   -> provide canonical managed manifest
#   -> mottainai-bootstrap reconcile builds + activates managed generation v1
#      (Mottainai + Nawabari) -> MANAGED_READY
#   -> desired manifest changes only the managed Mottainai version
#   -> reconcile builds/activates generation v2 without touching the base
#      appliance system closure
#   -> guest reboot
#   -> desired/active state and MANAGED_READY survive
#   -> desired manifest reverts to the v1 identity, whose real build output
#      is deliberately broken before reconcile activates it -> deterministic
#      rollback to the prior known-good generation (v2)
#   -> a persistent-unmanaged sentinel under repositoryStateDir survives
#      reconciliation/reboot without ever being reported managed
#   -> an ephemeral sentinel under /tmp carries no persistence guarantee
#
# What is real and what is pre-realized (see docs/nix-runtime-golden-path.md
# "Automated end-to-end proof (#630)" for the full rationale):
#
# - Every activation/health/rollback/persistence step below runs the real,
#   unmodified Issue #628 `reconcileManagedRuntime` state machine
#   (src/runtime-contract/managed-runtime.ts) via the real
#   `mottainai-bootstrap reconcile` command (Issue #630), including a real
#   `nix build` subprocess and real execution of the built managed
#   binaries for health checking. Nothing about activation, health, or
#   rollback is mocked or weakened.
# - The two managed Mottainai source trees (v1 = this flake's own tracked
#   checkout, v2 = the same tree with only package.json's version field
#   changed) are built once at Nix-eval time via the same
#   `lib.mkManagedGeneration` projection nix/tests/managed-generation.nix
#   and nix/tests/runtime-appliance.nix already exercise, and shared into
#   the guest's read-only Nix store via `virtualisation.additionalPaths` —
#   the standard nixosTest idiom for giving a guest already-built,
#   content-addressed store objects without guest network access
#   (nixosTest VMs are not internet-connected by design; Issue #626's own
#   GitHub-tag source-resolution transport is exercised by its own
#   dedicated tests with an injected fetcher, not re-proven here). The
#   guest's own `nix build` invocation evaluates the identical expression
#   and finds the identical output already valid — a real command, real
#   cache hit, not a stub.
# - The "deliberately unhealthy generation" step is a real permission-denial
#   fault (`chmod 000`) injected directly into a real, freshly built store
#   path's binary — the health check that then fails is the exact same
#   real `mottainai-bootstrap reconcile` health probe every other step uses.
# - "status" checks below re-invoke `mottainai-bootstrap reconcile` against
#   the *unchanged* desired manifest rather than a separate read-only
#   command: docs/runtime-lifecycle.md's own no-op-reconcile definition
#   ("does not rebuild, switch, or rewrite state; may refresh bounded
#   health evidence") is exactly the read used to observe current state
#   here, and exercising that real no-op path is itself part of Issue
#   #628's acceptance criteria.

let
  inherit (pkgs) lib;

  mottainaiPackageJson = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  mottainaiVersionV1 = mottainaiPackageJson.version;
  mottainaiVersionV2 = "${mottainaiVersionV1}-golden-path-v2";
  nawabariVersion = nawabariPackage.version;

  # v1 is this flake's own tracked checkout — the same source
  # nix/tests/managed-generation.nix and nix/flake.nix's own
  # `packages.<system>.mottainai` already build from, so this pays no new
  # Nix-eval-time cost beyond what already happens elsewhere in this
  # checkout's own checks.
  sourceV1 = source;

  # v2 is a real, independently buildable source tree: the identical
  # tracked checkout with only package.json's version field changed, so it
  # goes through the exact same nix/mottainai.nix build recipe
  # (nativeBuildInputs, pnpm-lock.yaml, node-gyp rebuild) as v1 — a
  # faithful, minimal proxy for "a new Mottainai release", not a
  # from-scratch fixture.
  sourceV2 = pkgs.runCommand "mottainai-golden-path-source-v2"
    { nativeBuildInputs = [ pkgs.jq ]; }
    ''
      cp -a ${sourceV1} "$out"
      chmod -R u+w "$out"
      jq --arg version ${lib.escapeShellArg mottainaiVersionV2} '.version = $version' \
        "$out/package.json" > "$out/package.json.golden-path-tmp"
      mv "$out/package.json.golden-path-tmp" "$out/package.json"
    '';

  # This test never asks the TS verifySourceIntegrity check to validate
  # genV1/genV2 directly — these two host-eval-time Nix values exist only
  # to pre-realize real build output for the guest's own real `nix build`
  # (see `virtualisation.additionalPaths` below). The *guest-side*
  # manifests the test script writes carry the real, guest-computed
  # sourceSha256 (mirroring exactly what production bootstrap/reconcile
  # verifies), so `lib.fakeSha256` here is never checked against anything.
  # Mirrors testScript's own `golden_manifest` package list exactly
  # (mottainai + nawabari) — the guest's real `mottainai-bootstrap
  # reconcile` builds its candidate generation as one buildEnv over BOTH
  # packages, so genV1.generation/genV2.generation below must be built from
  # the identical package set to land on the exact same store path the
  # guest activates (buildEnv's hash depends on its full `paths` list, not
  # just the mottainai entry). sourceSha256 itself does not affect
  # `generation`'s hash (only resolveEntry's version match does), so the
  # placeholder here is fine even though the guest computes a real one.
  mkGoldenManifest = { mottainaiVersion }: {
    contractId = "mottainai.managed-package-manifest.v1";
    schemaVersion = 1;
    activation.generation = 1;
    packages = [
      {
        packageId = "mottainai";
        kind = "nix-flake-package";
        version = mottainaiVersion;
        source = {
          flakeRef = "nix#mottainai";
          sourceSha256 = lib.fakeSha256;
        };
      }
      {
        packageId = "nawabari";
        kind = "nix-flake-package";
        version = nawabariVersion;
        source = {
          flakeRef = "nix/packages/nawabari.nix";
          sourceSha256 = lib.fakeSha256;
        };
      }
    ];
  };

  genV1 = mkManagedGeneration {
    system = pkgs.stdenv.hostPlatform.system;
    manifest = mkGoldenManifest { mottainaiVersion = mottainaiVersionV1; };
    mottainaiSource = sourceV1;
  };

  genV2 = mkManagedGeneration {
    system = pkgs.stdenv.hostPlatform.system;
    manifest = mkGoldenManifest { mottainaiVersion = mottainaiVersionV2; };
    mottainaiSource = sourceV2;
  };

  # Realize every store object the guest's own real `nix build`
  # (mottainai-bootstrap reconcile -> buildManagedGeneration) needs to find
  # already valid: the raw source trees (evaluated as the `mottainaiSource`
  # Nix path argument) and the full managed-generation build outputs
  # (buildEnv + metadataFile, which transitively realize the Mottainai and
  # Nawabari package derivations themselves).
  sharedGuestPaths = [
    sourceV1
    sourceV2
    genV1.generation
    genV1.metadataFile
    genV2.generation
    genV2.metadataFile
    nawabariPackage
    # The packaged mottainai-bootstrap CLI's embedded nix-projection
    # (nix/bootstrap.nix's installPhase) carries its own copy of
    # nix/flake.lock, locked to this exact nixpkgs input. Its own
    # `builtins.getFlake` call (managed-generation-build.ts) must resolve
    # that input without guest network access; sharing the identical,
    # already-fetched nixpkgs source tree by content (narHash) lets Nix
    # satisfy it locally instead of fetching from github.com.
    nixpkgs.outPath
  ];

  systemString = pkgs.stdenv.hostPlatform.system;
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
        runtimeIdentity = "golden-path-appliance";
        controlAuthorizedKeys = [ ];
      };
      virtualisation.additionalPaths = sharedGuestPaths;
      virtualisation.diskSize = 4096;
    };

  testScript = ''
    import shlex

    def run_as_control(command):
        return golden.succeed("su -l mottainai-control -c " + shlex.quote(command))

    def reconcile(mottainai_source_tree):
        return run_as_control(
            "mottainai-bootstrap reconcile --system ${systemString} --mottainai-source "
            + mottainai_source_tree
            + " --json"
        )

    def reconcile_expect_failure(mottainai_source_tree):
        return golden.fail(
            "su -l mottainai-control -c "
            + shlex.quote(
                "mottainai-bootstrap reconcile --system ${systemString} --mottainai-source "
                + mottainai_source_tree
                + " --json"
            )
        )

    def nar_hash_of(store_path):
        sri = golden.succeed(
            # --json-format 2 nests results under "info" keyed by store path
            # (matching src/runtime-contract/managed-generation-build.ts's
            # own narHashOfFactory: `pathInfo.info`, then Object.values),
            # not a plain top-level array.
            "nix path-info --json --json-format 2 " + store_path + " | jq -r '.info[].narHash'"
        ).strip()
        expr = 'builtins.convertHash { hash = "' + sri + '"; hashAlgo = "sha256"; toHashFormat = "base16"; }'
        return golden.succeed("nix eval --raw --expr " + shlex.quote(expr)).strip()

    def golden_manifest(mottainai_version, mottainai_sha, nawabari_sha, generation):
        return (
            '{\n'
            '  "contractId": "mottainai.managed-package-manifest.v1",\n'
            '  "schemaVersion": 1,\n'
            '  "activation": { "generation": ' + str(generation) + ' },\n'
            '  "packages": [\n'
            '    {\n'
            '      "packageId": "mottainai",\n'
            '      "kind": "nix-flake-package",\n'
            '      "version": "' + mottainai_version + '",\n'
            '      "source": { "flakeRef": "nix#mottainai", "sourceSha256": "' + mottainai_sha + '" }\n'
            '    },\n'
            '    {\n'
            '      "packageId": "nawabari",\n'
            '      "kind": "nix-flake-package",\n'
            '      "version": "${nawabariVersion}",\n'
            '      "source": { "flakeRef": "nix/packages/nawabari.nix", "sourceSha256": "' + nawabari_sha + '" }\n'
            '    }\n'
            '  ]\n'
            '}\n'
        )

    def apply_manifest(text):
        golden.succeed(
            "install -d -m 0700 -o mottainai-control -g mottainai-control /var/lib/mottainai-control/managed-packages"
        )
        golden.succeed(
            "cat > /var/lib/mottainai-control/managed-packages/manifest.json <<'MOTTAINAI_GOLDEN_PATH_MANIFEST_EOF'\n"
            + text
            + "MOTTAINAI_GOLDEN_PATH_MANIFEST_EOF"
        )
        golden.succeed(
            "chown mottainai-control:mottainai-control /var/lib/mottainai-control/managed-packages/manifest.json"
        )

    golden.start(allow_reboot=True)
    golden.wait_for_unit("multi-user.target")
    golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
    base_build_identity = golden.succeed("readlink -f /run/current-system").strip()

    with subtest("fresh appliance reaches bootstrap-ready with full Mottainai/Nawabari absent from base"):
        golden.fail("command -v mottainai")
        golden.fail("command -v nawabari")
        health = golden.succeed("mottainai-runtime-health")
        assert '"readiness": "bootstrap-ready"' in health
        assert '"bootstrapReady": true' in health
        assert '"managedRuntimeReady": false' in health
        bootstrap_status = run_as_control("mottainai-bootstrap status --json")
        assert '"present": false' in bootstrap_status

    with subtest("compute the real, guest-observed sourceSha256 for the pre-realized v1/v2 source trees"):
        mottainai_source_sha256_v1 = nar_hash_of("${sourceV1}")
        mottainai_source_sha256_v2 = nar_hash_of("${sourceV2}")
        nawabari_source_sha256 = nar_hash_of("${nawabariPackage.src}")
        assert len(mottainai_source_sha256_v1) == 64
        assert len(mottainai_source_sha256_v2) == 64
        assert mottainai_source_sha256_v1 != mottainai_source_sha256_v2

    with subtest("provide the canonical managed manifest and reconcile: build + activate generation v1 (Mottainai + Nawabari)"):
        apply_manifest(
            golden_manifest("${mottainaiVersionV1}", mottainai_source_sha256_v1, nawabari_source_sha256, 1)
        )
        reconcile_v1 = reconcile("${sourceV1}")
        assert '"outcome": "initialized"' in reconcile_v1

    with subtest("managed-runtime-ready: activated generation v1 reports healthy identities distinct from the base appliance"):
        current_v1 = golden.succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        golden.succeed("test -x " + current_v1 + "/bin/mottainai")
        golden.succeed("test -x " + current_v1 + "/bin/nawabari")
        assert golden.succeed(current_v1 + "/bin/mottainai --version").strip() == "${mottainaiVersionV1}"
        assert golden.succeed(current_v1 + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        health_after_v1 = golden.succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_v1
        assert '"managedRuntimeReady": true' in health_after_v1
        after_v1_build_identity = golden.succeed("readlink -f /run/current-system").strip()
        assert after_v1_build_identity == base_build_identity, (
            "activating the first managed generation must never rebuild the base appliance system closure"
        )

    with subtest("change only the managed Mottainai version: reconcile builds/activates generation v2 without touching the base appliance"):
        apply_manifest(
            golden_manifest("${mottainaiVersionV2}", mottainai_source_sha256_v2, nawabari_source_sha256, 2)
        )
        reconcile_v2 = reconcile("${sourceV2}")
        assert '"outcome": "updated"' in reconcile_v2
        current_v2 = golden.succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_v2 != current_v1, "the version-only update must activate a distinct managed generation store path"
        assert golden.succeed(current_v2 + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        after_v2_build_identity = golden.succeed("readlink -f /run/current-system").strip()
        assert after_v2_build_identity == base_build_identity, (
            "a managed Mottainai-version-only update must never rebuild the base appliance system closure"
        )

    with subtest("persistent-unmanaged and ephemeral sentinels, established before the reboot"):
        golden.succeed(
            "install -d -m 0755 -o root -g root /var/lib/mottainai/repositories/golden-path-sentinel-repo"
        )
        golden.succeed(
            "printf 'persistent-unmanaged-sentinel\\n'"
            " > /var/lib/mottainai/repositories/golden-path-sentinel-repo/UNMANAGED_MARKER"
        )
        golden.succeed("printf 'ephemeral-sentinel\\n' > /tmp/golden-path-ephemeral-sentinel")

    with subtest("VM restart preserves desired/active managed-runtime state and MANAGED_READY"):
        golden.succeed("sync")
        golden.reboot()
        golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
        after_reboot_build_identity = golden.succeed("readlink -f /run/current-system").strip()
        assert after_reboot_build_identity == base_build_identity
        current_after_reboot = golden.succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_after_reboot == current_v2, (
            "the active managed generation pointer must survive a guest reboot unchanged"
        )
        assert golden.succeed(current_after_reboot + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        health_after_reboot = golden.succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_reboot
        assert '"managedRuntimeReady": true' in health_after_reboot
        reconcile_after_reboot = reconcile("${sourceV2}")
        assert '"outcome": "noop"' in reconcile_after_reboot

    with subtest("persistent-unmanaged sentinel survives reconciliation and reboot without being reported managed"):
        golden.succeed(
            "grep -qx 'persistent-unmanaged-sentinel'"
            " /var/lib/mottainai/repositories/golden-path-sentinel-repo/UNMANAGED_MARKER"
        )
        bootstrap_status_after_reboot = run_as_control("mottainai-bootstrap status --json")
        assert "golden-path-sentinel-repo" not in bootstrap_status_after_reboot
        assert "UNMANAGED_MARKER" not in bootstrap_status_after_reboot
        assert "golden-path-sentinel-repo" not in reconcile_after_reboot
        assert "UNMANAGED_MARKER" not in reconcile_after_reboot

    with subtest("ephemeral sentinel carries no persistence guarantee (documented semantics recorded, not asserted either way)"):
        # /tmp is not one of the Runtime's persistent state owners
        # (nix/modules/runtime.nix systemStatePaths / repositoryUserStatePaths
        # — see docs/runtime-state.md's persistence matrix, "ephemeral/cache/temp:
        # Not guaranteed"). This only records what actually happened to it
        # across the reboot above; it never asserts either outcome as a
        # requirement, matching that documented "no guarantee" semantics.
        ephemeral_status, ephemeral_output = golden.execute("cat /tmp/golden-path-ephemeral-sentinel")
        print("ephemeral sentinel after reboot (no persistence guaranteed) exit=" + str(ephemeral_status) + " output=" + ephemeral_output)

    with subtest("force a deliberately unhealthy next generation: real permission-denial fault on a freshly built candidate"):
        # Re-declaring the v1 identity as desired is a genuine semantic
        # change from the currently active v2 — a real new activation
        # transaction, not a no-op. mottainai-bootstrap reconcile's real
        # buildGeneration step resolves it back to v1's already-realized,
        # otherwise perfectly healthy store output; the test then breaks
        # that real store path with a real permission-denial fault
        # *before* reconcile runs, so the exact same real health probe
        # every step above used now genuinely fails.
        apply_manifest(
            golden_manifest("${mottainaiVersionV1}", mottainai_source_sha256_v1, nawabari_source_sha256, 3)
        )
        golden.succeed("chmod 000 $(readlink -f ${genV1.generation}/bin/mottainai)")
        reconcile_expect_failure("${sourceV1}")

    with subtest("deterministic rollback to the prior known-good generation (v2)"):
        current_after_rollback = golden.succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_after_rollback == current_v2, (
            "a post-switch health failure must restore the prior known-good generation, not remain on the broken candidate"
        )
        assert golden.succeed(current_after_rollback + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        health_after_rollback = golden.succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_rollback
        assert '"managedRuntimeReady": true' in health_after_rollback

    with subtest("bounded machine-readable evidence: appliance identity, bootstrap contract, and generation identities"):
        evidence_health = golden.succeed("mottainai-runtime-health")
        assert '"contractId": "mottainai.linux-runtime.v1"' in evidence_health
        assert '"runtimeIdentity": "golden-path-appliance"' in evidence_health
        assert '"buildIdentity": "' + base_build_identity + '"' in evidence_health
        evidence_reconcile = reconcile("${sourceV2}")
        assert '"outcome": "noop"' in evidence_reconcile
        assert '"generationIdentity"' in evidence_reconcile
        print("=== bounded golden-path evidence: mottainai-runtime-health ===")
        print(evidence_health)
        print("=== bounded golden-path evidence: mottainai-bootstrap reconcile (final no-op) ===")
        print(evidence_reconcile)
  '';
}
