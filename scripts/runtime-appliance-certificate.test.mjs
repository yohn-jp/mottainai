import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRuntimeApplianceCertificate,
  verifyRuntimeApplianceCertificate,
} from "./lib/runtime-appliance-certificate.mjs";

const SOURCE_REVISION = "a".repeat(40);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-runtime-appliance-certificate-"));
  const raw = Buffer.from("certified raw appliance bytes\n");
  const compressed = Buffer.from("certified deterministic zstd envelope\n");
  const manifest = {
    contractId: "mottainai.linux-runtime-appliance.v1",
    schemaVersion: 1,
    architecture: "x86_64-linux",
    sourceRevision: SOURCE_REVISION,
    nixSystemClosure: "/nix/store/certified-appliance",
    mottainaiVersion: "1.2.3",
    nawabariVersion: "1.2.3",
    image: { filename: "mottainai-runtime-appliance.raw", format: "raw", sizeBytes: raw.length, sha256: sha256(raw) },
    canonicalSource: {
      flake: "nix/flake.nix",
      output: "applianceConfigurations.x86_64-linux.config.system.build.toplevel",
    },
  };
  const releaseMetadata = {
    contractId: "mottainai.linux-runtime-appliance-release.v1",
    schemaVersion: 1,
    architecture: "x86_64-linux",
    sourceRevision: SOURCE_REVISION,
    canonicalManifest: "runtime-appliance-manifest.json",
    compressedAsset: {
      filename: "mottainai-runtime-appliance.raw.zst",
      format: "zstd",
      sizeBytes: compressed.length,
      sha256: sha256(compressed),
    },
  };
  fs.writeFileSync(path.join(directory, "mottainai-runtime-appliance.raw"), raw);
  fs.writeFileSync(path.join(directory, "runtime-appliance-manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "mottainai-runtime-appliance.raw.zst"), compressed);
  fs.writeFileSync(path.join(directory, "runtime-appliance-release-metadata.json"), JSON.stringify(releaseMetadata));
  const layers = [
    ["mottainai-runtime-appliance.raw.zst", "application/vnd.mottainai.runtime.appliance.raw.v1+zstd", compressed],
    [
      "runtime-appliance-manifest.json",
      "application/vnd.mottainai.runtime.appliance.manifest.v1+json",
      Buffer.from(JSON.stringify(manifest)),
    ],
    [
      "runtime-appliance-release-metadata.json",
      "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json",
      Buffer.from(JSON.stringify(releaseMetadata)),
    ],
  ];
  const ociManifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.mottainai.runtime.appliance.v1",
    layers: layers.map(([filename, mediaType, bytes]) => ({
      mediaType,
      digest: `sha256:${sha256(bytes)}`,
      size: bytes.length,
      annotations: { "org.opencontainers.image.title": filename },
    })),
  };
  fs.writeFileSync(path.join(directory, "oci-manifest.json"), JSON.stringify(ociManifest));
  return directory;
}

test("certified Runtime Appliance evidence verifies exact raw, layer, and OCI identities", () => {
  const directory = writeFixture();
  try {
    const certificate = buildRuntimeApplianceCertificate({
      directory,
      sourceRevision: SOURCE_REVISION,
      workflow: "ci.yml",
      job: "runtime-appliance",
      runId: "123",
      runAttempt: "1",
    });
    assert.equal(
      certificate.canonical.raw.sizeBytes,
      fs.statSync(path.join(directory, certificate.canonical.raw.filename)).size,
    );
    assert.match(certificate.oci.digest, /^sha256:[0-9a-f]{64}$/u, "OCI identity must be content-addressed");
    assert.equal(
      certificate.oci.sha256,
      certificate.oci.digest.slice("sha256:".length),
      "the certified OCI fixture bytes must be the published descriptor identity",
    );
    assert.doesNotThrow(() =>
      verifyRuntimeApplianceCertificate({ directory, certificate, sourceRevision: SOURCE_REVISION }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("certified Runtime Appliance evidence rejects a changed byte and a different certification revision", () => {
  const directory = writeFixture();
  try {
    const certificate = buildRuntimeApplianceCertificate({
      directory,
      sourceRevision: SOURCE_REVISION,
      workflow: "ci.yml",
      job: "runtime-appliance",
      runId: "123",
      runAttempt: "1",
    });
    const rawPath = path.join(directory, "mottainai-runtime-appliance.raw");
    fs.appendFileSync(rawPath, "tampered");
    assert.throws(
      () => verifyRuntimeApplianceCertificate({ directory, certificate, sourceRevision: SOURCE_REVISION }),
      /certified raw size mismatch/u,
    );
    fs.writeFileSync(rawPath, Buffer.from("certified raw appliance bytes\n"));
    assert.throws(
      () => verifyRuntimeApplianceCertificate({ directory, certificate, sourceRevision: "b".repeat(40) }),
      /certification revision mismatch/u,
    );
    const ociPath = path.join(directory, "oci-manifest.json");
    const oci = JSON.parse(fs.readFileSync(ociPath, "utf8"));
    oci.annotations = { ...oci.annotations, tampered: true };
    fs.writeFileSync(ociPath, JSON.stringify(oci));
    assert.throws(
      () => verifyRuntimeApplianceCertificate({ directory, certificate, sourceRevision: SOURCE_REVISION }),
      /certified OCI manifest (?:size|SHA-256) mismatch/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
