import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ManagedRuntimeError,
  reconcileManagedRuntime,
  recoverManagedRuntime,
  readManagedRuntimeStatus,
  type ManagedRuntimeBuiltGeneration,
  type ManagedRuntimeCandidate,
  type ManagedRuntimeHealthResult,
  type ManagedRuntimeReconcileOptions,
} from "./managed-runtime.js";
import {
  atomicallySelectManagedRuntimeGeneration,
  readManagedRuntimePointer,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "./managed-runtime-state.js";
import type { ManagedRuntimeState } from "./managed-runtime-state.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
  semanticIdentityOf,
} from "./managed-package-manifest.js";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";

function manifest(packages: ManagedPackageManifest["packages"]): ManagedPackageManifest {
  return {
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages,
  };
}

function packageEntry(packageId: "mottainai" | "nawabari", version: string) {
  return {
    packageId,
    kind: "nix-flake-package" as const,
    version,
    source: {
      flakeRef: packageId === "mottainai" ? "nix#mottainai" : "nix/packages/nawabari.nix",
      sourceSha256: "a".repeat(64),
    },
  };
}

function candidate(
  identity: string,
  desiredManifestSemanticIdentity: string,
  packageIds = ["mottainai"],
): ManagedRuntimeCandidate {
  return {
    generationIdentity: identity,
    storePath: `/nix/store/${identity}`,
    desiredManifestSemanticIdentity,
    compatibilityContractVersion: 1,
    packageIds,
  };
}

function fixture(
  options: {
    readonly build?: (
      manifest: ManagedPackageManifest,
    ) => Promise<ManagedRuntimeBuiltGeneration> | ManagedRuntimeBuiltGeneration;
    readonly health?: (
      generation: ManagedRuntimeCandidate,
    ) => Promise<ManagedRuntimeHealthResult> | ManagedRuntimeHealthResult;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-runtime-test-"));
  let buildCalls = 0;
  let healthCalls = 0;
  const defaultBuild = (_manifestValue: ManagedPackageManifest): ManagedRuntimeBuiltGeneration => {
    buildCalls += 1;
    const id = `generation-${buildCalls}`;
    return { generationIdentity: id, storePath: `/nix/store/${id}` };
  };
  const defaultHealth = (generation: ManagedRuntimeCandidate): ManagedRuntimeHealthResult => {
    healthCalls += 1;
    return { healthy: true, generationIdentity: generation.generationIdentity, storePath: generation.storePath };
  };
  const build = options.build ?? defaultBuild;
  const health = options.health ?? defaultHealth;
  const baseOptions = (): Omit<ManagedRuntimeReconcileOptions, "manifest"> => ({
    stateDirectory: root,
    dependencies: {
      buildGeneration: async (manifestValue) => build(manifestValue),
      healthCheck: async (generation) => health(generation as ManagedRuntimeCandidate),
    },
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  return {
    root,
    baseOptions,
    get buildCalls() {
      return buildCalls;
    },
    get healthCalls() {
      return healthCalls;
    },
    paths() {
      return path.join(root, "managed-runtime", "state.json");
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const initialManifest = manifest([packageEntry("mottainai", "0.7.1"), packageEntry("nawabari", "0.6.1")]);
const updatedManifest = manifest([packageEntry("mottainai", "0.7.2"), packageEntry("nawabari", "0.6.1")]);
const removalManifest = manifest([packageEntry("mottainai", "0.7.1")]);

test("fresh init builds, stages, atomically activates, health-checks, and persists a known-good generation", async () => {
  const value = fixture();
  try {
    const result = await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    assert.equal(result.outcome, "initialized");
    assert.equal(result.active?.generationIdentity, "generation-1");
    assert.equal(result.previous, undefined);
    const state = readManagedRuntimeState(value.paths());
    assert.ok(state);
    assert.equal(state.activation.phase, "idle");
    assert.equal(state.active?.health.state, "healthy");
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      "/nix/store/generation-1",
    );
    assert.equal(value.buildCalls, 1);
    assert.equal(value.healthCalls, 1);
  } finally {
    value.cleanup();
  }
});

test("fresh init reads the canonical desired manifest from the control-state root", async () => {
  const value = fixture();
  try {
    const manifestPath = path.join(value.root, "managed-packages", "manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(initialManifest)}\n`);
    const result = await reconcileManagedRuntime(value.baseOptions());
    assert.equal(result.outcome, "initialized");
    assert.equal(result.active?.packageIds?.includes("mottainai"), true);
    assert.equal(result.active?.packageIds?.includes("nawabari"), true);
  } finally {
    value.cleanup();
  }
});

test("reconcile is a no-op when desired and active identities match and health remains healthy", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const result = await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    assert.equal(result.outcome, "noop");
    assert.equal(value.buildCalls, 1);
    assert.equal(value.healthCalls, 2);
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      "/nix/store/generation-1",
    );
  } finally {
    value.cleanup();
  }
});

test("update verifies and switches a new generation atomically while retaining the previous known-good generation", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const result = await reconcileManagedRuntime({ ...value.baseOptions(), manifest: updatedManifest });
    assert.equal(result.outcome, "updated");
    assert.equal(result.active?.generationIdentity, "generation-2");
    assert.equal(result.previous?.generationIdentity, "generation-1");
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      "/nix/store/generation-2",
    );
    assert.equal(value.buildCalls, 2);
  } finally {
    value.cleanup();
  }
});

test("removal is declarative and does not delete unrelated persistent workspace data", async () => {
  const value = fixture();
  const workspaceMarker = path.join(value.root, "workspace-data");
  fs.writeFileSync(workspaceMarker, "keep me");
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const result = await reconcileManagedRuntime({ ...value.baseOptions(), manifest: removalManifest });
    assert.equal(result.outcome, "removed");
    assert.deepEqual(result.active?.packageIds, ["mottainai"]);
    assert.equal(fs.readFileSync(workspaceMarker, "utf8"), "keep me");
    assert.equal(result.previous?.packageIds?.includes("nawabari"), true);
  } finally {
    value.cleanup();
  }
});

test("pre-switch build failure leaves active and previous selection unchanged", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const before = readManagedRuntimeState(value.paths());
    assert.ok(before);
    const beforePointer = readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current"));
    // Reuse the first fixture's state by replacing only the build dependency.
    await assert.rejects(
      reconcileManagedRuntime({
        ...value.baseOptions(),
        manifest: updatedManifest,
        dependencies: {
          ...value.baseOptions().dependencies,
          buildGeneration: () => {
            throw new Error("compiler failed");
          },
        },
      }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "build_failure",
    );
    const after = readManagedRuntimeState(value.paths());
    assert.ok(after);
    assert.equal(after.active?.generationIdentity, before.active?.generationIdentity);
    assert.equal(after.previous, before.previous);
    assert.equal(readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")), beforePointer);
    assert.equal(after.failure?.code, "build_failure");
  } finally {
    value.cleanup();
  }
});

test("pre-switch verification failure leaves active selection unchanged", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const before = readManagedRuntimeState(value.paths());
    assert.ok(before);
    const beforePointer = readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current"));
    await assert.rejects(
      reconcileManagedRuntime({
        ...value.baseOptions(),
        manifest: updatedManifest,
        dependencies: {
          ...value.baseOptions().dependencies,
          verifyGeneration: () => false,
        },
      }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "generation_verification_failure",
    );
    const after = readManagedRuntimeState(value.paths());
    assert.ok(after);
    assert.equal(after.active?.generationIdentity, before.active?.generationIdentity);
    assert.deepEqual(after.previous, before.previous);
    assert.equal(readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")), beforePointer);
    assert.equal(after.activation.phase, "idle");
    assert.equal(after.failure?.code, "generation_verification_failure");
  } finally {
    value.cleanup();
  }
});

test("post-switch health failure rolls back deterministically and retains bounded candidate failure evidence", async () => {
  const value = fixture({
    health: (generation) =>
      generation.generationIdentity === "generation-2"
        ? { healthy: false, generationIdentity: generation.generationIdentity, reason: "readiness timeout" }
        : { healthy: true, generationIdentity: generation.generationIdentity },
  });
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    await assert.rejects(
      reconcileManagedRuntime({ ...value.baseOptions(), manifest: updatedManifest }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "health_failure",
    );
    const state = readManagedRuntimeState(value.paths());
    assert.ok(state);
    assert.equal(state.active?.generationIdentity, "generation-1");
    assert.equal(state.previous, undefined);
    assert.equal(state.failure?.generationIdentity, "generation-2");
    assert.equal(state.failure?.code, "health_failure");
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      "/nix/store/generation-1",
    );
  } finally {
    value.cleanup();
  }
});

test("initial post-switch health failure removes the unproven pointer and returns to bootstrap-ready evidence", async () => {
  const value = fixture({ health: () => ({ healthy: false, reason: "managed service did not start" }) });
  try {
    await assert.rejects(
      reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "health_failure",
    );
    const state = readManagedRuntimeState(value.paths());
    assert.ok(state);
    assert.equal(state.active, undefined);
    assert.equal(state.activation.phase, "idle");
    assert.equal(state.failure?.generationIdentity, "generation-1");
    assert.equal(readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")), undefined);
  } finally {
    value.cleanup();
  }
});

test("compatibility mismatch fails closed before build or activation", async () => {
  const value = fixture();
  try {
    await assert.rejects(
      reconcileManagedRuntime({
        ...value.baseOptions(),
        manifest: initialManifest,
        applianceContract: { contractId: "mottainai.linux-runtime.v2", schemaVersion: 1 },
      }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "compatibility_mismatch",
    );
    assert.equal(value.buildCalls, 0);
    assert.equal(readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")), undefined);
    const state = readManagedRuntimeState(value.paths());
    assert.ok(state);
    assert.equal(state.active, undefined);
    assert.equal(state.failure?.code, "compatibility_mismatch");
  } finally {
    value.cleanup();
  }
});

test("activation-boundary compatibility failure is pre-switch and leaves the prior generation selected", async () => {
  const value = fixture();
  let compatibilityCalls = 0;
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const before = readManagedRuntimeState(value.paths());
    assert.ok(before?.active);
    await assert.rejects(
      reconcileManagedRuntime({
        ...value.baseOptions(),
        manifest: updatedManifest,
        dependencies: {
          ...value.baseOptions().dependencies,
          checkCompatibility: () => {
            compatibilityCalls += 1;
            return compatibilityCalls < 3;
          },
        },
      }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "compatibility_mismatch",
    );
    const after = readManagedRuntimeState(value.paths());
    assert.ok(after);
    assert.equal(compatibilityCalls, 3);
    assert.equal(after.active?.generationIdentity, before.active.generationIdentity);
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      before.active.storePath,
    );
    assert.equal(after.activation.phase, "idle");
    assert.equal(after.failure?.code, "compatibility_mismatch");
  } finally {
    value.cleanup();
  }
});

test("prepared activation recovers from an interruption without rebuilding or guessing the pointer", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const prior = readManagedRuntimeState(value.paths());
    assert.ok(prior?.active);
    const desiredIdentity = semanticIdentityOf(updatedManifest);
    const staged = candidate("generation-interrupted", desiredIdentity, ["mottainai", "nawabari"]);
    const interrupted: ManagedRuntimeState = {
      ...prior,
      desiredManifestSemanticIdentity: desiredIdentity,
      activation: {
        phase: "prepared",
        transactionId: "interrupted-transaction",
        candidate: staged,
        previous: prior.active,
        startedAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    writeManagedRuntimeState(value.paths(), interrupted);

    const result = await reconcileManagedRuntime({
      ...value.baseOptions(),
      manifest: updatedManifest,
      dependencies: {
        healthCheck: async (generation) => ({ healthy: true, generationIdentity: generation.generationIdentity }),
        buildGeneration: () => {
          throw new Error("recovery must not rebuild the persisted candidate");
        },
      },
    });
    assert.equal(result.outcome, "recovered");
    assert.equal(result.active?.generationIdentity, "generation-interrupted");
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      "/nix/store/generation-interrupted",
    );
  } finally {
    value.cleanup();
  }
});

test("switched-health-pending recovery verifies a candidate pointer left behind by a crash", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const prior = readManagedRuntimeState(value.paths());
    assert.ok(prior?.active);
    const desiredIdentity = semanticIdentityOf(updatedManifest);
    const staged = candidate("generation-switched", desiredIdentity, ["mottainai", "nawabari"]);
    atomicallySelectManagedRuntimeGeneration(path.join(value.root, "managed-runtime", "current"), staged.storePath);
    writeManagedRuntimeState(value.paths(), {
      ...prior,
      desiredManifestSemanticIdentity: desiredIdentity,
      activation: {
        phase: "switched-health-pending",
        transactionId: "switched-transaction",
        candidate: staged,
        previous: prior.active,
        startedAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const result = await reconcileManagedRuntime({
      ...value.baseOptions(),
      manifest: updatedManifest,
      dependencies: {
        buildGeneration: () => {
          throw new Error("recovery must not rebuild the persisted candidate");
        },
        healthCheck: async (generation) => ({ healthy: true, generationIdentity: generation.generationIdentity }),
      },
    });
    assert.equal(result.outcome, "recovered");
    assert.equal(result.active?.generationIdentity, "generation-switched");
  } finally {
    value.cleanup();
  }
});

test("explicit recovery rolls back an unhealthy interrupted candidate without starting a new build", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const prior = readManagedRuntimeState(value.paths());
    assert.ok(prior?.active);
    const desiredIdentity = semanticIdentityOf(updatedManifest);
    const staged = candidate("generation-unhealthy", desiredIdentity, ["mottainai", "nawabari"]);
    atomicallySelectManagedRuntimeGeneration(path.join(value.root, "managed-runtime", "current"), staged.storePath);
    writeManagedRuntimeState(value.paths(), {
      ...prior,
      desiredManifestSemanticIdentity: desiredIdentity,
      activation: {
        phase: "switched-health-pending",
        transactionId: "unhealthy-interrupted-transaction",
        candidate: staged,
        previous: prior.active,
        startedAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    let buildCalls = 0;
    const result = await recoverManagedRuntime({
      ...value.baseOptions(),
      manifest: updatedManifest,
      dependencies: {
        buildGeneration: () => {
          buildCalls += 1;
          throw new Error("recovery must not rebuild");
        },
        healthCheck: async (generation) =>
          generation.generationIdentity === staged.generationIdentity
            ? { healthy: false, generationIdentity: generation.generationIdentity, reason: "candidate failed" }
            : { healthy: true, generationIdentity: generation.generationIdentity },
      },
    });
    assert.equal(result.outcome, "rolled-back");
    assert.equal(result.active?.generationIdentity, "generation-1");
    assert.equal(buildCalls, 0);
    const state = readManagedRuntimeState(value.paths());
    assert.ok(state);
    assert.equal(state.activation.phase, "idle");
    assert.equal(state.failure?.generationIdentity, staged.generationIdentity);
    assert.equal(
      readManagedRuntimePointer(path.join(value.root, "managed-runtime", "current")),
      prior.active.storePath,
    );
  } finally {
    value.cleanup();
  }
});

test("an idle state with an unrelated current pointer fails closed instead of guessing an active generation", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const current = path.join(value.root, "managed-runtime", "current");
    fs.unlinkSync(current);
    fs.symlinkSync("/nix/store/unrelated-generation", current);
    await assert.rejects(
      reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest }),
      (error: unknown) => error instanceof ManagedRuntimeError && error.code === "ambiguous_activation",
    );
    assert.equal(readManagedRuntimePointer(current), "/nix/store/unrelated-generation");
  } finally {
    value.cleanup();
  }
});

test("status exposes bounded desired, active, previous, and observed identities", async () => {
  const value = fixture();
  try {
    await reconcileManagedRuntime({ ...value.baseOptions(), manifest: initialManifest });
    const status = readManagedRuntimeStatus({ stateDirectory: value.root });
    assert.equal(status.present, true);
    assert.equal(status.desiredManifestSemanticIdentity?.length, 64);
    assert.equal(status.activeGenerationIdentity, "generation-1");
    assert.equal(status.observedGenerationIdentity, "generation-1");
    assert.equal(status.activationPhase, "idle");
    assert.ok(status.state);
  } finally {
    value.cleanup();
  }
});
