// Builds a local, content-addressed layout of the published Runtime
// Appliance GHCR OCI Artifact contract (docs/runtime-appliance-oci.md) from
// the real, already-built canonical Runtime Appliance disk and its bounded
// manifest (scripts/build-runtime-appliance-manifest.mjs's output).
//
// This does not talk to a registry. It exists so CI can prove
// `mottainai-init runtime ensure`'s appliance resolution/verification
// (host-bootstrap/src/appliance.rs) against the exact bytes the real Nix
// build produces, using host-bootstrap's `FileOciSource` in place of a
// network registry (Issue #661 review: "add a bounded composition proof
// using the actual canonical Appliance output").
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function digest(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

const manifestPath = path.resolve(option("manifest"));
const diskPath = path.resolve(option("disk"));
const output = path.resolve(option("output"));

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (typeof manifest.sourceRevision !== "string" || !/^[0-9a-f]{40}$/iu.test(manifest.sourceRevision)) {
  throw new Error(`invalid Runtime Appliance manifest sourceRevision: ${manifestPath}`);
}
if (!fs.statSync(diskPath).isFile()) {
  throw new Error(`missing canonical Runtime Appliance disk: ${diskPath}`);
}

fs.mkdirSync(output, { recursive: true });
const blobsDirectory = path.join(output, "blobs");
fs.mkdirSync(blobsDirectory, { recursive: true });

const compressedPath = path.join(output, "mottainai-runtime-appliance.raw.zst");
const zstd = spawnSync("zstd", ["-q", "-f", "-o", compressedPath, diskPath], { stdio: "inherit" });
if (zstd.status !== 0) {
  throw new Error(`zstd compression of the canonical Runtime Appliance disk failed (exit ${zstd.status})`);
}

const releaseMetadata = {
  sourceRevision: manifest.sourceRevision,
  canonicalManifest: "runtime-appliance-manifest.json",
  compressedAsset: {
    filename: "mottainai-runtime-appliance.raw.zst",
    format: "zstd",
    sizeBytes: fs.statSync(compressedPath).size,
    sha256: digest(compressedPath),
  },
};
const releaseMetadataPath = path.join(output, "runtime-appliance-release-metadata.json");
fs.writeFileSync(releaseMetadataPath, `${JSON.stringify(releaseMetadata, null, 2)}\n`, { mode: 0o644 });

function blob(sourcePath, mediaType) {
  const bytes = fs.readFileSync(sourcePath);
  const hexDigest = createHash("sha256").update(bytes).digest("hex");
  fs.copyFileSync(sourcePath, path.join(blobsDirectory, hexDigest));
  return { mediaType, digest: `sha256:${hexDigest}`, size: bytes.length };
}

const layers = [
  blob(compressedPath, "application/vnd.mottainai.runtime.appliance.raw.v1+zstd"),
  blob(manifestPath, "application/vnd.mottainai.runtime.appliance.manifest.v1+json"),
  blob(releaseMetadataPath, "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json"),
];

const ociManifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  artifactType: "application/vnd.mottainai.runtime.appliance.v1",
  layers,
};
const ociManifestPath = path.join(output, "oci-manifest.json");
fs.writeFileSync(ociManifestPath, `${JSON.stringify(ociManifest, null, 2)}\n`, { mode: 0o644 });

console.log(
  JSON.stringify(
    {
      ociManifest: ociManifestPath,
      blobsDirectory,
      digest: `sha256:${digest(ociManifestPath)}`,
    },
    null,
    2,
  ),
);
