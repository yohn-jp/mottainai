import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  LocalRuntimeError,
  MANAGED_QEMU_BUILD_ID,
  MANAGED_QEMU_VERSION,
  UNBUILT_QEMU_ARTIFACT_SHA256,
  type LocalRuntimeHost,
  type LocalRuntimePaths,
  type QemuArtifactIdentity,
  type QemuArtifactManifest,
} from "./types.js";

/**
 * The release manifest is deliberately part of Mottainai rather than a
 * system-QEMU lookup. `source.sha256` is the real, verified upstream
 * `qemu-9.2.2.tar.xz` digest published at download.qemu.org. Each per-host
 * `sha256` (the built executable's digest) is intentionally the
 * `UNBUILT_QEMU_ARTIFACT_SHA256` sentinel until the release pipeline runs
 * `scripts/build-runtime-qemu-manifest.mjs` against a real reproducible
 * build for that host and replaces it with the actual binary hash;
 * `ensureManifest` rejects the sentinel rather than treating it as verified.
 */
export const QEMU_ARTIFACT_MANIFEST: Readonly<Record<LocalRuntimeHost, QemuArtifactManifest>> = {
  "linux-x64": {
    artifactId: "qemu-linux-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "linux-x64",
    executableName: "qemu-system-x86_64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-linux-x64-9.2.2.tar.zst",
    sha256: UNBUILT_QEMU_ARTIFACT_SHA256,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later",
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
    },
  },
  "linux-arm64": {
    artifactId: "qemu-linux-arm64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "linux-arm64",
    executableName: "qemu-system-aarch64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-linux-arm64-9.2.2.tar.zst",
    sha256: UNBUILT_QEMU_ARTIFACT_SHA256,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later",
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
    },
  },
  "macos-x64": {
    artifactId: "qemu-macos-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "macos-x64",
    executableName: "qemu-system-x86_64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-macos-x64-9.2.2.tar.zst",
    sha256: UNBUILT_QEMU_ARTIFACT_SHA256,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later",
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
    },
  },
  "macos-arm64": {
    artifactId: "qemu-macos-arm64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "macos-arm64",
    executableName: "qemu-system-aarch64",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-macos-arm64-9.2.2.tar.zst",
    sha256: UNBUILT_QEMU_ARTIFACT_SHA256,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later",
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
    },
  },
  "windows-x64": {
    artifactId: "qemu-windows-x64-9.2.2",
    version: MANAGED_QEMU_VERSION,
    buildId: MANAGED_QEMU_BUILD_ID,
    host: "windows-x64",
    executableName: "qemu-system-x86_64.exe",
    downloadUrl: "https://github.com/yohn-jp/mottainai/releases/download/qemu-9.2.2/qemu-windows-x64-9.2.2.zip",
    sha256: UNBUILT_QEMU_ARTIFACT_SHA256,
    runtimeLibraries: [],
    firmware: [],
    source: {
      url: "https://download.qemu.org/qemu-9.2.2.tar.xz",
      sha256: "752eaeeb772923a73d536b231e05bcc09c9b1f51690a41ad9973d900e4ec9fbf",
      license: "GPL-2.0-or-later",
      correspondingSource: "https://download.qemu.org/qemu-9.2.2.tar.xz",
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

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/iu.test(value);
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function ensureManifest(manifest: QemuArtifactManifest): void {
  if (manifest.sha256 === UNBUILT_QEMU_ARTIFACT_SHA256) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU manifest for ${manifest.host} has no built executable yet; run scripts/build-runtime-qemu-manifest.mjs from a release build before this host can be provisioned`,
    );
  }
  if (
    manifest.version !== MANAGED_QEMU_VERSION ||
    manifest.buildId !== MANAGED_QEMU_BUILD_ID ||
    !isSha256(manifest.sha256) ||
    !isSha256(manifest.source.sha256) ||
    manifest.sha256 === manifest.source.sha256 ||
    !manifest.runtimeLibraries.every((library) => library.length > 0 && library.length <= 512) ||
    !manifest.firmware.every((firmware) => firmware.name.length > 0 && isSha256(firmware.sha256)) ||
    manifest.source.license !== "GPL-2.0-or-later" ||
    manifest.source.correspondingSource !== manifest.source.url
  ) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_unavailable",
      `managed QEMU manifest is not a verified ${MANAGED_QEMU_BUILD_ID} release artifact`,
    );
  }
}

function bundledCandidates(directory: string, manifest: QemuArtifactManifest): string[] {
  return [
    path.join(directory, manifest.host, manifest.executableName),
    path.join(directory, manifest.artifactId, manifest.executableName),
    path.join(directory, manifest.executableName),
    path.join(directory, `${manifest.artifactId}.bin`),
  ];
}

function bundledManifest(directory: string, host: LocalRuntimeHost): QemuArtifactManifest | undefined {
  const candidates = [path.join(directory, host, "manifest.json"), path.join(directory, "manifest.json")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as QemuArtifactManifest;
      if (value.host === host && typeof value.artifactId === "string") return value;
    } catch {
      throw new LocalRuntimeError(
        "managed_qemu_artifact_corrupt",
        `managed QEMU bundle manifest is invalid: ${candidate}`,
      );
    }
  }
  return undefined;
}

function assertVerifiedExecutable(filePath: string, manifest: QemuArtifactManifest): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new LocalRuntimeError("managed_qemu_artifact_unavailable", `managed QEMU executable is missing: ${filePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU executable is not a regular executable file: ${filePath}`,
    );
  }
  const actual = sha256File(filePath);
  if (actual !== manifest.sha256) {
    throw new LocalRuntimeError(
      "managed_qemu_artifact_corrupt",
      `managed QEMU SHA-256 mismatch for ${manifest.artifactId}; expected ${manifest.sha256}, got ${actual}`,
      { expected: manifest.sha256, actual },
    );
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  fetcher?: (url: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<void> {
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
 * Materialize only the pinned package-owned artifact.  The source tree may
 * carry the executable beside dist/ in a release package; otherwise the
 * pinned release asset is downloaded into the private state directory.  No
 * PATH lookup or host package manager is involved.
 */
export async function materializeQemuArtifact(options: QemuArtifactOptions): Promise<QemuArtifactIdentity> {
  const manifest =
    options.manifest ??
    (options.bundledDirectory ? bundledManifest(options.bundledDirectory, options.host) : undefined) ??
    QEMU_ARTIFACT_MANIFEST[options.host];
  ensureManifest(manifest);
  fs.mkdirSync(options.paths.qemuDirectory, { recursive: true, mode: 0o700 });
  const destination = options.paths.qemuExecutable;

  if (!fs.existsSync(destination)) {
    const bundled = options.bundledDirectory
      ? bundledCandidates(options.bundledDirectory, manifest).find((candidate) => fs.existsSync(candidate))
      : undefined;
    if (bundled !== undefined) {
      fs.copyFileSync(bundled, destination);
      fs.chmodSync(destination, 0o700);
    } else {
      await downloadToFile(manifest.downloadUrl, destination, options.fetcher);
      fs.chmodSync(destination, 0o700);
    }
  }

  assertVerifiedExecutable(destination, manifest);
  return {
    artifactId: manifest.artifactId,
    version: manifest.version,
    buildId: manifest.buildId,
    sha256: manifest.sha256,
    executablePath: destination,
  };
}
