import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
const ciWorkflowText = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const goldenPathText = fs.readFileSync(
  path.join(repositoryRoot, "nix/tests/runtime-appliance-golden-path.nix"),
  "utf8",
);

function jobBlock(workflow, jobId) {
  const lines = workflow.split(/\r?\n/u);
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
  const { lines, start, end } = jobBlock(workflowText, "deployment-descriptor");
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

test("PR runtime-nix CI runs the real production-shaped positive round-trip proof", () => {
  const { lines, start, end } = jobBlock(ciWorkflowText, "runtime-nix");
  const proofIndex = lines.findIndex(
    (line, index) =>
      index >= start && index < end && line.includes("Verify corrected production deployment artifact round-trip"),
  );
  assert.notEqual(proofIndex, -1, "runtime-nix must run the positive round-trip proof");
  const proof = stepBlock(lines, start, end, "Verify corrected production deployment artifact round-trip (Issue #832)");
  assert.match(proof, /pnpm run test:deployment-roundtrip/u);
  const nixIndex = lines.findIndex(
    (line, index) => index >= start && index < proofIndex && line.includes("Install Nix"),
  );
  assert.notEqual(nixIndex, -1, "the positive proof must use the existing runtime-nix toolchain");
});

test("trusted-main certification forwards exact Runtime Appliance bytes to publication (#894)", () => {
  const { lines: ciLines, start: ciStart, end: ciEnd } = jobBlock(ciWorkflowText, "runtime-appliance");
  const ciBlock = ciLines.slice(ciStart, ciEnd).join("\n");
  assert.match(ciBlock, /Create the certified Runtime Appliance identity evidence \(Issue #894\)/u);
  assert.match(ciBlock, /create-runtime-appliance-certificate\.mjs/u);
  assert.match(ciBlock, /Upload the trusted-main certified Runtime Appliance \(Issue #894\)/u);
  assert.match(ciBlock, /mottainai-runtime-appliance-certified-x86_64-linux/u);

  const artifact = jobBlock(ciWorkflowText, "runtime-appliance-artifact");
  const artifactBlock = artifact.lines.slice(artifact.start, artifact.end).join("\n");
  assert.match(artifactBlock, /Download the exact trusted-main certified Runtime Appliance/u);
  assert.match(artifactBlock, /Verify and forward the certified Runtime Appliance without rebuilding/u);
  assert.doesNotMatch(artifactBlock, /nix build .*runtime-appliance-image/u);
  assert.match(artifactBlock, /mottainai-runtime-appliance-x86_64-linux/u);
});

test("trusted-main production certification binds Route 3, Route 2, and Route 1 independently of Lima (#904)", () => {
  const { lines, start, end } = jobBlock(ciWorkflowText, "runtime-appliance");
  const preparation = stepBlock(
    lines,
    start,
    end,
    "Prepare descriptor-bound production Runtime certification inputs (Issue #904)",
  );
  assert.match(preparation, /pack-canonical-payload\.mjs/u);
  assert.match(preparation, /verify-canonical-payload\.mjs/u);
  assert.match(preparation, /node --import tsx scripts\/create-trusted-main-runtime-certification-input\.mjs/u);
  assert.match(preparation, /runtime-certification-input\.json/u);
  assert.match(preparation, /route3\.appliance\.rawSha256 == \$raw_sha256/u);
  assert.match(preparation, /route3\.appliance\.digest == \$oci_digest/u);
  assert.match(preparation, /manifest_layer_digest/u);

  const golden = stepBlock(
    lines,
    start,
    end,
    "Prove mottainai-init resolves/verifies the real canonical Runtime Appliance and run the Runtime Appliance golden path (Issue #630, #661, #768)",
  );
  assert.match(golden, /MOTTAINAI_PRODUCTION_DESCRIPTOR/u);
  assert.match(golden, /MOTTAINAI_PRODUCTION_PAYLOAD/u);
  assert.match(golden, /MOTTAINAI_PRODUCTION_SOURCE_ARCHIVE/u);
  assert.match(golden, /productionCertification != null/u);
  assert.match(golden, /managedRuntimeReady == true/u);
  assert.match(golden, /secondEnsure == "noop"/u);
  assert.match(golden, /garbageCollection\.activeGenerationExecutableAfterGc == true/u);
  assert.match(golden, /rebootIdentityPersistence\.verified == true/u);
  assert.match(golden, /rollbackRecovery\.unhealthyNextGenerationAttempted == true/u);
  assert.match(golden, /rollbackRecovery\.failureCode == "health_failure"/u);
  assert.match(golden, /rollbackRecovery\.rollbackCompleted == true/u);
  assert.match(golden, /rollbackRecovery\.recoveryManagedRuntimeReady == true/u);
  assert.match(golden, /runtime-certification-evidence\.json/u);

  const lima = stepBlock(
    lines,
    start,
    end,
    "Exercise production Lima composition through canonical guest health (Issue #844)",
  );
  assert.match(lima, /MOTTAINAI_PRODUCTION_LIMA_STATE_DIRECTORY/u);
  assert.doesNotMatch(lima, /runtime-certification-evidence/u);
});

test("production evidence does not claim fixture-only previous-generation checks (#904)", () => {
  assert.match(goldenPathText, /"previousGenerationChecks":\s*\{[\s\S]*?"executed": False/u);
  assert.match(goldenPathText, /"rollbackRecovery": production_recovery_evidence/u);
  assert.match(goldenPathText, /write_manifest\(manifest_v1\)[\s\S]*?recovery_result = reconcile\(\)/u);
  assert.match(goldenPathText, /"activeAndPreviousExecutableAfterGc": True/u);
  assert.match(goldenPathText, /"missingPreviousRootFailsClosed": True/u);
});

test("release publication consumes the exact successful CI certificate and emits chain evidence (#894)", () => {
  const runtime = jobBlock(workflowText, "runtime-appliance");
  const runtimeBlock = runtime.lines.slice(runtime.start, runtime.end).join("\n");
  assert.match(runtimeBlock, /actions:\s*read/u);
  assert.match(runtimeBlock, /Resolve the exact trusted-main Runtime Appliance certification run \(Issue #894\)/u);
  assert.match(runtimeBlock, /head_sha=\$SOURCE_REVISION/u);
  assert.match(runtimeBlock, /Download the exact certified Runtime Appliance bytes \(Issue #894\)/u);
  assert.match(runtimeBlock, /run-id:\s*\$\{\{ steps\.certification_run\.outputs\.run_id \}\}/u);
  assert.match(runtimeBlock, /verify-runtime-appliance-certificate\.mjs/u);
  assert.match(runtimeBlock, /test "\$oci_digest" = "\$\(jq -er '\.oci\.digest' "\$certificate"\)"/u);
  assert.doesNotMatch(runtimeBlock, /Build canonical Runtime Appliance from the tagged source/u);
  assert.doesNotMatch(runtimeBlock, /build-runtime-appliance-manifest\.mjs/u);
  assert.match(runtimeBlock, /Upload mechanically auditable Runtime Appliance publication evidence \(Issue #894\)/u);

  const descriptor = jobBlock(workflowText, "deployment-descriptor");
  const descriptorBlock = descriptor.lines.slice(descriptor.start, descriptor.end).join("\n");
  assert.match(descriptorBlock, /Download the exact Runtime Appliance publication evidence \(Issue #894\)/u);
  assert.match(descriptorBlock, /\.certified\.ociManifestDigest == \.published\.ociDigest/u);
  assert.match(descriptorBlock, /\.certified\.manifestSizeBytes == \.published\.manifestSizeBytes/u);
  assert.match(descriptorBlock, /published\.ociDigest == \$oci_digest/u);
  assert.match(descriptorBlock, /mottainai-runtime-appliance-publication-evidence\.json/u);
});
