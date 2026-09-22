#!/usr/bin/env node
// Build, pack, install, and load the Pi adapter from its npm artifact.
// The consumer is deliberately outside the repository so source-tree imports
// cannot satisfy this certification.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(repositoryRoot, "packages", "pi-mottainai");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function readPackageJson(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
}

function findTarball(directory, packageName) {
  const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".tgz"));
  if (files.length !== 1) throw new Error(`expected one packed ${packageName} artifact, found ${files.length}`);
  return path.join(directory, files[0]);
}

function main() {
  const sourcePackage = readPackageJson(packageDirectory);
  if (sourcePackage.private === true) throw new Error("pi-mottainai must be publishable");
  if (sourcePackage.name !== "pi-mottainai") throw new Error(`unexpected package name: ${sourcePackage.name}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mottainai-package-smoke-"));
  const artifactDirectory = path.join(temporaryRoot, "artifact");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(artifactDirectory);
  fs.mkdirSync(consumerDirectory);
  try {
    run("pnpm", ["--dir", packageDirectory, "run", "build"]);
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifactDirectory], {
      cwd: packageDirectory,
    });
    const tarballPath = findTarball(artifactDirectory, sourcePackage.name);

    fs.writeFileSync(
      path.join(consumerDirectory, "package.json"),
      JSON.stringify({ name: "pi-mottainai-smoke-consumer", private: true, version: "0.0.0", type: "module" }, null, 2),
    );
    run("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
      cwd: consumerDirectory,
    });

    const installedDirectory = path.join(consumerDirectory, "node_modules", sourcePackage.name);
    const installedPackage = readPackageJson(installedDirectory);
    if (installedPackage.version !== sourcePackage.version) {
      throw new Error(`installed version ${installedPackage.version} differs from source ${sourcePackage.version}`);
    }
    if (fs.existsSync(path.join(installedDirectory, "src"))) throw new Error("packed artifact contains source files");
    if (!fs.existsSync(path.join(installedDirectory, "dist", "index.js"))) {
      throw new Error("packed artifact does not contain dist/index.js");
    }

    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { PiMottainaiRuntime, PI_MOTTAINAI_PROVIDER } from "pi-mottainai"; if (typeof PiMottainaiRuntime !== "function" || PI_MOTTAINAI_PROVIDER !== "pi") process.exit(1);',
      ],
      { cwd: consumerDirectory },
    );
    console.log(`verified ${sourcePackage.name}@${sourcePackage.version} from packed artifact`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main();
