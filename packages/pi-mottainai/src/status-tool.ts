import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA,
  WorkerRuntimeStatusReportInputSchema,
  type WorkerRuntimeStatusReportInput,
} from "mottainai/worker-runtime";

export const REPORT_STATUS_TOOL_NAME = "report_status" as const;
export const REPORT_STATUS_ACKNOWLEDGEMENT = "status recorded" as const;

/** Canonical tool parameters are projected directly from Mottainai's worker-runtime contract. */
export const REPORT_STATUS_PARAMETERS = WORKER_RUNTIME_STATUS_REPORT_JSON_SCHEMA;

/** A synchronous sink keeps report_status independent of orchestrator control. */
export type ReportStatusSink = (status: WorkerRuntimeStatusReportInput) => void;

export interface ReportStatusToolOptions {
  readonly onStatus: ReportStatusSink;
}

/** Validate through the single Mottainai-owned runtime schema. */
export function validateReportStatus(input: unknown): WorkerRuntimeStatusReportInput {
  const parsed = WorkerRuntimeStatusReportInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "input";
  throw new Error(`report_status ${path}: ${issue?.message ?? "invalid status"}`);
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
      options.onStatus(validateReportStatus(params));
      return {
        content: [{ type: "text", text: REPORT_STATUS_ACKNOWLEDGEMENT }],
        details: { accepted: true },
      };
    },
  };
}
