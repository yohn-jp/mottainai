import { z } from "zod";

/**
 * mottainai.linux-runtime.v1 — see docs/linux-runtime-contract.md and
 * ADR-0002. Mirrors the nawabari.standalone-execution.v1 contract-id /
 * schemaVersion split in src/workflow/nawabari.ts: the id names a
 * compatibility generation, schemaVersion names the wire-shape revision
 * within it.
 */
export const RUNTIME_CONTRACT_ID = "mottainai.linux-runtime.v1" as const;
export const RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const;

export const RUNTIME_ARCHITECTURES = ["x86_64-linux", "aarch64-linux"] as const;
export type RuntimeArchitecture = (typeof RUNTIME_ARCHITECTURES)[number];

export const RECONCILIATION_STATES = ["current", "repairable", "stale", "incompatible"] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const HEALTHY_RECONCILIATION_STATES = [
  "current",
  "repairable",
] as const satisfies readonly ReconciliationState[];

/**
 * The health/capability result is reported by an external Runtime, not
 * generated locally — these bounds keep a malformed or hostile Runtime from
 * inflating the parsed result with unbounded companion lists or path
 * strings (docs/linux-runtime-contract.md "Health/capability result").
 */
export const MAX_RUNTIME_IDENTITY_LENGTH = 256 as const;
export const MAX_STATE_PATH_LENGTH = 4096 as const;
export const MAX_STATE_PATHS_PER_OWNER = 64 as const;
export const MAX_COMPANIONS = 64 as const;
export const MAX_COMPANION_NAME_LENGTH = 128 as const;
export const MAX_COMPANION_VERSION_LENGTH = 64 as const;

const runtimeCompanionSchema = z
  .object({
    name: z.string().min(1).max(MAX_COMPANION_NAME_LENGTH),
    minimumVersion: z.string().min(1).max(MAX_COMPANION_VERSION_LENGTH),
    present: z.boolean(),
  })
  .strict();

const stateOwnerPathListSchema = z.array(z.string().min(1).max(MAX_STATE_PATH_LENGTH)).max(MAX_STATE_PATHS_PER_OWNER);

const runtimeStateOwnersSchema = z
  .object({
    system: stateOwnerPathListSchema,
    repositoryUser: stateOwnerPathListSchema,
  })
  .strict();

export const RuntimeCapabilityResultSchema = z
  .object({
    contractId: z.literal(RUNTIME_CONTRACT_ID),
    schemaVersion: z.number().int().min(1),
    runtimeIdentity: z.string().min(1).max(MAX_RUNTIME_IDENTITY_LENGTH),
    architecture: z.enum(RUNTIME_ARCHITECTURES),
    buildIdentity: z.string().min(1).max(MAX_STATE_PATH_LENGTH),
    generation: z.number().int().min(1),
    stateOwners: runtimeStateOwnersSchema,
    requiredCompanions: z.array(runtimeCompanionSchema).max(MAX_COMPANIONS),
    reconciliation: z.enum(RECONCILIATION_STATES),
    upgradeRequired: z.boolean(),
  })
  .strict();

export type RuntimeCapabilityResult = z.infer<typeof RuntimeCapabilityResultSchema>;

export function parseRuntimeCapabilityResult(value: unknown): RuntimeCapabilityResult {
  return RuntimeCapabilityResultSchema.parse(value);
}

/**
 * A higher/unrecognized contractId is incompatible outright; a lower
 * schemaVersion than the caller's minimum is stale but reconcilable, not
 * rejected. Callers that need "stale" surfaced as a distinct outcome should
 * inspect schemaVersion themselves — this helper only answers "safe to talk
 * to at all".
 */
export function isRuntimeContractCompatible(
  reported: { readonly contractId: string; readonly schemaVersion: number },
  minimumSchemaVersion: number = RUNTIME_CONTRACT_SCHEMA_VERSION,
): boolean {
  return reported.contractId === RUNTIME_CONTRACT_ID && reported.schemaVersion >= minimumSchemaVersion;
}

export interface RuntimeGenerationRecord {
  readonly generation: number;
  readonly buildIdentity: string;
  readonly reconciliation: ReconciliationState;
}

export class RuntimeRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRollbackError";
  }
}

/**
 * Rollback targets the most recent generation whose recorded health result
 * was current/repairable (docs/linux-runtime-contract.md "Update, rollback,
 * and rebuild semantics"). A generation that never reported a healthy
 * result is never a rollback target, even if it is the most recent one.
 */
export function planRollback(history: readonly RuntimeGenerationRecord[]): RuntimeGenerationRecord {
  const healthy = history.filter((record) =>
    (HEALTHY_RECONCILIATION_STATES as readonly string[]).includes(record.reconciliation),
  );
  const target = healthy.reduce<RuntimeGenerationRecord | undefined>(
    (latest, record) => (latest === undefined || record.generation > latest.generation ? record : latest),
    undefined,
  );
  if (target === undefined) {
    throw new RuntimeRollbackError("no generation in history reported a healthy reconciliation state");
  }
  return target;
}
