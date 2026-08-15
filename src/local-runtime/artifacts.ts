import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  LocalRuntimeError,
  MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
  MANAGED_QEMU_BUILD_ID,
  MANAGED_QEMU_VERSION,
  type LocalRuntimeHost,
  type LocalRuntimePaths,
  type QemuArtifactFile,
  type QemuArtifactIdentity,
  type QemuArtifactManifest,
} from "./types.js";

const TRUSTED_DOWNLOAD_ORIGIN = "https://github.com/yohn-jp/mottainai/releases/download/";
const QEMU_SOURCE_URL = "https://download.qemu.org/qemu-9.2.2.tar.xz";
const QEMU_SOURCE_SHA256 = "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf";
const QEMU_RELEASE_TAG = "qemu-9.2.2";
const QEMU_PROVENANCE = {
  sourceRevision: QEMU_SOURCE_SHA256,
  sourceDateEpoch: 0,
  builder: "github-actions",
  workflow: ".github/workflows/runtime-qemu-artifacts.yml",
  toolchain: "mottainai-qemu-profile-v1",
  configureArgs: [
    "--target-list=<host-system-target>",
    "--static",
    "--disable-debug-info",
    "--disable-docs",
    "--disable-gtk",
    "--disable-sdl",
    "--disable-vnc",
    "--disable-spice",
  ],
} as const;

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
    unavailableReason:
      "managed QEMU manifest for linux-x64 has no built executable yet; run the pinned runtime-qemu-artifacts workflow",
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
      licenseFiles: ["COPYING"],
    },
    provenance: QEMU_PROVENANCE,
  },
  "linux-arm64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason:
      "managed QEMU manifest for linux-arm64 has no built executable yet; run the pinned runtime-qemu-artifacts workflow",
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
      licenseFiles: ["COPYING"],
    },
    provenance: QEMU_PROVENANCE,
  },
  "macos-x64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason:
      "managed QEMU manifest for macos-x64 has no built executable yet; run the pinned runtime-qemu-artifacts workflow",
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
      licenseFiles: ["COPYING"],
    },
    provenance: QEMU_PROVENANCE,
  },
  "macos-arm64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason:
      "managed QEMU manifest for macos-arm64 has no built executable yet; run the pinned runtime-qemu-artifacts workflow",
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
      licenseFiles: ["COPYING"],
    },
    provenance: QEMU_PROVENANCE,
  },
  "windows-x64": {
    schemaVersion: MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION,
    availability: "not-built",
    unavailableReason:
      "managed QEMU manifest for windows-x64 has no built executable yet; run the pinned runtime-qemu-artifacts workflow",
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
      licenseFiles: ["COPYING"],
    },
    provenance: QEMU_PROVENANCE,
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
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return (
    !path.posix.isAbsolute(normalized) && normalized !== "." && normalized !== ".." && !normalized.startsWith("../")
  );
}

function isArtifactFile(value: QemuArtifactFile): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isSafeRelativePath(value.path) &&
    isSha256(value.sha256)
  );
}

function isArtifactFileList(value: unknown): value is readonly QemuArtifactFile[] {
  return Array.isArray(value) && value.every((file) => isArtifactFile(file as QemuArtifactFile));
}

function isSourceMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isSha256(value.sha256) &&
    value.license === "GPL-2.0-or-later" &&
    typeof value.url === "string" &&
    value.correspondingSource === value.url &&
    (value.licenseFiles === undefined ||
      (Array.isArray(value.licenseFiles) && value.licenseFiles.every((file) => isSafeRelativePath(file))))
  );
}

function isProvenance(value: unknown): boolean {
  if (value === undefined) return true;
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

function availabilityOf(manifest: QemuArtifactManifest): "available" | "not-built" | "unavailable" {
  if (manifest.availability !== undefined) return manifest.availability;
  return manifest.sha256 === undefined ? "not-built" : "available";
}

/** Validate the signed-by-content contract before any artifact is executed. */
export function assertQemuArtifactManifest(
  manifest: QemuArtifactManifest,
  expectedHost?: LocalRuntimeHost,
): asserts manifest is QemuArtifactManifest & { readonly sha256: string } {
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
  if (
    (manifest.schemaVersion !== undefined && manifest.schemaVersion !== MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION) ||
    (expectedHost !== undefined && manifest.host !== expectedHost) ||
    manifest.version !== MANAGED_QEMU_VERSION ||
    manifest.buildId !== MANAGED_QEMU_BUILD_ID ||
    !isSha256(manifest.sha256) ||
    (isRecord(manifest.source) && manifest.sha256 === manifest.source.sha256) ||
    !isArtifactFileList(manifest.runtimeLibraries) ||
    !isArtifactFileList(manifest.firmware) ||
    (manifest.schemaVersion === MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION &&
      (manifest.dependencyMode === undefined ||
        !["static", "bundled"].includes(manifest.dependencyMode) ||
        (manifest.dependencyMode === "static" && manifest.runtimeLibraries.length !== 0))) ||
    (manifest.payloadSha256 !== undefined && !isSha256(manifest.payloadSha256)) ||
    !isSourceMetadata(manifest.source) ||
    !isProvenance(manifest.provenance)
  ) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU manifest is not a verified ${MANAGED_QEMU_BUILD_ID} release artifact`,
    );
  }
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

function assertVerifiedFile(filePath: string, expected: string, label: string, executable = false): void {
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
  const destination = path.join(destinationRoot, file.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  assertVerifiedFile(destination, file.sha256, `dependency ${file.name}`);
}

function copyBundledArtifact(location: BundledLocation, destinationRoot: string, manifest: QemuArtifactManifest): void {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(location.executable).isSymbolicLink()) {
    throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU executable must not be a symbolic link");
  }
  const destination = path.join(destinationRoot, manifest.executableName);
  fs.copyFileSync(location.executable, destination);
  fs.chmodSync(destination, 0o700);
  for (const file of [...manifest.runtimeLibraries, ...manifest.firmware])
    copyDependency(location.root, destinationRoot, file);
}

function extractDownloadedArchive(archive: string, destination: string): void {
  let entries: string[];
  try {
    entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
      .split(/\r?\n/u)
      .map((entry) => entry.replace(/^\.\/+/, "").trim())
      .filter((entry) => entry.length > 0 && entry !== ".");
  } catch (error) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU archive cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (entries.some((entry) => !isSafeRelativePath(entry))) {
    throw new LocalRuntimeError("managed_qemu_artifact_corrupt", "managed QEMU archive contains an unsafe path");
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: "pipe" });
  } catch (error) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyDependencies(destinationRoot: string, manifest: QemuArtifactManifest): void {
  for (const file of manifest.runtimeLibraries) {
    assertVerifiedFile(path.join(destinationRoot, file.path), file.sha256, `dependency ${file.name}`);
  }
  for (const file of manifest.firmware) {
    assertVerifiedFile(path.join(destinationRoot, file.path), file.sha256, `firmware ${file.name}`);
  }
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
    let response: Response;
    try {
      response = await fetch(url, { redirect: "error" });
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU manifest download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU manifest returned HTTP ${response.status} from the pinned release URL`,
      );
    }
    body = response.body;
  }
  try {
    const value: unknown = JSON.parse(await new Response(body).text());
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
    let response: Response;
    try {
      response = await fetch(url, { redirect: "error" });
    } catch (error) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_unavailable",
        `managed QEMU download returned HTTP ${response.status} from the pinned release URL`,
      );
    }
    body = response.body;
  }
  const temporary = `${destination}.download-${process.pid}`;
  await pipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    fs.createWriteStream(temporary, { mode: 0o700 }),
  );
  fs.renameSync(temporary, destination);
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
    options.bundledDirectory !== undefined &&
    availabilityOf(baseManifest) !== "available" &&
    baseManifest.manifestUrl !== undefined
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
        await downloadToFile(manifest.downloadUrl, archive, options.fetcher);
        extractDownloadedArchive(archive, extracted);
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
