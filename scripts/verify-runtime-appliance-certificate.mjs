#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { verifyRuntimeApplianceCertificate } from "./lib/runtime-appliance-certificate.mjs";

function option(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    if (!required) return undefined;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

const directory = path.resolve(option("directory"));
const certificatePath = path.resolve(option("certificate"));
const certificate = JSON.parse(fs.readFileSync(certificatePath, "utf8"));
verifyRuntimeApplianceCertificate({
  directory,
  certificate,
  sourceRevision: option("source-revision", false),
});
console.log(`verified certified Runtime Appliance identity in ${directory}`);
