import { normalizeClientEvent, supportsHookDocument } from "./common.js";
import path from "node:path";
import type { HookClientAdapter } from "./types.js";
import type { HookDecision } from "../types.js";

function decisionToken(decision: HookDecision): string {
  const token = decision.replacement === undefined ? decision.reason : `${decision.reason};use=${decision.replacement}`;
  return decision.decisionId === undefined ? token : `${token};id=${decision.decisionId}`;
}

function jsonResponse(eventName: string, decision: HookDecision, permissionDecision: "ask" | "deny"): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision,
      permissionDecisionReason: decisionToken(decision),
    },
  });
}

export const claudeAdapter: HookClientAdapter = {
  client: "claude",
  adapterVersion: "1",
  configRelativePath: ".claude/settings.json",
  eventName: "PreToolUse",
  matcher: ".*",
  configPath: ({ workspaceRoot }) => path.join(workspaceRoot, ".claude", "settings.json"),
  normalize: (raw, context) => normalizeClientEvent(raw, "claude", context),
  project: (decision, event) => {
    if (decision.decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
    if (decision.decision === "warn") {
      return { exitCode: 0, stdout: jsonResponse(event.clientEvent, decision, "ask"), stderr: "" };
    }
    // Exit 2 is the portable Claude command-hook blocking semantic. Keep stderr compact.
    return { exitCode: 2, stdout: "", stderr: `${decision.decision.toUpperCase()} ${decisionToken(decision)}\n` };
  },
  supportsDocument: supportsHookDocument,
};
