#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildRuntimeApplianceCertificate } from "./lib/runtime-appliance-certificate.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

const directory = path.resolve(option("directory"));
const output = path.resolve(option("output"));
const certificate = buildRuntimeApplianceCertificate({
  directory,
  sourceRevision: option("source-revision"),
  workflow: option("workflow"),
  job: option("job"),
  runId: option("run-id"),
  runAttempt: option("run-attempt"),
});
fs.writeFileSync(output, `${JSON.stringify(certificate, null, 2)}\n`, { mode: 0o644 });
console.log(`wrote ${output}`);
