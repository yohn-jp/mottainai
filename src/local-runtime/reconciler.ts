import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identifyLocalRuntimeHost, probeHostHardware } from "./host.js";
import { materializeQemuArtifact } from "./artifacts.js";
import { materializeRuntimeImage, readRuntimeImageManifest, verifyMaterializedRuntimeImage } from "./image.js";
import { QemuRuntimeMachine, type MachineObservation, type QemuMachineOptions } from "./qmp.js";
import { ensureSshIdentity, SshRuntimeGuest, waitForRuntimeSsh, type RuntimeGuest } from "./ssh.js";
import {
  acquireLocalRuntimeStateLock,
  defaultRuntimeStateDirectory,
  ensurePrivateDirectory,
  loadLocalRuntimeState,
  resolveLocalRuntimePaths,
  saveLocalRuntimeState,
} from "./state.js";
import {
  LOCAL_RUNTIME_MACHINE_ID,
  LOCAL_RUNTIME_PROFILE,
  LocalRuntimeError,
  type HostProbeResult,
  type LocalRuntimeEnsureOptions,
  type LocalRuntimeEnsureResult,
  type LocalRuntimePaths,
  type LocalRuntimeState,
  type QemuArtifactIdentity,
  type RuntimeImageIdentity,
  type RuntimeLifecycle,
} from "./types.js";
import type { RuntimeCapabilityResult } from "../runtime-contract/contract.js";

export interface ManagedRuntimeMachine {
  inspect(pid?: number): Promise<MachineObservation>;
  start(): Promise<number>;
  stop?(pid?: number): Promise<void>;
}

export interface LocalRuntimeDependencies {
  readonly probeHost?: (
    host: ReturnType<typeof identifyLocalRuntimeHost>,
  ) => Promise<HostProbeResult> | HostProbeResult;
  readonly materializeQemu?: (options: Parameters<typeof materializeQemuArtifact>[0]) => Promise<QemuArtifactIdentity>;
  readonly materializeImage?: (options: Parameters<typeof materializeRuntimeImage>[0]) => RuntimeImageIdentity;
  readonly createMachine?: (options: QemuMachineOptions) => ManagedRuntimeMachine;
  readonly createGuest?: (options: {
    readonly paths: LocalRuntimePaths;
    readonly hostKey: string;
    readonly timeoutMs: number;
  }) => RuntimeGuest;
  readonly hostKey?: string;
  readonly bundledArtifactDirectory?: string;
  readonly bundledImageDirectory?: string;
}

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_SSH_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

function defaultBundledDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/qemu");
}

function defaultImageDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/runtime-image");
}

function nowIso(options: LocalRuntimeEnsureOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function stateWith(
  state: LocalRuntimeState,
  changes: Partial<Pick<LocalRuntimeState, "lifecycle" | "pid" | "runtime" | "qemu" | "image" | "updatedAt">>,
): LocalRuntimeState {
  const next: LocalRuntimeState = { ...state, ...changes, updatedAt: changes.updatedAt ?? new Date().toISOString() };
  if (changes.pid === undefined && "pid" in changes) {
    const { pid: _pid, ...withoutPid } = next;
    return withoutPid as LocalRuntimeState;
  }
  return next;
}

function baseState(
  host: HostProbeResult,
  qemu: QemuArtifactIdentity,
  image: RuntimeImageIdentity,
  paths: LocalRuntimePaths,
  hostKey: string,
  timestamp: string,
): LocalRuntimeState {
  return {
    schemaVersion: 1,
    machineId: LOCAL_RUNTIME_MACHINE_ID,
    host: host.host,
    accelerator: host.accelerator,
    lifecycle: "creating",
    qemu,
    image,
    paths: {
      stateDirectory: paths.stateDirectory,
      diskImage: paths.diskImage,
      qmpSocket: paths.qmpSocket,
      sshPrivateKey: paths.sshPrivateKey,
      sshKnownHosts: paths.sshKnownHosts,
    },
    ssh: {
      host: LOCAL_RUNTIME_PROFILE.sshHost,
      port: LOCAL_RUNTIME_PROFILE.sshPort,
      user: LOCAL_RUNTIME_PROFILE.sshUser,
      hostKey,
    },
    qmp: { endpoint: paths.qmpSocket, private: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function waitForMachine(
  machine: ManagedRuntimeMachine,
  pid: number,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observation: MachineObservation = "starting";
  while (Date.now() < deadline) {
    observation = await machine.inspect(pid);
    if (observation === "running") return;
    if (observation === "stopped" || observation === "failed") {
      throw new LocalRuntimeError("runtime_boot_failed", `managed QEMU stopped during boot (${observation})`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
  throw new LocalRuntimeError(
    "runtime_boot_failed",
    `managed QEMU did not expose private QMP within ${timeoutMs}ms (${observation})`,
  );
}

function imageFromStateOrThrow(paths: LocalRuntimePaths, state: LocalRuntimeState): RuntimeImageIdentity {
  try {
    const manifest = readRuntimeImageManifest(paths.imageManifest);
    verifyMaterializedRuntimeImage(paths, manifest);
  } catch (error) {
    throw new LocalRuntimeError(
      "runtime_recreate_required",
      `managed Runtime image is missing or changed; refusing destructive recreation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return state.image;
}

function sameQemuArtifact(expected: QemuArtifactIdentity, actual: QemuArtifactIdentity): boolean {
  return (
    expected.artifactId === actual.artifactId &&
    expected.version === actual.version &&
    expected.buildId === actual.buildId &&
    expected.sha256 === actual.sha256 &&
    expected.executablePath === actual.executablePath &&
    expected.runtimeLibraryDirectory === actual.runtimeLibraryDirectory
  );
}

export class LocalRuntimeProvisioner {
  constructor(private readonly dependencies: LocalRuntimeDependencies = {}) {}

  async ensure(options: LocalRuntimeEnsureOptions = {}): Promise<LocalRuntimeEnsureResult> {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const hostName = identifyLocalRuntimeHost(platform, architecture);
    const host = options.probe
      ? await options.probe()
      : this.dependencies.probeHost
        ? await this.dependencies.probeHost(hostName)
        : probeHostHardware(hostName);
    if (host.host !== hostName) {
      throw new LocalRuntimeError("unsupported_host", `host probe returned ${host.host} for detected ${hostName}`);
    }

    const stateRoot =
      options.stateDirectory ?? defaultRuntimeStateDirectory(platform, options.environment, options.homeDirectory);
    const paths = resolveLocalRuntimePaths(stateRoot, host.host, platform);
    ensurePrivateDirectory(paths.stateDirectory);
    const releaseLock = acquireLocalRuntimeStateLock(paths.stateDirectory);
    const timestamp = nowIso(options);
    let persisted: LocalRuntimeState | undefined;
    let currentState: LocalRuntimeState | undefined;
    try {
      persisted = loadLocalRuntimeState(paths.stateFile);
      currentState = persisted;
      const hadState = persisted !== undefined;
      if (persisted !== undefined) {
        if (persisted.host !== host.host || persisted.accelerator !== host.accelerator) {
          throw new LocalRuntimeError(
            "runtime_incompatible",
            `managed Runtime was created for ${persisted.host}/${persisted.accelerator}, not ${host.host}/${host.accelerator}`,
          );
        }
        if (persisted.lifecycle === "recreate-required" || persisted.lifecycle === "incompatible") {
          throw new LocalRuntimeError(
            persisted.lifecycle === "incompatible" ? "runtime_incompatible" : "runtime_recreate_required",
            `managed Runtime is ${persisted.lifecycle}; no destructive recovery was attempted`,
          );
        }
        if (!fs.existsSync(paths.qemuExecutable)) {
          throw new LocalRuntimeError(
            "runtime_recreate_required",
            "managed QEMU executable is missing; refusing to replace persistent Runtime data",
          );
        }
      }

      const artifact = await (this.dependencies.materializeQemu ?? materializeQemuArtifact)({
        paths,
        host: host.host,
        bundledDirectory:
          options.bundledArtifactDirectory ?? this.dependencies.bundledArtifactDirectory ?? defaultBundledDirectory(),
      });
      if (persisted !== undefined && !sameQemuArtifact(persisted.qemu, artifact)) {
        throw new LocalRuntimeError(
          "runtime_recreate_required",
          "managed QEMU artifact identity changed; refusing to replace persistent Runtime data",
        );
      }

      if (
        persisted !== undefined &&
        (!fs.existsSync(paths.sshPrivateKey) || !fs.existsSync(`${paths.sshPrivateKey}.pub`))
      ) {
        throw new LocalRuntimeError(
          "runtime_recreate_required",
          "managed SSH identity is missing; refusing to rotate the persistent Runtime identity",
        );
      }
      const identity = ensureSshIdentity(paths);
      let image: RuntimeImageIdentity;
      let hostKey: string;
      if (persisted === undefined) {
        image = (this.dependencies.materializeImage ?? materializeRuntimeImage)({
          paths,
          host: host.host,
          bundledDirectory:
            options.bundledImageDirectory ?? this.dependencies.bundledImageDirectory ?? defaultImageDirectory(),
          flakeDirectory: options.flakeDirectory,
          controlPublicKey: identity.publicKey,
        });
        hostKey = this.dependencies.hostKey ?? readRuntimeImageManifest(paths.imageManifest).sshHostKey;
      } else {
        image = imageFromStateOrThrow(paths, persisted);
        hostKey = persisted.ssh.hostKey;
      }

      const machineOptions: QemuMachineOptions = {
        artifact,
        image,
        paths,
        accelerator: host.accelerator,
        platform,
        environment: options.environment,
      };
      const machine = (this.dependencies.createMachine ?? ((value) => new QemuRuntimeMachine(value)))(machineOptions);
      const guest = (
        this.dependencies.createGuest ??
        ((value) =>
          new SshRuntimeGuest({ ...value, timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS }))
      )({
        paths,
        hostKey,
        timeoutMs: options.sshTimeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
      });

      let state = persisted ?? baseState(host, artifact, image, paths, hostKey, timestamp);
      const persist = (next: LocalRuntimeState): void => {
        currentState = next;
        saveLocalRuntimeState(paths.stateFile, next);
      };
      state = stateWith(state, { qemu: artifact, image, lifecycle: "booting", updatedAt: timestamp });
      persist(state);

      const observation = await machine.inspect(state.pid);
      let pid = state.pid;
      let reused = hadState;
      if (observation === "absent" || observation === "stopped" || observation === "failed") {
        pid = await machine.start();
        state = stateWith(state, { lifecycle: "booting", pid, updatedAt: nowIso(options) });
        persist(state);
      }
      if (pid === undefined) throw new LocalRuntimeError("runtime_boot_failed", "managed Runtime has no QEMU PID");
      await waitForMachine(machine, pid, options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);
      state = stateWith(state, { lifecycle: "reachable", pid, updatedAt: nowIso(options) });
      persist(state);

      let runtime = await waitForRuntimeSsh(guest, options.sshTimeoutMs ?? DEFAULT_SSH_TIMEOUT_MS);
      if (runtime.reconciliation !== "current" || runtime.upgradeRequired) {
        state = stateWith(state, { lifecycle: "reconciling", pid, runtime, updatedAt: nowIso(options) });
        persist(state);
        runtime = await guest.reconcile();
      }
      if (runtime.reconciliation !== "current" || runtime.upgradeRequired) {
        state = stateWith(state, { lifecycle: "repairable", pid, runtime, updatedAt: nowIso(options) });
        persist(state);
        throw new LocalRuntimeError(
          "runtime_reconciliation_failed",
          `Runtime remained ${runtime.reconciliation}${runtime.upgradeRequired ? " with an upgrade required" : ""} after canonical reconciliation`,
        );
      }
      state = stateWith(state, { lifecycle: "ready", pid, runtime, updatedAt: nowIso(options) });
      persist(state);
      return {
        ok: true,
        machineId: LOCAL_RUNTIME_MACHINE_ID,
        lifecycle: "ready",
        host: host.host,
        accelerator: host.accelerator,
        qemu: artifact,
        image,
        ssh: state.ssh,
        qmp: state.qmp,
        runtime,
        reused,
        warnings: [],
      };
    } catch (error) {
      if (currentState !== undefined) {
        const code = error instanceof LocalRuntimeError ? error.code : "runtime_boot_failed";
        const lifecycle: RuntimeLifecycle =
          code === "runtime_reconciliation_failed" && currentState.lifecycle === "repairable"
            ? "repairable"
            : code === "runtime_incompatible"
              ? "incompatible"
              : code === "runtime_recreate_required"
                ? "recreate-required"
                : "failed";
        try {
          saveLocalRuntimeState(paths.stateFile, stateWith(currentState, { lifecycle, updatedAt: nowIso(options) }));
        } catch {
          // Preserve the original bounded failure if state persistence itself fails.
        }
      }
      throw error;
    } finally {
      releaseLock();
    }
  }
}

export function createLocalRuntimeProvisioner(dependencies: LocalRuntimeDependencies = {}): LocalRuntimeProvisioner {
  return new LocalRuntimeProvisioner(dependencies);
}
