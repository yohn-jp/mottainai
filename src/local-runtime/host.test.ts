import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceleratorForHost, identifyLocalRuntimeHost, probeHostHardware } from "./host.js";

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
