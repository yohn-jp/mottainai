import type { HookClient, HookEvent, HookOperation } from "./types.js";

export const MANAGED_MCP_SERVER_NAME = "mottainai" as const;
export const MANAGED_MCP_EXEC_TOOL_NAME = "mcp__mottainai__mottainai_exec" as const;
export const MANAGED_CAPABILITY_REGISTRATION_ID = "mottainai:mcp:managed:v1" as const;
export const MANAGED_CAPABILITY_REGISTRATION_MARKER = "mottainai-managed-capability-v1" as const;

/** Identity supplied only after the client registration has been verified. */
export interface ManagedCapabilityIdentity {
  client: HookClient;
  registrationId: string;
  capabilityId: HookOperation;
  toolName: string;
}

export interface ManagedCapability {
  operation: HookOperation;
  id: string;
  replacement: string;
  available: boolean;
  source: "runtime" | "unavailable";
  identity?: ManagedCapabilityIdentity;
}

export interface ManagedCapabilityRegistry {
  resolve(operation: HookOperation, event?: HookEvent): ManagedCapability | undefined;
  all(): ManagedCapability[];
}

export interface ManagedRuntimeAvailability {
  dispatcherAvailable: boolean;
  exposedTools: ReadonlySet<string>;
  managedCapability?: ManagedCapabilityIdentity;
}

export function isVerifiedManagedCapabilityIdentity(
  value: ManagedCapabilityIdentity | undefined,
  operation: HookOperation = "process.exec",
  client?: HookClient,
): value is ManagedCapabilityIdentity {
  return value !== undefined
    && (client === undefined || value.client === client)
    && value.registrationId === MANAGED_CAPABILITY_REGISTRATION_ID
    && value.capabilityId === operation
    && value.toolName === MANAGED_MCP_EXEC_TOOL_NAME;
}

/** Names are runtime tool identifiers, not a deny list of native executables. */
export const MANAGED_TOOL_FOR_OPERATION: Readonly<Record<HookOperation, { id: string; tool: string }>> = Object.freeze({
  "source.read": { id: "source.read", tool: "mottainai_read" },
  "source.search": { id: "source.search", tool: "mottainai_search" },
  // The local exec gateway is the actual managed mutation surface. Keep the
  // operation ids distinct for policy and explanation, but do not advertise
  // replacement tools that are not exposed by the runtime.
  "source.write": { id: "source.write", tool: "mottainai_exec" },
  "process.exec": { id: "process.exec", tool: "mottainai_exec" },
  "git.mutate": { id: "git.mutate", tool: "mottainai_exec" },
  other: { id: "other", tool: "" },
});


export function createCapabilityRegistry(entries: readonly ManagedCapability[]): ManagedCapabilityRegistry {
  const byOperation = new Map(entries.map((entry) => [entry.operation, { ...entry }]));
  return {
    resolve(operation): ManagedCapability | undefined {
      const entry = byOperation.get(operation);
      return entry === undefined ? undefined : { ...entry };
    },
    all(): ManagedCapability[] {
      return [...byOperation.values()].map((entry) => ({ ...entry }));
    },
  };
}

/** Resolve availability from the live dispatcher and exposed tool surface. */
export function capabilityRegistryFromRuntime(runtime: ManagedRuntimeAvailability): ManagedCapabilityRegistry {
  const entries = (Object.entries(MANAGED_TOOL_FOR_OPERATION) as Array<[HookOperation, { id: string; tool: string }]>).map(([operation, mapping]) => {
    const available = operation !== "other"
      && runtime.dispatcherAvailable
      && mapping.tool.length > 0
      && runtime.exposedTools.has(mapping.tool);
    const identity = operation === "process.exec" && isVerifiedManagedCapabilityIdentity(runtime.managedCapability)
      ? { ...runtime.managedCapability }
      : undefined;
    return {
      operation,
      id: mapping.id,
      replacement: mapping.tool,
      available,
      source: available ? "runtime" : "unavailable",
      ...(identity === undefined ? {} : { identity }),
    } satisfies ManagedCapability;
  });
  return createCapabilityRegistry(entries);
}
