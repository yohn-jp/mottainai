import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalRuntimeProvisioner } from "./reconciler.js";
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
    materializeQemu: async () => artifact,
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
