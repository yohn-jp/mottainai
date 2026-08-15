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

const runtimeCompanionSchema = z
  .object({
    name: z.string().min(1),
    minimumVersion: z.string().min(1),
    present: z.boolean(),
  })
  .strict();

const runtimeStateOwnersSchema = z
  .object({
    system: z.array(z.string().min(1)),
    repositoryUser: z.array(z.string().min(1)),
  })
  .strict();

export const RuntimeCapabilityResultSchema = z
  .object({
    contractId: z.literal(RUNTIME_CONTRACT_ID),
    schemaVersion: z.number().int().min(1),
    runtimeIdentity: z.string().min(1),
    architecture: z.enum(RUNTIME_ARCHITECTURES),
    buildIdentity: z.string().min(1),
    generation: z.string().min(1),
    stateOwners: runtimeStateOwnersSchema,
    requiredCompanions: z.array(runtimeCompanionSchema),
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
