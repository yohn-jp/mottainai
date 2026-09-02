import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "./lib/schema-validator.mjs";

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schema");

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8"));
}

export function validateManifest(manifest) {
  return validateAgainstSchema(loadSchema("manifest.schema.json"), manifest);
}

export function validatePrIndex(prIndex) {
  return validateAgainstSchema(loadSchema("pr-index.schema.json"), prIndex);
}

function reportOrExit(label, result) {
  if (result.valid) {
    console.log(`${label}: valid`);
    return true;
  }
  console.error(`${label}: invalid`);
  for (const error of result.errors) console.error(`  - ${error}`);
  return false;
}

function main() {
  const [manifestPath, prIndexPath] = process.argv.slice(2);
  if (!manifestPath) {
    console.error("usage: validate-manifest.mjs <manifest.json> [pr-index.json]");
    return 1;
  }

  let ok = reportOrExit(manifestPath, validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))));
  if (prIndexPath) {
    ok = reportOrExit(prIndexPath, validatePrIndex(JSON.parse(fs.readFileSync(prIndexPath, "utf8")))) && ok;
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("validate-manifest.mjs")) {
  process.exitCode = main();
}
