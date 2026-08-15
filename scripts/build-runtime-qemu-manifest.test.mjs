import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("QEMU manifest builder stages a reproducible contract with real file digests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-qemu-builder-test-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  fs.mkdirSync(input, { recursive: true });
  const executable = path.join(input, "qemu-system-x86_64");
  const library = path.join(input, "libtest.so");
  const firmware = path.join(input, "test.rom");
  const license = path.join(input, "COPYING");
  fs.writeFileSync(executable, "managed-qemu", { mode: 0o700 });
  fs.writeFileSync(library, "managed-library");
  fs.writeFileSync(firmware, "managed-firmware");
  fs.writeFileSync(license, "GPL-2.0-or-later\n");
  try {
    execFileSync(
      process.execPath,
      [
        "scripts/build-runtime-qemu-manifest.mjs",
        "--host",
        "linux-x64",
        "--executable",
        executable,
        "--output",
        output,
        "--source-revision",
        "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
        "--dependency-mode",
        "bundled",
        "--runtime-library",
        `libtest.so=${library}`,
        "--firmware",
        `test.rom=${firmware}`,
        "--license-file",
        `COPYING=${license}`,
      ],
      { stdio: "pipe" },
    );
    const artifactRoot = path.join(output, "linux-x64", "qemu-linux-x64-9.2.2");
    const manifestPath = path.join(output, "linux-x64", "qemu-linux-x64-9.2.2.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.availability, "available");
    assert.equal(manifest.sha256, sha256("managed-qemu"));
    assert.equal(manifest.runtimeLibraries[0].sha256, sha256("managed-library"));
    assert.equal(manifest.firmware[0].sha256, sha256("managed-firmware"));
    assert.equal(manifest.source.licenseFiles[0], "licenses/COPYING");
    assert.equal(
      manifest.provenance.sourceRevision,
      "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
    );
    execFileSync(
      process.execPath,
      ["scripts/verify-runtime-qemu-artifact.mjs", "--manifest", manifestPath, "--artifact-root", artifactRoot],
      {
        stdio: "pipe",
      },
    );
    const archive = path.join(output, "linux-x64", "qemu-linux-x64-9.2.2.tar");
    assert.ok(fs.statSync(archive).isFile());
    const archiveListing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.match(archiveListing, /bin\/qemu-system-x86_64/);
    assert.match(archiveListing, /manifest\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
