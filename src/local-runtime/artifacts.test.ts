import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeQemuArtifact, QEMU_ARTIFACT_MANIFEST } from "./artifacts.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function paths(root: string) {
  return {
    stateDirectory: root,
    stateFile: path.join(root, "state.json"),
    qmpSocket: path.join(root, "qmp.sock"),
    diskImage: path.join(root, "disk.raw"),
    kernelImage: path.join(root, "kernel"),
    initrdImage: path.join(root, "initrd"),
    imageManifest: path.join(root, "image.json"),
    qemuDirectory: path.join(root, "qemu"),
    qemuExecutable: path.join(root, "qemu", "qemu-system-x86_64"),
    sshDirectory: path.join(root, "ssh"),
    sshPrivateKey: path.join(root, "ssh", "control_ed25519"),
    sshKnownHosts: path.join(root, "ssh", "known_hosts"),
  } as const;
}

test("QEMU artifact is copied lazily from a package-owned bundle and verified before use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-artifact-test-"));
  const bundle = path.join(root, "bundle");
  const manifest = {
    artifactId: "qemu-test",
    version: "9.2.2" as const,
    buildId: "qemu-9.2.2-mottainai-runtime-v1" as const,
    host: "linux-x64" as const,
    executableName: "qemu-system-x86_64",
    downloadUrl: "https://example.invalid/qemu-test.tar.zst",
    sha256: sha256("managed-qemu"),
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later" as const,
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
    },
  };
  const bundled = path.join(bundle, manifest.artifactId);
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, manifest.executableName), "managed-qemu", { mode: 0o700 });
  try {
    const result = await materializeQemuArtifact({
      paths: paths(root),
      host: "linux-x64",
      bundledDirectory: bundle,
      manifest,
    });
    assert.equal(result.sha256, manifest.sha256);
    assert.equal(fs.readFileSync(result.executablePath, "utf8"), "managed-qemu");
    fs.writeFileSync(result.executablePath, "tampered");
    await assert.rejects(
      materializeQemuArtifact({ paths: paths(root), host: "linux-x64", bundledDirectory: bundle, manifest }),
      /SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default manifest for a host without a released executable is rejected, not silently trusted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-artifact-test-"));
  try {
    await assert.rejects(
      materializeQemuArtifact({ paths: paths(root), host: "linux-x64", manifest: QEMU_ARTIFACT_MANIFEST["linux-x64"] }),
      /has no built executable yet/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
