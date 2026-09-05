import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reconcileAdapters, reconcileHealthCheck, runBootstrapCli } from "./cli.js";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH } from "./paths.js";
import {
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  ManagedRuntimeError,
  reconcileManagedRuntime,
} from "../runtime-contract/managed-runtime.js";
import { readManagedRuntimePointer, readManagedRuntimeState } from "../runtime-contract/managed-runtime-state.js";
import { generationIdentityOf } from "../runtime-contract/managed-generation.js";
import { parseManagedGenerationMetadata } from "../runtime-contract/managed-generation.js";
import type {
  BuildManagedGenerationOptions,
  BuiltManagedGeneration,
} from "../runtime-contract/managed-generation-build.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
} from "../runtime-contract/managed-package-manifest.js";
import { parseManagedPackageManifest } from "../runtime-contract/managed-package-manifest.js";

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
  const stateFilePathUsages = [...source.matchAll(/stateFilePath:\s*(\S+)/gu)].map((match) =>
    match[1].replace(/,$/u, ""),
  );
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

// Review response (PR #646, re-review): the exported production `runReconcile`
// itself used to accept `stateDirectory`/`manifest` as a "test-only" DI
// seam — since it was exported, that made the production API surface
// capable of overriding canonical managed-runtime state authority
// regardless of what runReconcileCommand's own argv parsing did. Fixed by
// removing both from RunReconcileOptions entirely (TypeScript now refuses
// any caller, including a test, from passing either to runReconcile at
// all) and moving the test-only DI seam to reconcileAdapters, which has no
// state/manifest parameter of any kind. This is a structural,
// source-scanning proof that the fix holds, mirroring the flag-scanning
// tests above.
test("runReconcile's exported options type has no stateDirectory/manifest override, and its body passes no state/manifest override to reconcileManagedRuntime", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  const optionsInterfaceMatch = source.match(/export interface RunReconcileOptions \{([^}]*)\}/u);
  assert.ok(optionsInterfaceMatch, "expected an exported RunReconcileOptions interface");
  assert.doesNotMatch(optionsInterfaceMatch[1], /stateDirectory|manifest/u);

  const runReconcileMatch = source.match(
    /export async function runReconcile\(options: RunReconcileOptions\): Promise<ManagedRuntimeReconcileResult> \{([^}]*)\}/u,
  );
  assert.ok(runReconcileMatch, "expected an exported runReconcile function body");
  assert.doesNotMatch(runReconcileMatch[1], /stateDirectory|options\.manifest/u);
});

// Review response (PR #646): the tests above only cover reconcile's usage
// error and its very first manifest-read failure — never the production
// composition (reconcileBuildGeneration/reconcileHealthCheck wired into
// #628's reconcileManagedRuntime) actually converging anything.
//
// This exercises that composition WITHOUT going through `runReconcile`
// (which is canonical-only — no state/manifest override of any kind, per
// review) — instead it calls #628's own `reconcileManagedRuntime` directly
// with a temporary `stateDirectory`/`manifest` (exactly the pattern
// managed-runtime.test.ts's own fixture() helper already uses) and passes
// `reconcileAdapters(...)`'s return value as `dependencies`.
// `reconcileAdapters` is the ONLY test-facing seam cli.ts exports for
// reconcile, and it has no state/manifest parameter at all — it only
// builds the buildGeneration/healthCheck adapter functions, with
// `runManagedGenerationBuild`/`healthCheck` overridden here — so this
// proves the real adapter-shaping logic this PR adds without any
// production-exported function accepting authority-path overrides, and
// without re-proving #628's own state machine, which
// managed-runtime.test.ts already covers exhaustively. Candidate store
// paths are fake `/nix/store/<identity>` strings that satisfy
// assertManagedStorePath's shape check without existing on disk — the
// same convention managed-runtime.test.ts's own fixture() helper already
// uses — so `healthCheck` is overridden here rather than left at its real
// default, which would genuinely try to execute a nonexistent binary.

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

test("reconcileAdapters composes the real production build/health logic with reconcileManagedRuntime end to end: initialize, noop, update, and post-switch health failure -> rollback", async (t) => {
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
    reconcileManagedRuntime({
      stateDirectory: root,
      manifest: nawabariManifest(manifestVersion),
      dependencies: reconcileAdapters({
        system: "x86_64-linux",
        repoRoot: "/unused",
        env: {},
        overrides: {
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
      }),
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

test("reconcileAdapters hands the selected Route 1 payload to the canonical build and skips it on an idempotent rerun", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-reconcile-route1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = parseManagedPackageManifest({
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "1.2.3",
        source: { flakeRef: "nix#mottainai", sourceSha256: "a".repeat(64) },
      },
    ],
  });
  const payload = {
    packageName: "mottainai" as const,
    version: "1.2.3",
    sourceRevision: "b".repeat(40),
    filename: "mottainai-1.2.3.tgz",
    sha256: "c".repeat(64),
    integrity: `sha512-${"A".repeat(86)}`,
    locator: "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-1.2.3.tgz",
  };
  const metadata = parseManagedGenerationMetadata({
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: { packages: [{ packageId: "mottainai", version: "1.2.3", sourceSha256: "a".repeat(64) }] },
    resolvedIdentity: { packages: [{ packageId: "mottainai", resolvedVersion: "1.2.3" }] },
    nixOutput: {
      storePath: "/nix/store/route1-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/route1-mottainai",
          sourceStorePath: "/nix/store/route1-source",
        },
      ],
    },
    applicationPayload: { packageName: "mottainai", packageVersion: "1.2.3", sha256: payload.sha256 },
  });
  const expectedIdentity = generationIdentityOf(manifest, metadata);
  let identityReads = 0;
  let payloadResolutions = 0;
  let sourceResolutions = 0;
  let builds = 0;
  const dependencies = reconcileAdapters({
    system: "x86_64-linux",
    repoRoot: "/unused",
    env: {},
    overrides: {
      readRoute1PayloadIdentity: () => {
        identityReads += 1;
        return payload;
      },
      readManagedGenerationIdentity: () => expectedIdentity,
      resolvePayload: async (options) => {
        payloadResolutions += 1;
        assert.equal(options.identity.sha256, payload.sha256);
        return {
          payloadPath: "/tmp/route1-selected.tgz",
          sha256: payload.sha256,
          packageName: "mottainai",
          version: payload.version,
          sourceRevision: payload.sourceRevision,
        };
      },
      resolveSource: async () => {
        sourceResolutions += 1;
        return { sourcePath: "/tmp/route2-source", resolvedTag: "v1.2.3", narHashSha256: "a".repeat(64) };
      },
      runManagedGenerationBuild: async (options) => {
        builds += 1;
        assert.equal(options.canonicalPayloadPath, "/tmp/route1-selected.tgz");
        assert.equal(options.canonicalPayloadSha256, payload.sha256);
        return { generationIdentity: expectedIdentity, metadata };
      },
      healthCheck: (candidate) => ({
        healthy: true,
        generationIdentity: candidate.generationIdentity,
        storePath: candidate.storePath,
      }),
    },
  });
  const first = await reconcileManagedRuntime({ stateDirectory: root, manifest, dependencies });
  const second = await reconcileManagedRuntime({ stateDirectory: root, manifest, dependencies });
  assert.equal(first.outcome, "initialized");
  assert.equal(second.outcome, "noop");
  assert.equal(identityReads, 2);
  assert.equal(payloadResolutions, 1);
  assert.equal(sourceResolutions, 1);
  assert.equal(builds, 1);
  assert.equal(second.active?.applicationPayload?.sha256, payload.sha256);
});

test("reconcile fails before activation when the descriptor generation identity differs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-reconcile-generation-mismatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = parseManagedPackageManifest({
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "1.2.3",
        source: { flakeRef: "nix#mottainai", sourceSha256: "a".repeat(64) },
      },
    ],
  });
  const metadata = parseManagedGenerationMetadata({
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: { packages: [{ packageId: "mottainai", version: "1.2.3", sourceSha256: "a".repeat(64) }] },
    resolvedIdentity: { packages: [{ packageId: "mottainai", resolvedVersion: "1.2.3" }] },
    nixOutput: {
      storePath: "/nix/store/mismatch-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/mismatch-package",
          sourceStorePath: "/nix/store/mismatch-source",
        },
      ],
    },
    applicationPayload: { packageName: "mottainai", packageVersion: "1.2.3", sha256: "c".repeat(64) },
  });
  const builtIdentity = generationIdentityOf(manifest, metadata);
  const dependencies = reconcileAdapters({
    system: "x86_64-linux",
    repoRoot: "/unused",
    env: {},
    overrides: {
      readRoute1PayloadIdentity: () => ({
        packageName: "mottainai",
        version: "1.2.3",
        sourceRevision: "b".repeat(40),
        filename: "mottainai-1.2.3.tgz",
        sha256: "c".repeat(64),
        integrity: `sha512-${"A".repeat(86)}`,
        locator: "https://github.com/yohn-jp/mottainai/releases/download/v1.2.3/mottainai-1.2.3.tgz",
      }),
      readManagedGenerationIdentity: () => "e".repeat(64),
      resolvePayload: async () => ({
        payloadPath: "/tmp/mismatch.tgz",
        sha256: "c".repeat(64),
        packageName: "mottainai",
        version: "1.2.3",
        sourceRevision: "b".repeat(40),
      }),
      resolveSource: async () => ({ sourcePath: "/tmp/source", resolvedTag: "v1.2.3", narHashSha256: "a".repeat(64) }),
      runManagedGenerationBuild: async () => ({ generationIdentity: builtIdentity, metadata }),
      healthCheck: () => ({ healthy: true }),
    },
  });
  await assert.rejects(
    reconcileManagedRuntime({ stateDirectory: root, manifest, dependencies }),
    (error: unknown) => error instanceof ManagedRuntimeError && error.code === "generation_verification_failure",
  );
  assert.equal(fs.existsSync(path.join(root, "managed-runtime", "current")), false);
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
  assert.match(typeof result === "object" && result !== null ? (result.reason ?? "") : "", /no package identities/u);
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

// Issue #644: `managed-status` is the read-only counterpart to `reconcile`
// — it reports #628's already-persisted managed-runtime state through the
// same canonical readManagedRuntimeStatus (real ManagedRuntimeStateSchema
// zod validation) reconcile itself uses, never a hand-rolled re-check, and
// never mutates anything.

test("managed-status --json against a fresh control-state root reports valid:true, present:false", async () => {
  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["managed-status", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.present, false);
});

test("managed-status --json reports valid:false with a bounded code/message against malformed persisted state", async (t) => {
  const stateDirectory = path.join(MANAGED_RUNTIME_CONTROL_STATE_ROOT, "managed-runtime");
  const stateFile = path.join(stateDirectory, "state.json");
  const alreadyPresent = fs.existsSync(stateFile);
  t.after(() => {
    if (!alreadyPresent) fs.rmSync(stateFile, { force: true });
  });
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(stateFile, "{ not valid json");

  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["managed-status", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.code, "state_corrupt");
  assert.equal(typeof parsed.message, "string");
});

test("managed-status --json reports valid:false against a schema-invalid-but-field-complete state (unknown top-level key)", async (t) => {
  const stateDirectory = path.join(MANAGED_RUNTIME_CONTROL_STATE_ROOT, "managed-runtime");
  const stateFile = path.join(stateDirectory, "state.json");
  const alreadyPresent = fs.existsSync(stateFile);
  t.after(() => {
    if (!alreadyPresent) fs.rmSync(stateFile, { force: true });
  });
  fs.mkdirSync(stateDirectory, { recursive: true });
  // Every field a valid mottainai.managed-runtime-state.v1 record needs is
  // present and well-typed EXCEPT for one unrecognized top-level key
  // (`.strict()` rejects it) — proving readiness depends on real schema
  // strictness, not merely "does this parse as an object with the right
  // shape of a few fields".
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      contractId: "mottainai.managed-runtime-state.v1",
      schemaVersion: 1,
      desiredManifestSemanticIdentity: "a".repeat(64),
      activation: { phase: "idle" },
      updatedAt: "2026-01-01T00:00:00.000Z",
      unexpectedExtraField: true,
    }),
  );

  const capture = captureStdout();
  const exitCode = await runBootstrapCli(["managed-status", "--json"]);
  const output = capture.restore();
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.code, "state_corrupt");
});

test("managed-status has no state-directory/state-file/current-pointer/manifest-path override flag: no code path reads one from argv", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
  const managedStatusSection = source.slice(source.indexOf("function runManagedStatusCommand"));
  for (const flag of ["state-directory", "state-file", "current-pointer", "manifest-path"]) {
    assert.doesNotMatch(managedStatusSection, new RegExp(`requireFlagValue\\([^)]*["'\`]${flag}["'\`]`, "u"));
    assert.doesNotMatch(managedStatusSection, new RegExp(`hasFlag\\([^)]*["'\`]${flag}["'\`]`, "u"));
  }
});
