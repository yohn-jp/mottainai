import { createHash } from "node:crypto";
import type { ManagedCapabilityRegistry } from "./capabilities.js";
import { resolveFailureMode, resolveHookMode } from "./policy.js";
import type { HookPolicy } from "./policy.js";
import { composeHookDecision } from "./providers/composition.js";
import type { HookDecisionTrace } from "./providers/composition.js";
import type { HookPolicyProvider, HookProviderResult } from "./providers/types.js";
import {
  boundHookDecision,
  HOOK_CONTRACT_VERSION,
  type HookDecision,
  type HookEvent,
  type HookOperation,
} from "./types.js";

export interface HookDispatcherOptions {
  policy: HookPolicy;
  capabilities: ManagedCapabilityRegistry;
  now?: () => number;
  capabilityResolver?: (operation: HookOperation, event: HookEvent) => unknown | Promise<unknown>;
  providers?: readonly HookPolicyProvider[];
}

export interface HookDispatchOptions extends HookDispatcherOptions {
  /** Operation-independent timeout is fixed by policy; event metadata cannot change it. */
  timeoutMs?: number;
}

function decisionId(event: HookEvent, now: () => number): string {
  const identity = JSON.stringify({ event, at: now() });
  return `hd_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function baseDecision(event: HookEvent, options: HookDispatcherOptions): Pick<HookDecision, "version" | "decisionId"> {
  return { version: HOOK_CONTRACT_VERSION, decisionId: decisionId(event, options.now ?? Date.now) };
}

export function decideHook(event: HookEvent, options: HookDispatcherOptions): HookDecision {
  const base = baseDecision(event, options);
  const mode = resolveHookMode(options.policy, event.operation);
  const capability = options.capabilities.resolve(event.operation, event);
  // The replacement itself is already inside the managed capability boundary.
  // This marker is produced only by the adapter for the registered Mottainai
  // MCP tool; unknown client tools remain governed as native process calls.
  if (
    event.operation === "process.exec" &&
    event.metadata?.boundary === "managed-capability" &&
    event.metadata.managedPath === true &&
    capability?.available === true &&
    capability.replacement.trim() !== ""
  ) {
    return boundHookDecision({ ...base, decision: "allow", reason: "managed_capability_path" });
  }

  if (capability?.available !== true || capability.replacement.trim() === "") {
    const closed = resolveFailureMode(options.policy, event.operation) === "closed";
    return boundHookDecision({
      ...base,
      decision: closed ? "deny" : "allow",
      reason: event.operation === "other" ? "unsupported_operation" : "managed_capability_unavailable",
      diagnostic: closed ? "failure_mode=closed" : "failure_mode=open",
    });
  }
  if (mode === "observe")
    return boundHookDecision({
      ...base,
      decision: "allow",
      reason: "observe_only",
      replacement: capability.replacement,
    });
  if (mode === "warn")
    return boundHookDecision({
      ...base,
      decision: "warn",
      reason: "managed_capability_available",
      replacement: capability.replacement,
    });
  return boundHookDecision({
    ...base,
    decision: "redirect",
    reason: "managed_capability_available",
    replacement: capability.replacement,
  });
}

function failureDecision(
  event: HookEvent,
  options: HookDispatcherOptions,
  reason: "hook_timeout" | "hook_error",
): HookDecision {
  const closed = resolveFailureMode(options.policy, event.operation) === "closed";
  return boundHookDecision({
    ...baseDecision(event, options),
    decision: closed ? "deny" : "allow",
    reason,
    diagnostic: closed ? "failure_mode=closed" : "failure_mode=open",
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hook timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One decision path used by both client adapters. */
export async function dispatchHook(event: HookEvent, options: HookDispatchOptions): Promise<HookDecision> {
  const result = await dispatchHookDetailed(event, options);
  return result.decision;
}

function providerFailure(provider: HookPolicyProvider): HookProviderResult {
  return {
    provider: provider.provider,
    state: "unavailable",
    reason: "provider_unavailable",
    diagnostic: "provider_error",
  };
}

async function evaluateProvider(provider: HookPolicyProvider, event: HookEvent): Promise<HookProviderResult> {
  try {
    const result = await provider.evaluate(event);
    return result.provider === provider.provider ? result : providerFailure(provider);
  } catch {
    return providerFailure(provider);
  }
}

/** Dispatch with compact provider evidence for explanation and privacy-safe telemetry. */
export async function dispatchHookDetailed(event: HookEvent, options: HookDispatchOptions): Promise<HookDecisionTrace> {
  const baseline = decideHook(event, options);
  try {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? options.policy.timeoutMs, 1), options.policy.timeoutMs);
    const providerResults = await withTimeout(
      Promise.all([
        ...(options.capabilityResolver === undefined
          ? []
          : [Promise.resolve(options.capabilityResolver(event.operation, event)).then(() => undefined)]),
        ...(options.providers ?? []).map((provider) => evaluateProvider(provider, event)),
      ]),
      timeoutMs,
    );
    const providers = providerResults.filter((result): result is HookProviderResult => result !== undefined);
    return composeHookDecision(baseline, providers);
  } catch (error) {
    return {
      baseline,
      decision: failureDecision(
        event,
        options,
        error instanceof Error && error.message === "hook timeout" ? "hook_timeout" : "hook_error",
      ),
      providers: [],
    };
  }
}
