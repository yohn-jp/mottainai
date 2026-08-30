import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import { MANAGED_PACKAGE_MANIFEST_CONTRACT_ID, MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION } from "../runtime-contract/managed-package-manifest.js";
import { defaultBootstrapDependencies, readBootstrapStatus, runBootstrapBuild } from "./build.js";
import type { BootstrapDependencies } from "./build.js";
import { readBootstrapState } from "./state.js";

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
