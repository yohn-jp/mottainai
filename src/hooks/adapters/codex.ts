import { normalizeClientEvent, supportsHookDocument } from "./common.js";
import path from "node:path";
import type { HookClientAdapter } from "./types.js";
import type { HookDecision } from "../types.js";

function decisionToken(decision: HookDecision): string {
  const token = decision.replacement === undefined ? decision.reason : `${decision.reason};use=${decision.replacement}`;
  return decision.decisionId === undefined ? token : `${token};id=${decision.decisionId}`;
}

function response(decision: HookDecision): string {
  const token = decisionToken(decision);
  if (decision.decision === "warn") return JSON.stringify({ systemMessage: token });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: token,
    },
  });
}

export const codexAdapter: HookClientAdapter = {
  client: "codex",
  adapterVersion: "1",
  configRelativePath: ".codex/hooks.json",
  eventName: "PreToolUse",
  matcher: ".*",
  configPath: ({ workspaceRoot }) => path.join(workspaceRoot, ".codex", "hooks.json"),
  normalize: (raw, context) => normalizeClientEvent(raw, "codex", context),
  project: (decision) => {
    if (decision.decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
    // Codex parses PreToolUse decisions from stdout. Keep the process successful
    // so a structured deny is not converted into a generic hook failure.
    return { exitCode: 0, stdout: response(decision), stderr: "" };
  },
  supportsDocument: supportsHookDocument,
};
