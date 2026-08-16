import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { option, isSafeRelativePath, SCHEMA_VERSION, VERSION, BUILD_ID, RELEASE_ORIGIN } from "./runtime-qemu-contract.mjs";

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensureTrustedDownloadUrl(url) {
  if (!url.startsWith(RELEASE_ORIGIN)) {
    throw new Error(`download URL is not a pinned mottainai release asset: ${url}`);
  }
}

function verifyFile(root, file, label) {
  if (!file || typeof file !== "object" || !isSafeRelativePath(file.path) || !/^[0-9a-f]{64}$/iu.test(file.sha256)) {
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
if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported artifact schema: ${manifest.schemaVersion}`);
if (manifest.version !== VERSION || manifest.buildId !== BUILD_ID) {
  throw new Error("artifact version/build identity is unsupported");
}
if (!/^(?:linux-(?:x64|arm64)|macos-(?:x64|arm64)|windows-x64)$/u.test(manifest.host)) {
  throw new Error(`unsupported artifact host: ${manifest.host}`);
}
const expectedArtifactId = `qemu-${manifest.host}-${manifest.version}`;
if (manifest.artifactId !== expectedArtifactId) {
  throw new Error(`artifactId must equal qemu-\${host}-\${version}: expected ${expectedArtifactId}, got ${manifest.artifactId}`);
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
const allFiles = [...manifest.runtimeLibraries, ...manifest.firmware];
const allPaths = allFiles.map((file) => file?.path);
if (new Set(allPaths).size !== allPaths.length) {
  throw new Error("duplicate paths detected across runtimeLibraries and firmware");
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
ensureTrustedDownloadUrl(manifest.downloadUrl);
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
if (manifest.provenance.sourceRevision !== manifest.source.sha256) {
  throw new Error("provenance.sourceRevision must equal source.sha256");
}
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
