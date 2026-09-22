#!/usr/bin/env node
// Build, pack, install, and load the Pi adapter from exact npm artifacts.
// The consumer is deliberately outside the repository so source-tree imports,
// workspace links, and an arbitrary registry peer cannot satisfy certification.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(repositoryRoot, "packages", "pi-mottainai");
const canonicalPeerRange = ">=0.9.4";
const firstCompatibleRootVersion = "0.9.4";

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

function readPackedPackageJson(tarballPath) {
  return JSON.parse(run("tar", ["-xOf", tarballPath, "package/package.json"]).stdout);
}

function findTarball(directory, packageName) {
  const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".tgz"));
  if (files.length !== 1) throw new Error(`expected one packed ${packageName} artifact, found ${files.length}`);
  return path.join(directory, files[0]);
}

function parseArguments(argv) {
  let rootTarball;
  let piTarball;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root-tarball") {
      rootTarball = argv[++index];
    } else if (argument === "--pi-tarball") {
      piTarball = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if ((rootTarball === undefined) !== (piTarball === undefined)) {
    throw new Error("--root-tarball and --pi-tarball must be provided together");
  }
  return { rootTarball, piTarball };
}

function copyRepositoryForRootPack(destination) {
  fs.cpSync(repositoryRoot, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repositoryRoot, source);
      return (
        !relative ||
        ![".git", "node_modules", ".nawabari"].some(
          (entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`),
        )
      );
    },
  });
}

function rootVersionSatisfiesCanonicalPeer(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 0 || (major === 0 && minor > 9) || (major === 0 && minor === 9 && patch >= 4);
}

function packBuiltArtifacts(temporaryRoot, sourcePackage) {
  const artifactDirectory = path.join(temporaryRoot, "artifact");
  const rootPackDirectory = path.join(temporaryRoot, "root-package");
  const piPackDirectory = path.join(temporaryRoot, "pi-package");
  fs.mkdirSync(artifactDirectory);
  copyRepositoryForRootPack(rootPackDirectory);
  fs.cpSync(packageDirectory, piPackDirectory, {
    recursive: true,
    filter(source) {
      const relative = path.relative(packageDirectory, source);
      return (
        !relative ||
        !["node_modules", "dist"].some((entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`))
      );
    },
  });
  fs.cpSync(path.join(packageDirectory, "dist"), path.join(piPackDirectory, "dist"), { recursive: true });

  const rootPackagePath = path.join(rootPackDirectory, "package.json");
  const rootPackage = readPackageJson(rootPackDirectory);
  // The implementation intentionally leaves the root package at 0.9.3. A
  // local smoke run models the first compatible release metadata while using
  // the freshly built dist from this exact checkout. Release verification
  // supplies the exact release tarball instead and therefore does not use
  // this projection.
  if (!rootVersionSatisfiesCanonicalPeer(rootPackage.version)) {
    rootPackage.version = firstCompatibleRootVersion;
    fs.writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  }

  run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifactDirectory], { cwd: rootPackDirectory });
  const rootTarball = findTarball(artifactDirectory, sourcePackage.name);

  const piArtifactDirectory = path.join(temporaryRoot, "pi-artifact");
  fs.mkdirSync(piArtifactDirectory);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", piArtifactDirectory], { cwd: piPackDirectory });
  const piTarball = findTarball(piArtifactDirectory, sourcePackage.name);
  return { rootTarball, piTarball };
}

function verifyPackedArtifacts(rootTarball, piTarball, consumerDirectory) {
  const rootPackage = readPackedPackageJson(rootTarball);
  const piPackage = readPackedPackageJson(piTarball);
  if (rootPackage.name !== "mottainai") throw new Error(`unexpected root package name: ${rootPackage.name}`);
  if (piPackage.name !== "pi-mottainai") throw new Error(`unexpected Pi package name: ${piPackage.name}`);
  if (piPackage.peerDependencies?.mottainai !== canonicalPeerRange) {
    throw new Error(`Pi artifact declares unexpected mottainai peer: ${piPackage.peerDependencies?.mottainai}`);
  }

  fs.writeFileSync(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "pi-mottainai-smoke-consumer",
        private: true,
        version: "0.0.0",
        type: "module",
        dependencies: {
          mottainai: pathToFileURL(rootTarball).href,
          "pi-mottainai": pathToFileURL(piTarball).href,
        },
      },
      null,
      2,
    ),
  );

  // Both package specs are exact file tarballs. The consumer is outside the
  // repository and has no workspace, so npm cannot replace the root artifact
  // with a workspace link or an arbitrary registry peer.
  run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumerDirectory,
    env: {
      ...process.env,
      npm_config_workspaces: "false",
    },
  });

  const installedRootDirectory = path.join(consumerDirectory, "node_modules", "mottainai");
  const installedPiDirectory = path.join(consumerDirectory, "node_modules", "pi-mottainai");
  const installedRoot = readPackageJson(installedRootDirectory);
  const installedPi = readPackageJson(installedPiDirectory);
  if (installedRoot.version !== rootPackage.version) {
    throw new Error(`installed root version ${installedRoot.version} differs from packed ${rootPackage.version}`);
  }
  if (installedPi.version !== piPackage.version) {
    throw new Error(`installed Pi version ${installedPi.version} differs from packed ${piPackage.version}`);
  }
  if (fs.existsSync(path.join(installedRootDirectory, "src"))) throw new Error("root artifact contains source files");
  if (fs.existsSync(path.join(installedPiDirectory, "src"))) throw new Error("Pi artifact contains source files");
  if (!fs.existsSync(path.join(installedRootDirectory, "dist", "manager", "worker-runtime.js"))) {
    throw new Error("root artifact does not contain dist/manager/worker-runtime.js");
  }
  if (!fs.existsSync(path.join(installedPiDirectory, "dist", "index.js"))) {
    throw new Error("Pi artifact does not contain dist/index.js");
  }

  const verificationScript = path.join(consumerDirectory, "verify.mjs");
  fs.writeFileSync(
    verificationScript,
    `import { WORKER_RUNTIME_CONTRACT_ID, WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA } from "mottainai/worker-runtime";\n` +
      `import { REPORT_STATUS_PARAMETERS, PiMottainaiRuntime, PI_MOTTAINAI_PROVIDER } from "pi-mottainai";\n` +
      `if (WORKER_RUNTIME_CONTRACT_ID !== "mottainai.worker-runtime.v1") throw new Error("canonical worker-runtime contract missing");\n` +
      `if (REPORT_STATUS_PARAMETERS !== WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA) throw new Error("Pi did not resolve its canonical contract from the installed root artifact");\n` +
      `if (typeof PiMottainaiRuntime !== "function" || PI_MOTTAINAI_PROVIDER !== "pi") throw new Error("Pi adapter exports are invalid");\n` +
      `const rootResolved = await import.meta.resolve("mottainai/worker-runtime");\n` +
      `const piResolved = await import.meta.resolve("pi-mottainai");\n` +
      `if (!rootResolved.includes("/node_modules/mottainai/")) throw new Error(\`root resolved outside consumer artifact: \${rootResolved}\`);\n` +
      `if (!piResolved.includes("/node_modules/pi-mottainai/")) throw new Error(\`Pi resolved outside consumer artifact: \${piResolved}\`);\n` +
      `console.log(\`resolved root=\${rootResolved} pi=\${piResolved}\`);\n`,
  );
  const verification = run(process.execPath, [verificationScript], { cwd: consumerDirectory });
  process.stdout.write(verification.stdout);
}

function main() {
  const sourcePackage = readPackageJson(packageDirectory);
  if (sourcePackage.private === true) throw new Error("pi-mottainai must be publishable");
  if (sourcePackage.name !== "pi-mottainai") throw new Error(`unexpected package name: ${sourcePackage.name}`);
  if (sourcePackage.peerDependencies?.mottainai !== canonicalPeerRange) {
    throw new Error(
      `source Pi package declares unexpected mottainai peer: ${sourcePackage.peerDependencies?.mottainai}`,
    );
  }

  const { rootTarball: suppliedRootTarball, piTarball: suppliedPiTarball } = parseArguments(process.argv.slice(2));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mottainai-package-smoke-"));
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(consumerDirectory);
  try {
    let rootTarball = suppliedRootTarball;
    let piTarball = suppliedPiTarball;
    if (rootTarball === undefined) {
      run("pnpm", ["run", "build"], { cwd: repositoryRoot });
      run("pnpm", ["--dir", packageDirectory, "run", "build"]);
      ({ rootTarball, piTarball } = packBuiltArtifacts(temporaryRoot, sourcePackage));
    }
    if (!fs.existsSync(rootTarball) || !fs.existsSync(piTarball)) {
      throw new Error(`missing supplied artifact: ${rootTarball} ${piTarball}`);
    }
    verifyPackedArtifacts(path.resolve(rootTarball), path.resolve(piTarball), consumerDirectory);
    const rootPackage = readPackedPackageJson(path.resolve(rootTarball));
    const piPackage = readPackedPackageJson(path.resolve(piTarball));
    console.log(
      `verified mottainai@${rootPackage.version} and ${piPackage.name}@${piPackage.version} from exact packed artifacts`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
