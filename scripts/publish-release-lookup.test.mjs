import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github/workflows/publish.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");

/**
 * Extract the exact `run: |` script body for the "Create or resume the
 * exact git tag and draft release" step, so this test exercises the
 * workflow's real shell logic rather than a re-implementation of it. This
 * is a plain indentation-based slice (matching the rest of this repository's
 * workflow-text assertions) rather than a full YAML parse, so no new parser
 * dependency is introduced for one test file.
 */
function extractPrepareReleaseScript() {
  const lines = workflowText.split("\n");
  const headingIndex = lines.findIndex((line) => line.includes("Create or resume the exact git tag and draft release"));
  assert.ok(headingIndex !== -1, "prepare-release step heading not found in publish.yml");
  const runIndex = lines.findIndex((line, index) => index > headingIndex && line.trim() === "run: |");
  assert.ok(runIndex !== -1, "run: | block not found for prepare-release step");
  const runIndent = lines[runIndex].match(/^(\s*)/u)[1].length;
  const bodyLines = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && line.match(/^(\s*)/u)[1].length <= runIndent) break;
    bodyLines.push(line);
  }
  const scriptIndent = bodyLines.find((line) => line.trim() !== "")?.match(/^(\s*)/u)[1].length ?? runIndent + 2;
  return bodyLines.map((line) => line.slice(scriptIndent)).join("\n");
}

/**
 * A fixture `gh` and `jq` are placed on PATH so the extracted script runs
 * against controlled release/tag state instead of the real GitHub API.
 * `resolve_tag_commit` calls `gh api repos/.../git/ref/tags/$TAG`, so the
 * fixture also answers that endpoint from the same in-memory tag state.
 */
function runPrepareReleaseScript({ existingRelease, existingTagCommit, targetSha, tag = "v9.9.9" }) {
  const script = extractPrepareReleaseScript();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-release-lookup-"));
  try {
    const stateFile = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        release: existingRelease ?? null,
        tagCommit: existingTagCommit ?? null,
      }),
    );

    const ghFixture = `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, "utf8"));
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

if (args[0] === "release" && args[1] === "view") {
  const tagArg = args[2];
  if (!state.release || state.release.tagName !== tagArg) {
    fail("release not found");
  }
  process.stdout.write(JSON.stringify({ isDraft: state.release.isDraft, tagName: state.release.tagName }));
  process.exit(0);
}

if (args[0] === "release" && args[1] === "create") {
  state.release = { isDraft: true, tagName: args[2] };
  state.tagCommit = process.env.FIXTURE_TARGET_SHA;
  fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === "api" && args[1].startsWith("repos/") && args[1].includes("/git/ref/tags/")) {
  if (!state.tagCommit) {
    fail("HTTP 404: Not Found");
  }
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha: state.tagCommit } }));
  process.exit(0);
}

if (args[0] === "api" && args[1].startsWith("repos/") && args[1].includes("/git/refs") && args[2] === "--method") {
  const shaIndex = args.indexOf("-f", args.indexOf("-f") + 1);
  const shaArg = args.find((value) => value.startsWith("sha="));
  state.tagCommit = shaArg.slice("sha=".length);
  fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
  process.exit(0);
}

fail("unhandled fixture gh invocation: " + args.join(" "));
`;
    const ghPath = path.join(tmpDir, "gh");
    fs.writeFileSync(ghPath, ghFixture, { mode: 0o755 });

    const wrapperScript = `set -euo pipefail\n${script}`;
    const wrapperPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      GH_TOKEN: "fixture-token",
      TAG: tag,
      VERSION: tag.replace(/^v/u, ""),
      TARGET_SHA: targetSha,
      GITHUB_REPOSITORY: "yohn-jp/mottainai",
      RUNNER_TEMP: tmpDir,
      FIXTURE_STATE: stateFile,
      FIXTURE_TARGET_SHA: targetSha,
    };

    try {
      const stdout = execFileSync("bash", [wrapperPath], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stdout, state: JSON.parse(fs.readFileSync(stateFile, "utf8")) };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? "",
        state: JSON.parse(fs.readFileSync(stateFile, "utf8")),
      };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("prepare-release creates a draft release when none exists for the tag", () => {
  const result = runPrepareReleaseScript({
    existingRelease: null,
    existingTagCommit: null,
    targetSha: "a".repeat(40),
  });
  assert.equal(result.status, 0);
  assert.equal(result.state.release.isDraft, true);
  assert.equal(result.state.release.tagName, "v9.9.9");
  assert.equal(result.state.tagCommit, "a".repeat(40));
});

test("prepare-release reuses an existing draft release for the same tag and commit", () => {
  const sha = "b".repeat(40);
  const result = runPrepareReleaseScript({
    existingRelease: { isDraft: true, tagName: "v9.9.9" },
    existingTagCommit: sha,
    targetSha: sha,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /reusing it/u);
});

test("prepare-release fails closed when the existing release for the tag is already published", () => {
  const sha = "c".repeat(40);
  const result = runPrepareReleaseScript({
    existingRelease: { isDraft: false, tagName: "v9.9.9" },
    existingTagCommit: sha,
    targetSha: sha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists and is not a draft; refusing to reuse or recreate it/u);
});

test("prepare-release fails closed when an existing draft's tag targets a different commit", () => {
  const result = runPrepareReleaseScript({
    existingRelease: { isDraft: true, tagName: "v9.9.9" },
    existingTagCommit: "d".repeat(40),
    targetSha: "e".repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to reuse a different commit's draft/u);
});
