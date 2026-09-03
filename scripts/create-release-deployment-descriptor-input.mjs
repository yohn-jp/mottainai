#!/usr/bin/env node
/**
 * Assemble the release fan-in input for build-deployment-descriptor.mjs.
 * The managed-generation file is produced by the Route 2 build; this helper
 * only binds its identity to the exact Route 1 tarball and never fabricates
 * Nix source hashes.
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

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const version = option("version");
const sourceRevision = option("source-revision").toLowerCase();
const tarballPath = path.resolve(option("tarball"));
const initPath = path.resolve(option("init"));
const appliancePath = path.resolve(option("appliance-metadata"));
const providerPath = path.resolve(option("provider-profile"));
const managedPath = path.resolve(option("managed-generation"));
const outputPath = path.resolve(option("output"));
const appliance = readJson(appliancePath, "Runtime Appliance metadata");
const provider = readJson(providerPath, "Route 4 provider profile");
const managed = readJson(managedPath, "managed-generation identity inputs");

const tarballBytes = fs.readFileSync(tarballPath);
const payloadSha256 = sha256(tarballPath);
const payloadIntegrity = `sha512-${crypto.createHash("sha512").update(tarballBytes).digest("base64")}`;
const managedInputs = {
  identity: managed.identity,
  flakeLockSha256: managed.flakeLockSha256,
  applicationPayloadSha256: payloadSha256,
  packages: managed.packages,
};
const repository = process.env.GITHUB_REPOSITORY ?? "yohn-jp/mottainai";
const releaseUrl = `https://github.com/${repository}/releases/download/v${version}`;

const descriptor = {
  contractId: "mottainai.deployment.v1",
  schemaVersion: 1,
  release: { version, tag: `v${version}`, sourceRevision },
  profile: "linux-x86_64",
  architecture: "x86_64-linux",
  contracts: {
    descriptor: "mottainai.deployment.v1",
    application: "mottainai.npm-payload.v1",
    managedGeneration: "mottainai.managed-generation.v1",
    appliance: "mottainai.linux-runtime-appliance.v1",
    provider: "mottainai.route4-provider-profile.v1",
  },
  route1: {
    payload: {
      packageName: "mottainai",
      version,
      sourceRevision,
      filename: path.basename(tarballPath),
      sha256: payloadSha256,
      integrity: payloadIntegrity,
      locator: `${releaseUrl}/${path.basename(tarballPath)}`,
    },
  },
  route2: {
    managedGeneration: {
      contractId: "mottainai.managed-generation.v1",
      schemaVersion: 1,
      version,
      sourceRevision,
      ...managedInputs,
    },
  },
  route3: {
    appliance: {
      contractId: "mottainai.linux-runtime-appliance.v1",
      schemaVersion: 1,
      architecture: "x86_64-linux",
      version,
      sourceRevision,
      registry: "ghcr.io",
      repository: `${repository.toLowerCase()}/runtime-appliance`,
      digest: appliance.digest,
      rawSha256: appliance.rawSha256,
      rawSizeBytes: appliance.rawSizeBytes,
      manifestSha256: appliance.manifestSha256,
      locator: `https://ghcr.io/v2/${repository.toLowerCase()}/runtime-appliance`,
    },
    managedGenerationIdentity: managed.identity,
  },
  route4: {
    mottainaiInit: {
      version,
      sourceRevision,
      architecture: "x86_64-linux",
      filename: path.basename(initPath),
      sha256: sha256(initPath),
      locator: `${releaseUrl}/${path.basename(initPath)}`,
    },
    provider,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o644 });
console.log(`wrote ${outputPath}`);
