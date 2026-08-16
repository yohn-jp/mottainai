import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRuntimeImageManifest } from "./image.js";

test("resolves Runtime image assets relative to the relocatable manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-image-"));
  const manifestPath = path.join(directory, "runtime-image.json");
  try {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        imageId: "runtime-test",
        contractId: "mottainai.linux-runtime.v1",
        schemaVersion: 1,
        architecture: "x86_64-linux",
        buildIdentity: "runtime-test-build",
        kernelPath: "kernel",
        kernelSha256: "a".repeat(64),
        initrdPath: "initrd",
        initrdSha256: "b".repeat(64),
        diskPath: "runtime-disk.raw",
        diskSha256: "c".repeat(64),
        sshHostKey: "127.0.0.1 ssh-ed25519 test-key runtime-test",
      }),
    );

    const manifest = readRuntimeImageManifest(manifestPath);
    assert.equal(manifest.kernelPath, path.join(directory, "kernel"));
    assert.equal(manifest.initrdPath, path.join(directory, "initrd"));
    assert.equal(manifest.diskPath, path.join(directory, "runtime-disk.raw"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
