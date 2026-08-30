import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BootstrapError } from "./errors.js";
import { BOOTSTRAP_TRUSTED_SOURCE_ORIGIN, defaultFetcher, resolveMottainaiSource } from "./source-resolution.js";
import type { RawHttpTransport } from "./source-resolution.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDirectory = path.join(repoRoot, "nix", "tests", "fixtures", "alt-mottainai-source");

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

test("resolves the fixture's alternate source tree, independent of this repository's own checkout", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");
  const expectedHash = "e".repeat(64);

  const result = await resolveMottainaiSource({
    requestedVersion: "0.0.1-fixture-alt-source",
    expectedSourceSha256: expectedHash,
    destinationDirectory: destination,
    fetcher: async (url) => {
      assert.ok(url.startsWith(BOOTSTRAP_TRUSTED_SOURCE_ORIGIN));
      return streamOf(archive);
    },
    narHashOfTree: () => expectedHash,
  });

  assert.equal(result.resolvedTag, "v0.0.1-fixture-alt-source");
  assert.equal(result.narHashSha256, expectedHash);
  const packageJson = JSON.parse(fs.readFileSync(path.join(result.sourcePath, "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.0.1-fixture-alt-source");
  assert.equal(packageJson.name, "mottainai");
});

test("fetcher is called against the pinned GitHub tag-archive origin only, never a local checkout path", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");
  let calledUrl: string | undefined;

  await resolveMottainaiSource({
    requestedVersion: "0.0.1-fixture-alt-source",
    expectedSourceSha256: "e".repeat(64),
    destinationDirectory: destination,
    fetcher: async (url) => {
      calledUrl = url;
      return streamOf(archive);
    },
    narHashOfTree: () => "e".repeat(64),
  });

  assert.equal(calledUrl, `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v0.0.1-fixture-alt-source.tar.gz`);
});

test("tree-hash mismatch fails closed with source_integrity_mismatch", async (t) => {
  const destination = tempDestination(t);
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v0.0.1-fixture-alt-source");

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "0.0.1-fixture-alt-source",
      expectedSourceSha256: "f".repeat(64),
      destinationDirectory: destination,
      fetcher: async () => streamOf(archive),
      narHashOfTree: () => "0".repeat(64),
    }),
    (error: unknown) => error instanceof BootstrapError && error.code === "source_integrity_mismatch",
  );
});

test("requested version not matching the resolved tree's package.json fails closed with requested_resolved_version_mismatch", async (t) => {
  const destination = tempDestination(t);
  // Pack the fixture (version 0.0.1-fixture-alt-source) but ask for a different version.
  const archive = packFixtureAsTagArchive(fixtureDirectory, "v9.9.9");

  await assert.rejects(
    resolveMottainaiSource({
      requestedVersion: "9.9.9",
      expectedSourceSha256: "e".repeat(64),
      destinationDirectory: destination,
      fetcher: async () => streamOf(archive),
      narHashOfTree: () => "e".repeat(64),
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
    defaultFetcher(`${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}v0.0.1-fixture-alt-source.tar.gz`, httpTransportFor(baseUrl, server)),
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
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "source-resolution.ts"), "utf8");
  assert.doesNotMatch(source, /["'`]npm["'`]/u);
  assert.doesNotMatch(source, /["'`]npx["'`]/u);
  assert.doesNotMatch(source, /npm install -g/u);
});
