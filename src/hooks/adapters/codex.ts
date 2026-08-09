import { normalizeClientEvent, supportsHookDocument } from "./common.js";
import path from "node:path";
import type { HookClientAdapter } from "./types.js";
import type { HookDecision } from "../types.js";

function decisionToken(decision: HookDecision): string {
  const token = decision.replacement === undefined ? decision.reason : `${decision.reason};use=${decision.replacement}`;
  return decision.decisionId === undefined ? token : `${token};id=${decision.decisionId}`;
}

function response(decision: HookDecision): string {
  return JSON.stringify({
    decision: decision.decision === "redirect" ? "deny" : decision.decision,
    reason: decisionToken(decision),
    ...(decision.replacement === undefined ? {} : { replacement: decision.replacement }),
    ...(decision.decisionId === undefined ? {} : { decisionId: decision.decisionId }),
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
    if (decision.decision === "warn") return { exitCode: 0, stdout: response(decision), stderr: "" };
    return { exitCode: 2, stdout: response(decision), stderr: "" };
  },
  supportsDocument: supportsHookDocument,
};
