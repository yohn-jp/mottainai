import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WorkerRuntimeStatusReportInput } from "mottainai/worker-runtime";

const MAX_LABEL_LENGTH = 256;

export type WorkerRuntimeStatusPatch = Pick<WorkerRuntimeStatusReportInput, "lifecycleState" | "phase" | "activity">;

function boundedToolLabel(toolName: unknown): string {
  const label = typeof toolName === "string" && toolName.length > 0 ? toolName : "tool";
  return label.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Project Pi's mechanical lifecycle notifications into bounded status fields.
 * Event payloads are deliberately not returned: message, reasoning, and tool
 * result bodies never cross the provider-neutral observation boundary.
 */
export function mapPiAgentEvent(event: AgentSessionEvent): WorkerRuntimeStatusPatch | undefined {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "bash_execution_update":
      return { lifecycleState: "running", phase: "executing", activity: { kind: "working" } };
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return {
        lifecycleState: "running",
        phase: "executing",
        activity: { kind: "working", label: boundedToolLabel(event.toolName) },
      };
    case "agent_end":
      return { lifecycleState: "running", phase: "waiting", activity: { kind: "waiting" } };
    case "agent_settled":
      return { lifecycleState: "completed", phase: "complete", activity: { kind: "idle" } };
    case "queue_update":
      return {
        lifecycleState: "running",
        phase: "waiting",
        activity: { kind: event.steering.length + event.followUp.length > 0 ? "waiting" : "idle" },
      };
    case "compaction_start":
    case "summarization_retry_attempt_start":
      return { lifecycleState: "running", phase: "finalizing", activity: { kind: "finalizing" } };
    case "compaction_end":
    case "auto_retry_end":
      return { lifecycleState: "running", phase: "ready", activity: { kind: "idle" } };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return { lifecycleState: "running", phase: "waiting", activity: { kind: "waiting" } };
    case "summarization_retry_finished":
      return { lifecycleState: "running", phase: "ready", activity: { kind: "idle" } };
    default:
      return undefined;
  }
}
