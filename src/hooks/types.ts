/**
 * Transport-independent contracts for the managed hook boundary.
 * Client payloads must be converted to these values before policy is applied.
 */

export const HOOK_CONTRACT_VERSION = 1 as const;
export const HOOK_DECISION_MAX_BYTES = 512;
export const HOOK_REASON_MAX_LENGTH = 64;
export const HOOK_REPLACEMENT_MAX_LENGTH = 96;
export const HOOK_DIAGNOSTIC_MAX_LENGTH = 160;

export type HookClient = "claude" | "codex";

export type HookOperation =
  | "source.read"
  | "source.search"
  | "source.write"
  | "process.exec"
  | "git.mutate"
  | "other";

export type HookRolloutMode = "observe" | "warn" | "enforce";
export type HookFailureMode = "open" | "closed";
export type HookDecisionKind = "allow" | "warn" | "deny" | "redirect";

export type HookReasonCode =
  | "managed_capability_available"
  | "managed_capability_unavailable"
  | "observe_only"
  | "unsupported_operation"
  | "malformed_client_event"
  | "invalid_event"
  | "repository_unavailable"
  | "hook_timeout"
  | "hook_error"
  | "policy_invalid"
  | "adapter_unsupported";

export interface HookRepository {
  /** Real path derived by Mottainai, never copied from an untrusted event field. */
  root: string;
  /** Stable non-secret identity for diagnostics and explanation lookup. */
  identity: string;
}

export interface HookWorktree {
  root: string;
  branch?: string;
}

export interface HookTarget {
  kind: "path" | "command" | "resource" | "unknown";
  value?: string;
}

export interface HookEvent {
  version: typeof HOOK_CONTRACT_VERSION;
  client: HookClient;
  clientEvent: string;
  operation: HookOperation;
  repository?: HookRepository;
  worktree?: HookWorktree;
  target?: HookTarget;
  /** Adapter-selected, bounded metadata only. Raw client payloads do not cross this boundary. */
  metadata?: Record<string, string | number | boolean>;
}

export interface HookDecision {
  version: typeof HOOK_CONTRACT_VERSION;
  decision: HookDecisionKind;
  /** Stable, compact reason code. It is intentionally not prose. */
  reason: HookReasonCode;
  replacement?: string;
  decisionId?: string;
  /** Bounded diagnostic for an explicit explanation path, not raw subprocess output. */
  diagnostic?: string;
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "…";
  if (maximumBytes < Buffer.byteLength(suffix, "utf8")) {
    let prefix = "";
    for (const character of value) {
      if (Buffer.byteLength(prefix + character, "utf8") > maximumBytes) break;
      prefix += character;
    }
    return prefix;
  }
  const budget = Math.max(0, maximumBytes - Buffer.byteLength(suffix, "utf8"));
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > budget) break;
    result += character;
  }
  return result + suffix;
}

/** Keep ordinary hook output small even when an adapter or future policy adds fields. */
export function boundHookDecision(decision: HookDecision, maximumBytes = HOOK_DECISION_MAX_BYTES): HookDecision {
  const boundedDecision: HookDecision = {
    version: HOOK_CONTRACT_VERSION,
    decision: decision.decision,
    reason: bounded(decision.reason, HOOK_REASON_MAX_LENGTH) as HookReasonCode,
    ...(bounded(decision.replacement, HOOK_REPLACEMENT_MAX_LENGTH) === undefined
      ? {}
      : { replacement: bounded(decision.replacement, HOOK_REPLACEMENT_MAX_LENGTH) }),
    ...(bounded(decision.decisionId, 80) === undefined ? {} : { decisionId: bounded(decision.decisionId, 80) }),
    ...(bounded(decision.diagnostic, HOOK_DIAGNOSTIC_MAX_LENGTH) === undefined
      ? {}
      : { diagnostic: bounded(decision.diagnostic, HOOK_DIAGNOSTIC_MAX_LENGTH) }),
  };
  if (Buffer.byteLength(JSON.stringify(boundedDecision), "utf8") <= maximumBytes) return boundedDecision;
  return {
    version: HOOK_CONTRACT_VERSION,
    decision: boundedDecision.decision,
    reason: boundedDecision.reason,
  };
}

export function serializeHookDecision(decision: HookDecision, maximumBytes = HOOK_DECISION_MAX_BYTES): string {
  if (maximumBytes <= 0) return "";
  const boundedDecision = boundHookDecision(decision, maximumBytes);
  const serialized = JSON.stringify(boundedDecision);
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return serialized;
  return boundHookText(
    JSON.stringify({ version: HOOK_CONTRACT_VERSION, decision: boundedDecision.decision, reason: boundedDecision.reason }),
    maximumBytes,
  );
}

export function boundHookText(value: string, maximumBytes: number): string {
  const limit = Number.isFinite(maximumBytes) ? Math.max(0, Math.floor(maximumBytes)) : 0;
  return truncateUtf8(value, limit);
}

export function isHookOperation(value: unknown): value is HookOperation {
  return value === "source.read"
    || value === "source.search"
    || value === "source.write"
    || value === "process.exec"
    || value === "git.mutate"
    || value === "other";
}
