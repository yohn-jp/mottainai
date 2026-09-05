import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManagedGeneration, ManagedGenerationBuildError } from "./managed-generation-build.js";
import {
  MANAGED_PACKAGE_MANIFEST_CONTRACT_ID,
  MANAGED_PACKAGE_MANIFEST_SCHEMA_VERSION,
} from "./managed-package-manifest.js";
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
    resolvedIdentity: {
      packages: manifestValue.packages.map((entry) => ({ packageId: entry.packageId, resolvedVersion })),
    },
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
      return JSON.stringify({
        info: { x: { narHash: `sha256-${Buffer.from(options.narHashSha256, "hex").toString("base64")}` } },
      });
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
    manifest: {
      ...manifestValue,
      packages: [
        { ...manifestValue.packages[0], source: { ...manifestValue.packages[0].source, sourceSha256: narHashSha256 } },
      ],
    },
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

// Issue #643: buildManagedGeneration used to spawn `nix build` with cwd set
// to `${repoRoot}/nix` and pass `mottainaiSource` through `--arg` to a
// `{ mottainaiSource }: ...` function expression. When the subprocess's cwd
// was itself inside the repository the expression's `builtins.getFlake`
// also resolved (a caller running from inside its own checkout), `nix`
// resolved that self-reference unreliably. These regressions prove the
// fixed invocation no longer depends on the caller's process.cwd() or on
// repoRoot self-reference, without requiring a real Nix toolchain.
test("buildManagedGeneration's nix invocation is independent of the caller's process.cwd()", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-cwd-a-"));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-cwd-b-"));
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  });

  const manifestValue = manifest();
  const metadataStorePath = path.join(dir, "metadata.json");
  const narHashSha256 = "b".repeat(64);
  fs.writeFileSync(metadataStorePath, JSON.stringify(metadataFor(manifestValue, narHashSha256, "0.7.1")));

  const calls: { args: readonly string[]; cwd: unknown }[] = [];
  const capturingExecFile = ((command: string, args?: readonly string[], execOptions?: { cwd?: unknown }) => {
    if (command === "nix" && args?.[0] === "build") {
      calls.push({ args: args ?? [], cwd: execOptions?.cwd });
      return `${metadataStorePath}\n`;
    }
    if (command === "nix" && args?.[0] === "path-info") {
      return JSON.stringify({
        info: { x: { narHash: `sha256-${Buffer.from(narHashSha256, "hex").toString("base64")}` } },
      });
    }
    if (command === "nix" && args?.[0] === "eval") {
      return Buffer.from(narHashSha256);
    }
    throw new Error(`unexpected execFile invocation: ${command} ${JSON.stringify(args)}`);
  }) as unknown as typeof import("node:child_process").execFileSync;

  const repoRoot = "/repo/checkout";
  const buildOptions = {
    repoRoot,
    manifest: {
      ...manifestValue,
      packages: [
        { ...manifestValue.packages[0], source: { ...manifestValue.packages[0].source, sourceSha256: narHashSha256 } },
      ],
    },
    system: "x86_64-linux",
    mottainaiSourcePath: "/some/resolved/source",
    env: {},
    execFile: capturingExecFile,
  };

  process.chdir(cwdA);
  await buildManagedGeneration(buildOptions);
  process.chdir(cwdB);
  await buildManagedGeneration(buildOptions);

  assert.equal(calls.length, 2);
  const [first, second] = calls;
  // Identical nix build invocation regardless of the caller's process.cwd()
  // at call time.
  assert.deepEqual(first.args, second.args);
  assert.equal(first.cwd, second.cwd);
  // No function-application indirection (the removed `--arg` mechanism).
  assert.ok(!first.args.includes("--arg"));
  // cwd is neutral: never repoRoot itself, nor nested inside it — the
  // self-reference condition the defect traced to.
  assert.notEqual(first.cwd, path.join(repoRoot, "nix"));
  assert.ok(typeof first.cwd === "string" && !first.cwd.startsWith(repoRoot));
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

// PR review finding P1-3: parseManagedGenerationMetadata, verifySourceIntegrity,
// and assertResolvedVersionsMatch all throw the SAME ManagedGenerationError
// class from src/runtime-contract/managed-generation.ts, but they mean three
// different things. buildManagedGeneration must re-throw each as a
// ManagedGenerationBuildError carrying a distinct `phase`, so
// src/bootstrap/build.ts's toBootstrapError can map each to its own
// BootstrapErrorCode instead of collapsing them all into
// "unsupported_managed_package".

test("buildManagedGeneration throws phase 'metadata' when the emitted metadata file is malformed JSON", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const metadataStorePath = path.join(dir, "metadata.json");
  fs.writeFileSync(metadataStorePath, "{ not valid json");

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: manifest(),
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      env: {},
      execFile: fakeExecFile({ metadataStorePath, metadataJson: {}, narHashSha256: "b".repeat(64) }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ManagedGenerationBuildError);
      assert.equal(error.phase, "metadata");
      return true;
    },
  );
});

test("buildManagedGeneration throws phase 'metadata' when the emitted metadata fails schema validation", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const metadataStorePath = path.join(dir, "metadata.json");
  fs.writeFileSync(metadataStorePath, JSON.stringify({ contractId: "wrong" }));

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: manifest(),
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      env: {},
      execFile: fakeExecFile({ metadataStorePath, metadataJson: {}, narHashSha256: "b".repeat(64) }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ManagedGenerationBuildError);
      assert.equal(error.phase, "metadata");
      return true;
    },
  );
});

test("buildManagedGeneration throws phase 'source_integrity' on a post-build NAR-hash mismatch", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifestValue = manifest();
  const metadataStorePath = path.join(dir, "metadata.json");
  // Metadata resolves to version "0.7.1" (matching the manifest, so
  // assertResolvedVersionsMatch would pass), but the actual NAR hash the
  // fake execFile reports differs from the manifest's declared sourceSha256
  // ("a".repeat(64)), so only verifySourceIntegrity should fail.
  fs.writeFileSync(metadataStorePath, JSON.stringify(metadataFor(manifestValue, "a".repeat(64), "0.7.1")));

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: manifestValue,
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      env: {},
      execFile: fakeExecFile({
        metadataStorePath,
        metadataJson: metadataFor(manifestValue, "a".repeat(64), "0.7.1"),
        narHashSha256: "c".repeat(64),
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ManagedGenerationBuildError);
      assert.equal(error.phase, "source_integrity");
      return true;
    },
  );
});

test("buildManagedGeneration throws phase 'resolved_version' on a post-build version mismatch", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifestValue = manifest();
  const narHashSha256 = "b".repeat(64);
  const metadataStorePath = path.join(dir, "metadata.json");
  // sourceSha256 matches (so verifySourceIntegrity passes), but
  // resolvedVersion "0.9.9" differs from the manifest's requested "0.7.1",
  // so only assertResolvedVersionsMatch should fail.
  fs.writeFileSync(metadataStorePath, JSON.stringify(metadataFor(manifestValue, narHashSha256, "0.9.9")));

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: {
        ...manifestValue,
        packages: [
          {
            ...manifestValue.packages[0],
            source: { ...manifestValue.packages[0].source, sourceSha256: narHashSha256 },
          },
        ],
      },
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      env: {},
      execFile: fakeExecFile({
        metadataStorePath,
        metadataJson: metadataFor(manifestValue, narHashSha256, "0.9.9"),
        narHashSha256,
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ManagedGenerationBuildError);
      assert.equal(error.phase, "resolved_version");
      return true;
    },
  );
});

test("exact payload builds use the release boundary as a Nix dependency and require its evidence", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-payload-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payloadPath = path.join(dir, "mottainai-0.7.1.tgz");
  fs.writeFileSync(payloadPath, "exact payload bytes");
  const payloadSha256 = crypto.createHash("sha256").update(fs.readFileSync(payloadPath)).digest("hex");
  const metadataStorePath = path.join(dir, "metadata.json");
  const manifestValue = manifest();
  const buildManifest = {
    ...manifestValue,
    packages: [
      { ...manifestValue.packages[0], source: { ...manifestValue.packages[0].source, sourceSha256: "b".repeat(64) } },
    ],
  };
  const metadata = {
    ...metadataFor(buildManifest, "b".repeat(64), "0.7.1"),
    applicationPayload: { packageName: "mottainai", packageVersion: "0.7.1", sha256: payloadSha256 },
  };
  fs.writeFileSync(metadataStorePath, JSON.stringify(metadata));
  let expression = "";
  const execFile = ((command: string, args?: readonly string[]) => {
    if (command === "nix" && args?.[0] === "build") {
      expression = args[args.indexOf("--expr") + 1] ?? "";
      return `${metadataStorePath}\n`;
    }
    if (command === "nix" && args?.[0] === "path-info") {
      return JSON.stringify({
        info: { x: { narHash: `sha256-${Buffer.from("b".repeat(64), "hex").toString("base64")}` } },
      });
    }
    if (command === "nix" && args?.[0] === "eval") return Buffer.from("b".repeat(64));
    throw new Error(`unexpected execFile invocation: ${command}`);
  }) as unknown as typeof import("node:child_process").execFileSync;

  await buildManagedGeneration({
    repoRoot: "/repo",
    manifest: buildManifest,
    system: "x86_64-linux",
    mottainaiSourcePath: "/some/resolved/source",
    canonicalPayloadPath: payloadPath,
    canonicalPayloadSha256: payloadSha256,
    env: {},
    execFile,
  });
  assert.match(expression, /lib\.mkMottainaiFromPayload/u);
  assert.match(expression, /canonicalPayload = \/\. \+/u);
  assert.match(expression, new RegExp(payloadPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(expression, /mottainaiPackagesForSystem\.mottainai/u);
});

test("payload hash mismatch fails closed before the Nix build", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-managed-generation-payload-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payloadPath = path.join(dir, "mottainai-0.7.1.tgz");
  fs.writeFileSync(payloadPath, "wrong payload bytes");
  let buildCalled = false;
  const execFile = (() => {
    buildCalled = true;
    throw new Error("Nix must not run");
  }) as unknown as typeof import("node:child_process").execFileSync;

  await assert.rejects(
    buildManagedGeneration({
      repoRoot: "/repo",
      manifest: manifest(),
      system: "x86_64-linux",
      mottainaiSourcePath: "/some/resolved/source",
      canonicalPayloadPath: payloadPath,
      canonicalPayloadSha256: "a".repeat(64),
      env: {},
      execFile,
    }),
    (error: unknown) => error instanceof ManagedGenerationBuildError && error.phase === "payload_integrity",
  );
  assert.equal(buildCalled, false);
});
