import fs from "node:fs";
import path from "node:path";
import type { ManagedHookDescriptor } from "../adapters/types.js";
import { isRecord } from "../adapters/common.js";

export type JsonObject = Record<string, unknown>;

export interface JsonHookReadResult {
  exists: boolean;
  valid: boolean;
  value?: JsonObject;
  reason?: string;
}

export type ManagedEntryHealth = "missing" | "healthy" | "drifted" | "unsupported";

export const MOTTainAI_HOOK_MARKER = "mottainai-managed-hook-v1";

export function readJsonHookConfig(filePath: string): JsonHookReadResult {
  if (!fs.existsSync(filePath)) return { exists: false, valid: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) return { exists: true, valid: false, reason: "root must be an object" };
    return { exists: true, valid: true, value: parsed };
  } catch (error) {
    return { exists: true, valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function hookObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hookValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function markerHook(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  return value.statusMessage === MOTTainAI_HOOK_MARKER ? value : undefined;
}

function groupHasMarker(group: unknown): boolean {
  return isRecord(group) && hookObjects(group.hooks).some((hook) => markerHook(hook) !== undefined);
}

function hookMatches(hook: JsonObject, descriptor: ManagedHookDescriptor): boolean {
  return hook.type === "command"
    && hook.statusMessage === descriptor.marker
    && hook.command === descriptor.command
    && (descriptor.timeout === undefined || hook.timeout === descriptor.timeout);
}

function allManagedGroups(root: JsonObject): Array<{ eventName: string; index: number; group: JsonObject }> {
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const groups: Array<{ eventName: string; index: number; group: JsonObject }> = [];
  for (const [eventName, value] of Object.entries(hooks)) {
    hookObjects(value).forEach((group, index) => {
      if (groupHasMarker(group)) groups.push({ eventName, index, group });
    });
  }
  return groups;
}

export function managedEntryHealth(root: JsonObject, descriptor: ManagedHookDescriptor): ManagedEntryHealth {
  const groups = allManagedGroups(root);
  if (groups.length === 0) return "missing";
  const expected = groups.find(({ eventName }) => eventName === descriptor.eventName);
  if (expected === undefined) return "drifted";
  const managed = hookObjects(expected.group.hooks).filter((hook) => markerHook(hook) !== undefined);
  return groups.length === 1
    && managed.length === 1
    && managed.every((hook) => hookMatches(hook, descriptor))
    && expected.group.matcher === descriptor.matcher
    ? "healthy"
    : "drifted";
}

function withoutManagedGroups(root: JsonObject): JsonObject {
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const nextGroups: unknown[] = [];
    for (const group of value) {
      if (!isRecord(group)) {
        nextGroups.push(group);
        continue;
      }
      const childHooks = hookValues(group.hooks);
      if (childHooks.length === 0 || !childHooks.some((hook) => markerHook(hook) !== undefined)) {
        nextGroups.push(group);
        continue;
      }
      const remaining = childHooks.filter((hook) => !isRecord(hook) || markerHook(hook) === undefined);
      if (remaining.length > 0) nextGroups.push({ ...group, hooks: remaining });
    }
    if (nextGroups.length > 0) hooks[eventName] = nextGroups;
    else delete hooks[eventName];
  }
  if (Object.keys(hooks).length === 0) {
    const next = { ...root };
    delete next.hooks;
    return next;
  }
  return { ...root, hooks };
}

export function upsertManagedEntry(root: JsonObject, descriptor: ManagedHookDescriptor): JsonObject {
  const clean = withoutManagedGroups(root);
  const hooks = isRecord(clean.hooks) ? { ...clean.hooks } : {};
  const groups = hookObjects(hooks[descriptor.eventName]);
  groups.push({
    matcher: descriptor.matcher,
    hooks: [{
      type: "command",
      command: descriptor.command,
      statusMessage: descriptor.marker,
      ...(descriptor.timeout === undefined ? {} : { timeout: descriptor.timeout }),
    }],
  });
  hooks[descriptor.eventName] = groups;
  return { ...clean, hooks };
}

export function removeManagedEntries(root: JsonObject): JsonObject {
  return withoutManagedGroups(root);
}

function atomicWrite(filePath: string, value: JsonObject): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(directory, ".mottainai-hooks-"));
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath));
  let fileMode = 0o600;
  try {
    fileMode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // New managed configuration files are private by default.
  }
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: fileMode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function writeJsonHookConfig(filePath: string, value: JsonObject): void {
  atomicWrite(filePath, value);
}
