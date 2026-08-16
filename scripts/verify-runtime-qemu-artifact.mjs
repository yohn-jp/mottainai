import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const slashPath = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  return (
    normalized === slashPath &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.posix.isAbsolute(normalized)
  );
}

function verifyFile(root, file, label) {
  if (!file || typeof file !== "object" || !safeRelative(file.path) || !/^[0-9a-f]{64}$/iu.test(file.sha256)) {
    throw new Error(`invalid ${label} record`);
  }
  const candidate = path.resolve(root, file.path);
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`${label} escapes artifact root`);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${file.path}`);
  const actual = sha256(candidate);
  if (actual !== file.sha256) throw new Error(`${label} SHA-256 mismatch: expected ${file.sha256}, got ${actual}`);
}

const manifestPath = path.resolve(option("manifest"));
const artifactRoot = path.resolve(option("artifact-root"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.availability !== "available") throw new Error(`artifact is not available: ${manifest.availability}`);
if (manifest.schemaVersion !== 2) throw new Error(`unsupported artifact schema: ${manifest.schemaVersion}`);
if (manifest.version !== "9.2.2" || manifest.buildId !== "qemu-9.2.2-mottainai-runtime-v1") {
  throw new Error("artifact version/build identity is unsupported");
}
if (!/^(?:linux-(?:x64|arm64)|macos-(?:x64|arm64)|windows-x64)$/u.test(manifest.host)) {
  throw new Error(`unsupported artifact host: ${manifest.host}`);
}
if (!/^[A-Za-z0-9._+-]+(?:\.exe)?$/u.test(manifest.executableName)) {
  throw new Error("artifact executable name is unsafe");
}
if (!/^[0-9a-f]{64}$/iu.test(manifest.sha256)) throw new Error("available artifact has no executable SHA-256");
if (manifest.dependencyMode !== "static" && manifest.dependencyMode !== "bundled") {
  throw new Error("artifact dependencyMode must be static or bundled");
}
if (manifest.dependencyMode === "static" && manifest.runtimeLibraries.length !== 0) {
  throw new Error("static artifact unexpectedly declares runtime libraries");
}
if (!/^[0-9a-f]{64}$/iu.test(manifest.source?.sha256)) throw new Error("source identity is not a SHA-256 digest");
if (manifest.source?.correspondingSource !== manifest.source?.url)
  throw new Error("corresponding source does not match source URL");
if (manifest.source?.license !== "GPL-2.0-or-later") throw new Error("source license identity is unsupported");
if (!Array.isArray(manifest.source?.licenseFiles) || manifest.source.licenseFiles.length === 0) {
  throw new Error("source-compliance license files are missing");
}
for (const license of manifest.source.licenseFiles) {
  verifyFile(artifactRoot, license, `license ${license?.name ?? "unknown"}`);
}
const executable = [
  path.join(artifactRoot, "bin", manifest.executableName),
  path.join(artifactRoot, manifest.executableName),
].find((candidate) => fs.existsSync(candidate));
if (executable === undefined) throw new Error(`managed QEMU executable is missing: ${manifest.executableName}`);
const executableStat = fs.lstatSync(executable);
if (!executableStat.isFile() || executableStat.isSymbolicLink())
  throw new Error("managed QEMU executable is not a regular file");
if (process.platform !== "win32" && (executableStat.mode & 0o111) === 0)
  throw new Error("managed QEMU executable is not executable");
const executableActual = sha256(executable);
if (executableActual !== manifest.sha256)
  throw new Error(`executable SHA-256 mismatch: expected ${manifest.sha256}, got ${executableActual}`);
for (const file of [...manifest.runtimeLibraries, ...manifest.firmware]) verifyFile(artifactRoot, file, file.name);
if (
  !manifest.provenance ||
  !/^[0-9a-f]{64}$/iu.test(manifest.provenance.sourceRevision) ||
  !Number.isSafeInteger(manifest.provenance.sourceDateEpoch) ||
  manifest.provenance.sourceDateEpoch < 0 ||
  typeof manifest.provenance.builder !== "string" ||
  manifest.provenance.builder.length === 0 ||
  typeof manifest.provenance.workflow !== "string" ||
  manifest.provenance.workflow.length === 0 ||
  typeof manifest.provenance.toolchain !== "string" ||
  manifest.provenance.toolchain.length === 0 ||
  !Array.isArray(manifest.provenance.configureArgs)
)
  throw new Error("build provenance is missing");
if (
  !manifest.archive ||
  !/^[A-Za-z0-9._+-]+\.tar$/u.test(manifest.archive.name) ||
  !Number.isSafeInteger(manifest.archive.size) ||
  manifest.archive.size <= 0 ||
  !/^[0-9a-f]{64}$/iu.test(manifest.archive.sha256) ||
  !manifest.downloadUrl.endsWith(`/${manifest.archive.name}`)
) {
  throw new Error("archive identity is invalid");
}
const archivePath = path.join(path.dirname(manifestPath), manifest.archive.name);
if (
  !fs.existsSync(archivePath) ||
  fs.statSync(archivePath).size !== manifest.archive.size ||
  sha256(archivePath) !== manifest.archive.sha256
) {
  throw new Error("archive SHA-256 mismatch");
}
console.log(
  JSON.stringify({ ok: true, artifactId: manifest.artifactId, host: manifest.host, sha256: manifest.sha256 }, null, 2),
);
