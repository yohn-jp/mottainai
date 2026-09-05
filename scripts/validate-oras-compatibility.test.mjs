import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkOrasCompatibility,
  checkOrasFlagSupport,
  downloadOrasBinary,
  extractOrasInvocations,
  extractOrasSetupStep,
  fetchOrasSubcommandFlags,
  fetchSupportedOrasVersions,
  validateOrasVersion,
  validateSetupOrasSha,
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

test("validateSetupOrasSha accepts exactly a lowercase 40-character hexadecimal commit SHA", () => {
  assert.equal(validateSetupOrasSha(sha), sha);
});

test("validateSetupOrasSha rejects revisions that could alter the trusted outbound path", () => {
  for (const unsafeRevision of [
    "main",
    "v2.0.1",
    "../main",
    `${sha}/../../main`,
    sha.toUpperCase(),
    sha.slice(0, 39),
    `${sha}0`,
  ]) {
    assert.throws(() => validateSetupOrasSha(unsafeRevision), {
      message: /40-character lowercase hexadecimal commit SHA/u,
    });
  }
});

test("validateOrasVersion accepts exactly a bare MAJOR.MINOR.PATCH semver", () => {
  assert.equal(validateOrasVersion("1.3.3"), "1.3.3");
});

test("validateOrasVersion rejects values that could alter the trusted download URL", () => {
  for (const unsafeVersion of ["1.3", "1.3.3-rc.1", "../1.3.3", "1.3.3/../../evil", "v1.3.3", "1.3.3 && rm -rf ."]) {
    assert.throws(() => validateOrasVersion(unsafeVersion), {
      message: /bare MAJOR\.MINOR\.PATCH semver/u,
    });
  }
});

test("downloadOrasBinary rejects an unsafe version before making a network request", async () => {
  let called = false;
  const fixtureFetch = async () => {
    called = true;
    throw new Error("must not be called");
  };

  await assert.rejects(downloadOrasBinary("../evil", "/tmp", fixtureFetch), {
    message: /bare MAJOR\.MINOR\.PATCH semver/u,
  });
  assert.equal(called, false);
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

test("fetchSupportedOrasVersions rejects an unsafe revision before making a network request", async () => {
  let called = false;
  const fixtureFetch = async () => {
    called = true;
    throw new Error("must not be called");
  };

  await assert.rejects(fetchSupportedOrasVersions("../main", fixtureFetch), {
    message: /40-character lowercase hexadecimal commit SHA/u,
  });
  assert.equal(called, false);
});

test("fetchSupportedOrasVersions surfaces a clear diagnostic on a non-OK response", async () => {
  const fixtureFetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchSupportedOrasVersions(sha, fixtureFetch), { message: /HTTP 404/u });
});

test("extractOrasInvocations finds every oras call site and its flags in publish.yml", () => {
  const publishWorkflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const invocations = extractOrasInvocations(publishWorkflowText);

  const bySubcommand = new Map();
  for (const invocation of invocations) {
    bySubcommand.set(invocation.subcommand, (bySubcommand.get(invocation.subcommand) ?? 0) + 1);
  }

  assert.ok(bySubcommand.has("push"));
  assert.ok(bySubcommand.has("pull"));
  assert.ok(bySubcommand.has("manifest fetch"));
  assert.ok(bySubcommand.has("tag"));
  assert.ok(invocations.some((invocation) => invocation.subcommand === "push" && invocation.flags.includes("no-tty")));
  assert.ok(invocations.some((invocation) => invocation.subcommand === "pull" && invocation.flags.includes("no-tty")));
  assert.ok(
    invocations.every(
      (invocation) => invocation.subcommand !== "manifest fetch" || !invocation.flags.includes("no-tty"),
    ),
    "manifest fetch must not carry --no-tty (Issue #834): the flag only exists on push/pull",
  );
  assert.ok(
    invocations.every((invocation) => invocation.subcommand !== "tag" || !invocation.flags.includes("no-tty")),
    "tag must not carry --no-tty (Issue #834): the flag only exists on push/pull",
  );
});

test("checkOrasFlagSupport passes when every invocation's flags are in that subcommand's supported set", () => {
  const invocations = [
    { subcommand: "push", flags: ["no-tty"] },
    { subcommand: "manifest fetch", flags: ["descriptor", "pretty"] },
  ];
  const subcommandFlags = new Map([
    ["push", new Set(["no-tty", "debug"])],
    ["manifest fetch", new Set(["descriptor", "pretty", "debug"])],
  ]);

  const result = checkOrasFlagSupport(invocations, subcommandFlags);
  assert.deepEqual(result, { compatible: true, errors: [] });
});

test("checkOrasFlagSupport reproduces the 0.9.2 release failure for a flag the subcommand doesn't support (Issue #834)", () => {
  const invocations = [
    { subcommand: "manifest fetch", flags: ["descriptor", "no-tty"] },
    { subcommand: "tag", flags: ["no-tty"] },
  ];
  const subcommandFlags = new Map([
    ["manifest fetch", new Set(["descriptor", "pretty", "debug"])],
    ["tag", new Set(["debug"])],
  ]);

  const result = checkOrasFlagSupport(invocations, subcommandFlags);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.errors, [
    "`oras manifest fetch --no-tty` is not a valid flag on this ORAS CLI release",
    "`oras tag --no-tty` is not a valid flag on this ORAS CLI release",
  ]);
});

test("checkOrasFlagSupport skips a subcommand with no supported-flags data instead of failing closed on it", () => {
  const invocations = [{ subcommand: "login", flags: ["password-stdin"] }];
  const result = checkOrasFlagSupport(invocations, new Map());
  assert.deepEqual(result, { compatible: true, errors: [] });
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

test("every oras invocation in the pinned publish.yml CLI release actually supports its flags (Issue #834)", async () => {
  const publishWorkflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const { version } = extractOrasSetupStep(publishWorkflowText);
  const invocations = extractOrasInvocations(publishWorkflowText);

  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oras-flag-support-test-"));
  try {
    let binaryPath;
    try {
      binaryPath = await downloadOrasBinary(version, workDirectory);
    } catch (error) {
      console.warn("skipping live ORAS flag support check: " + error.message);
      return;
    }

    const subcommandFlags = new Map();
    for (const subcommand of new Set(invocations.map((invocation) => invocation.subcommand))) {
      subcommandFlags.set(subcommand, fetchOrasSubcommandFlags(binaryPath, subcommand));
    }

    const result = checkOrasFlagSupport(invocations, subcommandFlags);
    assert.deepEqual(result.errors, []);
    assert.equal(result.compatible, true);
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
});
