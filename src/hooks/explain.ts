import fs from "node:fs";
import path from "node:path";
import type { ManagedCapabilityRegistry } from "./capabilities.js";
import { resolveHookMode } from "./policy.js";
import type { HookPolicy } from "./policy.js";
import type { HookDecision, HookEvent } from "./types.js";

export interface HookExplanation {
  decisionId: string;
  client: HookEvent["client"];
  operation: HookEvent["operation"];
  decision: HookDecision["decision"];
  reason: HookDecision["reason"];
  replacement?: string;
  mode: HookPolicy["mode"];
  effectiveMode: HookPolicy["mode"];
  capabilityAvailable: boolean;
  recordedAt: number;
  repository?: string;
}

export function explanationPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".mottainai", "hook-explanations.jsonl");
}

export function recordHookExplanation(
  workspaceRoot: string,
  event: HookEvent,
  decision: HookDecision,
  policy: HookPolicy,
  capabilities: ManagedCapabilityRegistry,
): void {
  if (decision.decisionId === undefined) return;
  const capability = capabilities.resolve(event.operation, event);
  const explanation: HookExplanation = {
    decisionId: decision.decisionId,
    client: event.client,
    operation: event.operation,
    decision: decision.decision,
    reason: decision.reason,
    ...(decision.replacement === undefined ? {} : { replacement: decision.replacement }),
    mode: policy.mode,
    effectiveMode: resolveHookMode(policy, event.operation),
    capabilityAvailable: capability?.available === true,
    recordedAt: Date.now(),
    ...(event.repository === undefined ? {} : { repository: event.repository.identity }),
  };
  const filePath = explanationPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prior = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).slice(-99) : [];
  prior.push(JSON.stringify(explanation));
  fs.writeFileSync(filePath, `${prior.join("\n")}\n`, { mode: 0o600 });
}

export function readHookExplanation(workspaceRoot: string, decisionId: string): HookExplanation | undefined {
  if (!/^hd_[a-f0-9]{16}$/u.test(decisionId)) return undefined;
  const filePath = explanationPath(workspaceRoot);
  if (!fs.existsSync(filePath)) return undefined;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as { decisionId?: unknown }).decisionId === decisionId) {
        return parsed as HookExplanation;
      }
    } catch {
      // A damaged explanation line is ignored; normal hook output remains bounded.
    }
  }
  return undefined;
}
