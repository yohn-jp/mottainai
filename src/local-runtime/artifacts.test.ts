import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertQemuArtifactManifest, materializeQemuArtifact, QEMU_ARTIFACT_MANIFEST } from "./artifacts.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

function manifestFixture(overrides: Record<string, unknown> = {}) {
  const defaults = {
    schemaVersion: 2 as const,
    availability: "available" as const,
    artifactId: "qemu-linux-x64-9.2.2",
    version: "9.2.2" as const,
    buildId: "qemu-9.2.2-mottainai-runtime-v1" as const,
    host: "linux-x64" as const,
    executableName: "qemu-system-x86_64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-linux-x64-9.2.2.tar",
    sha256: sha256("managed-qemu"),
    archive: { name: "qemu-linux-x64-9.2.2.tar", size: 1, sha256: sha256("unused-bundled-archive") },
    dependencyMode: "bundled" as const,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later" as const,
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      licenseFiles: [{ name: "COPYING", path: "licenses/COPYING", sha256: sha256("license") }],
    },
    provenance: {
      sourceRevision: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      sourceDateEpoch: 0,
      builder: "test",
      workflow: "test",
      toolchain: "test",
      configureArgs: ["--test"],
    },
  };
  return { ...defaults, ...overrides } as const;
}

test("QEMU artifact is copied lazily from a package-owned bundle and verified before use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-artifact-test-"));
  const bundle = path.join(root, "bundle");
  const manifest = manifestFixture();
  const bundled = path.join(bundle, manifest.artifactId);
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(path.join(bundled, "licenses"), { recursive: true });
  fs.writeFileSync(path.join(bundled, manifest.executableName), "managed-qemu", { mode: 0o700 });
  fs.writeFileSync(path.join(bundled, "licenses", "COPYING"), "license");
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
      /has no verified platform artifact yet/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("available manifest rejects wrong identity, schema, provenance, and unsafe dependency paths", () => {
  const manifest = {
    schemaVersion: 2 as const,
    availability: "available" as const,
    artifactId: "qemu-linux-x64-9.2.2",
    version: "9.2.2" as const,
    buildId: "qemu-9.2.2-mottainai-runtime-v1" as const,
    host: "linux-x64" as const,
    executableName: "qemu-system-x86_64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-linux-x64-9.2.2.tar",
    sha256: sha256("managed-qemu"),
    archive: { name: "qemu-linux-x64-9.2.2.tar", size: 7, sha256: sha256("archive") },
    dependencyMode: "bundled" as const,
    runtimeLibraries: [{ name: "libtest.so", path: "lib/libtest.so", sha256: sha256("library") }],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later" as const,
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      licenseFiles: [{ name: "COPYING", path: "licenses/COPYING", sha256: sha256("license") }],
    },
    provenance: {
      sourceRevision: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      sourceDateEpoch: 0,
      builder: "test",
      workflow: "test",
      toolchain: "test",
      configureArgs: ["--test"],
    },
  };
  assert.doesNotThrow(() => assertQemuArtifactManifest(manifest, "linux-x64"));
  const invalid = [
    { ...manifest, schemaVersion: 1 },
    { ...manifest, artifactId: "qemu-wrong-9.2.2" },
    { ...manifest, buildId: "qemu-unknown" },
    { ...manifest, provenance: undefined },
    { ...manifest, archive: { ...manifest.archive, name: "other.tar" } },
    { ...manifest, runtimeLibraries: [{ ...manifest.runtimeLibraries[0], path: "../libtest.so" }] },
    { ...manifest, source: { ...manifest.source, sha256: sha256("wrong-source") } },
  ];
  for (const candidate of invalid) {
    assert.throws(() => assertQemuArtifactManifest(candidate as never, "linux-x64"), /not a verified/);
  }
  // Negative case: dependencyMode undefined
  assert.throws(
    () => assertQemuArtifactManifest({ ...manifest, dependencyMode: undefined } as never, "linux-x64"),
    /not a verified/,
  );
  // Negative case: static dependencyMode with non-empty runtimeLibraries
  assert.throws(
    () =>
      assertQemuArtifactManifest(
        { ...manifest, dependencyMode: "static", runtimeLibraries: [manifest.runtimeLibraries[0]] } as never,
        "linux-x64",
      ),
    /not a verified/,
  );
  // Negative case: downloadUrl from untrusted origin
  assert.throws(
    () =>
      assertQemuArtifactManifest(
        {
          ...manifest,
          downloadUrl: "https://evil.example.com/qemu-linux-x64-9.2.2.tar",
          archive: { ...manifest.archive, name: "qemu-linux-x64-9.2.2.tar" },
        } as never,
        "linux-x64",
      ),
    /not a pinned mottainai release asset/,
  );
});

test("available manifests verify packaged runtime libraries and firmware on every reuse", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-dependency-test-"));
  const bundle = path.join(root, "bundle");
  const artifactRoot = path.join(bundle, "linux-x64", "qemu-linux-x64-9.2.2");
  const executable = "managed-qemu";
  const library = "runtime-library";
  const firmware = "runtime-firmware";
  const manifest = manifestFixture({
    sha256: sha256(executable),
    runtimeLibraries: [{ name: "libtest.so", path: "lib/libtest.so", sha256: sha256(library) }],
    firmware: [{ name: "test.rom", path: "share/firmware/test.rom", sha256: sha256(firmware) }],
  });
  fs.mkdirSync(path.join(artifactRoot, "bin", "unused"), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, "lib"), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, "share", "firmware"), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, "licenses"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "bin", manifest.executableName), executable, { mode: 0o700 });
  fs.writeFileSync(path.join(artifactRoot, "lib", "libtest.so"), library);
  fs.writeFileSync(path.join(artifactRoot, "share", "firmware", "test.rom"), firmware);
  fs.writeFileSync(path.join(artifactRoot, "licenses", "COPYING"), "license");
  try {
    const result = await materializeQemuArtifact({
      paths: paths(root),
      host: "linux-x64",
      bundledDirectory: bundle,
      manifest,
    });
    assert.equal(result.sha256, manifest.sha256);
    assert.equal(result.runtimeLibraryDirectory, path.join(root, "qemu", "lib"));
    assert.equal(fs.readFileSync(path.join(root, "qemu", "lib", "libtest.so"), "utf8"), library);
    fs.writeFileSync(path.join(root, "qemu", "share", "firmware", "test.rom"), "tampered");
    await assert.rejects(
      materializeQemuArtifact({ paths: paths(root), host: "linux-x64", bundledDirectory: bundle, manifest }),
      /SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("available release archives are extracted into the private state root before verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-archive-test-"));
  const stage = path.join(root, "stage");
  const archive = path.join(root, "qemu-test.tar");
  const bundle = path.join(root, "bundle");
  const executable = "archive-qemu";
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
  fs.mkdirSync(path.join(stage, "licenses"), { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(stage, "bin", "qemu-system-x86_64"), executable, { mode: 0o700 });
  fs.writeFileSync(path.join(stage, "licenses", "COPYING"), "license");
  execFileSync("tar", ["-cf", archive, "-C", stage, "."]);
  const manifest = manifestFixture({
    sha256: sha256(executable),
    archive: {
      name: "qemu-linux-x64-9.2.2.tar",
      size: fs.statSync(archive).size,
      sha256: fileSha256(archive),
    },
  });
  const fetcher = async (url: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const body = url.endsWith(".manifest.json") ? Buffer.from(JSON.stringify(manifest)) : fs.readFileSync(archive);
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
  try {
    const result = await materializeQemuArtifact({
      paths: paths(root),
      host: "linux-x64",
      bundledDirectory: bundle,
      fetcher,
    });
    assert.equal(result.sha256, manifest.sha256);
    assert.equal(fs.readFileSync(path.join(root, "qemu", manifest.executableName), "utf8"), executable);
    await assert.rejects(
      materializeQemuArtifact({
        paths: paths(path.join(root, "size-mismatch")),
        host: "linux-x64",
        manifest: { ...manifest, archive: { ...manifest.archive, size: manifest.archive.size + 1 } },
        fetcher,
      }),
      /archive size mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release archive links are rejected before extraction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-link-archive-test-"));
  const stage = path.join(root, "stage");
  const archive = path.join(root, "qemu-linux-x64-9.2.2.tar");
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
  fs.mkdirSync(path.join(stage, "licenses"), { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  fs.symlinkSync("../../outside-qemu", path.join(stage, "bin", "qemu-system-x86_64"));
  fs.writeFileSync(path.join(stage, "licenses", "COPYING"), "license");
  execFileSync("tar", ["-cf", archive, "-C", stage, "."]);
  const manifest = manifestFixture({
    sha256: sha256("outside-qemu"),
    archive: { name: path.basename(archive), size: fs.statSync(archive).size, sha256: fileSha256(archive) },
  });
  try {
    await assert.rejects(
      materializeQemuArtifact({
        paths: paths(root),
        host: "linux-x64",
        bundledDirectory: bundle,
        fetcher: async (url) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              const body = url.endsWith(".manifest.json")
                ? Buffer.from(JSON.stringify(manifest))
                : fs.readFileSync(archive);
              controller.enqueue(new Uint8Array(body));
              controller.close();
            },
          }),
      }),
      /link or special file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
