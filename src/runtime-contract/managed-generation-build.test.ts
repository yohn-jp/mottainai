import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManagedGeneration, ManagedGenerationBuildError } from "./managed-generation-build.js";
import { MANAGED_PACKAGE_MANIFEST_CONTRACT_ID, MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION } from "./managed-package-manifest.js";
import type { ManagedPackageManifest } from "./managed-package-manifest.js";

function manifest(): ManagedPackageManifest {
  return {
    contractId: MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
    schemaVersion: MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version: "0.7.1",
        source: { flakeRef: "nix#mottainai", sourceSha256: "a".repeat(64) },
      },
    ],
  };
}

function metadataFor(manifestValue: ManagedPackageManifest, sourceSha256: string, resolvedVersion: string) {
  return {
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: {
      packages: manifestValue.packages.map((entry) => ({
        packageId: entry.packageId,
        version: entry.version,
        sourceSha256: entry.source.sourceSha256,
      })),
    },
    resolvedIdentity: { packages: manifestValue.packages.map((entry) => ({ packageId: entry.packageId, resolvedVersion })) },
    nixOutput: {
      storePath: "/nix/store/example-generation",
      packages: manifestValue.packages.map((entry) => ({
        packageId: entry.packageId,
        storePath: "/nix/store/example-mottainai",
        sourceStorePath: "/nix/store/example-mottainai-source",
      })),
    },
  };
}

function fakeExecFile(options: {
  metadataStorePath: string;
  metadataJson: unknown;
  narHashSha256: string;
}): typeof import("node:child_process").execFileSync {
  return ((command: string, args?: readonly string[]) => {
    if (command === "nix" && args?.[0] === "build") {
      // simulate `nix build` writing metadata to a real temp file, but for
      // this fake we just return a marker path and stub the fs read via a
      // separately-injected filesystem in the test itself is unnecessary —
      // instead we write the metadata to a real temp file up front.
      return `${options.metadataStorePath}\n`;
    }
    if (command === "nix" && args?.[0] === "path-info") {
      return JSON.stringify({ info: { x: { narHash: `sha256-${Buffer.from(options.narHashSha256, "hex").toString("base64")}` } } });
    }
    if (command === "nix" && args?.[0] === "eval") {
      return Buffer.from(options.narHashSha256);
    }
    throw new Error(`unexpected execFile invocation: ${command} ${JSON.stringify(args)}`);
  }) as unknown as typeof import("node:child_process").execFileSync;
}

test("buildManagedGeneration succeeds when Nix build, metadata, and integrity all match", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifestValue = manifest();
  const metadataStorePath = path.join(dir, "metadata.json");
  const narHashSha256 = "b".repeat(64);
  fs.writeFileSync(metadataStorePath, JSON.stringify(metadataFor(manifestValue, "a".repeat(64), "0.7.1")));

  const result = await buildManagedGeneration({
    repoRoot: "/repo",
    manifest: { ...manifestValue, packages: [{ ...manifestValue.packages[0], source: { ...manifestValue.packages[0].source, sourceSha256: narHashSha256 } }] },
    system: "x86_64-linux",
    mottainaiSourcePath: "/some/resolved/source",
    env: {},
    execFile: fakeExecFile({
      metadataStorePath,
      metadataJson: metadataFor(manifestValue, narHashSha256, "0.7.1"),
      narHashSha256,
    }),
  });

  assert.equal(result.metadata.nixOutput.storePath, "/nix/store/example-generation");
  assert.equal(typeof result.generationIdentity, "string");
  assert.equal(result.generationIdentity.length, 64);
});

test("buildManagedGeneration throws ManagedGenerationBuildError when the nix build subprocess fails", async () => {
  const failingExecFile = ((command: string, args?: readonly string[]) => {
    if (command === "nix" && args?.[0] === "build") throw new Error("nix build exited with code 1");
    throw new Error("unexpected");
  }) as unknown as typeof import("node:child_process").execFileSync;

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: manifest(),
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      env: {},
      execFile: failingExecFile,
    }),
    ManagedGenerationBuildError,
  );
});
