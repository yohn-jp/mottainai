import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SOURCE_URL = "https://download.qemu.org/qemu-9.2.2.tar.xz";
const SOURCE_SHA256 = "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf";
const VERSION = "9.2.2";
const BUILD_ID = "qemu-9.2.2-mottainai-runtime-v1";
const SCHEMA_VERSION = 2;
const LICENSE = "GPL-2.0-or-later";
const RELEASE_ORIGIN = "https://github.com/yohn-jp/mottainai/releases/download/";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function repeatedOption(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.push(value);
  }
  return values;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseNameAndFile(value, optionName) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`${optionName} must be NAME=FILE`);
  const name = value.slice(0, separator);
  const source = path.resolve(value.slice(separator + 1));
  if (!/^[A-Za-z0-9._+-]+$/u.test(name)) throw new Error(`${optionName} name is unsafe: ${name}`);
  if (!fs.statSync(source).isFile()) throw new Error(`${optionName} is not a regular file: ${source}`);
  return { name, source };
}

function copyWithDigest(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.utimesSync(destination, 0, 0);
  return sha256(destination);
}

function createDeterministicArchive(stage, archive) {
  fs.rmSync(archive, { force: true });
  try {
    execFileSync(
      "tar",
      [
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-cf",
        archive,
        "-C",
        stage,
        ".",
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    throw new Error(
      `deterministic tar is required to package managed QEMU artifacts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const host = option("host");
const executable = path.resolve(option("executable"));
const output = path.resolve(option("output"));
const sourceRevision = option("source-revision", SOURCE_SHA256);
const sourceDateEpoch = Number(option("source-date-epoch", "0"));
const builder = option("builder", "github-actions");
const workflow = option("workflow", ".github/workflows/runtime-qemu-artifacts.yml");
const toolchain = option("toolchain", "mottainai-qemu-profile-v1");
const dependencyMode = option("dependency-mode", "bundled");
const releaseTag = option("release-tag", `qemu-${VERSION}`);
const executableName = path.basename(executable);

if (!/^(?:linux-(?:x64|arm64)|macos-(?:x64|arm64)|windows-x64)$/u.test(host)) {
  throw new Error(`unsupported host: ${host}`);
}
if (!/^[0-9a-f]{64}$/iu.test(sourceRevision)) throw new Error("--source-revision must be a SHA-256 source identity");
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0)
  throw new Error("--source-date-epoch must be a non-negative integer");
if (dependencyMode !== "static" && dependencyMode !== "bundled")
  throw new Error("--dependency-mode must be static or bundled");
if (!fs.statSync(executable).isFile()) throw new Error(`QEMU artifact is not a regular file: ${executable}`);
if (!host.startsWith("windows-") && (fs.statSync(executable).mode & 0o111) === 0) {
  throw new Error(`QEMU artifact is not executable: ${executable}`);
}

const artifactId = `qemu-${host}-${VERSION}`;
const hostOutput = path.join(output, host);
const stage = path.join(hostOutput, artifactId);
const archiveName = `${artifactId}.tar`;
const archive = path.join(hostOutput, archiveName);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true, mode: 0o700 });

const stagedExecutable = path.join(stage, "bin", executableName);
const executableSha256 = copyWithDigest(executable, stagedExecutable);
if (process.platform !== "win32") fs.chmodSync(stagedExecutable, 0o700);

const runtimeLibraries = repeatedOption("runtime-library").map((value) => {
  const item = parseNameAndFile(value, "--runtime-library");
  const relativePath = path.posix.join("lib", item.name);
  return { name: item.name, path: relativePath, sha256: copyWithDigest(item.source, path.join(stage, relativePath)) };
});
const firmware = repeatedOption("firmware").map((value) => {
  const item = parseNameAndFile(value, "--firmware");
  const relativePath = path.posix.join("share", "firmware", item.name);
  return { name: item.name, path: relativePath, sha256: copyWithDigest(item.source, path.join(stage, relativePath)) };
});
if (dependencyMode === "static" && runtimeLibraries.length !== 0) {
  throw new Error("--dependency-mode static cannot include --runtime-library entries");
}
const licenseFiles = repeatedOption("license-file").map((value) => {
  const item = parseNameAndFile(value, "--license-file");
  const relativePath = path.posix.join("licenses", item.name);
  copyWithDigest(item.source, path.join(stage, relativePath));
  return relativePath;
});
if (licenseFiles.length === 0)
  throw new Error("at least one --license-file is required for source compliance metadata");
const configureArgs = repeatedOption("configure-arg");
const manifest = {
  schemaVersion: SCHEMA_VERSION,
  availability: "available",
  artifactId,
  version: VERSION,
  buildId: BUILD_ID,
  host,
  executableName,
  downloadUrl: `${RELEASE_ORIGIN}${releaseTag}/${archiveName}`,
  sha256: executableSha256,
  dependencyMode,
  runtimeLibraries,
  firmware,
  source: {
    url: SOURCE_URL,
    sha256: SOURCE_SHA256,
    license: LICENSE,
    correspondingSource: SOURCE_URL,
    licenseFiles,
  },
  provenance: {
    sourceRevision,
    sourceDateEpoch,
    builder,
    workflow,
    toolchain,
    configureArgs,
  },
};
fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.mkdirSync(hostOutput, { recursive: true, mode: 0o700 });
createDeterministicArchive(stage, archive);
fs.writeFileSync(path.join(hostOutput, `${artifactId}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify({ ...manifest, stagedDirectory: stage, archive }, null, 2));
