import { z } from "zod";
import type { ManagerRuntimeId, ManagerSessionId, TaskId } from "../workflow/state/store.js";

/**
 * Provider-neutral worker runtime boundary.
 *
 * This module is deliberately a projection contract. It carries stable
 * Manager/task/runtime identities and bounded semantic state, but no provider
 * transcript, reasoning, or tool-result payloads.
 */

export const WORKER_RUNTIME_CONTRACT_ID = "mottainai.worker-runtime.v1" as const;
export const WORKER_RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const;

export const WORKER_RUNTIME_LIFECYCLE_STATES = [
  "starting",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
] as const;
export type WorkerRuntimeLifecycleState = (typeof WORKER_RUNTIME_LIFECYCLE_STATES)[number];

export const WORKER_RUNTIME_PHASES = [
  "initializing",
  "ready",
  "executing",
  "waiting",
  "finalizing",
  "complete",
  "failed",
] as const;
export type WorkerRuntimePhase = (typeof WORKER_RUNTIME_PHASES)[number];

export const WORKER_RUNTIME_ACTIVITY_KINDS = ["idle", "working", "waiting", "blocked", "finalizing"] as const;
export type WorkerRuntimeActivityKind = (typeof WORKER_RUNTIME_ACTIVITY_KINDS)[number];

export const WORKER_RUNTIME_ATTENTION_STATES = ["none", "attention", "blocked"] as const;
export type WorkerRuntimeAttentionState = (typeof WORKER_RUNTIME_ATTENTION_STATES)[number];

export const WORKER_RUNTIME_OBSERVATION_EVENT_KINDS = ["started", "status", "stopped", "failed"] as const;
export type WorkerRuntimeObservationEventKind = (typeof WORKER_RUNTIME_OBSERVATION_EVENT_KINDS)[number];

export const WORKER_RUNTIME_CONTROL_OPERATIONS = ["start", "bind", "stop", "steer", "input"] as const;
export type WorkerRuntimeControlOperation = (typeof WORKER_RUNTIME_CONTROL_OPERATIONS)[number];

export const WORKER_RUNTIME_MAX_IDENTITY_LENGTH = 256 as const;
export const WORKER_RUNTIME_MAX_PROVIDER_LENGTH = 128 as const;
export const WORKER_RUNTIME_MAX_LABEL_LENGTH = 256 as const;
export const WORKER_RUNTIME_MAX_BLOCKER_CODE_LENGTH = 128 as const;
export const WORKER_RUNTIME_MAX_BLOCKER_DETAIL_LENGTH = 512 as const;
export const WORKER_RUNTIME_MAX_CONTROL_TEXT_LENGTH = 4_096 as const;
export const WORKER_RUNTIME_MAX_TOKEN_COUNT = 1_000_000_000_000 as const;

const MAX_IDENTITY_LENGTH = WORKER_RUNTIME_MAX_IDENTITY_LENGTH;
const MAX_PROVIDER_LENGTH = WORKER_RUNTIME_MAX_PROVIDER_LENGTH;
const MAX_LABEL_LENGTH = WORKER_RUNTIME_MAX_LABEL_LENGTH;
const MAX_BLOCKER_CODE_LENGTH = WORKER_RUNTIME_MAX_BLOCKER_CODE_LENGTH;
const MAX_BLOCKER_DETAIL_LENGTH = WORKER_RUNTIME_MAX_BLOCKER_DETAIL_LENGTH;
const MAX_CONTROL_TEXT_LENGTH = WORKER_RUNTIME_MAX_CONTROL_TEXT_LENGTH;
const MAX_TOKEN_COUNT = WORKER_RUNTIME_MAX_TOKEN_COUNT;

const boundedIdentitySchema = z.string().min(1).max(MAX_IDENTITY_LENGTH);
const boundedProviderSchema = z.string().min(1).max(MAX_PROVIDER_LENGTH);
const boundedLabelSchema = z.string().min(1).max(MAX_LABEL_LENGTH);
const boundedControlTextSchema = z.string().min(1).max(MAX_CONTROL_TEXT_LENGTH);
const boundedTokenCountSchema = z.number().int().min(0).max(MAX_TOKEN_COUNT);
const timestampSchema = z.string().datetime({ offset: true });

// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const managerSessionIdSchema = boundedIdentitySchema.transform((value) => value as ManagerSessionId);
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const managerRuntimeIdSchema = boundedIdentitySchema.transform((value) => value as ManagerRuntimeId);
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const taskIdSchema = boundedIdentitySchema.transform((value) => value as TaskId);

/** Existing Manager/task/runtime identities composed into one worker identity. */
export const WorkerRuntimeIdentitySchema = z
  .object({
    managerSessionId: managerSessionIdSchema,
    runtimeId: managerRuntimeIdSchema,
    taskId: taskIdSchema.optional(),
    executionSessionId: boundedIdentitySchema.optional(),
    provider: boundedProviderSchema,
  })
  .strict();
export type WorkerRuntimeIdentity = z.infer<typeof WorkerRuntimeIdentitySchema>;

/** A binding is an association, not a new physical session or authority. */
export const WorkerRuntimeBindingSchema = z
  .object({
    identity: WorkerRuntimeIdentitySchema,
    boundAt: timestampSchema,
  })
  .strict();
export type WorkerRuntimeBinding = z.infer<typeof WorkerRuntimeBindingSchema>;

export const WorkerRuntimeStartInputSchema = z
  .object({
    identity: WorkerRuntimeIdentitySchema,
    requestedAt: timestampSchema.optional(),
  })
  .strict();
export type WorkerRuntimeStartInput = z.infer<typeof WorkerRuntimeStartInputSchema>;

export const WorkerRuntimeStartResultSchema = z
  .object({
    binding: WorkerRuntimeBindingSchema,
  })
  .strict();
export type WorkerRuntimeStartResult = z.infer<typeof WorkerRuntimeStartResultSchema>;

export const WorkerRuntimeBindInputSchema = z
  .object({
    identity: WorkerRuntimeIdentitySchema,
    boundAt: timestampSchema.optional(),
  })
  .strict();
export type WorkerRuntimeBindInput = z.infer<typeof WorkerRuntimeBindInputSchema>;

export const WorkerRuntimeBindResultSchema = WorkerRuntimeStartResultSchema;
export type WorkerRuntimeBindResult = z.infer<typeof WorkerRuntimeBindResultSchema>;

export const WorkerRuntimeActivitySchema = z
  .object({
    kind: z.enum(WORKER_RUNTIME_ACTIVITY_KINDS),
    label: boundedLabelSchema.optional(),
  })
  .strict();
export type WorkerRuntimeActivity = z.infer<typeof WorkerRuntimeActivitySchema>;

export const WorkerRuntimeProgressSchema = z
  .object({
    completed: boundedTokenCountSchema,
    current: boundedLabelSchema.nullable(),
    remaining: boundedTokenCountSchema.nullable(),
  })
  .strict();
export type WorkerRuntimeProgress = z.infer<typeof WorkerRuntimeProgressSchema>;

/** Aggregate counters only; no content or provider payload is retained. */
export const WorkerRuntimeUsageSchema = z
  .object({
    inputTokens: boundedTokenCountSchema.optional(),
    outputTokens: boundedTokenCountSchema.optional(),
    totalTokens: boundedTokenCountSchema.optional(),
  })
  .strict();
export type WorkerRuntimeUsage = z.infer<typeof WorkerRuntimeUsageSchema>;

/** Context-window counters only; the context contents are outside this contract. */
export const WorkerRuntimeContextSchema = z
  .object({
    usedTokens: boundedTokenCountSchema.optional(),
    limitTokens: boundedTokenCountSchema.optional(),
  })
  .strict();
export type WorkerRuntimeContext = z.infer<typeof WorkerRuntimeContextSchema>;

export const WorkerRuntimeBlockerSchema = z
  .object({
    code: z.string().min(1).max(MAX_BLOCKER_CODE_LENGTH),
    detail: z.string().min(1).max(MAX_BLOCKER_DETAIL_LENGTH),
  })
  .strict();
export type WorkerRuntimeBlocker = z.infer<typeof WorkerRuntimeBlockerSchema>;

/**
 * Semantic status supplied by an adapter. It is intentionally bounded and
 * contains only lifecycle/progress/usage projections.
 */
export const WorkerRuntimeStatusReportInputSchema = z
  .object({
    lifecycleState: z.enum(WORKER_RUNTIME_LIFECYCLE_STATES),
    phase: z.enum(WORKER_RUNTIME_PHASES),
    activity: WorkerRuntimeActivitySchema,
    progress: WorkerRuntimeProgressSchema,
    attention: z.enum(WORKER_RUNTIME_ATTENTION_STATES),
    blocker: WorkerRuntimeBlockerSchema.optional(),
    usage: WorkerRuntimeUsageSchema.optional(),
    context: WorkerRuntimeContextSchema.optional(),
  })
  .strict();
export type WorkerRuntimeStatusReportInput = z.infer<typeof WorkerRuntimeStatusReportInputSchema>;

/** Canonical JSON Schema projection of WorkerRuntimeStatusReportInputSchema for provider tool registration. */
export const WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    lifecycleState: { type: "string", enum: WORKER_RUNTIME_LIFECYCLE_STATES },
    phase: { type: "string", enum: WORKER_RUNTIME_PHASES },
    activity: {
      type: "object",
      properties: {
        kind: { type: "string", enum: WORKER_RUNTIME_ACTIVITY_KINDS },
        label: { type: "string", minLength: 1, maxLength: MAX_LABEL_LENGTH },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    progress: {
      type: "object",
      properties: {
        completed: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
        current: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: MAX_LABEL_LENGTH },
            { type: "null" },
          ],
        },
        remaining: {
          anyOf: [
            { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
            { type: "null" },
          ],
        },
      },
      required: ["completed", "current", "remaining"],
      additionalProperties: false,
    },
    attention: { type: "string", enum: WORKER_RUNTIME_ATTENTION_STATES },
    blocker: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1, maxLength: MAX_BLOCKER_CODE_LENGTH },
        detail: { type: "string", minLength: 1, maxLength: MAX_BLOCKER_DETAIL_LENGTH },
      },
      required: ["code", "detail"],
      additionalProperties: false,
    },
    usage: {
      type: "object",
      properties: {
        inputTokens: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
        outputTokens: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
        totalTokens: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
      },
      additionalProperties: false,
    },
    context: {
      type: "object",
      properties: {
        usedTokens: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
        limitTokens: { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT },
      },
      additionalProperties: false,
    },
  },
  required: ["lifecycleState", "phase", "activity", "progress", "attention"],
  additionalProperties: false,
} as const;

export const WorkerRuntimeObservationSchema = z
  .object({
    binding: WorkerRuntimeBindingSchema,
    status: WorkerRuntimeStatusReportInputSchema,
    observedAt: timestampSchema,
  })
  .strict();
export type WorkerRuntimeObservation = z.infer<typeof WorkerRuntimeObservationSchema>;

const observationEventBaseSchema = {
  binding: WorkerRuntimeBindingSchema,
  observedAt: timestampSchema,
};

export const WorkerRuntimeObservationEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...observationEventBaseSchema, kind: z.literal("started") }).strict(),
  z.object({ ...observationEventBaseSchema, kind: z.literal("status"), status: WorkerRuntimeStatusReportInputSchema }).strict(),
  z.object({ ...observationEventBaseSchema, kind: z.literal("stopped"), reason: boundedLabelSchema.optional() }).strict(),
  z.object({ ...observationEventBaseSchema, kind: z.literal("failed"), blocker: WorkerRuntimeBlockerSchema }).strict(),
]);
export type WorkerRuntimeObservationEvent = z.infer<typeof WorkerRuntimeObservationEventSchema>;

export const WorkerRuntimeStopInputSchema = z
  .object({
    binding: WorkerRuntimeBindingSchema,
    reason: boundedLabelSchema.optional(),
  })
  .strict();
export type WorkerRuntimeStopInput = z.infer<typeof WorkerRuntimeStopInputSchema>;

export const WorkerRuntimeSteerInputSchema = z
  .object({
    binding: WorkerRuntimeBindingSchema,
    directive: boundedControlTextSchema,
  })
  .strict();
export type WorkerRuntimeSteerInput = z.infer<typeof WorkerRuntimeSteerInputSchema>;

export const WorkerRuntimeInputSchema = z
  .object({
    binding: WorkerRuntimeBindingSchema,
    input: boundedControlTextSchema,
  })
  .strict();
export type WorkerRuntimeInput = z.infer<typeof WorkerRuntimeInputSchema>;

export const WorkerRuntimeControlReceiptSchema = z
  .object({
    operation: z.enum(WORKER_RUNTIME_CONTROL_OPERATIONS),
    acceptedAt: timestampSchema,
  })
  .strict();
export type WorkerRuntimeControlReceipt = z.infer<typeof WorkerRuntimeControlReceiptSchema>;

export type WorkerRuntimeControl =
  | { operation: "start"; input: WorkerRuntimeStartInput }
  | { operation: "bind"; input: WorkerRuntimeBindInput }
  | { operation: "stop"; input: WorkerRuntimeStopInput }
  | { operation: "steer"; input: WorkerRuntimeSteerInput }
  | { operation: "input"; input: WorkerRuntimeInput };

/** Read-only observations: no lifecycle or input mutation operation is exposed. */
export interface WorkerRuntimeObservationPort {
  readonly observe: (binding: WorkerRuntimeBinding) => Promise<WorkerRuntimeObservation>;
  readonly events: (binding: WorkerRuntimeBinding) => AsyncIterable<WorkerRuntimeObservationEvent>;
}

/** Explicit mutation boundary for starting, binding, stopping, and directing a worker. */
export interface WorkerRuntimeControlPort {
  readonly start: (input: WorkerRuntimeStartInput) => Promise<WorkerRuntimeStartResult>;
  readonly bind: (input: WorkerRuntimeBindInput) => Promise<WorkerRuntimeBindResult>;
  readonly stop: (input: WorkerRuntimeStopInput) => Promise<WorkerRuntimeControlReceipt>;
  readonly steer: (input: WorkerRuntimeSteerInput) => Promise<WorkerRuntimeControlReceipt>;
  readonly sendInput: (input: WorkerRuntimeInput) => Promise<WorkerRuntimeControlReceipt>;
}

/** An adapter may implement both ports, while callers can depend on either one alone. */
export interface WorkerRuntimeAdapter extends WorkerRuntimeObservationPort, WorkerRuntimeControlPort {}
