import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reconcileHealthCheck, runBootstrapCli, runReconcile } from "./cli.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";
import { ManagedRuntimeError } from "../runtime-contract/managed-runtime.js";
import { readManagedRuntimePointer, readManagedRuntimeState } from "../runtime-contract/managed-runtime-state.js";
import { generationIdentityOf } from "../runtime-contract/managed-generation.js";
import type { BuildManagedGenerationOptions, BuiltManagedGeneration } from "../runtime-contract/managed-generation-build.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
} from "../runtime-contract/managed-package-manifest.js";

function captureStdout(): { restore: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string) => {
    buffer += chunk;
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
      return buffer;
    },
  };
}

test("status --json against a fresh path reports a bounded, fixed-shape envelope (present:false)", async () => {
  // CANONICAL_BOOTSTRAP_STATE_FILE_PATH is a fixed constant the CLI always
  // uses in production, so this test exercises the real path and expects
  // it not to exist in this sandboxed environment — verifying the CLI
  // never fabricates a present:true report for a path it can't read.
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["status", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["contractId", "present", "schemaVersion"]);
  assert.equal(parsed.contractId, "mottainai.bootstrap-state.v1");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.present, false);
});

test("verify --json against a fresh path reports bounded, machine-readable output", async () => {
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["verify", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["contractId", "reason", "schemaVersion", "verified"]);
  assert.equal(parsed.verified, false);
});

test("an unknown command is rejected deterministically", async () => {
  const exitCode = await runBootstrapCli(["nonsense"]);
  assert.equal(exitCode, 1);
});

test("build has no --state-file flag: no code path reads one as a state-path override", async () => {
  // The CLI never parses a --state-file flag value anywhere in its source;
  // this asserts that structurally rather than behaviorally (a real
  // `build` run needs a valid manifest + Nix, which this unit test
  // intentionally does not exercise — see build.test.ts for the full
  // pipeline). Matches actual flag-reading calls, not prose that merely
  // discusses the absence of such a flag (this file's own doc comment
  // mentions "--state-file" while explaining that it deliberately doesn't
  // exist).
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  assert.doesNotMatch(source, /requireFlagValue\([^)]*["'`]state-file["'`]/u);
  assert.doesNotMatch(source, /hasFlag\([^)]*["'`]state-file["'`]/u);
  assert.doesNotMatch(source, /process\.env\.\w*STATE/u);
  assert.doesNotMatch(source, /process\.env\.MOTTAINAI_CONTROL_STATE_ROOT/u);
});

test("the CLI's production dispatch always uses CANONICAL_BOOTSTRAP_STATE_FILE_PATH, never a caller-supplied path", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  const stateFilePathUsages = [...source.matchAll(/stateFilePath:\s*(\S+)/gu)].map((match) => match[1].replace(/,$/u, ""));
  assert.ok(stateFilePathUsages.length > 0, "expected at least one stateFilePath: usage in cli.ts");
  for (const usage of stateFilePathUsages) {
    assert.equal(usage, "CANONICAL_BOOTSTRAP_STATE_FILE_PATH");
  }
  assert.equal(CANONICAL_BOOTSTRAP_STATE_FILE_PATH, "/var/lib/mottainai-control/bootstrap/state.json");
});

// PR review finding P1-4, exercised through the real CLI boundary (not just
// runBootstrapBuild directly, which build.test.ts already covers): `build`
// against a manifest path that does not exist must still route through
// runBootstrapBuild (via the UnreadableManifest sentinel cli.ts constructs)
// rather than returning early before any bootstrap-state persistence logic
// runs. Exercised against CANONICAL_BOOTSTRAP_STATE_FILE_PATH (the real
// production path, unwritable in this sandbox) so the specific assertion
// here is behavioral, not structural: a missing manifest file must fail
// with `invalid_manifest`, proving control reached runBootstrapBuild's
// manifest-stage rejection — not `bootstrap_state_corruption` or a crash
// from some earlier code path that never got that far.
test("build against a nonexistent manifest path fails with invalid_manifest, proving it reached runBootstrapBuild rather than returning early", async () => {
  const capture = captureStdout();
  const exitCode = await runBootstrapCli([
    "build",
    "/nonexistent/path/manifest.json",
    "--system",
    "x86_64-linux",
    "--json",
  ]);
  const output = capture.restore();
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.code, "invalid_manifest");
  assert.match(parsed.message, /manifest file cannot be read/u);
});

// Issue #642: `reconcile` composes #626's build interface with #628's
// already-implemented reconcileManagedRuntime state machine into one
// guest-invokable command. These tests exercise the real CLI boundary
// against the real canonical managed-runtime state root
// (/var/lib/mottainai-control/managed-runtime), which does not exist in
// this sandbox — proving reconcile fails deterministically with
// manifest_read_failure rather than fabricating a manifest or falling back
// to any other source, without requiring a Nix toolchain or the #630 VM
// harness.

test("reconcile --json without --system is a usage error, never reaching reconcileManagedRuntime", async () => {
  const exitCode = await runBootstrapCli(["reconcile", "--json"]);
  assert.equal(exitCode, 1);
});

test("reconcile --json against a fresh control-state root fails deterministically with manifest_read_failure", async () => {
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["reconcile", "--system", "x86_64-linux", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.code, "manifest_read_failure");
});

test("reconcile has no state-directory/state-file/current-pointer/manifest-path override flag: no code path reads one from argv", async () => {
  // Structural, matching the existing --state-file assertion above:
  // reconcileManagedRuntime accepts stateDirectory/stateFilePath/
  // currentPointerPath/manifestPath overrides, and this asserts cli.ts
  // never reads any of them from argv, so `reconcile` always targets the
  // canonical managed-runtime control state Issue #628 defaults to.
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  for (const flag of ["state-directory", "state-file", "current-pointer", "manifest-path", "mottainai-source"]) {
    assert.doesNotMatch(source, new RegExp(`requireFlagValue\\([^)]*["'\`]${flag}["'\`]`, "u"));
    assert.doesNotMatch(source, new RegExp(`hasFlag\\([^)]*["'\`]${flag}["'\`]`, "u"));
  }
});

// Review response (PR #646): the tests above only cover reconcile's usage
// error and its very first manifest-read failure — never the production
// composition (reconcileBuildGeneration/reconcileHealthCheck wired into
// #628's reconcileManagedRuntime) actually converging anything.
// `runReconcile` (exported from cli.ts for exactly this purpose) is
// exercised directly here with an injected `runManagedGenerationBuild`
// and `healthCheck`, plus a test-only `stateDirectory`/`manifest` DI
// seam `runReconcileCommand` itself never uses (see the structural test
// above) — proving the real adapter-shaping logic this PR adds, not
// re-proving #628's own state machine, which managed-runtime.test.ts
// already covers exhaustively. Candidate store paths are fake
// `/nix/store/<identity>` strings that satisfy assertManagedStorePath's
// shape check without existing on disk — the same convention
// managed-runtime.test.ts's own fixture() helper already uses — so
// `healthCheck` is injected here rather than left at its real default,
// which would genuinely try to execute a nonexistent binary.

function nawabariManifest(version: string) {
  return {
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "nawabari",
        kind: "nix-flake-package" as const,
        version,
        source: { flakeRef: "nix/packages/nawabari.nix", sourceSha256: "a".repeat(64) },
      },
    ],
  };
}

test("runReconcile composes the real production adapters end to end: initialize, noop, update, and post-switch health failure -> rollback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-reconcile-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let buildCalls = 0;
  let nextGenerationNumber = 0;
  // Set to a specific storePath to make ONLY that generation's health check
  // fail — the real recoverTransaction logic also re-checks the PREVIOUS
  // generation's health while rolling back, and that check must still
  // succeed, or this would prove nothing about rollback specifically.
  let unhealthyStorePath: string | undefined;

  const build = async (options: BuildManagedGenerationOptions): Promise<BuiltManagedGeneration> => {
    buildCalls += 1;
    nextGenerationNumber += 1;
    const storePath = `/nix/store/generation-${nextGenerationNumber}`;
    const version = (options.manifest.packages[0] as { version: string }).version;
    const metadata = {
      contractId: "mottainai.managed-generation.v1" as const,
      schemaVersion: 1 as const,
      compatibilityContractVersion: 1 as const,
      requestedIdentity: { packages: [{ packageId: "nawabari", version, sourceSha256: "a".repeat(64) }] },
      resolvedIdentity: { packages: [{ packageId: "nawabari", resolvedVersion: version }] },
      nixOutput: { storePath, packages: [{ packageId: "nawabari", storePath, sourceStorePath: storePath }] },
    };
    // asCandidate (managed-runtime.ts) re-derives generationIdentityOf(manifest,
    // metadata) whenever metadata is present and requires it to match —
    // the real production invariant this fake build must also honor, so
    // this uses the real generationIdentityOf rather than an arbitrary
    // string.
    return { generationIdentity: generationIdentityOf(options.manifest, metadata), metadata };
  };

  const runFor = (manifestVersion: string) =>
    runReconcile({
      system: "x86_64-linux",
      repoRoot: "/unused",
      env: {},
      stateDirectory: root,
      manifest: nawabariManifest(manifestVersion),
      dependencies: {
        runManagedGenerationBuild: build,
        healthCheck: (candidate) => {
          const healthy = candidate.storePath !== unhealthyStorePath;
          return {
            healthy,
            generationIdentity: candidate.generationIdentity,
            storePath: candidate.storePath,
            ...(healthy ? {} : { reason: "fixture-forced unhealthy" }),
          };
        },
      },
    });

  // 1. Initialize: no prior state, first build succeeds and is healthy.
  const initialized = await runFor("0.6.1");
  assert.equal(initialized.outcome, "initialized");
  assert.equal(initialized.active?.storePath, "/nix/store/generation-1");
  assert.equal(buildCalls, 1);

  // 2. Noop: same manifest, same desired identity, active is already
  // healthy — must not rebuild.
  const noop = await runFor("0.6.1");
  assert.equal(noop.outcome, "noop");
  assert.equal(buildCalls, 1);

  // 3. Update: a new manifest version builds and activates a new generation.
  const updated = await runFor("0.6.2");
  assert.equal(updated.outcome, "updated");
  assert.equal(updated.active?.storePath, "/nix/store/generation-2");
  assert.equal(updated.previous?.storePath, "/nix/store/generation-1");
  assert.equal(buildCalls, 2);

  // 4. Post-switch health failure -> rollback: the next candidate builds
  // successfully but fails its post-switch health check. reconcileManagedRuntime
  // throws health_failure even after a successful rollback (the desired
  // state was not reached) -- assert that, then verify via the persisted
  // state/pointer that generation-2 (the prior known-good) was actually
  // restored as active, not merely that the call rejected.
  unhealthyStorePath = "/nix/store/generation-3";
  await assert.rejects(
    runFor("0.6.3"),
    (error: unknown) => error instanceof ManagedRuntimeError && error.code === "health_failure",
  );
  assert.equal(buildCalls, 3);
  const stateFile = path.join(root, "managed-runtime", "state.json");
  const currentPointer = path.join(root, "managed-runtime", "current");
  const recoveredState = readManagedRuntimeState(stateFile);
  assert.equal(recoveredState?.active?.storePath, "/nix/store/generation-2");
  assert.equal(recoveredState?.activation.phase, "idle");
  assert.equal(readManagedRuntimePointer(currentPointer), "/nix/store/generation-2");
});

// Review response (PR #646): reconcileHealthCheck used to loop
// `generation.packageIds ?? []`, so a candidate with no package identities
// received zero executable checks and reported `healthy: true` without
// verifying anything at all -- silently vacuous, not intentional. It now
// fails closed instead. This also proves the real `--version`
// executable-proof logic (verifyManagedBinaryExecutes) against a real
// fixture binary on disk -- unlike the composition test above,
// reconcileHealthCheck is called directly here (never through
// reconcileManagedRuntime/asCandidate), so its storePath does not need to
// satisfy assertManagedStorePath's `/nix/store/<name>` shape and can be a
// real, ordinary tmp directory.

test("reconcileHealthCheck fails closed when a candidate declares no package identities", () => {
  const result = reconcileHealthCheck({
    generationIdentity: "empty-generation",
    storePath: "/nix/store/empty-generation",
    desiredManifestSemanticIdentity: "a".repeat(64),
    compatibilityContractVersion: 1,
    packageIds: [],
  });
  assert.equal(typeof result === "object" && result !== null ? result.healthy : result, false);
  assert.match(
    typeof result === "object" && result !== null ? (result.reason ?? "") : "",
    /no package identities/u,
  );
});

test("reconcileHealthCheck proves a real executable and fails closed on a real execution failure", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-reconcile-health-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  const workingBinary = path.join(dir, "bin", "nawabari-ok");
  fs.writeFileSync(workingBinary, "#!/bin/sh\necho 'nawabari 0.6.1'\n");
  fs.chmodSync(workingBinary, 0o755);
  const brokenBinary = path.join(dir, "bin", "nawabari-broken");
  fs.writeFileSync(brokenBinary, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(brokenBinary, 0o755);

  const healthy = reconcileHealthCheck({
    generationIdentity: "real-ok",
    storePath: dir,
    desiredManifestSemanticIdentity: "a".repeat(64),
    compatibilityContractVersion: 1,
    packageIds: ["nawabari-ok"],
  });
  assert.equal(typeof healthy === "object" && healthy !== null ? healthy.healthy : healthy, true);

  const unhealthy = reconcileHealthCheck({
    generationIdentity: "real-broken",
    storePath: dir,
    desiredManifestSemanticIdentity: "a".repeat(64),
    compatibilityContractVersion: 1,
    packageIds: ["nawabari-broken"],
  });
  assert.equal(typeof unhealthy === "object" && unhealthy !== null ? unhealthy.healthy : unhealthy, false);
});
