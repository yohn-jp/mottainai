import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BootstrapError } from "./errors.js";
import { BOOTSTRAP_TRUSTED_SOURCE_ORIGIN, resolveMottainaiSource } from "./source-resolution.js";

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

test("no fallback: source-resolution.ts never invokes npm/npx or a global install", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "source-resolution.ts"), "utf8");
  assert.doesNotMatch(source, /["'`]npm["'`]/u);
  assert.doesNotMatch(source, /["'`]npx["'`]/u);
  assert.doesNotMatch(source, /npm install -g/u);
});
