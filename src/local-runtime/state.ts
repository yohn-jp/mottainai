import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  LOCAL_RUNTIME_MACHINE_ID,
  LOCAL_RUNTIME_PROFILE,
  LOCAL_RUNTIME_STATE_SCHEMA_VERSION,
  LocalRuntimeError,
  type LocalRuntimeHost,
  type LocalRuntimePaths,
  type LocalRuntimeState,
} from "./types.js";
import { RuntimeCapabilityResultSchema } from "../runtime-contract/contract.js";

const qemuIdentitySchema = z
  .object({
    artifactId: z.string().min(1).max(160),
    version: z.string().min(1).max(32),
    buildId: z.string().min(1).max(160),
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    executablePath: z.string().min(1).max(4_096),
  })
  .strict();

const imageIdentitySchema = z
  .object({
    imageId: z.string().min(1).max(256),
    architecture: z.enum(["x86_64-linux", "aarch64-linux"]),
    buildIdentity: z.string().min(1).max(4_096),
    diskSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
  })
  .strict();

const runtimeStateSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_RUNTIME_STATE_SCHEMA_VERSION),
    machineId: z.literal(LOCAL_RUNTIME_MACHINE_ID),
    host: z.enum(["linux-x64", "linux-arm64", "macos-x64", "macos-arm64", "windows-x64"]),
    accelerator: z.enum(["kvm", "hvf", "whpx"]),
    lifecycle: z.enum([
      "absent",
      "acquiring-substrate",
      "creating",
      "stopped",
      "booting",
      "reachable",
      "reconciling",
      "ready",
      "incompatible",
      "repairable",
      "recreate-required",
      "failed",
    ]),
    qemu: qemuIdentitySchema,
    image: imageIdentitySchema,
    paths: z
      .object({
        stateDirectory: z.string().min(1).max(4_096),
        diskImage: z.string().min(1).max(4_096),
        qmpSocket: z.string().min(1).max(4_096),
        sshPrivateKey: z.string().min(1).max(4_096),
        sshKnownHosts: z.string().min(1).max(4_096),
      })
      .strict(),
    ssh: z
      .object({
        host: z.literal(LOCAL_RUNTIME_PROFILE.sshHost),
        port: z.literal(LOCAL_RUNTIME_PROFILE.sshPort),
        user: z.literal(LOCAL_RUNTIME_PROFILE.sshUser),
        hostKey: z.string().min(1).max(8_192),
      })
      .strict(),
    qmp: z.object({ endpoint: z.string().min(1).max(4_096), private: z.literal(true) }).strict(),
    pid: z.number().int().positive().optional(),
    runtime: RuntimeCapabilityResultSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export function defaultRuntimeStateDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = {},
  homeDirectory: string = os.homedir(),
): string {
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"), "Mottainai", "Runtime");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Mottainai", "Runtime");
  return path.join(environment.XDG_STATE_HOME ?? path.join(homeDirectory, ".local", "state"), "mottainai", "runtime");
}

export function resolveLocalRuntimePaths(
  stateDirectory: string,
  host: LocalRuntimeHost,
  platform: NodeJS.Platform = process.platform,
): LocalRuntimePaths {
  const root = path.resolve(stateDirectory, LOCAL_RUNTIME_MACHINE_ID);
  const qemuDirectory = path.join(root, "qemu", "9.2.2");
  const sshDirectory = path.join(root, "ssh");
  const qmpSocket =
    platform === "win32" ? `\\\\.\\pipe\\mottainai-${LOCAL_RUNTIME_MACHINE_ID}` : path.join(root, "qmp.sock");
  return {
    stateDirectory: root,
    stateFile: path.join(root, "state.json"),
    qmpSocket,
    diskImage: path.join(root, "runtime-disk.raw"),
    kernelImage: path.join(root, "kernel"),
    initrdImage: path.join(root, "initrd"),
    imageManifest: path.join(root, "runtime-image.json"),
    qemuDirectory,
    qemuExecutable: path.join(
      qemuDirectory,
      host === "windows-x64"
        ? "qemu-system-x86_64.exe"
        : host.endsWith("arm64")
          ? "qemu-system-aarch64"
          : "qemu-system-x86_64",
    ),
    sshDirectory,
    sshPrivateKey: path.join(sshDirectory, "control_ed25519"),
    sshKnownHosts: path.join(sshDirectory, "known_hosts"),
  };
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows ACLs are inherited from the user-private application directory.
  }
}

export function loadLocalRuntimeState(stateFile: string): LocalRuntimeState | undefined {
  if (!fs.existsSync(stateFile)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    throw new LocalRuntimeError(
      "runtime_state_corrupt",
      `local Runtime state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = runtimeStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new LocalRuntimeError("runtime_state_corrupt", "local Runtime state does not match the managed schema");
  }
  return result.data as LocalRuntimeState;
}

export function saveLocalRuntimeState(stateFile: string, state: LocalRuntimeState): void {
  ensurePrivateDirectory(path.dirname(stateFile));
  const temporary = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Windows ACLs are inherited from the private state directory.
  }
  fs.renameSync(temporary, stateFile);
}

export function acquireLocalRuntimeStateLock(stateDirectory: string): () => void {
  ensurePrivateDirectory(stateDirectory);
  const lockPath = path.join(stateDirectory, "state.lock");
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch {
    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) ownerPid = owner.pid;
    } catch {
      // An unreadable lock is not safe to remove.
    }
    if (ownerPid === undefined) {
      throw new LocalRuntimeError(
        "runtime_state_corrupt",
        `another Mottainai Runtime operation owns the state lock: ${lockPath}`,
      );
    }
    let alive = true;
    try {
      process.kill(ownerPid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      throw new LocalRuntimeError(
        "runtime_state_corrupt",
        `another Mottainai Runtime operation owns the state lock: ${lockPath}`,
      );
    }
    try {
      fs.unlinkSync(lockPath);
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      throw new LocalRuntimeError(
        "runtime_state_corrupt",
        `local Runtime state lock could not be recovered: ${lockPath}`,
      );
    }
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  return () => {
    try {
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
    } catch {
      // Releasing a lock is best effort after the operation has completed.
    }
  };
}
