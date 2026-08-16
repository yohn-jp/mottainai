import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalRuntimeProvisioner } from "./reconciler.js";
import { acceleratorForHost, identifyLocalRuntimeHost, probeHostHardware } from "./host.js";
import { LocalRuntimeError } from "./types.js";

test("local Runtime maps every supported host to one QEMU accelerator", () => {
  assert.equal(identifyLocalRuntimeHost("linux", "x64"), "linux-x64");
  assert.equal(identifyLocalRuntimeHost("linux", "arm64"), "linux-arm64");
  assert.equal(identifyLocalRuntimeHost("darwin", "arm64"), "macos-arm64");
  assert.equal(identifyLocalRuntimeHost("darwin", "x64"), "macos-x64");
  assert.equal(identifyLocalRuntimeHost("win32", "x64"), "windows-x64");
  assert.equal(acceleratorForHost("linux-x64"), "kvm");
  assert.equal(acceleratorForHost("macos-arm64"), "hvf");
  assert.equal(acceleratorForHost("windows-x64"), "whpx");
});

test("unsupported host/architecture is rejected instead of selecting a fallback", () => {
  assert.throws(() => identifyLocalRuntimeHost("linux", "ia32"), /canonical local Runtime supports/);
  assert.throws(() => identifyLocalRuntimeHost("freebsd", "x64"), /canonical local Runtime supports/);
});

test("Linux without /dev/kvm fails closed", { skip: fs.existsSync("/dev/kvm") }, () => {
  assert.throws(() => probeHostHardware("linux-x64"), /KVM hardware acceleration is unavailable.*\/dev\/kvm/u);
});

test("unavailable acceleration stops ensure before artifact or image execution", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-acceleration-test-"));
  let artifactCalls = 0;
  let imageCalls = 0;
  try {
    const provisioner = new LocalRuntimeProvisioner({
      probeHost: () => {
        throw new LocalRuntimeError(
          "hardware_acceleration_unavailable",
          "KVM hardware acceleration is unavailable; no fallback is allowed",
        );
      },
      materializeQemu: async () => {
        artifactCalls += 1;
        throw new Error("must not execute");
      },
      materializeImage: () => {
        imageCalls += 1;
        throw new Error("must not execute");
      },
    });
    await assert.rejects(
      provisioner.ensure({ stateDirectory, platform: "linux", architecture: "x64" }),
      (error: unknown) =>
        error instanceof LocalRuntimeError && error.code === "hardware_acceleration_unavailable",
    );
    assert.equal(artifactCalls, 0);
    assert.equal(imageCalls, 0);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
