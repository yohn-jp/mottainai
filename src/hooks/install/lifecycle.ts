import fs from "node:fs";
import path from "node:path";
import type { HookClientAdapter, HookDiscoveryContext, ClientDiscovery, HookAdapterContext, ManagedHookDescriptor } from "../adapters/types.js";
import { MOTTainAI_HOOK_MARKER, managedEntryHealth, readJsonHookConfig, removeManagedEntries, upsertManagedEntry, writeJsonHookConfig } from "./json-hooks.js";

export interface HookLifecycleContext {
  workspaceRoot: string;
  homeDirectory: string;
  resolveCommand: (command: string) => string | undefined;
  probeVersion: (executable: string) => string | undefined;
  dispatcherCommand: string;
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

function descriptor(adapter: HookClientAdapter, command: string): ManagedHookDescriptor {
  return { marker: MOTTainAI_HOOK_MARKER, eventName: adapter.eventName, matcher: adapter.matcher, command };
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
  const discovery = discover(adapter, context);
  const managedDescriptor = descriptor(adapter, context.dispatcherCommand);
  const config = readJsonHookConfig(discovery.configPath);
  const health = !config.valid || config.value === undefined || !adapter.supportsDocument(config.value)
    ? "unsupported" : managedEntryHealth(config.value, managedDescriptor);
  let changed = false;
  let error: string | undefined;
  if (action !== "status" && action !== "uninstall" && discovery.state === "installed" && config.valid && config.value !== undefined) {
    const next = upsertManagedEntry(config.value, managedDescriptor);
    writeJsonHookConfig(discovery.configPath, next);
    changed = true;
  } else if (action === "uninstall" && config.valid && config.value !== undefined) {
    const next = removeManagedEntries(config.value);
    if (JSON.stringify(next) !== JSON.stringify(config.value)) {
      writeJsonHookConfig(discovery.configPath, next);
      changed = true;
    }
  } else if (action !== "status" && (discovery.state === "unsupported" || discovery.state === "incompatible")) {
    error = discovery.reason ?? discovery.state;
  } else if (action !== "status" && !config.valid) {
    error = config.reason ?? "unsupported client configuration";
  }
  const after = readJsonHookConfig(discovery.configPath);
  const afterHealth = !after.valid || after.value === undefined
    ? "unsupported"
    : action === "uninstall" ? managedEntryHealth(after.value, managedDescriptor) : managedEntryHealth(after.value, managedDescriptor);
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

export function managedDescriptor(adapter: HookClientAdapter, dispatcherCommand: string): ManagedHookDescriptor {
  return descriptor(adapter, dispatcherCommand);
}

export function isDispatcherPathAvailable(command: string, resolveCommand: (value: string) => string | undefined): boolean {
  const first = command.trim().split(/\s+/u)[0];
  if (first === undefined || first.length === 0) return false;
  return path.isAbsolute(first) ? fs.existsSync(first) : resolveCommand(first) !== undefined;
}
