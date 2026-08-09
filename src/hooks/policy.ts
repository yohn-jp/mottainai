import fs from "node:fs";
import path from "node:path";
import type { HookFailureMode, HookOperation, HookRolloutMode } from "./types.js";
import { isHookOperation } from "./types.js";

export const HOOK_POLICY_VERSION = 1 as const;
export const DEFAULT_HOOK_TIMEOUT_MS = 1_000;
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 512;

export interface HookPolicy {
  version: typeof HOOK_POLICY_VERSION;
  mode: HookRolloutMode;
  operationModes: Partial<Record<HookOperation, HookRolloutMode>>;
  failureModes: Record<HookOperation, HookFailureMode>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type HookPolicyLoadResult = {
  ok: true;
  path: string;
  policy: HookPolicy;
} | {
  ok: false;
  path: string;
  reason: string;
};

const DEFAULT_FAILURE_MODES: Record<HookOperation, HookFailureMode> = {
  "source.read": "open",
  "source.search": "open",
  "source.write": "closed",
  "process.exec": "closed",
  "git.mutate": "closed",
  other: "open",
};

export const DEFAULT_HOOK_POLICY: HookPolicy = Object.freeze({
  version: HOOK_POLICY_VERSION,
  mode: "observe",
  operationModes: Object.freeze({}),
  failureModes: Object.freeze({ ...DEFAULT_FAILURE_MODES }),
  timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_HOOK_MAX_OUTPUT_BYTES,
});

export function hookPolicyPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".mottainai", "hooks.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mode(value: unknown): HookRolloutMode | undefined {
  return value === "observe" || value === "warn" || value === "enforce" ? value : undefined;
}

function failureMode(value: unknown): HookFailureMode | undefined {
  return value === "open" || value === "closed" ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`hooks policy ${field} must be a positive integer`);
  }
  if (value > maximum) throw new Error(`hooks policy ${field} must be at most ${maximum}`);
  return value;
}

export function validateHookPolicy(value: unknown): HookPolicy {
  if (!isRecord(value) || value.version !== HOOK_POLICY_VERSION) throw new Error("hooks policy version must be 1");
  const selectedMode = mode(value.mode);
  if (selectedMode === undefined) throw new Error("hooks policy mode must be observe, warn, or enforce");

  const operationModes: Partial<Record<HookOperation, HookRolloutMode>> = {};
  if (value.operationModes !== undefined) {
    if (!isRecord(value.operationModes)) throw new Error("hooks policy operationModes must be an object");
    for (const [operation, selected] of Object.entries(value.operationModes)) {
      if (!isHookOperation(operation) || mode(selected) === undefined) throw new Error(`invalid hooks operation mode: ${operation}`);
      operationModes[operation] = selected as HookRolloutMode;
    }
  }

  const failureModes: Record<HookOperation, HookFailureMode> = { ...DEFAULT_FAILURE_MODES };
  if (value.failureModes !== undefined) {
    if (!isRecord(value.failureModes)) throw new Error("hooks policy failureModes must be an object");
    for (const [operation, selected] of Object.entries(value.failureModes)) {
      if (!isHookOperation(operation) || failureMode(selected) === undefined) throw new Error(`invalid hooks failure mode: ${operation}`);
      failureModes[operation] = selected as HookFailureMode;
    }
  }

  return {
    version: HOOK_POLICY_VERSION,
    mode: selectedMode,
    operationModes,
    failureModes,
    timeoutMs: positiveInteger(value.timeoutMs, DEFAULT_HOOK_TIMEOUT_MS, 30_000, "timeoutMs"),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, DEFAULT_HOOK_MAX_OUTPUT_BYTES, 4_096, "maxOutputBytes"),
  };
}

export function loadHookPolicy(workspaceRoot: string): HookPolicyLoadResult {
  const filePath = hookPolicyPath(workspaceRoot);
  if (!fs.existsSync(filePath)) return { ok: true, path: filePath, policy: { ...DEFAULT_HOOK_POLICY, failureModes: { ...DEFAULT_FAILURE_MODES } } };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, path: filePath, policy: validateHookPolicy(parsed) };
  } catch (error) {
    return { ok: false, path: filePath, reason: error instanceof Error ? error.message : String(error) };
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function writeHookPolicy(workspaceRoot: string, policy: HookPolicy): string {
  const validated = validateHookPolicy(policy);
  const filePath = hookPolicyPath(workspaceRoot);
  atomicWrite(filePath, validated);
  return filePath;
}

export function resolveHookMode(policy: HookPolicy, operation: HookOperation): HookRolloutMode {
  return policy.operationModes[operation] ?? policy.mode;
}

export function resolveFailureMode(policy: HookPolicy, operation: HookOperation): HookFailureMode {
  return policy.failureModes[operation] ?? policy.failureModes.other;
}
