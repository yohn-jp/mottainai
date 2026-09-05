import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");

function jobBlock(jobId) {
  const lines = workflowText.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^  ${jobId}:\\s*$`, "u").test(line));
  assert.notEqual(start, -1, `missing ${jobId} job`);
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/u.test(line));
  return { lines, start, end: end === -1 ? lines.length : end };
}

function stepBlock(lines, start, end, stepName) {
  const heading = lines.findIndex(
    (line, index) => index >= start && index < end && line.includes(`- name: ${stepName}`),
  );
  assert.notEqual(heading, -1, `missing step ${stepName}`);
  const stepIndent = lines[heading].match(/^(\s*)-/u)[1].length;
  let stepEnd = end;
  for (let index = heading + 1; index < end; index += 1) {
    if (new RegExp(`^\\s{${stepIndent}}-\\s+name:`).test(lines[index])) {
      stepEnd = index;
      break;
    }
  }
  return lines.slice(heading, stepEnd).join("\n");
}

test("release descriptor publication has an unconditional production artifact round-trip gate", () => {
  const { lines, start, end } = jobBlock("deployment-descriptor");
  const gate = stepBlock(lines, start, end, "Verify the production deployment artifact round-trip (Issue #832)");

  assert.match(gate, /node --import tsx scripts\/verify-deployment-artifact-roundtrip\.mjs/u);
  assert.match(gate, /--descriptor mottainai-deployment-v1\.json/u);
  assert.match(gate, /--tarball "\$tarball"/u);
  assert.match(gate, /--system x86_64-linux/u);
  assert.doesNotMatch(gate, /^\s*if:/mu, "the release gate must not be silently skipped");

  const assembleIndex = lines.findIndex(
    (line, index) => index >= start && index < end && line.includes("Assemble and validate the release descriptor"),
  );
  const gateIndex = lines.findIndex(
    (line, index) =>
      index >= start &&
      index < end &&
      line.includes("Verify the production deployment artifact round-trip (Issue #832)"),
  );
  const publishIndex = lines.findIndex(
    (line, index) => index >= start && index < end && line.includes("Publish descriptor assets idempotently"),
  );
  assert.ok(
    assembleIndex < gateIndex && gateIndex < publishIndex,
    "the gate must run after descriptor creation and before publication",
  );

  const nixInstall = lines.findIndex(
    (line, index) =>
      index >= start && index < end && line.includes("Install Nix for the deployment artifact round-trip gate"),
  );
  assert.notEqual(nixInstall, -1, "the gate must have a real Nix toolchain");
  assert.match(
    lines.slice(nixInstall, nixInstall + 3).join("\n"),
    /DeterminateSystems\/nix-installer-action@[0-9a-f]{40}/u,
  );
});

test("finalize-release cannot publish without the round-trip-bearing descriptor job", () => {
  assert.match(
    workflowText,
    /needs:\s*\[prepare-release, publish, runtime-appliance, host-bootstrap-init, deployment-descriptor\]/u,
  );
});
