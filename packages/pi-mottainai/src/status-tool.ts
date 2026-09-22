import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerRuntimeStatusReportInput } from "./runtime.js";

export const REPORT_STATUS_TOOL_NAME = "report_status" as const;
export const REPORT_STATUS_ACKNOWLEDGEMENT = "status recorded" as const;

const MAX_LABEL_LENGTH = 256;
const MAX_BLOCKER_CODE_LENGTH = 128;
const MAX_BLOCKER_DETAIL_LENGTH = 512;
const MAX_TOKEN_COUNT = 1_000_000_000_000;

const LIFECYCLE_STATES = ["starting", "running", "paused", "completed", "failed", "stopped"] as const;
const PHASES = ["initializing", "ready", "executing", "waiting", "finalizing", "complete", "failed"] as const;
const ACTIVITY_KINDS = ["idle", "working", "waiting", "blocked", "finalizing"] as const;
const ATTENTION_STATES = ["none", "attention", "blocked"] as const;

type JsonSchema = {
  type?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  anyOf?: readonly JsonSchema[];
};

const stringSchema = (maxLength: number): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const integerSchema: JsonSchema = { type: "integer", minimum: 0, maximum: MAX_TOKEN_COUNT };
const nullableIntegerSchema: JsonSchema = { anyOf: [integerSchema, { type: "null" }] };
const nullableLabelSchema: JsonSchema = { anyOf: [stringSchema(MAX_LABEL_LENGTH), { type: "null" }] };

/** JSON Schema matching WorkerRuntimeStatusReportInputSchema from #947. */
export const REPORT_STATUS_PARAMETERS = {
  type: "object",
  properties: {
    lifecycleState: { type: "string", enum: LIFECYCLE_STATES },
    phase: { type: "string", enum: PHASES },
    activity: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ACTIVITY_KINDS },
        label: stringSchema(MAX_LABEL_LENGTH),
      },
      required: ["kind"],
      additionalProperties: false,
    },
    progress: {
      type: "object",
      properties: {
        completed: integerSchema,
        current: nullableLabelSchema,
        remaining: nullableIntegerSchema,
      },
      required: ["completed", "current", "remaining"],
      additionalProperties: false,
    },
    attention: { type: "string", enum: ATTENTION_STATES },
    blocker: {
      type: "object",
      properties: {
        code: stringSchema(MAX_BLOCKER_CODE_LENGTH),
        detail: stringSchema(MAX_BLOCKER_DETAIL_LENGTH),
      },
      required: ["code", "detail"],
      additionalProperties: false,
    },
    usage: {
      type: "object",
      properties: {
        inputTokens: integerSchema,
        outputTokens: integerSchema,
        totalTokens: integerSchema,
      },
      additionalProperties: false,
    },
    context: {
      type: "object",
      properties: {
        usedTokens: integerSchema,
        limitTokens: integerSchema,
      },
      additionalProperties: false,
    },
  },
  required: ["lifecycleState", "phase", "activity", "progress", "attention"],
  additionalProperties: false,
} as const;

/** A synchronous sink keeps report_status independent of orchestrator control. */
export type ReportStatusSink = (status: WorkerRuntimeStatusReportInput) => void;

export interface ReportStatusToolOptions {
  readonly onStatus: ReportStatusSink;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`report_status ${path} contains unsupported field "${key}"`);
  }
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`report_status ${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function enumValue<T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`report_status ${path} is not a supported value`);
  }
  return value as T[number];
}

function boundedInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_TOKEN_COUNT) {
    throw new Error(`report_status ${path} must be an integer from 0 to ${MAX_TOKEN_COUNT}`);
  }
  return value as number;
}

function parseStatus(input: unknown): WorkerRuntimeStatusReportInput {
  if (!isRecord(input)) throw new Error("report_status input must be an object");
  exactKeys(
    input,
    ["lifecycleState", "phase", "activity", "progress", "attention", "blocker", "usage", "context"],
    "input",
  );

  const activity = input.activity;
  if (!isRecord(activity)) throw new Error("report_status activity must be an object");
  exactKeys(activity, ["kind", "label"], "activity");
  const parsedActivity: WorkerRuntimeStatusReportInput["activity"] = {
    kind: enumValue(activity.kind, "activity.kind", ACTIVITY_KINDS),
    ...(activity.label === undefined
      ? {}
      : { label: boundedString(activity.label, "activity.label", MAX_LABEL_LENGTH) }),
  };

  const progress = input.progress;
  if (!isRecord(progress)) throw new Error("report_status progress must be an object");
  exactKeys(progress, ["completed", "current", "remaining"], "progress");
  const parsedProgress: WorkerRuntimeStatusReportInput["progress"] = {
    completed: boundedInteger(progress.completed, "progress.completed"),
    current: progress.current === null ? null : boundedString(progress.current, "progress.current", MAX_LABEL_LENGTH),
    remaining: progress.remaining === null ? null : boundedInteger(progress.remaining, "progress.remaining"),
  };

  const parsed: WorkerRuntimeStatusReportInput = {
    lifecycleState: enumValue(input.lifecycleState, "lifecycleState", LIFECYCLE_STATES),
    phase: enumValue(input.phase, "phase", PHASES),
    activity: parsedActivity,
    progress: parsedProgress,
    attention: enumValue(input.attention, "attention", ATTENTION_STATES),
  };

  if (input.blocker !== undefined) {
    if (!isRecord(input.blocker)) throw new Error("report_status blocker must be an object");
    exactKeys(input.blocker, ["code", "detail"], "blocker");
    parsed.blocker = {
      code: boundedString(input.blocker.code, "blocker.code", MAX_BLOCKER_CODE_LENGTH),
      detail: boundedString(input.blocker.detail, "blocker.detail", MAX_BLOCKER_DETAIL_LENGTH),
    };
  }

  if (input.usage !== undefined) {
    if (!isRecord(input.usage)) throw new Error("report_status usage must be an object");
    exactKeys(input.usage, ["inputTokens", "outputTokens", "totalTokens"], "usage");
    parsed.usage = {
      ...(input.usage.inputTokens === undefined
        ? {}
        : { inputTokens: boundedInteger(input.usage.inputTokens, "usage.inputTokens") }),
      ...(input.usage.outputTokens === undefined
        ? {}
        : { outputTokens: boundedInteger(input.usage.outputTokens, "usage.outputTokens") }),
      ...(input.usage.totalTokens === undefined
        ? {}
        : { totalTokens: boundedInteger(input.usage.totalTokens, "usage.totalTokens") }),
    };
  }

  if (input.context !== undefined) {
    if (!isRecord(input.context)) throw new Error("report_status context must be an object");
    exactKeys(input.context, ["usedTokens", "limitTokens"], "context");
    parsed.context = {
      ...(input.context.usedTokens === undefined
        ? {}
        : { usedTokens: boundedInteger(input.context.usedTokens, "context.usedTokens") }),
      ...(input.context.limitTokens === undefined
        ? {}
        : { limitTokens: boundedInteger(input.context.limitTokens, "context.limitTokens") }),
    };
  }

  return parsed;
}

/** Create the Mottainai-owned semantic progress tool. */
export function createReportStatusTool(options: ReportStatusToolOptions): ToolDefinition {
  return {
    name: REPORT_STATUS_TOOL_NAME,
    label: "Report status",
    description: "Report bounded semantic worker lifecycle, activity, and progress status.",
    promptSnippet: "Report explicit semantic progress to worker supervision.",
    parameters: REPORT_STATUS_PARAMETERS as unknown as ToolDefinition["parameters"],
    async execute(_toolCallId, params) {
      options.onStatus(parseStatus(params));
      return {
        content: [{ type: "text", text: REPORT_STATUS_ACKNOWLEDGEMENT }],
        details: { accepted: true },
      };
    },
  };
}

export { parseStatus as validateReportStatus };
