#!/usr/bin/env node
/**
 * Bind a realized managed-generation metadata output to the release fan-in
 * contract. The generation identity is always obtained from the runtime
 * contract; this file does not implement a parallel identity algorithm.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const manifestPath = path.resolve(option("manifest"));
const metadataPath = path.resolve(option("metadata"));
const payloadPath = path.resolve(option("payload"));
const flakeLockPath = path.resolve(option("flake-lock"));
const sourceNarSha256 = option("source-nar-sha256");
const outputPath = path.resolve(option("output"));

if (!/^[0-9a-f]{64}$/.test(sourceNarSha256)) {
  throw new Error(`canonical source NAR identity is not lowercase hex SHA-256: ${sourceNarSha256}`);
}

const { generationIdentityOf, parseManagedGenerationMetadata } = await import(
  "../src/runtime-contract/managed-generation.ts"
);
const { parseManagedPackageManifest } = await import("../src/runtime-contract/managed-package-manifest.ts");

const manifest = parseManagedPackageManifest(readJson(manifestPath, "managed-package-manifest"));
const metadata = parseManagedGenerationMetadata(readJson(metadataPath, "managed-generation metadata"));
const payloadSha256 = sha256(payloadPath);
const manifestPackage = manifest.packages.find((entry) => entry.packageId === "mottainai");
if (manifestPackage === undefined || manifestPackage.source.sourceSha256 !== sourceNarSha256) {
  throw new Error(
    `managed-generation manifest source identity mismatch; canonical Route 2 source NAR is ${sourceNarSha256}`,
  );
}
if (
  metadata.applicationPayload === undefined ||
  metadata.applicationPayload.packageName !== "mottainai" ||
  metadata.applicationPayload.packageVersion !== manifestPackage.version ||
  metadata.applicationPayload.sha256 !== payloadSha256
) {
  throw new Error(
    `managed-generation metadata does not prove the exact Route 1 payload was consumed: expected ${payloadSha256}`,
  );
}
const requestedPackage = metadata.requestedIdentity.packages.find((entry) => entry.packageId === "mottainai");
if (requestedPackage === undefined || requestedPackage.sourceSha256 !== sourceNarSha256) {
  throw new Error(
    `managed-generation metadata source identity mismatch; canonical Route 2 source NAR is ${sourceNarSha256}`,
  );
}
const generationIdentity = generationIdentityOf(manifest, metadata);

const result = {
  manifest,
  metadata,
  generationIdentity,
  flakeLockSha256: sha256(flakeLockPath),
  applicationPayloadSha256: payloadSha256,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ output: outputPath, generationIdentity }, null, 2));
