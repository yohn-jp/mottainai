#!/usr/bin/env node
/**
 * Derive one `mottainai-init runtime ensure --spec PATH` Runtime
 * specification, including Issue #753's desired managed-generation intent,
 * from an exact immutable deployment descriptor (#755/ADR-0003). This is the
 * zero-manual composition boundary ADR-0003 requires: the operator selects a
 * release descriptor, and Route 3's Appliance identity and desired managed
 * manifest are both derived automatically — no manual guest file injection,
 * no hand-authored manifest.
 *
 * Product-level intent only (instance name, CPU/memory, optional bounded
 * mounts) is accepted as flags; everything Mottainai-owned (Appliance
 * digest, managed-generation identity/packages) comes from the descriptor.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function option(argv, name, { required = true } = {}) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  return argv[index + 1];
}

/**
 * Pure transform: exact deployment descriptor -> Route 3 Runtime
 * specification. Kept import-free of Node's fs/process so it is directly
 * unit-testable against in-memory descriptor fixtures; all disk/argv
 * handling lives in `runCli` below.
 */
export function buildLimaRuntimeSpec({
  descriptor,
  instanceName = "mottainai-runtime",
  cpus = 2,
  memoryMib = 4096,
  parseManagedPackageManifest,
  canonicalPersistedManagedPackageManifestText,
}) {
  if (!Number.isInteger(cpus) || cpus < 1) throw new Error("cpus must be a positive integer");
  if (!Number.isInteger(memoryMib) || memoryMib < 1) throw new Error("memoryMib must be a positive integer");

  const managedGeneration = descriptor.route2.managedGeneration;
  const manifest = parseManagedPackageManifest({
    contractId: "mottainai.managed-package-manifest.v1",
    schemaVersion: 1,
    // A fresh materialization always starts at generation 1; the guest's
    // own reconcileManagedRuntime state machine owns generation progression
    // from here on (docs/managed-package-manifest.md: activation.generation
    // is reconciliation-ordering bookkeeping, excluded from semantic
    // identity).
    activation: { generation: 1 },
    packages: managedGeneration.packages.map((entry) => ({
      packageId: entry.packageId,
      kind: "nix-flake-package",
      version: entry.version,
      source: { flakeRef: entry.flakeRef, sourceSha256: entry.sourceSha256 },
    })),
  });
  // Round-trip through the canonical persisted serialization so the
  // embedded document is byte-identical to what a direct
  // `mottainai-bootstrap reconcile` run against the same descriptor would
  // itself accept.
  const canonicalManifest = JSON.parse(canonicalPersistedManagedPackageManifestText(manifest));

  return {
    schema_version: "mottainai.host-bootstrap.lima-runtime-spec.v1",
    instance_name: instanceName,
    architecture: "x86_64",
    cpus,
    memory_mib: memoryMib,
    appliance: {
      registry: descriptor.route3.appliance.registry,
      repository: descriptor.route3.appliance.repository,
      digest: descriptor.route3.appliance.digest,
    },
    mounts: [],
    managed_generation: {
      identity: descriptor.route3.managedGenerationIdentity,
      manifest: canonicalManifest,
    },
  };
}

async function runCli(argv) {
  const descriptorPath = path.resolve(option(argv, "descriptor"));
  const outputPath = path.resolve(option(argv, "output"));
  const instanceName = option(argv, "instance-name", { required: false }) ?? "mottainai-runtime";
  const cpus = Number.parseInt(option(argv, "cpus", { required: false }) ?? "2", 10);
  const memoryMib = Number.parseInt(option(argv, "memory-mib", { required: false }) ?? "4096", 10);
  const sidecarPath = option(argv, "sidecar", { required: false }) ?? `${descriptorPath}.sha256`;

  // Keep the validators in the runtime-contract authority. This script is a
  // thin composition boundary and must not grow a second, drifting schema
  // for either the deployment descriptor or the managed-package manifest.
  const { assertDeploymentDescriptorIdentity, readDeploymentDescriptor } = await import(
    "../src/runtime-contract/deployment-descriptor.ts"
  );
  const { canonicalPersistedManagedPackageManifestText, parseManagedPackageManifest } = await import(
    "../src/runtime-contract/managed-package-manifest.ts"
  );

  const sidecarText = fs.readFileSync(sidecarPath, "utf8");
  const expectedSha256 = sidecarText.trim().split(/\s+/u)[0];
  if (expectedSha256 === undefined || expectedSha256.length === 0) {
    throw new Error(`deployment descriptor sidecar is empty or malformed: ${sidecarPath}`);
  }

  const descriptor = readDeploymentDescriptor(descriptorPath);
  assertDeploymentDescriptorIdentity(descriptor, expectedSha256);

  const spec = buildLimaRuntimeSpec({
    descriptor,
    instanceName,
    cpus,
    memoryMib,
    parseManagedPackageManifest,
    canonicalPersistedManagedPackageManifestText,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o644 });
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        release: descriptor.release.version,
        applianceDigest: spec.appliance.digest,
        managedGenerationIdentity: spec.managed_generation.identity,
        packages: spec.managed_generation.manifest.packages.map((entry) => entry.packageId),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
