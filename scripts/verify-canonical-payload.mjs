#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { verifyCanonicalPayload } from "./lib/canonical-payload.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

const sourceRootIndex = process.argv.indexOf("--source-root");
const sourceRoot = sourceRootIndex === -1 ? process.cwd() : path.resolve(process.argv[sourceRootIndex + 1] ?? "");
const identity = verifyCanonicalPayload(path.resolve(option("tarball")), path.resolve(option("identity")), sourceRoot);
console.log(
  `verified ${identity.package.name}@${identity.package.version} canonical payload ${identity.payload.sha256}`,
);
