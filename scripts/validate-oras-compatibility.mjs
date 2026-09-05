#!/usr/bin/env node
// Reproduces the 0.9.1 publish failure (Issue #821) as a pre-merge check:
// setup-oras resolves the ORAS CLI from a version->checksum table baked
// into the pinned Action revision, so an Action SHA and a `with.version`
// that are each individually "current" can still be an incompatible pair
// if the table predates the requested CLI release. This fetches that exact
// table for the pinned revision and asserts the requested version is in it.
//
// It also reproduces the follow-on 0.9.2 publish failure (Issue #834):
// publish.yml called `oras manifest fetch --no-tty` and `oras tag --no-tty`,
// but `--no-tty` only exists on `push`/`pull` (it disables their progress
// bar) and never existed on `manifest fetch` or `tag`. That flag/subcommand
// mismatch was invisible until a real release got past CLI setup, because
// the #821 failure always happened first. checkOrasFlagSupport downloads
// the actual pinned CLI release and checks every `oras <subcommand> --flag`
// invocation in publish.yml against that subcommand's real `--help` output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const PUBLISH_WORKFLOW_RELATIVE_PATH = ".github/workflows/publish.yml";
const SETUP_ORAS_STEP_NAME = "Setup ORAS CLI";
const USES_PATTERN = /^\s*uses:\s*oras-project\/setup-oras@([0-9a-f]{40})/u;
const VERSION_PATTERN = /^\s*version:\s*["']?([^"'\s#]+)["']?/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ORAS_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const RELEASES_JSON_TIMEOUT_MS = 10_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 30_000;
// Two-word subcommands must be listed before their one-word prefix would
// otherwise match (there is no `oras manifest` invocation on its own here).
const ORAS_SUBCOMMANDS = ["manifest fetch", "push", "pull", "tag", "login"];
const ORAS_INVOCATION_PATTERN = new RegExp(
  `\\boras\\s+(${ORAS_SUBCOMMANDS.map((command) => command.replace(" ", "\\s+")).join("|")})\\s+([^\\n]*)`,
  "gu",
);
const FLAG_PATTERN = /--([a-z][a-z0-9-]*)/gu;
// Matches only a flag *declaration* line in `--help` output, e.g.
// `  -d, --debug   output debug logs (implies --no-tty)`, so a flag named
// in a description's prose (like `--no-tty` there) is never mistaken for a
// flag the described command itself accepts.
const FLAG_DECLARATION_PATTERN = /^\s*(?:-[a-zA-Z],\s+)?--([a-z][a-z0-9-]*)(?:\s{2,}|\s+[a-zA-Z0-9_]+\s{2,}|$)/u;

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

export function validateSetupOrasSha(sha) {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error("setup-oras revision must be exactly a 40-character lowercase hexadecimal commit SHA");
  }
  return sha;
}

// Constrains the extracted `with.version` before it can reach a download
// URL, the same way validateSetupOrasSha constrains the extracted Action
// SHA: publish.yml is trusted content, but a value pulled out of it by
// regex should still be shaped like the bare semver ORAS actually
// publishes before it is allowed to influence an outbound request.
export function validateOrasVersion(version) {
  if (!ORAS_VERSION_PATTERN.test(version)) {
    throw new Error("ORAS CLI version must be exactly a bare MAJOR.MINOR.PATCH semver");
  }
  return version;
}

export async function fetchSupportedOrasVersions(sha, fetchImpl = fetch) {
  const validatedSha = validateSetupOrasSha(sha);
  const url = `https://raw.githubusercontent.com/oras-project/setup-oras/${validatedSha}/src/lib/data/releases.json`;
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

export function extractOrasInvocations(publishWorkflowText) {
  const invocations = [];
  for (const match of publishWorkflowText.matchAll(ORAS_INVOCATION_PATTERN)) {
    const subcommand = match[1].replace(/\s+/gu, " ");
    const flags = [...match[2].matchAll(FLAG_PATTERN)].map((flagMatch) => flagMatch[1]);
    invocations.push({ subcommand, flags });
  }
  return invocations;
}

export async function downloadOrasBinary(version, destinationDirectory, fetchImpl = fetch) {
  const validatedVersion = validateOrasVersion(version);
  const archiveName = `oras_${validatedVersion}_linux_amd64.tar.gz`;
  const url = `https://github.com/oras-project/oras/releases/download/v${validatedVersion}/${archiveName}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(BINARY_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`could not download ORAS CLI release at ${url}: HTTP ${response.status}`);
  }

  const archivePath = path.join(destinationDirectory, archiveName);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archivePath));
  execFileSync("tar", ["xzf", archivePath, "-C", destinationDirectory], { stdio: "pipe" });

  const binaryPath = path.join(destinationDirectory, "oras");
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

export function fetchOrasSubcommandFlags(binaryPath, subcommand) {
  const helpText = execFileSync(binaryPath, [...subcommand.split(" "), "--help"], { encoding: "utf8" });
  const flags = new Set();
  for (const line of helpText.split(/\r?\n/u)) {
    const match = line.match(FLAG_DECLARATION_PATTERN);
    if (match !== null) flags.add(match[1]);
  }
  return flags;
}

export function checkOrasFlagSupport(invocations, subcommandFlags) {
  const errors = [];
  for (const { subcommand, flags } of invocations) {
    const supportedFlags = subcommandFlags.get(subcommand);
    if (supportedFlags === undefined) continue;
    for (const flag of flags) {
      if (!supportedFlags.has(flag)) {
        errors.push(`\`oras ${subcommand} --${flag}\` is not a valid flag on this ORAS CLI release`);
      }
    }
  }
  return { compatible: errors.length === 0, errors };
}

async function runFlagSupportCheck(binaryPath, publishWorkflowText) {
  const invocations = extractOrasInvocations(publishWorkflowText);
  const subcommandFlags = new Map();
  for (const subcommand of new Set(invocations.map((invocation) => invocation.subcommand))) {
    subcommandFlags.set(subcommand, fetchOrasSubcommandFlags(binaryPath, subcommand));
  }
  return checkOrasFlagSupport(invocations, subcommandFlags);
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

  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oras-flag-support-"));
  try {
    let binaryPath;
    try {
      binaryPath = await downloadOrasBinary(version, workDirectory);
    } catch (error) {
      console.error("ORAS flag support check could not download the pinned CLI release: " + error.message);
      process.exitCode = 1;
      return;
    }

    const flagResult = await runFlagSupportCheck(binaryPath, publishWorkflowText);
    if (!flagResult.compatible) {
      console.error("ORAS flag support check failed:");
      for (const error of flagResult.errors) console.error("- " + error);
      process.exitCode = 1;
      return;
    }

    console.log("ORAS flag support check passed: every oras invocation in publish.yml uses a supported flag");
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAsCommand();
}
