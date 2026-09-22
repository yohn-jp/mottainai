import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapPiAgentEvent } from "./events.js";

test("maps lifecycle events to bounded provider-neutral status", () => {
  assert.deepEqual(mapPiAgentEvent({ type: "agent_start" }), {
    lifecycleState: "running",
    phase: "executing",
    activity: { kind: "working" },
  });
  assert.deepEqual(mapPiAgentEvent({ type: "agent_settled" }), {
    lifecycleState: "completed",
    phase: "complete",
    activity: { kind: "idle" },
  });
  assert.deepEqual(mapPiAgentEvent({ type: "queue_update", steering: [], followUp: [] }), {
    lifecycleState: "running",
    phase: "waiting",
    activity: { kind: "idle" },
  });
});

test("maps tool start and end without exposing arguments or result bodies", () => {
  const start = mapPiAgentEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "secret.txt" },
  });
  const end = mapPiAgentEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "private body" }] },
    isError: false,
  });

  assert.deepEqual(start, {
    lifecycleState: "running",
    phase: "executing",
    activity: { kind: "working", label: "read" },
  });
  assert.deepEqual(end, start);
  assert.equal(JSON.stringify(end).includes("private body"), false);
  assert.equal(JSON.stringify(end).includes("secret.txt"), false);
});

test("bounds untrusted tool names and ignores transcript-bearing events", () => {
  const event: AgentSessionEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "x".repeat(1_000),
    args: { reasoning: "private chain of thought" },
  };
  const mapped = mapPiAgentEvent(event);
  assert.equal(mapped?.activity.label?.length, 256);
  assert.equal(JSON.stringify(mapped).includes("reasoning"), false);
});
