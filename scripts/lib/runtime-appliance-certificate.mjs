import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_APPLIANCE_CERTIFICATE_CONTRACT_ID = "mottainai.runtime-appliance-certification.v1";
export const RUNTIME_APPLIANCE_CERTIFICATE_SCHEMA_VERSION = 1;

const FILES = Object.freeze({
  raw: "mottainai-runtime-appliance.raw",
  manifest: "runtime-appliance-manifest.json",
  compressed: "mottainai-runtime-appliance.raw.zst",
  releaseMetadata: "runtime-appliance-release-metadata.json",
  ociManifest: "oci-manifest.json",
});

function sha256File(filePath) {
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

function fileIdentity(directory, filename) {
  if (path.basename(filename) !== filename) throw new Error(`unsafe certified artifact filename: ${filename}`);
  const filePath = path.join(directory, filename);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`certified artifact is missing or empty: ${filename}`);
  return { filename, sizeBytes: stat.size, sha256: sha256File(filePath) };
}

function readJson(directory, filename) {
  return JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
}

function jsonSha256(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function layerByMediaType(ociManifest, mediaType) {
  const layers = ociManifest?.layers;
  if (!Array.isArray(layers)) throw new Error("certified OCI manifest layers are invalid");
  const matches = layers.filter((layer) => layer?.mediaType === mediaType);
  if (matches.length !== 1) throw new Error(`certified OCI manifest must contain one ${mediaType} layer`);
  return matches[0];
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}; expected ${expected}, got ${actual}`);
}

function assertIdentity(actual, expected, label) {
  assertEqual(actual.filename, expected.filename, `${label} filename mismatch`);
  assertEqual(actual.sizeBytes, expected.sizeBytes, `${label} size mismatch`);
  assertEqual(actual.sha256, expected.sha256, `${label} SHA-256 mismatch`);
}

function identityForLayer(directory, ociManifest, mediaType, expectedFilename) {
  const layer = layerByMediaType(ociManifest, mediaType);
  const title = layer.annotations?.["org.opencontainers.image.title"];
  if (title !== undefined) assertEqual(title, expectedFilename, `${mediaType} layer title mismatch`);
  if (typeof layer.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(layer.digest)) {
    throw new Error(`${mediaType} layer digest is invalid`);
  }
  if (!Number.isInteger(layer.size) || layer.size <= 0) throw new Error(`${mediaType} layer size is invalid`);
  return { filename: expectedFilename, sizeBytes: layer.size, sha256: layer.digest.slice("sha256:".length) };
}

export function buildRuntimeApplianceCertificate({ directory, sourceRevision, workflow, job, runId, runAttempt }) {
  if (!/^[0-9a-f]{40}$/iu.test(sourceRevision)) throw new Error("sourceRevision must be a full Git SHA");
  const manifest = readJson(directory, FILES.manifest);
  if (manifest.sourceRevision?.toLowerCase() !== sourceRevision.toLowerCase()) {
    throw new Error("Runtime Appliance manifest sourceRevision does not match the certification revision");
  }
  const ociManifest = readJson(directory, FILES.ociManifest);
  const raw = fileIdentity(directory, FILES.raw);
  const manifestIdentity = fileIdentity(directory, FILES.manifest);
  const compressed = fileIdentity(directory, FILES.compressed);
  const releaseMetadata = fileIdentity(directory, FILES.releaseMetadata);
  const oci = fileIdentity(directory, FILES.ociManifest);
  const releaseMetadataValue = readJson(directory, FILES.releaseMetadata);
  assertEqual(
    releaseMetadataValue.contractId,
    "mottainai.linux-runtime-appliance-release.v1",
    "Runtime Appliance release metadata contractId mismatch",
  );
  assertEqual(releaseMetadataValue.schemaVersion, 1, "Runtime Appliance release metadata schemaVersion mismatch");
  assertEqual(
    releaseMetadataValue.sourceRevision?.toLowerCase(),
    sourceRevision.toLowerCase(),
    "Runtime Appliance release metadata sourceRevision mismatch",
  );
  assertEqual(
    releaseMetadataValue.canonicalManifest,
    manifestIdentity.filename,
    "Runtime Appliance release metadata manifest reference mismatch",
  );
  assertEqual(
    releaseMetadataValue.compressedAsset?.filename,
    compressed.filename,
    "Runtime Appliance release metadata compressed filename mismatch",
  );
  assertEqual(
    releaseMetadataValue.compressedAsset?.sizeBytes,
    compressed.sizeBytes,
    "Runtime Appliance release metadata compressed size mismatch",
  );
  assertEqual(
    releaseMetadataValue.compressedAsset?.sha256,
    compressed.sha256,
    "Runtime Appliance release metadata compressed SHA-256 mismatch",
  );
  assertEqual(manifest.image?.filename, raw.filename, "Runtime Appliance manifest raw filename mismatch");
  assertEqual(manifest.image?.sizeBytes, raw.sizeBytes, "Runtime Appliance manifest raw size mismatch");
  assertEqual(manifest.image?.sha256, raw.sha256, "Runtime Appliance manifest raw SHA-256 mismatch");
  assertEqual(ociManifest.schemaVersion, 2, "OCI manifest schemaVersion mismatch");
  assertEqual(ociManifest.mediaType, "application/vnd.oci.image.manifest.v1+json", "OCI manifest mediaType mismatch");
  assertEqual(ociManifest.artifactType, "application/vnd.mottainai.runtime.appliance.v1", "OCI artifactType mismatch");
  const ociLayers = [
    identityForLayer(
      directory,
      ociManifest,
      "application/vnd.mottainai.runtime.appliance.raw.v1+zstd",
      compressed.filename,
    ),
    identityForLayer(
      directory,
      ociManifest,
      "application/vnd.mottainai.runtime.appliance.manifest.v1+json",
      manifestIdentity.filename,
    ),
    identityForLayer(
      directory,
      ociManifest,
      "application/vnd.mottainai.runtime.appliance.release-metadata.v1+json",
      releaseMetadata.filename,
    ),
  ];
  assertIdentity(ociLayers[0], compressed, "OCI compressed layer");
  assertIdentity(ociLayers[1], manifestIdentity, "OCI manifest layer");
  assertIdentity(ociLayers[2], releaseMetadata, "OCI release metadata layer");
  return {
    contractId: RUNTIME_APPLIANCE_CERTIFICATE_CONTRACT_ID,
    schemaVersion: RUNTIME_APPLIANCE_CERTIFICATE_SCHEMA_VERSION,
    architecture: manifest.architecture,
    sourceRevision: sourceRevision.toLowerCase(),
    certification: {
      workflow,
      job,
      runId: String(runId),
      runAttempt: String(runAttempt),
    },
    canonical: { raw, manifest: manifestIdentity, compressed, releaseMetadata },
    oci: {
      filename: oci.filename,
      sizeBytes: oci.sizeBytes,
      sha256: oci.sha256,
      digest: `sha256:${jsonSha256(ociManifest)}`,
      layers: ociLayers,
    },
  };
}

export function verifyRuntimeApplianceCertificate({ directory, certificate, sourceRevision }) {
  if (
    certificate?.contractId !== RUNTIME_APPLIANCE_CERTIFICATE_CONTRACT_ID ||
    certificate?.schemaVersion !== RUNTIME_APPLIANCE_CERTIFICATE_SCHEMA_VERSION
  ) {
    throw new Error("Runtime Appliance certification evidence contract is invalid");
  }
  if (sourceRevision !== undefined && certificate.sourceRevision !== sourceRevision.toLowerCase()) {
    throw new Error(
      `Runtime Appliance certification revision mismatch; expected ${sourceRevision}, got ${certificate.sourceRevision}`,
    );
  }
  const expected = certificate.canonical;
  if (expected === null || typeof expected !== "object") throw new Error("certified canonical identities are missing");
  for (const key of ["raw", "manifest", "compressed", "releaseMetadata"]) {
    const identity = fileIdentity(directory, expected[key].filename);
    assertIdentity(identity, expected[key], `certified ${key}`);
  }
  const ociIdentity = fileIdentity(directory, certificate.oci.filename);
  assertIdentity(ociIdentity, certificate.oci, "certified OCI manifest");
  const generated = buildRuntimeApplianceCertificate({
    directory,
    sourceRevision: certificate.sourceRevision,
    workflow: certificate.certification.workflow,
    job: certificate.certification.job,
    runId: certificate.certification.runId,
    runAttempt: certificate.certification.runAttempt,
  });
  assertIdentity(generated.canonical.raw, expected.raw, "generated raw identity");
  assertIdentity(generated.canonical.manifest, expected.manifest, "generated manifest identity");
  assertIdentity(generated.canonical.compressed, expected.compressed, "generated compressed identity");
  assertIdentity(generated.canonical.releaseMetadata, expected.releaseMetadata, "generated release metadata identity");
  assertIdentity(generated.oci, certificate.oci, "generated OCI identity");
  assertEqual(generated.oci.digest, certificate.oci.digest, "generated OCI descriptor digest mismatch");
  if (!Array.isArray(certificate.oci.layers) || certificate.oci.layers.length !== generated.oci.layers.length) {
    throw new Error("certified OCI layer identity count mismatch");
  }
  for (let index = 0; index < generated.oci.layers.length; index += 1) {
    assertIdentity(generated.oci.layers[index], certificate.oci.layers[index], `generated OCI layer ${index}`);
  }
  return certificate;
}

export { FILES, fileIdentity, sha256File };
