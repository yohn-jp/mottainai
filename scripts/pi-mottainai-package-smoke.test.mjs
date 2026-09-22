import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repositoryRoot, "packages", "pi-mottainai", "package.json");
const smokePath = path.join(repositoryRoot, "scripts", "pi-mottainai-package-smoke.mjs");
const rootPackagePath = path.join(repositoryRoot, "package.json");
const rootDistPath = path.join(repositoryRoot, "dist");
const piPackageDirectory = path.join(repositoryRoot, "packages", "pi-mottainai");
const piDistPath = path.join(piPackageDirectory, "dist");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function buildPackages() {
  run("pnpm", ["run", "build"]);
  run("pnpm", ["--dir", piPackageDirectory, "run", "build"]);
}

function packFixture(directory, packageJson, temporaryRoot) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const outputDirectory = path.join(
    temporaryRoot,
    `${packageJson.name}-artifact-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(outputDirectory);
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", outputDirectory], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const tarballs = fs.readdirSync(outputDirectory).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  return path.join(outputDirectory, tarballs[0]);
}

function makeArtifactFixtures() {
  buildPackages();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mottainai-package-fixtures-"));
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  rootPackage.version = "0.9.4";
  const piPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));

  const goodRootDirectory = path.join(temporaryRoot, "root-good");
  fs.cpSync(rootDistPath, path.join(goodRootDirectory, "dist"), { recursive: true });
  const goodRoot = packFixture(goodRootDirectory, rootPackage, temporaryRoot);

  const goodPiDirectory = path.join(temporaryRoot, "pi-good");
  fs.cpSync(piDistPath, path.join(goodPiDirectory, "dist"), { recursive: true });
  const goodPi = packFixture(goodPiDirectory, piPackage, temporaryRoot);

  const rootWithoutExportPackage = structuredClone(rootPackage);
  delete rootWithoutExportPackage.exports["./worker-runtime"];
  const rootWithoutExportDirectory = path.join(temporaryRoot, "root-without-worker-runtime");
  fs.cpSync(rootDistPath, path.join(rootWithoutExportDirectory, "dist"), { recursive: true });
  const rootWithoutExport = packFixture(rootWithoutExportDirectory, rootWithoutExportPackage, temporaryRoot);

  const incompatibleRootPackage = structuredClone(rootPackage);
  incompatibleRootPackage.version = "0.9.3";
  const incompatibleRootDirectory = path.join(temporaryRoot, "root-incompatible");
  fs.cpSync(rootDistPath, path.join(incompatibleRootDirectory, "dist"), { recursive: true });
  const incompatibleRoot = packFixture(incompatibleRootDirectory, incompatibleRootPackage, temporaryRoot);

  return { temporaryRoot, goodRoot, goodPi, rootWithoutExport, incompatibleRoot };
}

function runSmoke(rootTarball, piTarball) {
  return spawnSync(process.execPath, [smokePath, "--root-tarball", rootTarball, "--pi-tarball", piTarball], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("pi-mottainai declares the canonical peer and a dist-only publish surface", () => {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(packageJson.name, "pi-mottainai");
  assert.equal(packageJson.peerDependencies.mottainai, ">=0.9.4");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
  assert.notEqual(packageJson.private, true);
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.equal(packageJson.main, "dist/index.js");
  assert.equal(packageJson.types, "dist/index.d.ts");
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
  assert.equal(packageJson.publishConfig.registry, "https://registry.npmjs.org/");
});

test("pi-mottainai smoke installs exact root and Pi tarballs in an external consumer", () => {
  const result = spawnSync(process.execPath, [smokePath], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /resolved root=.*\/consumer\/node_modules\/mottainai\//u);
  assert.match(result.stdout, /pi=.*\/consumer\/node_modules\/pi-mottainai\//u);
  assert.match(result.stdout, /verified mottainai@0\.9\.4 and pi-mottainai@/u);
});

test("pi-mottainai smoke rejects missing canonical exports and incompatible root peers", () => {
  const fixtures = makeArtifactFixtures();
  try {
    const missingExport = runSmoke(fixtures.rootWithoutExport, fixtures.goodPi);
    assert.notEqual(missingExport.status, 0, "a root artifact without worker-runtime must fail");
    assert.match(`${missingExport.stdout}\n${missingExport.stderr}`, /ERR_PACKAGE_PATH_NOT_EXPORTED|worker-runtime/u);

    const incompatiblePeer = runSmoke(fixtures.incompatibleRoot, fixtures.goodPi);
    assert.notEqual(incompatiblePeer.status, 0, "a root artifact below the Pi peer lower bound must fail");
    assert.match(`${incompatiblePeer.stdout}\n${incompatiblePeer.stderr}`, /ERESOLVE|peer|0\.9\.4/u);
  } finally {
    fs.rmSync(fixtures.temporaryRoot, { recursive: true, force: true });
  }
});
