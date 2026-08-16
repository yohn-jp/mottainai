import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalRuntimeProvisioner } from "./reconciler.js";
import { loadLocalRuntimeState, resolveLocalRuntimePaths, saveLocalRuntimeState } from "./state.js";
import { LocalRuntimeError, type LocalRuntimeState, type QemuArtifactIdentity } from "./types.js";
import type { RuntimeCapabilityResult } from "../runtime-contract/contract.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function healthyRuntime(): RuntimeCapabilityResult {
  return {
    contractId: "mottainai.linux-runtime.v1",
    schemaVersion: 1,
    runtimeIdentity: "test-runtime",
    architecture: "x86_64-linux",
    buildIdentity: "/nix/store/test-runtime",
    generation: 1,
    stateOwners: { system: ["/var/lib/mottainai-control"], repositoryUser: ["/var/lib/mottainai/repositories"] },
    requiredCompanions: [],
    reconciliation: "current",
    upgradeRequired: false,
  };
}

function runtimeWith(changes: Partial<RuntimeCapabilityResult>): RuntimeCapabilityResult {
  return { ...healthyRuntime(), ...changes };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFixture(configuration: {
  readonly blockArtifact?: boolean;
  readonly health?: RuntimeCapabilityResult;
  readonly reconciliation?: RuntimeCapabilityResult;
} = {}) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-contract-"));
  const paths = resolveLocalRuntimePaths(stateDirectory, "linux-x64", "linux");
  const artifact = {
    artifactId: "test-qemu",
    version: "9.2.2",
    buildId: "qemu-9.2.2-mottainai-runtime-v1",
    sha256: "a".repeat(64),
    executablePath: paths.qemuExecutable,
  };
  const image = {
    imageId: "test-image",
    architecture: "x86_64-linux" as const,
    buildIdentity: "/nix/store/test-runtime",
    diskSha256: hash("disk"),
  };
  let qemuRunning = false;
  let starts = 0;
  let qemuMaterializations = 0;
  let imageMaterializations = 0;
  let reconcileCalls = 0;
  let currentArtifact = artifact;
  let health = configuration.health ?? healthyRuntime();
  let reconciliation = configuration.reconciliation ?? healthyRuntime();
  const artifactStarted = deferred<void>();
  const releaseArtifact = deferred<void>();
  const observedLifecycles: string[] = [];
  const stateFile = paths.stateFile;

  const observeState = (): void => {
    const state = loadLocalRuntimeState(stateFile);
    if (state !== undefined) observedLifecycles.push(state.lifecycle);
  };

  const provisioner = new LocalRuntimeProvisioner({
    probeHost: () => ({ host: "linux-x64", accelerator: "kvm", architecture: "x64" }),
    materializeQemu: async ({ paths: artifactPaths }) => {
      qemuMaterializations += 1;
      if (configuration.blockArtifact && qemuMaterializations === 1) {
        artifactStarted.resolve();
        await releaseArtifact.promise;
      }
      fs.mkdirSync(artifactPaths.qemuDirectory, { recursive: true });
      fs.writeFileSync(artifactPaths.qemuExecutable, "qemu");
      return currentArtifact;
    },
    materializeImage: ({ paths: imagePaths }) => {
      imageMaterializations += 1;
      const contents = { kernel: "kernel", initrd: "initrd", disk: "disk" };
      fs.mkdirSync(imagePaths.stateDirectory, { recursive: true });
      fs.writeFileSync(imagePaths.kernelImage, contents.kernel);
      fs.writeFileSync(imagePaths.initrdImage, contents.initrd);
      fs.writeFileSync(imagePaths.diskImage, contents.disk);
      fs.writeFileSync(
        imagePaths.imageManifest,
        JSON.stringify({
          imageId: image.imageId,
          contractId: "mottainai.linux-runtime.v1",
          schemaVersion: 1,
          architecture: image.architecture,
          buildIdentity: image.buildIdentity,
          kernelPath: imagePaths.kernelImage,
          kernelSha256: hash(contents.kernel),
          initrdPath: imagePaths.initrdImage,
          initrdSha256: hash(contents.initrd),
          diskPath: imagePaths.diskImage,
          diskSha256: image.diskSha256,
          sshHostKey: "[127.0.0.1]:48321 ssh-ed25519 AAAATEST",
        }),
      );
      return image;
    },
    hostKey: "[127.0.0.1]:48321 ssh-ed25519 AAAATEST",
    createMachine: () => ({
      inspect: async () => {
        observeState();
        return qemuRunning ? "running" : "absent";
      },
      start: async () => {
        observeState();
        starts += 1;
        qemuRunning = true;
        return 12345;
      },
    }),
    createGuest: () => ({
      health: async () => {
        observeState();
        return health;
      },
      reconcile: async () => {
        reconcileCalls += 1;
        observeState();
        return reconciliation;
      },
    }),
  });

  return {
    provisioner,
    paths,
    stateDirectory,
    stateFile,
    artifactStarted: artifactStarted.promise,
    releaseArtifact: () => releaseArtifact.resolve(),
    observedLifecycles,
    get starts() {
      return starts;
    },
    get qemuMaterializations() {
      return qemuMaterializations;
    },
    get imageMaterializations() {
      return imageMaterializations;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    setRunning(value: boolean) {
      qemuRunning = value;
    },
    setArtifact(value: typeof artifact) {
      currentArtifact = value;
    },
    setHealth(value: RuntimeCapabilityResult) {
      health = value;
    },
    setReconciliation(value: RuntimeCapabilityResult) {
      reconciliation = value;
    },
    readState(): LocalRuntimeState {
      const state = loadLocalRuntimeState(stateFile);
      assert.ok(state);
      return state;
    },
    writeState(state: LocalRuntimeState): void {
      saveLocalRuntimeState(stateFile, state);
    },
    cleanup(): void {
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}

test("local Runtime ensure is idempotent and restarts a stopped machine without replacing state", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-test-"));
  let qemuRunning = false;
  let starts = 0;
  let imageMaterializations = 0;
  const artifact = {
    artifactId: "test-qemu",
    version: "9.2.2",
    buildId: "qemu-9.2.2-mottainai-runtime-v1",
    sha256: "a".repeat(64),
    executablePath: path.join(stateDirectory, "qemu-system-x86_64"),
  };
  const image = {
    imageId: "test-image",
    architecture: "x86_64-linux" as const,
    buildIdentity: "/nix/store/test-runtime",
    diskSha256: hash("disk"),
  };
  const runtime = healthyRuntime();
  const provisioner = new LocalRuntimeProvisioner({
    probeHost: () => ({ host: "linux-x64", accelerator: "kvm", architecture: "x64" }),
    materializeQemu: async ({ paths: artifactPaths }) => {
      fs.mkdirSync(artifactPaths.qemuDirectory, { recursive: true });
      fs.writeFileSync(artifactPaths.qemuExecutable, "qemu");
      return artifact;
    },
    materializeImage: ({ paths }) => {
      imageMaterializations += 1;
      const contents = { kernel: "kernel", initrd: "initrd", disk: "disk" };
      fs.mkdirSync(paths.stateDirectory, { recursive: true });
      fs.writeFileSync(paths.kernelImage, contents.kernel);
      fs.writeFileSync(paths.initrdImage, contents.initrd);
      fs.writeFileSync(paths.diskImage, contents.disk);
      fs.writeFileSync(
        paths.imageManifest,
        JSON.stringify({
          imageId: image.imageId,
          contractId: "mottainai.linux-runtime.v1",
          schemaVersion: 1,
          architecture: image.architecture,
          buildIdentity: image.buildIdentity,
          kernelPath: paths.kernelImage,
          kernelSha256: hash(contents.kernel),
          initrdPath: paths.initrdImage,
          initrdSha256: hash(contents.initrd),
          diskPath: paths.diskImage,
          diskSha256: image.diskSha256,
          sshHostKey: "[127.0.0.1]:48321 ssh-ed25519 AAAATEST",
        }),
      );
      return image;
    },
    hostKey: "[127.0.0.1]:48321 ssh-ed25519 AAAATEST",
    createMachine: () => ({
      inspect: async () => (qemuRunning ? "running" : "absent"),
      start: async () => {
        starts += 1;
        qemuRunning = true;
        return 12345;
      },
    }),
    createGuest: () => ({ health: async () => runtime, reconcile: async () => runtime }),
  });
  const options = {
    stateDirectory,
    platform: "linux" as const,
    architecture: "x64",
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  };
  try {
    const first = await provisioner.ensure(options);
    const second = await provisioner.ensure(options);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(starts, 1);
    assert.equal(imageMaterializations, 1);
    assert.equal(second.machineId, "mottainai-local-runtime-v1");
    assert.equal(second.lifecycle, "ready");

    qemuRunning = false;
    const restarted = await provisioner.ensure(options);
    assert.equal(restarted.reused, true);
    assert.equal(starts, 2);
    assert.equal(restarted.image.imageId, image.imageId);
    assert.equal(imageMaterializations, 1);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

const persistedRecoverableLifecycles = [
  "absent",
  "acquiring-substrate",
  "creating",
  "stopped",
  "booting",
  "reachable",
  "reconciling",
  "ready",
  "repairable",
  "failed",
] as const;

for (const lifecycle of persistedRecoverableLifecycles) {
  test(`persisted ${lifecycle} state recovers without image or identity replacement`, async () => {
    const fixture = createFixture();
    try {
      await fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
        now: () => new Date("2026-08-15T00:00:00.000Z"),
      });
      const before = fixture.readState();
      const privateKey = fs.readFileSync(fixture.paths.sshPrivateKey, "utf8");
      const disk = fs.readFileSync(fixture.paths.diskImage, "utf8");
      fixture.writeState({ ...before, lifecycle });
      fixture.setRunning(false);

      const result = await fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
        now: () => new Date("2026-08-15T00:00:01.000Z"),
      });
      const after = fixture.readState();

      assert.equal(result.lifecycle, "ready");
      assert.equal(fixture.starts, 2);
      assert.equal(fixture.imageMaterializations, 1);
      assert.equal(fixture.qemuMaterializations, 2);
      assert.equal(after.lifecycle, "ready");
      assert.equal(after.machineId, before.machineId);
      assert.deepEqual(after.image, before.image);
      assert.deepEqual(after.ssh, before.ssh);
      assert.deepEqual(after.qmp, before.qmp);
      assert.equal(fs.readFileSync(fixture.paths.sshPrivateKey, "utf8"), privateKey);
      assert.equal(fs.readFileSync(fixture.paths.diskImage, "utf8"), disk);
    } finally {
      fixture.cleanup();
    }
  });
}

test("state transitions persist the recoverable path and retain repairable state after failed reconciliation", async () => {
  const fixture = createFixture({
    health: runtimeWith({ reconciliation: "stale" }),
    reconciliation: runtimeWith({ reconciliation: "stale" }),
  });
  try {
    await assert.rejects(
      fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
        now: () => new Date("2026-08-15T00:00:00.000Z"),
      }),
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_reconciliation_failed",
    );
    const repairable = fixture.readState();
    assert.equal(repairable.lifecycle, "repairable");
    assert.equal(repairable.pid, 12345);
    assert.equal(repairable.runtime?.reconciliation, "stale");
    assert.deepEqual(
      new Set(fixture.observedLifecycles),
      new Set(["booting", "reachable", "reconciling"]),
    );

    fixture.setHealth(runtimeWith({ reconciliation: "stale" }));
    fixture.setReconciliation(healthyRuntime());
    fixture.setRunning(true);
    const recovered = await fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
      now: () => new Date("2026-08-15T00:00:01.000Z"),
    });
    assert.equal(recovered.lifecycle, "ready");
    assert.equal(fixture.starts, 1);
    assert.equal(fixture.imageMaterializations, 1);
    assert.equal(fixture.reconcileCalls, 2);
  } finally {
    fixture.cleanup();
  }
});

for (const lifecycle of ["incompatible", "recreate-required"] as const) {
  test(`${lifecycle} state returns an explicit bounded recovery error`, async () => {
    const fixture = createFixture();
    try {
      await fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
        now: () => new Date("2026-08-15T00:00:00.000Z"),
      });
      fixture.writeState({ ...fixture.readState(), lifecycle });
      const starts = fixture.starts;
      const materializations = fixture.qemuMaterializations;
      await assert.rejects(
        fixture.provisioner.ensure({
          stateDirectory: fixture.stateDirectory,
          platform: "linux",
          architecture: "x64",
        }),
        (error: unknown) =>
          error instanceof LocalRuntimeError &&
          error.code === (lifecycle === "incompatible" ? "runtime_incompatible" : "runtime_recreate_required"),
      );
      assert.equal(fixture.starts, starts);
      assert.equal(fixture.qemuMaterializations, materializations);
      assert.equal(fixture.readState().lifecycle, lifecycle);
    } finally {
      fixture.cleanup();
    }
  });
}

test("corrupt persisted state fails closed without starting or replacing the Runtime", async () => {
  const fixture = createFixture();
  try {
    await fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    const starts = fixture.starts;
    const materializations = fixture.qemuMaterializations;
    fs.writeFileSync(fixture.stateFile, "{ not valid json\n");
    await assert.rejects(
      fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
      }),
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_state_corrupt",
    );
    assert.equal(fixture.starts, starts);
    assert.equal(fixture.qemuMaterializations, materializations);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), "{ not valid json\n");
  } finally {
    fixture.cleanup();
  }
});

test("changed QEMU artifact identity returns a recreate plan instead of replacing persistent state", async () => {
  const fixture = createFixture();
  try {
    await fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    fixture.setArtifact({
      ...fixture.readState().qemu,
      sha256: "b".repeat(64),
    });
    fs.rmSync(fixture.paths.qemuExecutable);
    await assert.rejects(
      fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
      }),
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_recreate_required",
    );
    assert.equal(fixture.qemuMaterializations, 1);
    assert.equal(fs.existsSync(fixture.paths.qemuExecutable), false);
    assert.equal(fixture.imageMaterializations, 1);
    assert.equal(fixture.readState().lifecycle, "recreate-required");
  } finally {
    fixture.cleanup();
  }
});

test("changed QEMU runtimeLibraryDirectory returns a recreate plan", async () => {
  const fixture = createFixture();
  try {
    await fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    const originalQemu = fixture.readState().qemu;
    const changedArtifact: QemuArtifactIdentity = {
      ...originalQemu,
      runtimeLibraryDirectory: originalQemu.runtimeLibraryDirectory ? undefined : "/new/lib",
    };
    fixture.setArtifact(changedArtifact);
    await assert.rejects(
      fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
      }),
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_recreate_required",
    );
    assert.equal(fixture.readState().lifecycle, "recreate-required");
  } finally {
    fixture.cleanup();
  }
});

test("missing persisted SSH identity returns a recreate plan instead of rotating the key", async () => {
  const fixture = createFixture();
  try {
    await fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    fs.rmSync(fixture.paths.sshPrivateKey);
    await assert.rejects(
      fixture.provisioner.ensure({
        stateDirectory: fixture.stateDirectory,
        platform: "linux",
        architecture: "x64",
      }),
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_recreate_required",
    );
    assert.equal(fs.existsSync(fixture.paths.sshPrivateKey), false);
    assert.equal(fixture.imageMaterializations, 1);
    assert.equal(fixture.readState().lifecycle, "recreate-required");
  } finally {
    fixture.cleanup();
  }
});

test("simultaneous ensure operations serialize on the Runtime state lock", async () => {
  const fixture = createFixture({ blockArtifact: true });
  try {
    const first = fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    await fixture.artifactStarted;
    const second = fixture.provisioner.ensure({
      stateDirectory: fixture.stateDirectory,
      platform: "linux",
      architecture: "x64",
    });
    await assert.rejects(
      second,
      (error: unknown) => error instanceof LocalRuntimeError && error.code === "runtime_state_corrupt",
    );
    fixture.releaseArtifact();
    await first;
    assert.equal(fixture.starts, 1);
    assert.equal(fixture.imageMaterializations, 1);
    assert.equal(fixture.readState().lifecycle, "ready");
  } finally {
    fixture.cleanup();
  }
});
