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

  # --repo-root only needs to locate nix/flake.nix so
  # buildManagedGeneration (managed-generation-build.ts) can resolve
  # `flake.lib.mkManagedGeneration` via `builtins.getFlake`; it never
  # affects genV1/genV2's own derivation identity below, since
  # `mottainaiSource` is supplied to that function independently via
  # --mottainai-source. Passing sourceV1 directly as --repo-root hit a real
  # CI failure ("path '.../nix/flake.nix' does not exist", naming a
  # different, truncated store path than the one actually passed in) for
  # exactly the reason nix/bootstrap.nix's own installPhase comment
  # documents: `builtins.getFlake` requires its target to be a git (or
  # other supported VCS) working tree to resolve `?dir=nix` as a flake — a
  # plain `cp -a` of sourceV1 is not one (sourceV1 itself, this flake's own
  # git-fetched checkout content, does not carry its own `.git`), so
  # `getFlake` fell back to some other, buggy resolution. git-init this
  # copy exactly the way nix/bootstrap.nix's installPhase git-inits its own
  # packaged nix-projection copy for the identical reason.
  repoRootForGuest = pkgs.runCommand "golden-path-repo-root"
    { nativeBuildInputs = [ pkgs.git ]; }
    ''
      cp -a ${sourceV1} "$out"
      chmod -R u+w "$out"
      (
        cd "$out"
        export HOME="$TMPDIR/git-home-for-golden-path-repo-root"
        mkdir -p "$HOME"
        git init --quiet
        git -c user.email=golden-path@localhost -c user.name=golden-path add -A
        git -c user.email=golden-path@localhost -c user.name=golden-path commit --quiet -m "golden-path repo-root snapshot"
      )
    '';

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
    repoRootForGuest
    genV1.generation
    genV1.metadataFile
    genV2.generation
    genV2.metadataFile
    nawabariPackage
    # Runtime closures alone are not enough: mottainai's own build needs a
    # native-module toolchain (node-gyp's Python, make, ...) that is a
    # *build-time* input of the mottainai/managed-generation derivations,
    # never referenced by their *output* closure. Sharing each .drv path
    # too (not just the built output) additionally shares that full build
    # closure, so the guest's own real `nix build` (a separate evaluation
    # of the embedded nix-projection flake, not literally `self`) never
    # needs network even on a cache miss for the top-level derivation
    # itself.
    genV1.generation.drvPath
    genV1.metadataFile.drvPath
    genV2.generation.drvPath
    genV2.metadataFile.drvPath
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

  goldenPathTest = pkgs.testers.nixosTest {
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
    import binascii
    import json
    import shlex
    import time

    # The nixosTest Python driver captures every machine.succeed/fail/execute
    # command's output as a single newline-delimited base64 block read back
    # over the guest's backdoor console. On a slow (non-KVM-accelerated or
    # otherwise loaded) run, something occasionally interleaves with that
    # block — observed even on a short, few-byte read, so this is a
    # driver/console race rather than anything specific to the size of a
    # given command's output — and the read raises `binascii.Error: Invalid
    # base64-encoded string`. succeed/fail/execute below wrap the driver's
    # own methods (aliased before the wrapping so they keep working) with a
    # bounded retry on exactly that error. Retrying is safe here: every
    # command this golden path issues is either read-only or itself
    # idempotent against re-invocation with the same inputs
    # (`mottainai-bootstrap reconcile`'s #628 reconcileManagedRuntime state
    # machine included).
    _golden_succeed = getattr(golden, "succeed")
    _golden_fail = getattr(golden, "fail")
    _golden_execute = getattr(golden, "execute")

    def _resilient(call, attempts=3, delay_seconds=2):
        for attempt in range(1, attempts + 1):
            try:
                return call()
            except binascii.Error as exc:
                print(
                    "console command-capture race (attempt "
                    + str(attempt)
                    + "/"
                    + str(attempts)
                    + "): "
                    + str(exc)
                )
                if attempt == attempts:
                    raise
                time.sleep(delay_seconds)
        assert False, "unreachable: the loop above always returns or raises"

    def succeed(command):
        return _resilient(lambda: _golden_succeed(command))

    def fail(command):
        return _resilient(lambda: _golden_fail(command))

    def execute(command):
        return _resilient(lambda: _golden_execute(command))

    def run_as_control(command):
        return succeed("su -l mottainai-control -c " + shlex.quote(command))

    # `mottainai-bootstrap reconcile` embeds the *entire* captured nix build
    # error text verbatim into its JSON error output on failure, which can
    # run to several KB with embedded newlines — worth keeping out of the
    # driver's single-block capture regardless of the retry above, since a
    # huge blob only makes that race more likely to bite and makes any real
    # failure output far harder to read in CI logs anyway. Route the
    # command's own stdout/stderr to a file inside the guest instead, then
    # read back only a bounded prefix, preserving the real exit code via
    # `exit $ec`.
    def run_as_control_bounded(command, expect_success, max_bytes=8000):
        log_path = "/tmp/mottainai-golden-path-cmd.log"
        wrapped = (
            command
            + " > "
            + log_path
            + " 2>&1; ec=$?; head -c "
            + str(max_bytes)
            + " "
            + log_path
            + "; exit $ec"
        )
        runner = succeed if expect_success else fail
        return runner("su -l mottainai-control -c " + shlex.quote(wrapped))

    # --repo-root points at repoRootForGuest, a plain re-copy of this exact
    # repository checkout (see its own comment above for why a copy rather
    # than sourceV1/source directly), rather than the packaged
    # mottainai-bootstrap CLI's own embedded nix-projection copy
    # (nix/bootstrap.nix's installPhase re-git-inits a *separate* tree).
    # Real production/manual use relies on that embedded copy precisely so
    # a fresh Appliance with no repository checkout can still resolve
    # nix/flake.nix (its own dedicated coverage: nix/tests/bootstrap.nix);
    # this golden path's job is Issue #628's activation/health/rollback
    # lifecycle, not re-proving #626's packaging in isolation. Evaluating
    # the *identical* nix/ directory genV1/genV2 were themselves built
    # from (repoRootForGuest is a byte-identical copy of the same source
    # genV1/genV2 build from, just under a different store path name)
    # guarantees the guest's real `nix build` computes the exact same
    # derivation as the host's, landing on the pre-realized cache hit
    # instead of attempting a network-dependent rebuild with no network.
    def reconcile(mottainai_source_tree):
        return run_as_control_bounded(
            "mottainai-bootstrap reconcile --system ${systemString} --repo-root ${repoRootForGuest} --mottainai-source "
            + mottainai_source_tree
            + " --json",
            expect_success=True,
        )

    def reconcile_expect_failure(mottainai_source_tree):
        return run_as_control_bounded(
            "mottainai-bootstrap reconcile --system ${systemString} --repo-root ${repoRootForGuest} --mottainai-source "
            + mottainai_source_tree
            + " --json",
            expect_success=False,
        )

    def nar_hash_of(store_path):
        sri = succeed(
            # --json-format 2 nests results under "info" keyed by store path
            # (matching src/runtime-contract/managed-generation-build.ts's
            # own narHashOfFactory: `pathInfo.info`, then Object.values),
            # not a plain top-level array.
            "nix path-info --json --json-format 2 " + store_path + " | jq -r '.info[].narHash'"
        ).strip()
        expr = 'builtins.convertHash { hash = "' + sri + '"; hashAlgo = "sha256"; toHashFormat = "base16"; }'
        return succeed("nix eval --raw --expr " + shlex.quote(expr)).strip()

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
        succeed(
            "install -d -m 0700 -o mottainai-control -g mottainai-control /var/lib/mottainai-control/managed-packages"
        )
        succeed(
            "cat > /var/lib/mottainai-control/managed-packages/manifest.json <<'MOTTAINAI_GOLDEN_PATH_MANIFEST_EOF'\n"
            + text
            + "MOTTAINAI_GOLDEN_PATH_MANIFEST_EOF"
        )
        succeed(
            "chown mottainai-control:mottainai-control /var/lib/mottainai-control/managed-packages/manifest.json"
        )

    golden.start(allow_reboot=True)
    golden.wait_for_unit("multi-user.target")
    golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
    base_build_identity = succeed("readlink -f /run/current-system").strip()

    with subtest("fresh appliance reaches bootstrap-ready with full Mottainai/Nawabari absent from base"):
        fail("command -v mottainai")
        fail("command -v nawabari")
        health = succeed("mottainai-runtime-health")
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

    with subtest("diagnostic: isolate builtins.getFlake's own resolution of repoRootForGuest with verbose Nix fetcher logging"):
        # Temporary diagnostic (not part of #630's lifecycle proof): every
        # prior fix attempt (renaming the store path, git-init'ing it) has
        # failed to change the "path .../nix/flake.nix does not exist"
        # error, and --show-trace added nothing beyond confirming the error
        # is thrown directly inside the getFlake builtin itself, with no
        # further Nix-expression-level stack beneath it. -vvv exposes the
        # fetcher's own internal resolution steps (registry lookups,
        # canonicalization, what it decides to fetch and from where).
        #
        # nixosTest's own driver never streams output live to the CI log —
        # on a build failure, Nix's error reporting only shows the LAST ~25
        # lines of the whole builder's output, so a plain print() here was
        # silently pushed out of that window by the real reconcile
        # subtest's own output a few steps later (confirmed: it never
        # appeared in a real CI failure). Force *this* command itself to
        # fail (`exit 1`) so `succeed()` raises immediately, right here,
        # with this diagnostic's own filtered output as the last thing the
        # builder printed — guaranteeing it lands inside that 25-line
        # window instead of getting buried.
        # First pass (5e011b1/8ecc424) showed Nix computing a brand-new lock
        # file for this flake instead of trusting the flake.lock already
        # copied into it ("computing lock file node" for the empty-string
        # root name, then "new lock file: { ... }") — nix's ~25-line CI
        # display cut off before the "root" node's own recorded url/type
        # ever came through. Extract exactly that block (the 16 lines
        # starting at "computing lock file node" for the empty-string root
        # name) plus the final error line, instead of a broad grep, so the
        # one thing actually still missing fits within the visible window
        # this time.
        diag_inner = (
            "nix eval --impure --offline -vvv --expr "
            + shlex.quote(
                '(builtins.getFlake (toString "${repoRootForGuest}" + "?dir=nix")).lib ? mkManagedGeneration'
            )
            + " > /tmp/golden-path-diag.log 2>&1; "
            + "echo '=== root node lock computation ==='; "
            + "grep -A 16 "
            + shlex.quote("computing lock file node " + "'" + "'")
            + " /tmp/golden-path-diag.log | head -n 16; "
            + "echo '=== final error ==='; "
            + "tail -n 4 /tmp/golden-path-diag.log; "
            + "exit 1"
        )
        succeed("su -l mottainai-control -c " + shlex.quote(diag_inner))

    with subtest("provide the canonical managed manifest and reconcile: build + activate generation v1 (Mottainai + Nawabari)"):
        apply_manifest(
            golden_manifest("${mottainaiVersionV1}", mottainai_source_sha256_v1, nawabari_source_sha256, 1)
        )
        reconcile_v1 = reconcile("${sourceV1}")
        assert '"outcome": "initialized"' in reconcile_v1

    with subtest("managed-runtime-ready: activated generation v1 reports healthy identities distinct from the base appliance"):
        current_v1 = succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        succeed("test -x " + current_v1 + "/bin/mottainai")
        succeed("test -x " + current_v1 + "/bin/nawabari")
        assert succeed(current_v1 + "/bin/mottainai --version").strip() == "${mottainaiVersionV1}"
        assert succeed(current_v1 + "/bin/nawabari --version").strip() == "${nawabariVersion}"
        health_after_v1 = succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_v1
        assert '"managedRuntimeReady": true' in health_after_v1
        after_v1_build_identity = succeed("readlink -f /run/current-system").strip()
        assert after_v1_build_identity == base_build_identity, (
            "activating the first managed generation must never rebuild the base appliance system closure"
        )

    with subtest("change only the managed Mottainai version: reconcile builds/activates generation v2 without touching the base appliance"):
        apply_manifest(
            golden_manifest("${mottainaiVersionV2}", mottainai_source_sha256_v2, nawabari_source_sha256, 2)
        )
        reconcile_v2 = reconcile("${sourceV2}")
        assert '"outcome": "updated"' in reconcile_v2
        current_v2 = succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_v2 != current_v1, "the version-only update must activate a distinct managed generation store path"
        assert succeed(current_v2 + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        after_v2_build_identity = succeed("readlink -f /run/current-system").strip()
        assert after_v2_build_identity == base_build_identity, (
            "a managed Mottainai-version-only update must never rebuild the base appliance system closure"
        )

    with subtest("persistent-unmanaged and ephemeral sentinels, established before the reboot"):
        succeed(
            "install -d -m 0755 -o root -g root /var/lib/mottainai/repositories/golden-path-sentinel-repo"
        )
        succeed(
            "printf 'persistent-unmanaged-sentinel\\n'"
            " > /var/lib/mottainai/repositories/golden-path-sentinel-repo/UNMANAGED_MARKER"
        )
        succeed("printf 'ephemeral-sentinel\\n' > /tmp/golden-path-ephemeral-sentinel")

    with subtest("VM restart preserves desired/active managed-runtime state and MANAGED_READY"):
        succeed("sync")
        golden.reboot()
        golden.wait_for_unit("mottainai-runtime-bootstrap-ready.service")
        after_reboot_build_identity = succeed("readlink -f /run/current-system").strip()
        assert after_reboot_build_identity == base_build_identity
        current_after_reboot = succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_after_reboot == current_v2, (
            "the active managed generation pointer must survive a guest reboot unchanged"
        )
        assert succeed(current_after_reboot + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        health_after_reboot = succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_reboot
        assert '"managedRuntimeReady": true' in health_after_reboot
        reconcile_after_reboot = reconcile("${sourceV2}")
        assert '"outcome": "noop"' in reconcile_after_reboot

    with subtest("persistent-unmanaged sentinel survives reconciliation and reboot without being reported managed"):
        succeed(
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
        ephemeral_status, ephemeral_output = execute("cat /tmp/golden-path-ephemeral-sentinel")
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
        succeed("chmod 000 $(readlink -f ${genV1.generation}/bin/mottainai)")
        reconcile_expect_failure("${sourceV1}")

    with subtest("deterministic rollback to the prior known-good generation (v2)"):
        current_after_rollback = succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_after_rollback == current_v2, (
            "a post-switch health failure must restore the prior known-good generation, not remain on the broken candidate"
        )
        assert succeed(current_after_rollback + "/bin/mottainai --version").strip() == "${mottainaiVersionV2}"
        health_after_rollback = succeed("mottainai-runtime-health")
        assert '"readiness": "managed-runtime-ready"' in health_after_rollback
        assert '"managedRuntimeReady": true' in health_after_rollback

    with subtest("post-rollback state: active/current restored to v2 while the persisted desired identity correctly still reflects the failed v1 attempt (#628 rollback semantics)"):
        # reconcileManagedRuntime's rollback path (managed-runtime.ts
        # selectPreviousAndVerify) restores `active`/`current` to the prior
        # known-good generation, but deliberately does not also rewind the
        # top-level `desiredManifestSemanticIdentity` back to that
        # generation's identity — the failed candidate's desired identity is
        # exactly what was requested, and rollback only undoes the
        # unsuccessful *activation*, not the request itself. Read the
        # persisted state directly here (no reconcile call): the manifest on
        # disk still declares v1/generation 3, so a reconcile at this point
        # is a real recovery transaction, never a no-op — asserted in the
        # next subtest instead of here.
        state_after_rollback = json.loads(
            succeed("cat /var/lib/mottainai-control/managed-runtime/state.json")
        )
        active_after_rollback = state_after_rollback["active"]
        assert active_after_rollback["storePath"] == current_after_rollback
        assert active_after_rollback["health"]["state"] == "healthy"
        assert (
            state_after_rollback["desiredManifestSemanticIdentity"]
            != active_after_rollback["desiredManifestSemanticIdentity"]
        ), (
            "desired and active identities must diverge after a rollback: the"
            " persisted desired identity is the failed v1 attempt, never"
            " silently reset to the restored generation's identity"
        )
        failure_after_rollback = state_after_rollback["failure"]
        assert failure_after_rollback["code"] == "health_failure"
        assert failure_after_rollback["storePath"] == "${genV1.generation}", (
            "retained failure evidence must pin to the exact broken v1 candidate, not a generic error"
        )

    with subtest("recover the desired state to v2: reconcile updates back to the known-good identity (outcome is 'updated', not 'noop', since desired only just caught up with active)"):
        apply_manifest(
            golden_manifest("${mottainaiVersionV2}", mottainai_source_sha256_v2, nawabari_source_sha256, 4)
        )
        reconcile_after_recovery = reconcile("${sourceV2}")
        assert '"outcome": "updated"' in reconcile_after_recovery, (
            "the first reconcile after re-declaring v2 as desired must still"
            " go through a real build+switch transaction: the persisted"
            " desired identity only just caught up with the already-active"
            " generation, so this cannot be a no-op"
        )
        current_after_recovery = succeed("readlink -f /var/lib/mottainai-control/managed-runtime/current").strip()
        assert current_after_recovery == current_v2

    with subtest("bounded machine-readable evidence: appliance identity, bootstrap contract, and generation identities"):
        evidence_health = succeed("mottainai-runtime-health")
        assert '"contractId": "mottainai.linux-runtime.v1"' in evidence_health
        assert '"runtimeIdentity": "golden-path-appliance"' in evidence_health
        assert '"buildIdentity": "' + base_build_identity + '"' in evidence_health
        # Desired and active identities are now equal (the prior subtest
        # brought the persisted desired identity back in line with v2), so
        # this repeat call with the same manifest is a genuine no-op.
        evidence_reconcile = reconcile("${sourceV2}")
        assert '"outcome": "noop"' in evidence_reconcile
        assert '"generationIdentity"' in evidence_reconcile
        print("=== bounded golden-path evidence: mottainai-runtime-health ===")
        print(evidence_health)
        print("=== bounded golden-path evidence: mottainai-bootstrap reconcile (final no-op) ===")
        print(evidence_reconcile)
  '';
  };
in
# Forces genV1/genV2's full build closure (including native-module
# toolchain build inputs, via the .drvPath entries in sharedGuestPaths
# above) to actually realize on the host as an explicit, unambiguous
# dependency of this derivation — not merely implied by testScript string
# interpolation or virtualisation.additionalPaths' own internal closure
# computation, which only covers runtime references.
pkgs.runCommand goldenPathTest.name
  {
    nativeBuildInputs = [
      genV1.generation
      genV1.metadataFile
      genV2.generation
      genV2.metadataFile
    ];
  }
  ''
    cp -r ${goldenPathTest} "$out"
  ''
