import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import {
  LocalRuntimeError,
  MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
  MANAGED_QEMU_BUILD_ID,
  MANAGED_QEMU_VERSION,
  type LocalRuntimeHost,
  type LocalRuntimePaths,
  type QemuArtifactArchive,
  type QemuArtifactFile,
  type QemuArtifactIdentity,
  type QemuArtifactManifest,
  type VerifiedQemuArtifactManifest,
} from "./types.js";

const TRUSTED_DOWNLOAD_ORIGIN = "https://github.com/yohn-jp/mottainai/releases/download/";
const QEMU_SOURCE_URL = "https://download.qemu.org/qemu-9.2.2.tar.xz";
const QEMU_SOURCE_SHA256 = "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf";
const QEMU_RELEASE_TAG = "qemu-9.2.2";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TRUSTED_REDIRECT_HOSTS = ["github.com", "objects.githubusercontent.com"];
/**
 * The source manifest is a truthful availability index, not a fabricated
 * release. A host entry becomes `available` only when the build workflow
 * writes a generated sidecar containing the real executable and dependency
 * digests. The runtime therefore fails closed until that sidecar is supplied.
 */
export const QEMU_ARTIFACT_MANIFEST: Readonly<Record<LocalRuntimeHost, QemuArtifactManifest>> = {
  "linux-x64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason: "managed QEMU manifest for linux-x64 has no verified platform artifact yet",
    artifactId: "qemu-linux-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "linux-x64",
    executableName: "qemu-system-x86_64",
    downloadUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-linux-x64-9.2.2.tar`,
    manifestUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-linux-x64-9.2.2.manifest.json`,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: QEMU_SOURCE_URL,
      sha256: QEMU_SOURCE_SHA256,
      license: "GPL-2.0-or-later",
      correspondingSource: QEMU_SOURCE_URL,
    },
  },
  "linux-arm64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason: "managed QEMU manifest for linux-arm64 has no verified platform artifact yet",
    artifactId: "qemu-linux-arm64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "linux-arm64",
    executableName: "qemu-system-aarch64",
    downloadUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-linux-arm64-9.2.2.tar`,
    manifestUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-linux-arm64-9.2.2.manifest.json`,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: QEMU_SOURCE_URL,
      sha256: QEMU_SOURCE_SHA256,
      license: "GPL-2.0-or-later",
      correspondingSource: QEMU_SOURCE_URL,
    },
  },
  "macos-x64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason: "managed QEMU manifest for macos-x64 has no verified platform artifact yet",
    artifactId: "qemu-macos-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "macos-x64",
    executableName: "qemu-system-x86_64",
    downloadUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-macos-x64-9.2.2.tar`,
    manifestUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-macos-x64-9.2.2.manifest.json`,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: QEMU_SOURCE_URL,
      sha256: QEMU_SOURCE_SHA256,
      license: "GPL-2.0-or-later",
      correspondingSource: QEMU_SOURCE_URL,
    },
  },
  "macos-arm64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason: "managed QEMU manifest for macos-arm64 has no verified platform artifact yet",
    artifactId: "qemu-macos-arm64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "macos-arm64",
    executableName: "qemu-system-aarch64",
    downloadUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-macos-arm64-9.2.2.tar`,
    manifestUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-macos-arm64-9.2.2.manifest.json`,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: QEMU_SOURCE_URL,
      sha256: QEMU_SOURCE_SHA256,
      license: "GPL-2.0-or-later",
      correspondingSource: QEMU_SOURCE_URL,
    },
  },
  "windows-x64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason: "managed QEMU manifest for windows-x64 has no verified platform artifact yet",
    artifactId: "qemu-windows-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "windows-x64",
    executableName: "qemu-system-x86_64.exe",
    downloadUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-windows-x64-9.2.2.tar`,
    manifestUrl: `${TRUSTED_DOWNLOAD_ORIGIN}${QEMU_RELEASE_TAG}/qemu-windows-x64-9.2.2.manifest.json`,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: QEMU_SOURCE_URL,
      sha256: QEMU_SOURCE_SHA256,
      license: "GPL-2.0-or-later",
      correspondingSource: QEMU_SOURCE_URL,
    },
  },
};

export interface QemuArtifactOptions {
  readonly paths: LocalRuntimePaths;
  readonly host: LocalRuntimeHost;
  readonly bundledDirectory?: string;
  readonly manifest?: QemuArtifactManifest;
  readonly fetcher?: (url: string) => Promise<ReadableStream<Uint8Array>>;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const slashPath = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  return (
    normalized === slashPath &&
    !path.posix.isAbsolute(normalized) &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function isArtifactFile(value: unknown): value is QemuArtifactFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    "path" in value &&
    isSafeRelativePath(value.path) &&
    "sha256" in value &&
    isSha256(value.sha256)
  );
}

function isArtifactFileList(value: unknown): value is readonly QemuArtifactFile[] {
  if (!Array.isArray(value) || !value.every((file) => isArtifactFile(file))) return false;
  const paths = value.map((file) => file.path);
  return new Set(paths).size === paths.length;
}

function isSourceMetadata(value: unknown): value is QemuArtifactManifest["source"] {
  if (!isRecord(value)) return false;
  return (
    isSha256(value.sha256) &&
    value.license === "GPL-2.0-or-later" &&
    typeof value.url === "string" &&
    value.correspondingSource === value.url &&
    isArtifactFileList(value.licenseFiles) &&
    value.licenseFiles.length > 0
  );
}

function isProvenance(value: unknown): value is Required<QemuArtifactManifest>["provenance"] {
  if (!isRecord(value)) return false;
  return (
    isSha256(value.sourceRevision) &&
    typeof value.sourceDateEpoch === "number" &&
    Number.isSafeInteger(value.sourceDateEpoch) &&
    value.sourceDateEpoch >= 0 &&
    typeof value.builder === "string" &&
    value.builder.length > 0 &&
    typeof value.workflow === "string" &&
    value.workflow.length > 0 &&
    typeof value.toolchain === "string" &&
    value.toolchain.length > 0 &&
    Array.isArray(value.configureArgs) &&
    value.configureArgs.every((argument) => typeof argument === "string" && argument.length > 0)
  );
}

function isArchiveIdentity(value: unknown): value is QemuArtifactArchive {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name === path.posix.basename(value.name) &&
    /^[A-Za-z0-9._+-]+\.tar$/u.test(value.name) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= MAX_ARCHIVE_BYTES &&
    isSha256(value.sha256)
  );
}

function availabilityOf(manifest: QemuArtifactManifest): "available" | "not-built" | "unavailable" {
  if (manifest.availability !== undefined) return manifest.availability;
  return manifest.sha256 === undefined ? "not-built" : "available";
}

/** Validate the signed-by-content contract before any artifact is executed. */
export function assertQemuArtifactManifest(
  manifest: QemuArtifactManifest,
  expectedHost?: LocalRuntimeHost,
): asserts manifest is VerifiedQemuArtifactManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU manifest is not an object");
  }
  const availability = availabilityOf(manifest);
  if (availability !== "available" || manifest.sha256 === undefined) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      manifest.unavailableReason ?? `managed QEMU manifest for ${manifest.host} has no built executable yet`,
    );
  }
  const expectedArtifactId = `qemu-${manifest.host}-${MANAGED_QEMU_VERSION}`;
  const expectedExecutable = QEMU_ARTIFACT_MANIFEST[manifest.host]?.executableName;

  const checks: Array<{ valid: boolean; field: string }> = [
    { valid: manifest.schemaVersion === MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION, field: "schemaVersion" },
    { valid: expectedHost === undefined || manifest.host === expectedHost, field: "host" },
    { valid: manifest.version === MANAGED_QEMU_VERSION, field: "version" },
    { valid: manifest.buildId === MANAGED_QEMU_BUILD_ID, field: "buildId" },
    { valid: manifest.artifactId === expectedArtifactId, field: "artifactId" },
    { valid: manifest.executableName === expectedExecutable, field: "executableName" },
    { valid: isSha256(manifest.sha256), field: "sha256" },
    { valid: !isRecord(manifest.source) || manifest.sha256 !== manifest.source.sha256, field: "sha256" },
    { valid: isArtifactFileList(manifest.runtimeLibraries), field: "runtimeLibraries" },
    { valid: isArtifactFileList(manifest.firmware), field: "firmware" },
    { valid: manifest.availability === "available", field: "availability" },
    { valid: manifest.dependencyMode !== undefined, field: "dependencyMode" },
    { valid: manifest.dependencyMode === undefined || ["static", "bundled"].includes(manifest.dependencyMode), field: "dependencyMode" },
    { valid: manifest.dependencyMode !== "static" || manifest.runtimeLibraries.length === 0, field: "dependencyMode" },
    { valid: manifest.archive !== undefined && isArchiveIdentity(manifest.archive), field: "archive" },
    { valid: manifest.archive === undefined || manifest.archive.name === `${manifest.artifactId}.tar`, field: "archive.name" },
    { valid: manifest.archive === undefined || manifest.downloadUrl.endsWith(`/${manifest.archive.name}`), field: "downloadUrl" },
    { valid: isSourceMetadata(manifest.source), field: "source" },
    { valid: !isSourceMetadata(manifest.source) || manifest.source.url === QEMU_SOURCE_URL, field: "source.url" },
    { valid: !isSourceMetadata(manifest.source) || manifest.source.sha256 === QEMU_SOURCE_SHA256, field: "source.sha256" },
    { valid: isProvenance(manifest.provenance), field: "provenance" },
    { valid: !isProvenance(manifest.provenance) || manifest.provenance.sourceRevision === (isSourceMetadata(manifest.source) ? manifest.source.sha256 : ""), field: "provenance.sourceRevision" },
  ];

  const failed = checks.find((check) => !check.valid);
  if (failed !== undefined) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU manifest is not a verified ${MANAGED_QEMU_BUILD_ID} release artifact`,
      { field: failed.field },
    );
  }
  ensureTrustedDownloadUrl(manifest.downloadUrl);
  if (manifest.manifestUrl !== undefined) ensureTrustedDownloadUrl(manifest.manifestUrl);
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function ensureTrustedDownloadUrl(url: string): void {
  if (!url.startsWith(TRUSTED_DOWNLOAD_ORIGIN)) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU download URL is not a pinned mottainai release asset: ${url}`,
    );
  }
}

function bundledManifest(directory: string, host: LocalRuntimeHost): QemuArtifactManifest | undefined {
  const candidates = [
    path.join(directory, host, "manifest.json"),
    path.join(directory, host, QEMU_ARTIFACT_MANIFEST[host].artifactId, "manifest.json"),
    path.join(directory, QEMU_ARTIFACT_MANIFEST[host].artifactId, "manifest.json"),
    path.join(directory, "manifest.json"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (
        value !== null &&
        typeof value === "object" &&
        "host" in value &&
        value.host === host &&
        "artifactId" in value &&
        typeof value.artifactId === "string"
      ) {
        return value as QemuArtifactManifest;
      }
    } catch {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_corrupt",
        `managed QEMU bundle manifest is invalid: ${candidate}`,
      );
    }
  }
  return undefined;
}

interface BundledLocation {
  readonly root: string;
  readonly executable: string;
}

function locateBundledArtifact(directory: string, manifest: QemuArtifactManifest): BundledLocation | undefined {
  const roots = [
    path.join(directory, manifest.host, manifest.artifactId),
    path.join(directory, manifest.artifactId),
    path.join(directory, manifest.host),
    directory,
  ];
  const relativeExecutablePaths = [`bin/${manifest.executableName}`, manifest.executableName];
  for (const root of roots) {
    for (const relative of relativeExecutablePaths) {
      const executable = path.join(root, relative);
      if (fs.existsSync(executable)) return { root, executable };
    }
  }
  return undefined;
}

function assertVerifiedFile(
  filePath: string,
  expected: string,
  label: string,
  executable = false,
  containmentRoot?: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new LocalRuntimeError("managed_qemu_artifact_unavailable", `managed QEMU ${label} is missing: ${filePath}`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (executable && process.platform !== "win32" && (stat.mode & 0o111) === 0)
  ) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU ${label} is not a regular file: ${filePath}`,
    );
  }
  if (containmentRoot !== undefined) {
    const root = fs.realpathSync(containmentRoot);
    const real = fs.realpathSync(filePath);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new LocalRuntimeError("managed_qemu_artifact_corrupt", `managed QEMU ${label} escapes the artifact root`);
    }
  }
  const actual = sha256File(filePath);
  if (actual !== expected) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU SHA-256 mismatch for ${label}; expected ${expected}, got ${actual}`,
      { expected, actual },
    );
  }
}

function copyDependency(root: string, destinationRoot: string, file: QemuArtifactFile): void {
  const source = path.resolve(root, file.path);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!source.startsWith(rootPrefix) || !fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU dependency is missing: ${file.path}`,
    );
  }
  assertVerifiedFile(source, file.sha256, `source dependency ${file.name}`, false, root);
  const destination = path.join(destinationRoot, file.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  assertVerifiedFile(destination, file.sha256, `dependency ${file.name}`);
}

function copyBundledArtifact(location: BundledLocation, destinationRoot: string, manifest: VerifiedQemuArtifactManifest): void {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(location.executable).isSymbolicLink()) {
    throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU executable must not be a symbolic link");
  }
  assertVerifiedFile(location.executable, manifest.sha256, "source executable", true, location.root);
  const destination = path.join(destinationRoot, manifest.executableName);
  fs.copyFileSync(location.executable, destination);
  fs.chmodSync(destination, 0o700);
  for (const file of [...manifest.runtimeLibraries, ...manifest.firmware, ...(manifest.source.licenseFiles ?? [])])
    copyDependency(location.root, destinationRoot, file);
}

function extractDownloadedArchive(archive: string, destination: string, manifest: VerifiedQemuArtifactManifest): void {
  const tarCommand = process.platform === "win32" ? "tar" : "/usr/bin/tar";
  let listing: string;
  let typeListing: string;
  try {
    listing = execFileSync(tarCommand, ["-tf", archive], { encoding: "utf8" });
    typeListing = execFileSync(tarCommand, ["-tvf", archive], { encoding: "utf8" });
  } catch (error) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU archive cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = new Set<string>();
  const entries = listing.split(/\r?\n/u).filter((entry) => entry.length > 0);
  const typedEntries = typeListing.split(/\r?\n/u).filter((entry) => entry.trim().length > 0);
  if (entries.length !== typedEntries.length) {
    throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU archive entries cannot be type-checked");
  }
  for (const [index, rawEntry] of entries.entries()) {
    const mode = typedEntries[index]?.trimStart().charAt(0);
    if (mode !== "-" && mode !== "d") {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_corrupt",
        "managed QEMU archive contains a link or special file",
      );
    }
    const entry = rawEntry.replace(/\r$/u, "").replace(/^\.\/+/, "").replace(/\/+$/u, "");
    if (entry.length === 0) continue;
    if (!isSafeRelativePath(entry) || !/^[A-Za-z0-9._+/-]+$/u.test(entry)) {
      throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU archive contains an unsafe path");
    }
    if (mode === "-") files.add(entry);
  }
  const expected = new Set([
    `bin/${manifest.executableName}`,
    ...manifest.runtimeLibraries.map((file) => file.path),
    ...manifest.firmware.map((file) => file.path),
    ...(manifest.source.licenseFiles ?? []).map((file) => file.path),
  ]);
  if (files.size !== expected.size || [...files].some((entry) => !expected.has(entry))) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      "managed QEMU archive contents do not match the manifest",
    );
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const extractArgs = ["-xf", archive, "-C", destination];
  if (process.platform !== "win32") {
    extractArgs.push("--no-same-owner", "--no-same-permissions");
  }
  try {
    execFileSync(tarCommand, extractArgs, { stdio: "pipe" });
  } catch (error) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyDependencies(destinationRoot: string, manifest: VerifiedQemuArtifactManifest): void {
  for (const file of manifest.runtimeLibraries) {
    assertVerifiedFile(path.join(destinationRoot, file.path), file.sha256, `dependency ${file.name}`);
  }
  for (const file of manifest.firmware) {
    assertVerifiedFile(path.join(destinationRoot, file.path), file.sha256, `firmware ${file.name}`);
  }
  for (const file of manifest.source.licenseFiles ?? []) {
    assertVerifiedFile(path.join(destinationRoot, file.path), file.sha256, `license ${file.name}`);
  }
}

async function fetchWithRedirects(url: string): Promise<ReadableStream<Uint8Array>> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
    const parsedUrl = new URL(currentUrl);
    if (parsedUrl.protocol !== "https:") {
      throw new Error(`non-HTTPS redirect not allowed: ${currentUrl}`);
    }
    if (!TRUSTED_REDIRECT_HOSTS.includes(parsedUrl.hostname)) {
      throw new Error(`redirect to untrusted host: ${parsedUrl.hostname}`);
    }
    const response = await fetch(currentUrl, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new Error(`redirect response missing location header`);
      }
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    if (!response.ok || response.body === null) {
      throw new Error(`HTTP ${response.status} from ${currentUrl}`);
    }
    return response.body;
  }
  throw new Error(`exceeded maximum redirect count (${MAX_REDIRECTS})`);
}

async function fetchManifest(
  url: string,
  fetcher?: (url: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<QemuArtifactManifest> {
  ensureTrustedDownloadUrl(url);
  let body: ReadableStream<Uint8Array>;
  if (fetcher !== undefined) {
    try {
      body = await fetcher(url);
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU manifest download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      body = await fetchWithRedirects(url);
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU manifest download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
      chunks.push(result.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object") throw new Error("manifest is not an object");
    return value as QemuArtifactManifest;
  } catch (error) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU sidecar manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  expectedSize: number,
  fetcher?: (url: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<void> {
  ensureTrustedDownloadUrl(url);
  let body: ReadableStream<Uint8Array>;
  if (fetcher !== undefined) {
    try {
      body = await fetcher(url);
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      body = await fetchWithRedirects(url);
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const temporary = `${destination}.download-${process.pid}`;
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > expectedSize || size > MAX_ARCHIVE_BYTES) {
            callback(new Error(`managed QEMU archive exceeds declared size ${expectedSize}`));
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(temporary, { mode: 0o700 }),
    );
    if (size !== expectedSize) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_corrupt",
        `managed QEMU archive size mismatch; expected ${expectedSize}, got ${size}`,
      );
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU archive download is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Materialize only the pinned package-owned artifact. There is no PATH lookup
 * and no host package-manager fallback. Available manifests must contain the
 * executable and every packaged firmware/library digest before this returns.
 */
export async function materializeQemuArtifact(options: QemuArtifactOptions): Promise<QemuArtifactIdentity> {
  const baseManifest =
    options.manifest ??
    (options.bundledDirectory ? bundledManifest(options.bundledDirectory, options.host) : undefined) ??
    QEMU_ARTIFACT_MANIFEST[options.host];
  let manifest = baseManifest;
  if (
    availabilityOf(baseManifest) !== "available" &&
    baseManifest.manifestUrl !== undefined &&
    options.fetcher !== undefined
  ) {
    const remote = await fetchManifest(baseManifest.manifestUrl, options.fetcher);
    if (remote.host !== options.host || remote.artifactId !== baseManifest.artifactId) {
      throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU sidecar manifest identity mismatch");
    }
    manifest = remote;
  }
  assertQemuArtifactManifest(manifest, options.host);
  fs.mkdirSync(options.paths.qemuDirectory, { recursive: true, mode: 0o700 });
  const destination = options.paths.qemuExecutable;

  if (!fs.existsSync(destination)) {
    const bundled = options.bundledDirectory ? locateBundledArtifact(options.bundledDirectory, manifest) : undefined;
    if (bundled !== undefined) {
      copyBundledArtifact(bundled, options.paths.qemuDirectory, manifest);
    } else {
      const archive = path.join(options.paths.qemuDirectory, `.managed-qemu-${process.pid}.tar`);
      const extracted = path.join(options.paths.qemuDirectory, `.managed-qemu-${process.pid}-extract`);
      try {
        await downloadToFile(manifest.downloadUrl, archive, manifest.archive.size, options.fetcher);
        assertVerifiedFile(archive, manifest.archive.sha256, "archive");
        extractDownloadedArchive(archive, extracted, manifest);
        const downloaded = locateBundledArtifact(extracted, manifest);
        if (downloaded === undefined) {
          throw new LocalRuntimeError(
            "managed_qemu_artifact_corrupt",
            "managed QEMU archive has no expected executable",
          );
        }
        copyBundledArtifact(downloaded, options.paths.qemuDirectory, manifest);
      } finally {
        fs.rmSync(archive, { force: true });
        fs.rmSync(extracted, { recursive: true, force: true });
      }
    }
  }

  assertVerifiedFile(destination, manifest.sha256, "executable", true);
  verifyDependencies(options.paths.qemuDirectory, manifest);
  return {
    artifactId: manifest.artifactId,
    version: manifest.version,
    buildId: manifest.buildId,
    sha256: manifest.sha256,
    executablePath: destination,
    ...(manifest.runtimeLibraries.length === 0
      ? {}
      : { runtimeLibraryDirectory: path.join(options.paths.qemuDirectory, "lib") }),
  };
}
