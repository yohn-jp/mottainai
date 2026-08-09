import fs from "node:fs";
import path from "node:path";
import type { ManagedCapabilityRegistry } from "./capabilities.js";
import { resolveHookMode } from "./policy.js";
import type { HookPolicy } from "./policy.js";
import type { HookDecision, HookEvent } from "./types.js";
import type { HookProviderResult } from "./providers/types.js";

const EXPLANATION_RETENTION = 100;
const EXPLANATION_LOCK_ATTEMPTS = 200;
const EXPLANATION_LOCK_WAIT_MS = 5;

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
  provider?: HookDecision["provider"];
  providerState?: HookDecision["providerState"];
  rule?: string;
  providers?: readonly HookProviderEvidence[];
  recordedAt: number;
  repository?: string;
}

export interface HookProviderEvidence {
  provider: HookProviderResult["provider"];
  state: HookProviderResult["state"];
  reason: HookProviderResult["reason"];
  action?: HookProviderResult["action"];
  rule?: string;
}

export function explanationPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".mottainai", "hook-explanations.jsonl");
}

function withExplanationLock<T>(filePath: string, operation: () => T): T {
  const lockPath = `${filePath}.lock`;
  let lock: number | undefined;
  for (let attempt = 0; attempt < EXPLANATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXPLANATION_LOCK_WAIT_MS);
    }
  }
  if (lock === undefined) throw new Error("explanation log is busy");
  try {
    return operation();
  } finally {
    fs.closeSync(lock);
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function trimExplanations(filePath: string): void {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean);
  if (lines.length <= EXPLANATION_RETENTION) return;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, `${lines.slice(-EXPLANATION_RETENTION).join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function recordHookExplanation(
  workspaceRoot: string,
  event: HookEvent,
  decision: HookDecision,
  policy: HookPolicy,
  capabilities: ManagedCapabilityRegistry,
  providerResults: readonly HookProviderResult[] = [],
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
    ...(decision.provider === undefined ? {} : { provider: decision.provider }),
    ...(decision.providerState === undefined ? {} : { providerState: decision.providerState }),
    ...(decision.rule === undefined ? {} : { rule: decision.rule }),
    ...(providerResults.length === 0 ? {} : {
      providers: providerResults.map((result) => ({
        provider: result.provider,
        state: result.state,
        reason: result.reason,
        ...(result.action === undefined ? {} : { action: result.action }),
        ...(result.rule === undefined ? {} : { rule: result.rule }),
      })),
    }),
    recordedAt: Date.now(),
    ...(event.repository === undefined ? {} : { repository: event.repository.identity }),
  };
  const filePath = explanationPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withExplanationLock(filePath, () => {
    fs.appendFileSync(filePath, `${JSON.stringify(explanation)}\n`, { mode: 0o600, flag: "a" });
    trimExplanations(filePath);
  });
}

export function readHookExplanation(workspaceRoot: string, decisionId: string): HookExplanation | undefined {
  if (!/^hd_[a-f0-9]{16}$/u.test(decisionId)) return undefined;
  const filePath = explanationPath(workspaceRoot);
  if (!fs.existsSync(filePath)) return undefined;
  return withExplanationLock(filePath, () => {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as { decisionId?: unknown }).decisionId === decisionId
        ) {
          return parsed as HookExplanation;
        }
      } catch {
        // A damaged explanation line is ignored; normal hook output remains bounded.
      }
    }
    return undefined;
  });
}
