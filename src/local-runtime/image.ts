import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LocalRuntimeError,
  type LocalRuntimeHost,
  type LocalRuntimePaths,
  type RuntimeImageIdentity,
  type RuntimeImageManifest,
} from "./types.js";

const imageManifestSchema = z
  .object({
    imageId: z.string().min(1).max(256),
    contractId: z.literal("mottainai.linux-runtime.v1"),
    schemaVersion: z.literal(1),
    architecture: z.enum(["x86_64-linux", "aarch64-linux"]),
    buildIdentity: z.string().min(1).max(4_096),
    kernelPath: z.string().min(1).max(4_096),
    kernelSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    initrdPath: z.string().min(1).max(4_096),
    initrdSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    diskPath: z.string().min(1).max(4_096),
    diskSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    sshHostKey: z.string().min(1).max(8_192),
    authorizedKeySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .optional(),
    canonicalSource: z
      .object({
        flake: z.string().min(1).max(4_096),
        output: z.string().min(1).max(4_096),
        lockSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
      })
      .strict()
      .optional(),
  })
  .strict();

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertFileHash(filePath: string, expected: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    throw new LocalRuntimeError("runtime_image_unavailable", `canonical Runtime ${label} is missing: ${filePath}`);
  }
  const actual = sha256File(filePath);
  if (actual !== expected) {
    throw new LocalRuntimeError(
      "runtime_image_corrupt",
      `canonical Runtime ${label} SHA-256 mismatch; expected ${expected}, got ${actual}`,
      { label, expected, actual },
    );
  }
}

function guestArchitecture(host: LocalRuntimeHost): RuntimeImageManifest["architecture"] {
  return host.endsWith("arm64") ? "aarch64-linux" : "x86_64-linux";
}

function defaultFlakeDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(process.cwd(), "nix"), path.resolve(moduleDirectory, "../../nix")];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "flake.nix"))) ?? candidates[0];
}

function manifestCandidates(directory: string, architecture: RuntimeImageManifest["architecture"]): string[] {
  return [
    path.join(directory, architecture, "runtime-image.json"),
    path.join(directory, architecture, "manifest.json"),
    path.join(directory, `runtime-image-${architecture}.json`),
  ];
}

export function readRuntimeImageManifest(filePath: string): RuntimeImageManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new LocalRuntimeError(
      "runtime_image_corrupt",
      `canonical Runtime image manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = imageManifestSchema.safeParse(value);
  if (!parsed.success)
    throw new LocalRuntimeError("runtime_image_corrupt", "canonical Runtime image manifest is invalid");
  const manifest = parsed.data as RuntimeImageManifest;
  const resolveAssetPath = (assetPath: string): string =>
    path.isAbsolute(assetPath) ? assetPath : path.resolve(path.dirname(filePath), assetPath);
  return {
    ...manifest,
    kernelPath: resolveAssetPath(manifest.kernelPath),
    initrdPath: resolveAssetPath(manifest.initrdPath),
    diskPath: resolveAssetPath(manifest.diskPath),
  };
}

function copyVerified(source: string, destination: string, expected: string, label: string): void {
  assertFileHash(source, expected, label);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

function buildCanonicalImageManifest(
  flakeDirectory: string,
  architecture: RuntimeImageManifest["architecture"],
): RuntimeImageManifest {
  let output: string;
  try {
    output = execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        `${flakeDirectory}#nixosConfigurations.${architecture}.config.system.build.vm`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    ).trim();
  } catch (error) {
    throw new LocalRuntimeError(
      "runtime_image_unavailable",
      `canonical NixOS Runtime image could not be materialized from #231 authority: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = output.split(/\r?\n/u).filter(Boolean).at(-1);
  if (root === undefined)
    throw new LocalRuntimeError("runtime_image_unavailable", "Nix returned no Runtime VM output path");
  const generatedManifest = [path.join(root, "runtime-image.json"), path.join(root, "manifest.json")].find(
    (candidate) => fs.existsSync(candidate),
  );
  if (generatedManifest !== undefined) return readRuntimeImageManifest(generatedManifest);
  const candidates = ["nixos.qcow2", "disk.qcow2", "nixos.img", "disk.raw"];
  const disk = candidates.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
  const kernel = [path.join(root, "kernel"), path.join(root, "bzImage")].find((candidate) => fs.existsSync(candidate));
  const initrd = [path.join(root, "initrd"), path.join(root, "initrd-linux")].find((candidate) =>
    fs.existsSync(candidate),
  );
  if (disk === undefined || kernel === undefined || initrd === undefined) {
    throw new LocalRuntimeError(
      "runtime_image_unavailable",
      `Nix Runtime VM output ${root} did not contain a complete kernel/initrd/disk bundle`,
    );
  }
  throw new LocalRuntimeError(
    "runtime_image_unavailable",
    "canonical NixOS VM output did not include the verified Runtime image manifest; refusing to invent a second image authority",
    { output: root, architecture },
  );
}

export interface RuntimeImageOptions {
  readonly paths: LocalRuntimePaths;
  readonly host: LocalRuntimeHost;
  readonly bundledDirectory?: string;
  readonly flakeDirectory?: string;
  readonly manifest?: RuntimeImageManifest;
  readonly controlPublicKey?: string;
}

/**
 * Consume a release image bundle generated from the #231 flake, or invoke the
 * same flake's VM output to obtain a bundle.  The VM launcher never defines a
 * second guest configuration; it only consumes this verified projection.
 */
export function materializeRuntimeImage(options: RuntimeImageOptions): RuntimeImageIdentity {
  const architecture = guestArchitecture(options.host);
  const manifest =
    options.manifest ??
    (options.bundledDirectory === undefined
      ? undefined
      : manifestCandidates(options.bundledDirectory, architecture)
          .filter((candidate) => fs.existsSync(candidate))
          .map(readRuntimeImageManifest)
          .find((candidate) => candidate.architecture === architecture));
  const resolved =
    manifest ?? buildCanonicalImageManifest(options.flakeDirectory ?? defaultFlakeDirectory(), architecture);
  if (resolved.architecture !== architecture) {
    throw new LocalRuntimeError(
      "runtime_image_corrupt",
      `Runtime image architecture ${resolved.architecture} does not match host profile ${architecture}`,
    );
  }
  if (resolved.canonicalSource !== undefined) {
    const lockPath = path.join(options.flakeDirectory ?? defaultFlakeDirectory(), "flake.lock");
    if (fs.existsSync(lockPath) && sha256File(lockPath) !== resolved.canonicalSource.lockSha256) {
      throw new LocalRuntimeError(
        "runtime_image_corrupt",
        "Runtime image was built from a different locked #231 Nix input set",
      );
    }
  }
  if (options.controlPublicKey !== undefined && resolved.authorizedKeySha256 !== undefined) {
    const keyHash = createHash("sha256").update(options.controlPublicKey).digest("hex");
    if (keyHash !== resolved.authorizedKeySha256) {
      throw new LocalRuntimeError(
        "runtime_image_corrupt",
        "Runtime image is not authorized for the managed control key",
      );
    }
  }

  assertFileHash(resolved.kernelPath, resolved.kernelSha256, "kernel");
  assertFileHash(resolved.initrdPath, resolved.initrdSha256, "initrd");
  assertFileHash(resolved.diskPath, resolved.diskSha256, "disk");
  copyVerified(resolved.kernelPath, options.paths.kernelImage, resolved.kernelSha256, "kernel");
  copyVerified(resolved.initrdPath, options.paths.initrdImage, resolved.initrdSha256, "initrd");
  copyVerified(resolved.diskPath, options.paths.diskImage, resolved.diskSha256, "disk");
  fs.writeFileSync(options.paths.imageManifest, `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600 });

  return {
    imageId: resolved.imageId,
    architecture: resolved.architecture,
    buildIdentity: resolved.buildIdentity,
    diskSha256: resolved.diskSha256,
  };
}

export function verifyMaterializedRuntimeImage(paths: LocalRuntimePaths, manifest: RuntimeImageManifest): void {
  assertFileHash(paths.kernelImage, manifest.kernelSha256, "kernel");
  assertFileHash(paths.initrdImage, manifest.initrdSha256, "initrd");
  assertFileHash(paths.diskImage, manifest.diskSha256, "disk");
}

export function hostKeyLineForLocalRuntime(hostKey: string): string {
  const line = hostKey.trim();
  if (!/^(?:\[127\.0\.0\.1\]:48321|127\.0\.0\.1)\s+ssh-(?:ed25519|rsa|ecdsa-sha2-nistp256)\s+\S+$/u.test(line)) {
    throw new LocalRuntimeError("runtime_image_corrupt", "Runtime image contains an invalid SSH host-key record");
  }
  return line;
}
