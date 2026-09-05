import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BootstrapError } from "./errors.js";
import {
  BOOTSTRAP_TRUSTED_SOURCE_ORIGIN,
  defaultFetcher,
  resolveCanonicalPayload,
  resolveMottainaiSource,
} from "./source-resolution.js";
import type { RawHttpTransport } from "./source-resolution.js";
import { generationIdentityOf, parseManagedGenerationMetadata } from "../runtime-contract/managed-generation.js";
import { parseDeploymentDescriptor } from "../runtime-contract/deployment-descriptor.js";
import { parseManagedPackageManifest } from "../runtime-contract/managed-package-manifest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDirectory = path.join(repoRoot, "nix", "tests", "fixtures", "alt-mottainai-source");
const fixtureSourceNarSha256 = "e74b0ab3b7dae31df8a4d099d6991cc7988118cf3b4456792eebbc640181ed36";

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalPayloadIdentity(bytes: Buffer, filename = "mottainai-1.2.3.tgz") {
  const payloadSha256 = createHash("sha256").update(bytes).digest("hex");
  const version = "1.2.3";
  return {
    packageName: "mottainai" as const,
    version,
    sourceRevision: "a".repeat(40),
    filename,
    sha256: payloadSha256,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    locator: `https://github.com/yohn-jp/mottainai/releases/download/v${version}/${filename}`,
  };
}

/**
 * Packs a fixture directory as a GitHub-tag-archive-shaped tar.gz: a single
 * top-level `<name>/` wrapper directory around the fixture's files, so
 * resolveMottainaiSource's `--strip-components=1` extraction behaves the
 * same as it would against a real GitHub archive.
 */
function packFixtureAsTagArchive(sourceDirectory: string, tag: string): Buffer {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-source-resolution-pack-"));
  try {
    const wrapper = path.join(stagingRoot, `mottainai-${tag.replace(/^v/u, "")}`);
    fs.cpSync(sourceDirectory, wrapper, { recursive: true });
    const archivePath = path.join(stagingRoot, "archive.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, path.basename(wrapper)]);
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

function tempDestination(t: import("node:test").TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-source-resolution-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function generatedProductionDescriptor(t: import("node:test").TestContext, sourceSha256: string) {
  const version = "0.0.1-fixture-alt-source";
  const sourceRevision = "a".repeat(40);
  const directory = tempDestination(t);
  const tarballPath = path.join(directory, `mottainai-${version}.tgz`);
  const initPath = path.join(directory, "mottainai-init-linux-x86_64");
  const appliancePath = path.join(directory, "appliance-metadata.json");
  const managedPath = path.join(directory, "managed-generation.json");
  const outputPath = path.join(directory, "deployment-descriptor-input.json");
  const flakeLockPath = path.join(repoRoot, "nix", "flake.lock");

  fs.writeFileSync(tarballPath, "canonical npm payload bytes");
  fs.writeFileSync(initPath, "canonical init bytes");
  fs.writeFileSync(
    appliancePath,
    JSON.stringify({
      digest: `sha256:${"6".repeat(64)}`,
      rawSha256: "7".repeat(64),
      rawSizeBytes: 2048,
      manifestSha256: "8".repeat(64),
    }),
  );
  const manifest = {
    contractId: "mottainai.managed-package-manifest.v1",
    schemaVersion: 1,
    activation: { generation: 1 },
    packages: [
      {
        packageId: "mottainai",
        kind: "nix-flake-package",
        version,
        source: { flakeRef: "nix#mottainai", sourceSha256 },
      },
    ],
  };
  const metadata = {
    contractId: "mottainai.managed-generation.v1",
    schemaVersion: 1,
    compatibilityContractVersion: 1,
    requestedIdentity: { packages: [{ packageId: "mottainai", version, sourceSha256 }] },
    resolvedIdentity: { packages: [{ packageId: "mottainai", resolvedVersion: version }] },
    nixOutput: {
      storePath: "/nix/store/1111-mottainai-managed-generation",
      packages: [
        {
          packageId: "mottainai",
          storePath: "/nix/store/2222-mottainai-0.0.1-fixture-alt-source",
          sourceStorePath: "/nix/store/3333-mottainai-source",
        },
      ],
    },
    applicationPayload: {
      packageName: "mottainai",
      packageVersion: version,
      sha256: sha256(tarballPath),
    },
  };
  const parsedManifest = parseManagedPackageManifest(manifest);
  const parsedMetadata = parseManagedGenerationMetadata(metadata);
  fs.writeFileSync(
    managedPath,
    JSON.stringify({
      manifest,
      metadata,
      generationIdentity: generationIdentityOf(parsedManifest, parsedMetadata),
      flakeLockSha256: sha256(flakeLockPath),
      applicationPayloadSha256: sha256(tarballPath),
    }),
  );

  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/create-release-deployment-descriptor-input.mjs",
      "--version",
      version,
      "--source-revision",
      sourceRevision,
      "--tarball",
      tarballPath,
      "--init",
      initPath,
      "--appliance-metadata",
      appliancePath,
      "--provider-profile",
      path.join(repoRoot, "release", "deployment-provider-profile-linux-x86_64.json"),
      "--managed-generation",
      managedPath,
      "--flake-lock",
      flakeLockPath,
      "--output",
      outputPath,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
  return parseDeploymentDescriptor(JSON.parse(fs.readFileSync(outputPath, "utf8")));
}

test("production-shaped descriptor sourceSha256 passes the real source-resolution boundary", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");
  const descriptor = generatedProductionDescriptor(t, fixtureSourceNarSha256);
  const sourceSha256 = descriptor.route2.managedGeneration.packages[0].sourceSha256;
  assert.equal(descriptor.route2.managedGeneration.applicationPayloadSha256, descriptor.route1.payload.sha256);
  assert.notEqual(sourceSha256, descriptor.route1.payload.sha256);

  const result = await resolveMottainaiSource({
    requestedVersion: "0.0.1-fixture-alt-source",
    expectedSourceSha256: sourceSha256,
    destinationDirectory: destination,
    fetcher: async (url) => {
      assert.ok(url.startsWith(BOOTSTRAP_TRUSTED_SOURCE_ORIGIN));
      return streamOf(archive);
    },
    narHashOfTree: () => sourceSha256,
  });

  assert.equal(result.resolvedTag, "v0.0.1-fixture-alt-source");
  assert.equal(result.narHashSha256, sourceSha256);
  const packageJson = JSON.parse(fs.readFileSync(path.join(result.sourcePath, "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.0.1-fixture-alt-source");
  assert.equal(packageJson.name, "mottainai");
});

test("exact Route 1 payload acquisition verifies bytes and is idempotent", async (t) => {
  const destination = tempDestination(t);
  const bytes = Buffer.from("canonical route 1 payload bytes");
  const identity = canonicalPayloadIdentity(bytes);
  let fetchCalls = 0;
  const fetcher = async (url: string) => {
    fetchCalls += 1;
    assert.equal(url, identity.locator);
    return streamOf(bytes);
  };

  const first = await resolveCanonicalPayload({ identity, destinationDirectory: destination, fetcher });
  const second = await resolveCanonicalPayload({ identity, destinationDirectory: destination, fetcher });
  assert.equal(first.sha256, identity.sha256);
  assert.equal(second.payloadPath, first.payloadPath);
  assert.equal(fetchCalls, 1);
});

test("wrong Route 1 payload bytes fail closed before any build", async (t) => {
  const destination = tempDestination(t);
  const identity = canonicalPayloadIdentity(Buffer.from("expected payload"));

  await assert.rejects(
    resolveCanonicalPayload({
      identity,
      destinationDirectory: destination,
      fetcher: async () => streamOf(Buffer.from("wrong payload")),
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_integrity_mismatch",
  );
});

test("a plausible same-version substituted filename is rejected as non-canonical", async (t) => {
  const destination = tempDestination(t);
  const bytes = Buffer.from("canonical route 1 payload bytes");
  const identity = canonicalPayloadIdentity(bytes, "mottainai-1.2.3-substituted.tgz");
  let fetchCalls = 0;

  await assert.rejects(
    resolveCanonicalPayload({
      identity,
      destinationDirectory: destination,
      fetcher: async () => {
        fetchCalls += 1;
        return streamOf(bytes);
      },
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_resolution_failure",
  );
  assert.equal(fetchCalls, 0);
});

test("missing Route 1 payload identity fails closed without acquisition", async (t) => {
  const destination = tempDestination(t);
  await assert.rejects(
    resolveCanonicalPayload({
      identity: { packageName: "mottainai", version: "1.2.3" } as never,
      destinationDirectory: destination,
      fetcher: async () => streamOf(Buffer.from("must not be fetched")),
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_resolution_failure",
  );
});

test("fetcher is called against the pinned GitHub tag-archive origin only, never a local checkout path", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");
  let calledUrl: string | undefined;

  await resolveMottainaiSource({
    requestedVersion: "0.0.1-fixture-alt-source",
    expectedSourceSha256: fixtureSourceNarSha256,
    destinationDirectory: destination,
    fetcher: async (url) => {
      calledUrl = url;
      return streamOf(archive);
    },
    narHashOfTree: () => fixtureSourceNarSha256,
  });

  assert.equal(calledUrl, `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v0.0.1-fixture-alt-source.tar.gz`);
});

test("tree-hash mismatch fails closed with source_integrity_mismatch", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");
  const descriptor = generatedProductionDescriptor(t, "f".repeat(64));
  const actualHash = fixtureSourceNarSha256;

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "0.0.1-fixture-alt-source",
      expectedSourceSha256: descriptor.route2.managedGeneration.packages[0].sourceSha256,
      destinationDirectory: destination,
      fetcher: async () => streamOf(archive),
      narHashOfTree: () => actualHash,
    }),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code === "source_integrity_mismatch" &&
      error.message.includes(`sourceSha256=${descriptor.route2.managedGeneration.packages[0].sourceSha256}`),
  );
});

test("requested version not matching the resolved tree's package.json fails closed with requested_resolved_version_mismatch", async (t) => {
  const destination = tempDestination(t);
  // Pack the fixture (version 0.0.1-fixture-alt-source) but ask for a different version.
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v9.9.9");

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "9.9.9",
      expectedSourceSha256: fixtureSourceNarSha256,
      destinationDirectory: destination,
      fetcher: async () => streamOf(archive),
      narHashOfTree: () => fixtureSourceNarSha256,
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "requested_resolved_version_mismatch",
  );
});

test("rejects a malformed requested version before ever calling the fetcher", async (t) => {
  const destination = tempDestination(t);
  let fetcherCalled = false;

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "not-a-version; rm -rf /",
      expectedSourceSha256: "e".repeat(64),
      destinationDirectory: destination,
      fetcher: async () => {
        fetcherCalled = true;
        return streamOf(Buffer.alloc(0));
      },
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_resolution_failure",
  );
  assert.equal(fetcherCalled, false);
});

test("an injected fetcher that models a redirect to an untrusted host is rejected before any bytes are trusted", async (t) => {
  const destination = tempDestination(t);

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "0.0.1-fixture-alt-source",
      expectedSourceSha256: "e".repeat(64),
      destinationDirectory: destination,
      // Simulates a fetcher that itself followed (or was redirected to) an
      // untrusted host before resolveMottainaiSource ever gets to inspect
      // the actual bytes — the fetcher call itself models "this hop landed
      // outside the allowlist" by throwing, the same failure shape
      // defaultFetcher's real manual-redirect loop produces.
      fetcher: async () => {
        throw new Error("redirect to untrusted host: evil.example.com");
      },
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_resolution_failure",
  );
});

/**
 * Wraps a real node:http server's response semantics (status code,
 * location header, body) as a RawHttpTransport, so defaultFetcher's real
 * manual-redirect loop (protocol/host validation per hop, MAX_REDIRECTS
 * bound, location-header resolution) runs unmodified against real HTTP
 * responses — only the underlying transport (fetch vs. node:http request)
 * is substituted, not the redirect-following logic itself. This is what
 * lets the test start at the pinned https://github.com/... origin (as
 * production always does) while still routing bytes through a local
 * server for the redirect hop, without needing a TLS certificate for
 * github.com in a hermetic test.
 */
function httpTransportFor(baseUrl: URL, server: http.Server): RawHttpTransport {
  return (url) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = http.request(
        {
          host: baseUrl.hostname,
          port: baseUrl.port,
          path: target.pathname + target.search,
          method: "GET",
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location ?? null;
          if (status >= 300 && status < 400) {
            response.resume();
            resolve({ status, ok: false, body: null, location });
            return;
          }
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            resolve({
              status,
              ok: status >= 200 && status < 300,
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(buffer));
                  controller.close();
                },
              }),
              location,
            });
          });
        },
      );
      request.on("error", reject);
      request.end();
      void server;
    });
}

async function listen(server: http.Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return new URL(`http://127.0.0.1:${address.port}/`);
}

test("defaultFetcher rejects a real HTTP redirect hop that resolves to a host outside BOOTSTRAP_TRUSTED_REDIRECT_HOSTS", async (t) => {
  // Exercises the actual production redirect-following code path
  // (defaultFetcher's manual-redirect loop: per-hop protocol/host
  // validation, location-header resolution) against a real HTTP server's
  // response, not a fake that bypasses it. If the allowlist enforcement in
  // defaultFetcher's loop were removed, this test fails.
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("v0.0.1-fixture-alt-source.tar.gz") === true) {
      res.writeHead(302, { location: "https://evil.example.com/payload" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("should never be reached");
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    defaultFetcher(
      `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v0.0.1-fixture-alt-source.tar.gz`,
      httpTransportFor(baseUrl, server),
    ),
    /redirect to untrusted host: evil\.example\.com/u,
  );
});

test("defaultFetcher follows a redirect hop that resolves to a trusted allowlisted host", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("v0.0.1-fixture-alt-source.tar.gz") === true) {
      res.writeHead(302, { location: "https://codeload.github.com/final.tar.gz" });
      res.end();
      return;
    }
    if (req.url === "/final.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end("archive-bytes");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const body = await defaultFetcher(
    `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v0.0.1-fixture-alt-source.tar.gz`,
    httpTransportFor(baseUrl, server),
  );
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    chunks.push(result.value);
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "archive-bytes");
});

test("no fallback: source-resolution.ts never invokes npm/npx or a global install", () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "source-resolution.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /["'`]npm["'`]/u);
  assert.doesNotMatch(source, /["'`]npx["'`]/u);
  assert.doesNotMatch(source, /npm install -g/u);
});
