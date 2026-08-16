import type { RuntimeCapabilityResult } from "../runtime-contract/contract.js";

export const LOCAL_RUNTIME_STATE_SCHEMA_VERSION = 1 as const;
export const LOCAL_RUNTIME_MACHINE_ID = "mottainai-local-runtime-v1" as const;
export const LOCAL_RUNTIME_PROFILE = Object.freeze({
  machineId: LOCAL_RUNTIME_MACHINE_ID,
  machineUuid: "c4d5e6f7-8091-4a2b-9c3d-4e5f60718293",
  machineType: "q35",
  cpuCount: 2,
  memoryMiB: 2048,
  sshHost: "127.0.0.1",
  sshPort: 48321,
  sshUser: "mottainai-control",
} as const);

export const MANAGED_QEMU_VERSION = "9.2.2" as const;
export const MANAGED_QEMU_BUILD_ID = `qemu-${MANAGED_QEMU_VERSION}-mottainai-runtime-v1` as const;
export const MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION = 2 as const;

export type LocalRuntimeHost = "linux-x64" | "linux-arm64" | "macos-x64" | "macos-arm64" | "windows-x64";
export type RuntimeAccelerator = "kvm" | "hvf" | "whpx";
export type QemuArtifactAvailability = "available" | "not-built" | "unavailable";
export type QemuArtifactDependencyMode = "static" | "bundled";
export type RuntimeLifecycle =
  | "absent"
  | "acquiring-substrate"
  | "creating"
  | "stopped"
  | "booting"
  | "reachable"
  | "reconciling"
  | "ready"
  | "incompatible"
  | "repairable"
  | "recreate-required"
  | "failed";

export interface QemuArtifactFile {
  /** Stable name used in compliance records and diagnostics. */
  readonly name: string;
  /** Path relative to the artifact root; never an absolute host path. */
  readonly path: string;
  readonly sha256: string;
}

export interface QemuArtifactProvenance {
  readonly sourceRevision: string;
  readonly sourceDateEpoch: number;
  readonly builder: string;
  readonly workflow: string;
  readonly toolchain: string;
  readonly configureArgs: readonly string[];
}

export interface QemuArtifactManifest {
  /** Optional for compatibility with injected #257 test manifests. */
  readonly schemaVersion?: typeof MANAGED_QEMU_ARTIFACT_SCHEMA_VERSION;
  /** Unavailable entries carry no executable digest and can never be executed. */
  readonly availability?: QemuArtifactAvailability;
  readonly unavailableReason?: string;
  readonly artifactId: string;
  readonly version: typeof MANAGED_QEMU_VERSION;
  readonly buildId: typeof MANAGED_QEMU_BUILD_ID;
  readonly host: LocalRuntimeHost;
  readonly executableName: string;
  /** Release archive URL; a package may instead provide the artifact directory beside dist/. */
  readonly downloadUrl: string;
  /** Optional URL for the generated manifest sidecar published with the archive. */
  readonly manifestUrl?: string;
  /** SHA-256 of the executable inside an available artifact. */
  readonly sha256?: string;
  /** SHA-256 of the deterministic payload archive, when a build produced one. */
  readonly payloadSha256?: string;
  /** Whether dynamic runtime dependencies are absent by design or bundled below. */
  readonly dependencyMode?: QemuArtifactDependencyMode;
  readonly runtimeLibraries: readonly QemuArtifactFile[];
  readonly firmware: readonly QemuArtifactFile[];
  readonly source: {
    readonly url: string;
    readonly sha256: string;
    readonly license: "GPL-2.0-or-later";
    readonly correspondingSource: string;
    readonly licenseFiles?: readonly string[];
  };
  readonly provenance?: QemuArtifactProvenance;
}

export interface QemuArtifactIdentity {
  readonly artifactId: string;
  readonly version: string;
  readonly buildId: string;
  readonly sha256: string;
  readonly executablePath: string;
  /** Private child-process library path for bundled dynamic dependencies. */
  readonly runtimeLibraryDirectory?: string;
}

export interface RuntimeImageManifest {
  readonly imageId: string;
  readonly contractId: "mottainai.linux-runtime.v1";
  readonly schemaVersion: 1;
  readonly architecture: "x86_64-linux" | "aarch64-linux";
  readonly buildIdentity: string;
  readonly kernelPath: string;
  readonly kernelSha256: string;
  readonly initrdPath: string;
  readonly initrdSha256: string;
  readonly diskPath: string;
  readonly diskSha256: string;
  readonly sshHostKey: string;
  readonly authorizedKeySha256?: string;
  readonly canonicalSource?: {
    readonly flake: string;
    readonly output: string;
    readonly lockSha256: string;
  };
}

export interface RuntimeImageIdentity {
  readonly imageId: string;
  readonly architecture: RuntimeImageManifest["architecture"];
  readonly buildIdentity: string;
  readonly diskSha256: string;
}

export interface LocalRuntimePaths {
  readonly stateDirectory: string;
  readonly stateFile: string;
  readonly qmpSocket: string;
  readonly diskImage: string;
  readonly kernelImage: string;
  readonly initrdImage: string;
  readonly imageManifest: string;
  readonly qemuDirectory: string;
  readonly qemuExecutable: string;
  readonly sshDirectory: string;
  readonly sshPrivateKey: string;
  readonly sshKnownHosts: string;
}

export interface LocalRuntimeState {
  readonly schemaVersion: typeof LOCAL_RUNTIME_STATE_SCHEMA_VERSION;
  readonly machineId: typeof LOCAL_RUNTIME_MACHINE_ID;
  readonly host: LocalRuntimeHost;
  readonly accelerator: RuntimeAccelerator;
  readonly lifecycle: RuntimeLifecycle;
  readonly qemu: QemuArtifactIdentity;
  readonly image: RuntimeImageIdentity;
  readonly paths: {
    readonly stateDirectory: string;
    readonly diskImage: string;
    readonly qmpSocket: string;
    readonly sshPrivateKey: string;
    readonly sshKnownHosts: string;
  };
  readonly ssh: {
    readonly host: typeof LOCAL_RUNTIME_PROFILE.sshHost;
    readonly port: typeof LOCAL_RUNTIME_PROFILE.sshPort;
    readonly user: typeof LOCAL_RUNTIME_PROFILE.sshUser;
    readonly hostKey: string;
  };
  readonly qmp: {
    readonly endpoint: string;
    readonly private: true;
  };
  readonly pid?: number;
  readonly runtime?: RuntimeCapabilityResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HostProbeResult {
  readonly host: LocalRuntimeHost;
  readonly accelerator: RuntimeAccelerator;
  readonly architecture: string;
}

export interface LocalRuntimeEnsureResult {
  readonly ok: boolean;
  readonly machineId: typeof LOCAL_RUNTIME_MACHINE_ID;
  readonly lifecycle: RuntimeLifecycle;
  readonly host: LocalRuntimeHost;
  readonly accelerator: RuntimeAccelerator;
  readonly qemu: QemuArtifactIdentity;
  readonly image: RuntimeImageIdentity;
  readonly ssh: LocalRuntimeState["ssh"];
  readonly qmp: LocalRuntimeState["qmp"];
  readonly runtime?: RuntimeCapabilityResult;
  readonly reused: boolean;
  readonly warnings: string[];
}

/** Read-only, bounded projection of the persisted local Runtime state. */
export interface LocalRuntimeStatus {
  readonly ok: true;
  readonly machineId: typeof LOCAL_RUNTIME_MACHINE_ID;
  readonly lifecycle: RuntimeLifecycle;
  readonly stateDirectory: string;
  readonly stateFile: string;
  readonly host?: LocalRuntimeHost;
  readonly accelerator?: RuntimeAccelerator;
  readonly qemu?: QemuArtifactIdentity;
  readonly image?: RuntimeImageIdentity;
  readonly ssh?: Pick<LocalRuntimeState["ssh"], "host" | "port" | "user">;
  readonly qmp?: Pick<LocalRuntimeState["qmp"], "private">;
  readonly pid?: number;
  readonly runtime?: RuntimeCapabilityResult;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type LocalRuntimeErrorCode =
  | "unsupported_host"
  | "hardware_acceleration_unavailable"
  | "managed_qemu_artifact_unavailable"
  | "managed_qemu_artifact_corrupt"
  | "runtime_image_unavailable"
  | "runtime_image_corrupt"
  | "runtime_state_corrupt"
  | "runtime_incompatible"
  | "runtime_recreate_required"
  | "runtime_boot_failed"
  | "runtime_ssh_failed"
  | "runtime_health_failed"
  | "runtime_reconciliation_failed";

export class LocalRuntimeError extends Error {
  readonly code: LocalRuntimeErrorCode;
  readonly details?: Readonly<Record<string, string>>;

  constructor(code: LocalRuntimeErrorCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "LocalRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export interface LocalRuntimeEnsureOptions {
  readonly homeDirectory?: string;
  readonly stateDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly flakeDirectory?: string;
  readonly bundledArtifactDirectory?: string;
  readonly bundledImageDirectory?: string;
  readonly now?: () => Date;
  readonly commandTimeoutMs?: number;
  readonly bootTimeoutMs?: number;
  readonly sshTimeoutMs?: number;
  readonly probe?: () => Promise<HostProbeResult>;
}
