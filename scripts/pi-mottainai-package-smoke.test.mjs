import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repositoryRoot, "packages", "pi-mottainai", "package.json");
const smokePath = path.join(repositoryRoot, "scripts", "pi-mottainai-package-smoke.mjs");

test("pi-mottainai exposes canonical publish metadata and a dist-only entry point", () => {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(packageJson.name, "pi-mottainai");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
  assert.notEqual(packageJson.private, true);
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.equal(packageJson.main, "dist/index.js");
  assert.equal(packageJson.types, "dist/index.d.ts");
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
  assert.equal(packageJson.publishConfig.registry, "https://registry.npmjs.org/");
});

test("pi-mottainai smoke certifies the packed artifact in a clean consumer", () => {
  const result = spawnSync(process.execPath, [smokePath], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified pi-mottainai@/u);
});
