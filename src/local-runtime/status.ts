import path from "node:path";
import { defaultRuntimeStateDirectory, loadLocalRuntimeState } from "./state.js";
import { LOCAL_RUNTIME_MACHINE_ID, type LocalRuntimeEnsureResult, type LocalRuntimeStatus } from "./types.js";
import type { LocalRuntimeEnsureOptions } from "./types.js";

export type LocalRuntimeStatusOptions = Pick<
  LocalRuntimeEnsureOptions,
  "environment" | "homeDirectory" | "platform" | "stateDirectory"
>;

function statePaths(options: LocalRuntimeStatusOptions): { stateDirectory: string; stateFile: string } {
  const root =
    options.stateDirectory ??
    defaultRuntimeStateDirectory(options.platform, options.environment, options.homeDirectory);
  const stateDirectory = path.resolve(root, LOCAL_RUNTIME_MACHINE_ID);
  return { stateDirectory, stateFile: path.join(stateDirectory, "state.json") };
}

/** Read the persisted Runtime projection without probing hardware or creating state. */
export function readLocalRuntimeStatus(options: LocalRuntimeStatusOptions = {}): LocalRuntimeStatus {
  const paths = statePaths(options);
  const state = loadLocalRuntimeState(paths.stateFile);
  if (state === undefined) {
    return {
      ok: true,
      machineId: LOCAL_RUNTIME_MACHINE_ID,
      lifecycle: "absent",
      stateDirectory: paths.stateDirectory,
      stateFile: paths.stateFile,
    };
  }

  return {
    ok: true,
    machineId: state.machineId,
    lifecycle: state.lifecycle,
    stateDirectory: paths.stateDirectory,
    stateFile: paths.stateFile,
    host: state.host,
    accelerator: state.accelerator,
    qemu: state.qemu,
    image: state.image,
    ssh: { host: state.ssh.host, port: state.ssh.port, user: state.ssh.user },
    qmp: { private: state.qmp.private },
    ...(state.pid === undefined ? {} : { pid: state.pid }),
    ...(state.runtime === undefined ? {} : { runtime: state.runtime }),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function formatLocalRuntimeEnsureHuman(result: LocalRuntimeEnsureResult): string {
  const lines = [
    "Local Runtime",
    `  lifecycle: ${result.lifecycle}`,
    `  machine: ${result.machineId}`,
    `  host: ${result.host}/${result.accelerator}`,
    `  qemu: ${result.qemu.buildId}`,
    `  image: ${result.image.imageId}`,
    `  ${result.reused ? "reused" : "created or restarted"}`,
  ];
  if (result.runtime !== undefined) lines.push(`  reconciliation: ${result.runtime.reconciliation}`);
  if (result.warnings.length > 0) lines.push("", "Warnings", ...result.warnings.map((warning) => `  ⚠ ${warning}`));
  return lines.join("\n");
}

export function formatLocalRuntimeStatusHuman(status: LocalRuntimeStatus): string {
  const lines = [
    "Local Runtime",
    `  lifecycle: ${status.lifecycle}`,
    `  machine: ${status.machineId}`,
    `  state: ${status.stateFile}`,
  ];
  if (status.host !== undefined && status.accelerator !== undefined) {
    lines.push(`  host: ${status.host}/${status.accelerator}`);
  }
  if (status.pid !== undefined) lines.push(`  pid: ${status.pid}`);
  if (status.qemu !== undefined) lines.push(`  qemu: ${status.qemu.buildId}`);
  if (status.image !== undefined) lines.push(`  image: ${status.image.imageId}`);
  if (status.runtime !== undefined) lines.push(`  reconciliation: ${status.runtime.reconciliation}`);
  if (status.updatedAt !== undefined) lines.push(`  updated: ${status.updatedAt}`);
  return lines.join("\n");
}
