import fs from "node:fs";
import path from "node:path";
import type { HookClientAdapter, ClientDiscovery, ManagedHookDescriptor } from "../adapters/types.js";
import {
  JsonHookConfigChangedError,
  MOTTainAI_HOOK_MARKER,
  managedEntryHealth,
  readJsonHookConfig,
  readJsonHookConfigSnapshot,
  removeManagedEntries,
  upsertManagedEntry,
  writeJsonHookConfig,
} from "./json-hooks.js";

export interface HookLifecycleContext {
  workspaceRoot: string;
  homeDirectory: string;
  resolveCommand: (command: string) => string | undefined;
  probeVersion: (executable: string) => string | undefined;
  dispatcherCommand: string;
  hookTimeoutMs?: number;
  /** Arguments pinned by the installer, after the `hooks dispatch` subcommand. */
  dispatcherArguments?: readonly string[];
}

export interface HookClientReport extends ClientDiscovery {
  managedEntry: "missing" | "healthy" | "drifted" | "unsupported";
  changed: boolean;
  error?: string;
}

function versionCompatible(version: string | undefined): { compatibility: ClientDiscovery["compatibility"]; state?: ClientDiscovery["state"] } {
  if (version === undefined) return { compatibility: "unknown" };
  const match = version.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/u);
  if (match === null) return { compatibility: "incompatible", state: "incompatible" };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor === 0) return { compatibility: "incompatible", state: "incompatible" };
  return { compatibility: "compatible" };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function descriptor(
  adapter: HookClientAdapter,
  command: string,
  hookTimeoutMs?: number,
  dispatcherArguments: readonly string[] = [],
): ManagedHookDescriptor {
  // The configured command is the executable selected by the CLI (an installed
  // binary, or the development entry point). Add the adapter at this boundary
  // so both clients invoke the same transport-independent dispatcher path.
  const timeout = hookTimeoutMs === undefined ? undefined : Math.max(1, Math.ceil(hookTimeoutMs / 1_000));
  return {
    marker: MOTTainAI_HOOK_MARKER,
    eventName: adapter.eventName,
    matcher: adapter.matcher,
    command: [
      command,
      "hooks",
      "dispatch",
      "--client",
      adapter.client,
      ...dispatcherArguments.flatMap((argument) => [shellWord(argument)]),
    ].join(" "),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function discover(adapter: HookClientAdapter, context: HookLifecycleContext): ClientDiscovery {
  const configPath = adapter.configPath(context);
  const config = readJsonHookConfig(configPath);
  if (config.valid && config.value !== undefined && !adapter.supportsDocument(config.value)) {
    return {
      client: adapter.client, adapterVersion: adapter.adapterVersion, state: "unsupported", compatibility: "unknown",
      configPath, configPresent: config.exists, configValid: false, reason: "client hook configuration shape is unsupported",
    };
  }
  const executable = context.resolveCommand(adapter.client);
  if (!config.valid) {
    return {
      client: adapter.client, adapterVersion: adapter.adapterVersion, state: "unsupported", compatibility: "unknown",
      ...(executable === undefined ? {} : { executable }), configPath, configPresent: config.exists, configValid: false, reason: config.reason,
    };
  }
  if (executable === undefined) {
    return {
      client: adapter.client, adapterVersion: adapter.adapterVersion, state: "not-installed", compatibility: "unknown",
      configPath, configPresent: config.exists, configValid: config.valid, reason: "client executable not found",
    };
  }
  const clientVersion = context.probeVersion(executable);
  const compatibility = versionCompatible(clientVersion);
  return {
    client: adapter.client, adapterVersion: adapter.adapterVersion, state: compatibility.state ?? "installed", compatibility: compatibility.compatibility,
    ...(clientVersion === undefined ? {} : { clientVersion }), executable, configPath, configPresent: config.exists, configValid: config.valid,
    ...(compatibility.state === "incompatible" ? { reason: "client version is not supported" } : {}),
  };
}

function reportFor(adapter: HookClientAdapter, context: HookLifecycleContext, action: "status" | "install" | "repair" | "uninstall"): HookClientReport {
  const managedDescriptor = descriptor(adapter, context.dispatcherCommand, context.hookTimeoutMs, context.dispatcherArguments);
  let changed = false;
  let error: string | undefined;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const discovery = discover(adapter, context);
    const snapshot = readJsonHookConfigSnapshot(discovery.configPath);
    const config = snapshot.config;
    const supported = config.valid && config.value !== undefined && adapter.supportsDocument(config.value);
    try {
      if (action === "status") break;
      if (!supported) {
        error = config.reason ?? discovery.reason ?? "unsupported client configuration";
        break;
      }
      if (action === "uninstall") {
        const next = removeManagedEntries(config.value!);
        if (JSON.stringify(next) !== JSON.stringify(config.value)) {
          writeJsonHookConfig(discovery.configPath, next, snapshot.revision);
          changed = true;
        }
        break;
      }
      if (discovery.state !== "installed") {
        error = discovery.reason ?? discovery.state;
        break;
      }
      if (!isDispatcherPathAvailable(context.dispatcherCommand, context.resolveCommand, context.workspaceRoot)) {
        error = "dispatcher command is not resolvable";
        break;
      }
      const next = upsertManagedEntry(config.value!, managedDescriptor);
      if (JSON.stringify(next) !== JSON.stringify(config.value)) {
        writeJsonHookConfig(discovery.configPath, next, snapshot.revision);
        changed = true;
      }
      break;
    } catch (caught) {
      if (caught instanceof JsonHookConfigChangedError && attempt + 1 < maxAttempts) continue;
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }

  const discovery = discover(adapter, context);
  const after = readJsonHookConfig(discovery.configPath);
  const afterHealth = !after.valid || after.value === undefined
    ? "unsupported"
    : managedEntryHealth(after.value, managedDescriptor);
  if (error === undefined && action === "uninstall" && afterHealth !== "missing") {
    error = `managed entry remains ${afterHealth} after uninstall`;
  } else if (error === undefined && action !== "status" && action !== "uninstall" && afterHealth !== "healthy") {
    error = `managed entry remains ${afterHealth} after ${action}`;
  }
  return { ...discovery, managedEntry: afterHealth, changed, ...(error === undefined ? {} : { error }) };
}

export function discoverHookClients(adapters: readonly HookClientAdapter[], context: HookLifecycleContext): HookClientReport[] {
  return adapters.map((adapter) => reportFor(adapter, context, "status"));
}

export function applyHookLifecycle(
  action: "install" | "repair" | "uninstall",
  adapters: readonly HookClientAdapter[],
  context: HookLifecycleContext,
  selected?: string,
): HookClientReport[] {
  return adapters.filter((adapter) => selected === undefined || selected === "all" || adapter.client === selected)
    .map((adapter) => reportFor(adapter, context, action));
}

export function managedDescriptor(
  adapter: HookClientAdapter,
  dispatcherCommand: string,
  hookTimeoutMs?: number,
  dispatcherArguments?: readonly string[],
): ManagedHookDescriptor {
  return descriptor(adapter, dispatcherCommand, hookTimeoutMs, dispatcherArguments);
}

function commandWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/gu;
  for (const match of command.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) words.push(value.replace(/'\\''/g, "'"));
  }
  return words;
}

function regularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function executableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

export function isDispatcherPathAvailable(
  command: string,
  resolveCommand: (value: string) => string | undefined,
  workingDirectory = process.cwd(),
): boolean {
  const words = commandWords(command);
  const first = words[0];
  if (first === undefined || first.length === 0) return false;
  const executable = path.isAbsolute(first) ? (executableFile(first) ? first : undefined) : resolveCommand(first);
  if (executable === undefined) return false;

  // A node/tsx dispatcher is only resolvable when its entry script also exists.
  // This catches stale generated hook entries without trying to execute them.
  const executableName = path.basename(executable).toLowerCase();
  if (executableName !== "node" && executableName !== "nodejs" && executableName !== "tsx") return true;
  const script = words.slice(1).find((word) => /\.(?:[cm]?js|ts)$/u.test(word) && !word.startsWith("-"));
  return script === undefined || regularFile(path.isAbsolute(script) ? script : path.resolve(workingDirectory, script));
}
