#!/usr/bin/env node
// Reproduces the 0.9.1 publish failure (Issue #821) as a pre-merge check:
// setup-oras resolves the ORAS CLI from a version->checksum table baked
// into the pinned Action revision, so an Action SHA and a `with.version`
// that are each individually "current" can still be an incompatible pair
// if the table predates the requested CLI release. This fetches that exact
// table for the pinned revision and asserts the requested version is in it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISH_WORKFLOW_RELATIVE_PATH = ".github/workflows/publish.yml";
const SETUP_ORAS_STEP_NAME = "Setup ORAS CLI";
const USES_PATTERN = /^\s*uses:\s*oras-project\/setup-oras@([0-9a-f]{40})/u;
const VERSION_PATTERN = /^\s*version:\s*["']?([^"'\s#]+)["']?/u;
const RELEASES_JSON_TIMEOUT_MS = 10_000;

export function extractOrasSetupStep(publishWorkflowText) {
  const lines = publishWorkflowText.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) => line.includes(SETUP_ORAS_STEP_NAME));
  if (stepIndex === -1) {
    throw new Error(`could not find a "${SETUP_ORAS_STEP_NAME}" step in ${PUBLISH_WORKFLOW_RELATIVE_PATH}`);
  }

  let sha;
  let version;
  for (let index = stepIndex + 1; index < lines.length && index < stepIndex + 10; index += 1) {
    const usesMatch = lines[index].match(USES_PATTERN);
    if (usesMatch !== null) sha = usesMatch[1];
    const versionMatch = lines[index].match(VERSION_PATTERN);
    if (versionMatch !== null) version = versionMatch[1];
    if (sha !== undefined && version !== undefined) break;
  }

  if (sha === undefined) {
    throw new Error(`could not find a commit-SHA-pinned "uses: oras-project/setup-oras@..." after the setup step`);
  }
  if (version === undefined) {
    throw new Error(`could not find a "with.version" input after the setup-oras step`);
  }

  return { sha, version };
}

export async function fetchSupportedOrasVersions(sha, fetchImpl = fetch) {
  const url = `https://raw.githubusercontent.com/oras-project/setup-oras/${sha}/src/lib/data/releases.json`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(RELEASES_JSON_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`could not fetch setup-oras release table at ${url}: HTTP ${response.status}`);
  }
  const table = await response.json();
  return Object.keys(table);
}

export function checkOrasCompatibility(version, supportedVersions) {
  if (!supportedVersions.includes(version)) {
    return {
      compatible: false,
      message:
        `pinned setup-oras revision does not support ORAS CLI version ${version}; ` +
        `supported versions are: ${supportedVersions.join(", ")}`,
    };
  }
  return { compatible: true, message: `ORAS CLI version ${version} is supported by the pinned setup-oras revision` };
}

async function runAsCommand() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const publishWorkflowText = fs.readFileSync(path.join(repositoryRoot, PUBLISH_WORKFLOW_RELATIVE_PATH), "utf8");

  let sha;
  let version;
  try {
    ({ sha, version } = extractOrasSetupStep(publishWorkflowText));
  } catch (error) {
    console.error("ORAS setup compatibility check failed: " + error.message);
    process.exitCode = 1;
    return;
  }

  let supportedVersions;
  try {
    supportedVersions = await fetchSupportedOrasVersions(sha);
  } catch (error) {
    console.error("ORAS setup compatibility check could not verify upstream data: " + error.message);
    process.exitCode = 1;
    return;
  }

  const result = checkOrasCompatibility(version, supportedVersions);
  if (!result.compatible) {
    console.error("ORAS setup compatibility check failed: " + result.message);
    process.exitCode = 1;
    return;
  }

  console.log("ORAS setup compatibility check passed: " + result.message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAsCommand();
}
