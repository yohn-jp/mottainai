{ pkgs, lib, bootstrapPackage, mottainaiPackage }:

# Real-build proof for Issue #626's standalone bootstrap package
# (nix/bootstrap.nix), mirroring nix/tests/managed-generation.nix's style
# of a `runCommand` check run via `nix build .#checks.<system>.bootstrap`.
#
# Two properties this proves that pure evaluation alone cannot:
#
# 1. The packaged `mottainai-bootstrap status` binary actually runs — in an
#    isolated $TMPDIR with no prior state and no full `mottainai` package
#    anywhere in its build environment — and reports present:false without
#    crashing (Issue #626 AC: "a fresh environment without full Mottainai
#    installed can request/build ..." — this is the "runs at all" half of
#    that; src/bootstrap/build.test.ts proves the full build pipeline with
#    injected dependencies).
#
# 2. The built closure genuinely excludes the full `mottainai` derivation
#    and the unrelated root-dependency packages it pulls in (node-pty,
#    tree-sitter*, xterm, the MCP SDK, ws) — not just that nix/bootstrap.nix
#    was written with that intent, but that the real store closure has no
#    reference to any of them.
#
# The closure listing itself is obtained via `exportReferencesGraph`, not by
# shelling out to `nix-store -q --requisites` inside the build sandbox: the
# sandboxed builder has no access to the host Nix store database, only to
# paths explicitly declared as inputs, so `exportReferencesGraph` (a
# well-known derivation-attribute idiom) is how a build gets its own
# dependency closure as a plain file to inspect.

pkgs.runCommand "mottainai-bootstrap-smoke"
  {
    nativeBuildInputs = [ bootstrapPackage ];
    exportReferencesGraph = [ "bootstrap-closure" bootstrapPackage ];
  }
  ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"

    # 1. Standalone smoke: the packaged binary runs and reports a bounded,
    # machine-readable "never attempted" status with no prior state.
    status_output="$(mottainai-bootstrap status --json)"
    echo "$status_output" | grep -q '"present": false' \
      || { echo "expected present:false in fresh status output, got: $status_output"; exit 1; }
    echo "$status_output" | grep -q '"contractId": "mottainai.bootstrap-state.v1"' \
      || { echo "status output missing contractId: $status_output"; exit 1; }

    # 2. Closure-exclusion: the built bootstrap package's own runtime
    # closure must not reference the full mottainai derivation or any of
    # the unrelated root dependencies it pulls in. `bootstrap-closure` is a
    # storeExprSyntax file listing every store path exportReferencesGraph
    # found reachable from ${bootstrapPackage}; the paths themselves (one
    # per line, interleaved with derivation metadata) are what we scan.
    if grep -qF ${mottainaiPackage} bootstrap-closure; then
      echo "FAIL: bootstrap closure references the full mottainai derivation: ${mottainaiPackage}"
      exit 1
    fi

    for forbidden in node-pty tree-sitter xterm modelcontextprotocol -ws- -ws@; do
      if grep -qi -- "$forbidden" bootstrap-closure; then
        echo "FAIL: bootstrap closure references an unrelated full-runtime dependency matching: $forbidden"
        grep -i -- "$forbidden" bootstrap-closure
        exit 1
      fi
    done

    touch "$out"
  ''
