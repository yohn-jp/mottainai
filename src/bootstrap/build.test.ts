import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import { ManagedGenerationBuildError } from "../runtime-contract/managed-generation-build.js";
import { MANAGED_PACKAGE_MANIFEST_CONTRACT_ID, MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION } from "../runtime-contract/managed-package-manifest.js";
import { defaultBootstrapDependencies, readBootstrapStatus, runBootstrapBuild } from "./build.js";
import type { BootstrapDependencies } from "./build.js";
import { readBootstrapState } from "./state.js";
import { UnreadableManifest } from "./unreadable-manifest.js";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "0.7.1",
        source: { flakeRef: "nix#mottainai", sourceSha256: "a".repeat(64) },
      },
      {
        packageId: "nawabari",
        kind: "nix-flake-package",
        version: "0.6.1",
        source: { flakeRef: "nix/packages/nawabari.nix", sourceSha256: "b".repeat(64) },
      },
    ],
    ...overrides,
  };
}

function metadataStub(storePath = "/nix/store/example-managed-generation") {
  return {
    contractId: "mottainai.managed-generation.v1" as const,
    schemaVersion: 1 as const,
    compatibilityContractVersion: 1 as const,
    requestedIdentity: { packages: [] },
    resolvedIdentity: { packages: [] },
    nixOutput: { storePath, packages: [] },
  };
}

interface TestHarness {
  readonly deps: BootstrapDependencies;
  readonly stateFilePath: string;
  readonly workspaceRoot: string;
  readonly resolveSourceCalls: unknown[];
  readonly buildCalls: unknown[];
  cleanup(): void;
}

function harness(overrides: Partial<BootstrapDependencies> = {}): TestHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-bootstrap-build-test-"));
  const stateFilePath = path.join(root, "control-state", "bootstrap", "state.json");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const resolveSourceCalls: unknown[] = [];
  const buildCalls: unknown[] = [];

  const deps: BootstrapDependencies = {
    resolveSource: async (options) => {
      resolveSourceCalls.push(options);
      return { sourcePath: "/tmp/fake-resolved-source", resolvedTag: `v${options.requestedVersion}`, narHashSha256: "c".repeat(64) };
    },
    runManagedGenerationBuild: async (options) => {
      buildCalls.push(options);
      return { metadata: metadataStub(), generationIdentity: "d".repeat(64) };
    },
    stateFilePath,
    boundaries: DIRECT_BOUNDARIES,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    repoRoot: "/repo",
    system: "x86_64-linux",
    env: {},
    checkNixAvailable: () => {},
    ...overrides,
  };

  return {
    deps,
    stateFilePath,
    workspaceRoot,
    resolveSourceCalls,
    buildCalls,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("scenario 1: fresh environment (no mottainai on PATH) builds a generation containing Mottainai + Nawabari", async () => {
  const h = harness();
  try {
    const state = await runBootstrapBuild(validManifest(), h.deps);
    assert.equal(state.lastAttempt.outcome, "success");
    assert.ok(state.lastSuccessfulBuild !== undefined);
    assert.equal(h.resolveSourceCalls.length, 1);
    assert.equal(h.buildCalls.length, 1);
    const source = fs.readFileSync(new URL("./source-resolution.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /execFileSync\(\s*["'`]mottainai["'`]/u);
  } finally {
    h.cleanup();
  }
});

test("scenario 4: invalid manifest fails closed before resolveSource/runManagedGenerationBuild are ever called", async () => {
  const h = harness();
  try {
    await assert.rejects(
      runBootstrapBuild({ not: "a manifest" }, h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "invalid_manifest",
    );
    assert.equal(h.resolveSourceCalls.length, 0);
    assert.equal(h.buildCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("scenario 4b: unsupported managed package fails closed before resolveSource/runManagedGenerationBuild are ever called", async () => {
  const h = harness();
  try {
    const manifest = validManifest({
      packages: [
        {
          packageId: "mottainai",
          kind: "nix-flake-package",
          version: "0.7.1",
          source: { flakeRef: "nix#some-other-ref", sourceSha256: "a".repeat(64) },
        },
      ],
    });
    await assert.rejects(
      runBootstrapBuild(manifest, h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "unsupported_managed_package",
    );
    assert.equal(h.resolveSourceCalls.length, 0);
    assert.equal(h.buildCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("scenario 5a: a Nix build failure produces nix_generation_build_failure", async () => {
  const h = harness({
    runManagedGenerationBuild: async () => {
      throw new Error("nix build exited with code 1");
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "nix_generation_build_failure",
    );
  } finally {
    h.cleanup();
  }
});

test("scenario 5b: an unavailable Nix prerequisite is distinguished from a build failure", async () => {
  const h = harness({
    checkNixAvailable: () => {
      const error = new Error("spawnSync nix ENOENT");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    },
    runManagedGenerationBuild: async () => {
      throw new Error("this must never be called once Nix is unavailable");
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "unavailable_nix_prerequisite",
    );
    assert.equal(h.buildCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("scenario 11: a first-ever invalid-manifest failure persists valid bounded state", async () => {
  const h = harness();
  try {
    await assert.rejects(runBootstrapBuild({ not: "a manifest" }, h.deps));
    const state = readBootstrapState(h.stateFilePath);
    assert.ok(state !== undefined);
    assert.equal(state.lastAttempt.outcome, "failure");
    assert.equal(state.lastAttempt.errorCode, "invalid_manifest");
    assert.equal(state.lastAttempt.desiredManifestSemanticIdentity, undefined);
    assert.equal(state.lastSuccessfulBuild, undefined);
  } finally {
    h.cleanup();
  }
});

test("scenario 12: a failed later attempt preserves previous successful generation evidence", async () => {
  const h = harness();
  try {
    const successState = await runBootstrapBuild(validManifest(), h.deps);
    assert.ok(successState.lastSuccessfulBuild !== undefined);

    const failingDeps: BootstrapDependencies = {
      ...h.deps,
      runManagedGenerationBuild: async () => {
        throw new Error("simulated later build failure");
      },
    };
    await assert.rejects(runBootstrapBuild(validManifest(), failingDeps));

    const state = readBootstrapState(h.stateFilePath);
    assert.ok(state !== undefined);
    assert.equal(state.lastAttempt.outcome, "failure");
    assert.deepEqual(state.lastSuccessfulBuild, successState.lastSuccessfulBuild);
  } finally {
    h.cleanup();
  }
});

// PR review finding P1-3: a ManagedGenerationBuildError with phase
// "metadata"/"source_integrity"/"resolved_version" (thrown by
// buildManagedGeneration's post-build verification steps) must map to its
// own distinct BootstrapErrorCode, not collapse into
// "unsupported_managed_package" or a generic "nix_generation_build_failure".

test("scenario 5c: post-build malformed metadata produces malformed_generation_metadata, not unsupported_managed_package", async () => {
  const h = harness({
    runManagedGenerationBuild: async () => {
      throw new ManagedGenerationBuildError("managed generation metadata is malformed: bad json", "metadata");
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "malformed_generation_metadata",
    );
  } finally {
    h.cleanup();
  }
});

test("scenario 5d: post-build source-integrity mismatch produces source_integrity_mismatch, not unsupported_managed_package", async () => {
  const h = harness({
    runManagedGenerationBuild: async () => {
      throw new ManagedGenerationBuildError("managed generation source integrity mismatch for packageId=mottainai", "source_integrity");
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "source_integrity_mismatch",
    );
  } finally {
    h.cleanup();
  }
});

test("scenario 5e: post-build resolved-version mismatch produces requested_resolved_version_mismatch, not unsupported_managed_package", async () => {
  const h = harness({
    runManagedGenerationBuild: async () => {
      throw new ManagedGenerationBuildError("managed generation version mismatch for packageId=mottainai", "resolved_version");
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "requested_resolved_version_mismatch",
    );
  } finally {
    h.cleanup();
  }
});

// PR review finding P1-5: a Nawabari-only manifest (no `mottainai` entry) is
// intentionally allowed — runBootstrapBuild skips source resolution when
// there's no mottainai entry to resolve. The persisted success state must
// omit resolvedMottainaiSource entirely in that case (not write empty
// strings, which would fail lastSuccessfulBuildSchema) and must still
// round-trip through readBootstrapState without throwing.

test("scenario 13: a Nawabari-only manifest persists success state with no resolvedMottainaiSource key", async () => {
  const h = harness();
  try {
    const nawabariOnlyManifest = validManifest({
      packages: [
        {
          packageId: "nawabari",
          kind: "nix-flake-package",
          version: "0.6.1",
          source: { flakeRef: "nix/packages/nawabari.nix", sourceSha256: "b".repeat(64) },
        },
      ],
    });

    const state = await runBootstrapBuild(nawabariOnlyManifest, h.deps);
    assert.equal(state.lastAttempt.outcome, "success");
    assert.ok(state.lastSuccessfulBuild !== undefined);
    assert.equal(state.lastSuccessfulBuild.resolvedMottainaiSource, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(state.lastSuccessfulBuild, "resolvedMottainaiSource"));
    // source resolution must never run when there's no mottainai entry
    assert.equal(h.resolveSourceCalls.length, 0);

    // Round-trips through readBootstrapState (i.e. parseBootstrapState)
    // without throwing.
    const reread = readBootstrapState(h.stateFilePath);
    assert.ok(reread !== undefined);
    assert.equal(reread.lastSuccessfulBuild?.resolvedMottainaiSource, undefined);
  } finally {
    h.cleanup();
  }
});

// PR review finding P1-6: BootstrapStateSchema's lastAttempt.message is
// capped at 2048 chars, but a Nix/subprocess/fetch error can plausibly
// produce a much longer message (long stderr-derived text). Bootstrap must
// truncate before persisting, or its own normal failure path would write a
// state.json that violates its own schema and then fail the next
// status/verify call with bootstrap_state_corruption.

test("scenario 5f: a failure message longer than the 2048-char schema bound is truncated so persisted state stays schema-valid", async () => {
  const longMessage = `nix build exited with code 1: ${"x".repeat(3000)}`;
  const h = harness({
    runManagedGenerationBuild: async () => {
      throw new Error(longMessage);
    },
  });
  try {
    await assert.rejects(
      runBootstrapBuild(validManifest(), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "nix_generation_build_failure",
    );
    // readBootstrapState validates against BootstrapStateSchema internally —
    // if the persisted message exceeded the 2048-char bound this throws
    // BootstrapStateError (bootstrap corrupting its own state via its own
    // failure path), which is exactly the bug this test guards against.
    const state = readBootstrapState(h.stateFilePath);
    assert.ok(state !== undefined);
    assert.equal(state.lastAttempt.outcome, "failure");
    assert.equal(state.lastAttempt.errorCode, "nix_generation_build_failure");
    assert.ok(state.lastAttempt.message !== undefined);
    assert.ok(state.lastAttempt.message.length <= 2048);
    assert.ok(state.lastAttempt.message.endsWith("...[truncated]"));
  } finally {
    h.cleanup();
  }
});

test("scenario 9: no user/workspace mutation — bootstrap only writes under its own state file directory", async () => {
  const h = harness();
  try {
    const before = fs.existsSync(h.workspaceRoot) ? fs.readdirSync(h.workspaceRoot, { recursive: true }).sort() : [];
    await runBootstrapBuild(validManifest(), h.deps);
    const after = fs.existsSync(h.workspaceRoot) ? fs.readdirSync(h.workspaceRoot, { recursive: true }).sort() : [];
    assert.deepEqual(before, after);
  } finally {
    h.cleanup();
  }
});

test("status reports present:false when bootstrap has never been attempted", async () => {
  const h = harness();
  try {
    const report = readBootstrapStatus({ stateFilePath: h.stateFilePath });
    assert.equal(report.present, false);
    assert.equal(report.state, undefined);
  } finally {
    h.cleanup();
  }
});

test("defaultBootstrapDependencies wires resolveMottainaiSource/buildManagedGeneration as the production implementation", () => {
  const deps = defaultBootstrapDependencies({
    stateFilePath: "/var/lib/mottainai-control/bootstrap/state.json",
    boundaries: DIRECT_BOUNDARIES,
    repoRoot: "/repo",
    system: "x86_64-linux",
    env: {},
  });
  assert.equal(typeof deps.resolveSource, "function");
  assert.equal(typeof deps.runManagedGenerationBuild, "function");
});

// PR review finding P1-4: src/bootstrap/cli.ts wraps a manifest file that
// cannot be read or does not parse as JSON as an UnreadableManifest
// sentinel and still calls runBootstrapBuild with it, so this failure goes
// through the same lastAttempt-persisting path as every other
// invalid-manifest case — including a first-ever attempt, before any
// bootstrap state exists yet. These tests exercise runBootstrapBuild
// directly with that sentinel, proving the persistence contract the CLI
// boundary relies on.

test("scenario P1-4: an UnreadableManifest sentinel (file read/JSON.parse failure at the CLI boundary) still persists lastAttempt", async () => {
  const h = harness();
  try {
    await assert.rejects(
      runBootstrapBuild(new UnreadableManifest("ENOENT: no such file or directory"), h.deps),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "invalid_manifest",
    );
    const state = readBootstrapState(h.stateFilePath);
    assert.ok(state !== undefined);
    assert.equal(state.lastAttempt.outcome, "failure");
    assert.equal(state.lastAttempt.errorCode, "invalid_manifest");
    assert.match(state.lastAttempt.message ?? "", /manifest file cannot be read/u);
    assert.match(state.lastAttempt.message ?? "", /ENOENT/u);
    assert.equal(state.lastAttempt.desiredManifestSemanticIdentity, undefined);
    assert.equal(state.lastSuccessfulBuild, undefined);
    assert.equal(h.resolveSourceCalls.length, 0);
    assert.equal(h.buildCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("scenario P1-4: an UnreadableManifest failure preserves a previously recorded successful build", async () => {
  const h = harness();
  try {
    const successState = await runBootstrapBuild(validManifest(), h.deps);
    assert.ok(successState.lastSuccessfulBuild !== undefined);

    await assert.rejects(runBootstrapBuild(new UnreadableManifest("EACCES: permission denied"), h.deps));

    const state = readBootstrapState(h.stateFilePath);
    assert.ok(state !== undefined);
    assert.equal(state.lastAttempt.outcome, "failure");
    assert.equal(state.lastAttempt.errorCode, "invalid_manifest");
    assert.deepEqual(state.lastSuccessfulBuild, successState.lastSuccessfulBuild);
  } finally {
    h.cleanup();
  }
});
