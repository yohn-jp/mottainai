/**
 * Connection-local bounds for the asynchronous managed-process surface.
 *
 * These limits are deliberately finite even when they are not configured. The
 * registry owns the lifecycle enforcement; this module only resolves and
 * validates the policy that the registry receives.
 */
export interface ManagedProcessPolicyConfig {
  /** Maximum number of live processes in one MCP connection. */
  maxActiveProcesses?: number;
  /** Maximum number of completed handles retained for a connection. */
  maxRetainedHandles?: number;
  /** Maximum wall-clock lifetime of one managed process. */
  maxLifetimeMs?: number;
}

export interface ManagedProcessPolicy {
  maxActiveProcesses: number;
  maxRetainedHandles: number;
  maxLifetimeMs: number;
}

export const DEFAULT_MANAGED_PROCESS_POLICY: ManagedProcessPolicy = {
  maxActiveProcesses: 8,
  maxRetainedHandles: 32,
  maxLifetimeMs: 5 * 60 * 1_000,
};

// Keep configuration below the limits supported by the runtime and avoid a
// policy file itself becoming an unbounded resource request.
const MAX_ACTIVE_PROCESSES = 1_024;
const MAX_RETAINED_HANDLES = 4_096;
const MAX_LIFETIME_MS = 2_147_483_647;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  field: keyof ManagedProcessPolicy,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`invalid managed process policy ${field}`);
  }
  return resolved;
}

export function resolveManagedProcessPolicy(config?: ManagedProcessPolicyConfig): ManagedProcessPolicy {
  return {
    maxActiveProcesses: boundedInteger(
      config?.maxActiveProcesses,
      DEFAULT_MANAGED_PROCESS_POLICY.maxActiveProcesses,
      "maxActiveProcesses",
      1,
      MAX_ACTIVE_PROCESSES,
    ),
    maxRetainedHandles: boundedInteger(
      config?.maxRetainedHandles,
      DEFAULT_MANAGED_PROCESS_POLICY.maxRetainedHandles,
      "maxRetainedHandles",
      0,
      MAX_RETAINED_HANDLES,
    ),
    maxLifetimeMs: boundedInteger(
      config?.maxLifetimeMs,
      DEFAULT_MANAGED_PROCESS_POLICY.maxLifetimeMs,
      "maxLifetimeMs",
      1,
      MAX_LIFETIME_MS,
    ),
  };
}
