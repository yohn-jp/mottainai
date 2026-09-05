import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkOrasCompatibility,
  extractOrasSetupStep,
  fetchSupportedOrasVersions,
} from "./validate-oras-compatibility.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d";

test("extracts the pinned setup-oras SHA and requested CLI version from publish.yml", () => {
  const publishWorkflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const { sha: extractedSha, version } = extractOrasSetupStep(publishWorkflowText);

  assert.equal(extractedSha, sha);
  assert.match(version, /^\d+\.\d+\.\d+$/u);
});

test("rejects a step missing a commit-SHA-pinned uses line", () => {
  assert.throws(
    () => extractOrasSetupStep("      - name: Setup ORAS CLI\n        uses: oras-project/setup-oras@v2\n"),
    {
      message: /commit-SHA-pinned/u,
    },
  );
});

test("rejects a step missing a with.version input", () => {
  assert.throws(
    () => extractOrasSetupStep(`      - name: Setup ORAS CLI\n        uses: oras-project/setup-oras@${sha}\n`),
    { message: /with.version/u },
  );
});

test("checkOrasCompatibility passes when the requested version is in the supported table", () => {
  const result = checkOrasCompatibility("1.3.3", ["1.3.0", "1.3.1", "1.3.2", "1.3.3"]);
  assert.equal(result.compatible, true);
});

test("checkOrasCompatibility reproduces the 0.9.1 release failure for an unlisted version", () => {
  const result = checkOrasCompatibility("1.3.4", ["1.3.0", "1.3.1", "1.3.2", "1.3.3"]);
  assert.equal(result.compatible, false);
  assert.match(result.message, /does not support ORAS CLI version 1\.3\.4/u);
});

test("fetchSupportedOrasVersions parses the upstream release table for the pinned revision", async () => {
  const fixtureFetch = async (url) => {
    assert.equal(url, `https://raw.githubusercontent.com/oras-project/setup-oras/${sha}/src/lib/data/releases.json`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ "1.3.1": {}, "1.3.2": {}, "1.3.3": {} }),
    };
  };

  const versions = await fetchSupportedOrasVersions(sha, fixtureFetch);
  assert.deepEqual(versions.sort(), ["1.3.1", "1.3.2", "1.3.3"]);
});

test("fetchSupportedOrasVersions surfaces a clear diagnostic on a non-OK response", async () => {
  const fixtureFetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchSupportedOrasVersions(sha, fixtureFetch), { message: /HTTP 404/u });
});

test("the pinned publish.yml version is actually resolvable against live upstream data", async () => {
  const publishWorkflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const { sha: extractedSha, version } = extractOrasSetupStep(publishWorkflowText);

  let supportedVersions;
  try {
    supportedVersions = await fetchSupportedOrasVersions(extractedSha);
  } catch (error) {
    // No network access in this environment: skip rather than fail, since
    // this assertion's purpose is catching real upstream drift, not
    // exercising offline behavior (covered by the fixture-based tests above).
    console.warn("skipping live ORAS compatibility check: " + error.message);
    return;
  }

  const result = checkOrasCompatibility(version, supportedVersions);
  assert.equal(result.compatible, true, result.message);
});
