#!/usr/bin/env node
/**
 * Canonicalize and validate the release deployment descriptor (#755).
 * Inputs are supplied as a file so release jobs can fan in independently
 * built artifacts without this script reaching into mutable registries.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

const inputPath = path.resolve(option("input"));
const outputPath = path.resolve(option("output"));
const identityPath = process.argv.includes("--identity-output")
  ? path.resolve(option("identity-output"))
  : `${outputPath}.sha256`;

let value;
try {
  value = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
  throw new Error(
    `deployment descriptor input cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Keep the validator in the runtime-contract authority. The script is a thin
// release boundary and must not grow a second, drifting schema.
const { canonicalDeploymentDescriptorText, deploymentDescriptorIdentityOf, parseDeploymentDescriptor } = await import(
  "../src/runtime-contract/deployment-descriptor.ts"
);
const descriptor = parseDeploymentDescriptor(value);
const canonical = canonicalDeploymentDescriptorText(descriptor);
const identity = deploymentDescriptorIdentityOf(descriptor);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, canonical, { mode: 0o644 });
fs.mkdirSync(path.dirname(identityPath), { recursive: true });
fs.writeFileSync(identityPath, `${identity}  ${path.basename(outputPath)}\n`, { mode: 0o644 });

// Recompute from bytes written, guarding against accidental formatter or
// newline changes in the publication path.
const written = fs.readFileSync(outputPath);
const writtenIdentity = crypto.createHash("sha256").update(written).digest("hex");
if (writtenIdentity !== identity) throw new Error("canonical descriptor bytes changed while writing");
console.log(JSON.stringify({ output: outputPath, identity, bytes: written.length }, null, 2));
