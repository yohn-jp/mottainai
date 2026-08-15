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
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  return (
    normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !path.posix.isAbsolute(normalized)
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
if (!Array.isArray(manifest.source?.licenseFiles) || manifest.source.licenseFiles.length === 0) {
  throw new Error("source-compliance license files are missing");
}
for (const license of manifest.source.licenseFiles) {
  if (!safeRelative(license)) throw new Error(`license path escapes artifact root: ${license}`);
  const licensePath = path.resolve(artifactRoot, license);
  const licenseStat = fs.lstatSync(licensePath);
  if (!licenseStat.isFile() || licenseStat.isSymbolicLink()) throw new Error(`license file is not regular: ${license}`);
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
if (!manifest.provenance || !/^[0-9a-f]{64}$/iu.test(manifest.provenance.sourceRevision))
  throw new Error("build provenance is missing");
console.log(
  JSON.stringify({ ok: true, artifactId: manifest.artifactId, host: manifest.host, sha256: manifest.sha256 }, null, 2),
);
