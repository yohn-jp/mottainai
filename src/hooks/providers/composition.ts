import { boundHookDecision, type HookDecision, type HookEvent, type HookProviderName } from "../types.js";
import type { HookProviderResult } from "./types.js";

export interface HookDecisionTrace {
  baseline: HookDecision;
  decision: HookDecision;
  providers: readonly HookProviderResult[];
}

const PROVIDER_ORDER: readonly HookProviderName[] = ["generic", "workflow", "context", "semantic"];
const DECISION_STRENGTH: Record<HookDecision["decision"], number> = {
  allow: 1,
  warn: 2,
  redirect: 3,
  deny: 4,
};

function providerRank(provider: HookProviderName): number {
  return PROVIDER_ORDER.indexOf(provider);
}

function actionFor(result: HookProviderResult): HookDecision["decision"] {
  return result.action ?? "allow";
}

function candidateFor(result: HookProviderResult, baseline: HookDecision): HookDecision | undefined {
  if (result.state !== "authoritative") return undefined;
  return boundHookDecision({
    version: baseline.version,
    decision: actionFor(result),
    reason: result.reason,
    // A domain blocker still needs to point at the already-resolved managed
    // operation when generic anti-bypass found one. Providers may replace it
    // with a more specific capability, but must not erase a usable remedy.
    ...(result.replacement === undefined && baseline.replacement === undefined
      ? {}
      : { replacement: result.replacement ?? baseline.replacement }),
    ...(baseline.decisionId === undefined ? {} : { decisionId: baseline.decisionId }),
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    provider: result.provider,
    ...(result.rule === undefined ? {} : { rule: result.rule }),
    providerState: result.state,
  });
}

function nonAuthoritativeCandidate(result: HookProviderResult, baseline: HookDecision): HookDecision | undefined {
  if (result.state === "not_applicable" || result.state === "authoritative") return undefined;
  // An unavailable/stale provider is never turned into an authoritative allow. It is
  // surfaced only when no stronger generic/provider decision already blocks the event.
  if (DECISION_STRENGTH[baseline.decision] > DECISION_STRENGTH.allow) return undefined;
  return boundHookDecision({
    ...baseline,
    reason: result.reason,
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    provider: result.provider,
    ...(result.rule === undefined ? {} : { rule: result.rule }),
    providerState: result.state,
  });
}

function shouldReplace(current: HookDecision, candidate: HookDecision): boolean {
  const currentStrength = DECISION_STRENGTH[current.decision];
  const candidateStrength = DECISION_STRENGTH[candidate.decision];
  if (candidateStrength !== currentStrength) return candidateStrength > currentStrength;
  if ((current.provider ?? "generic") === "generic" && candidate.provider !== undefined) return true;
  const currentRank = providerRank(current.provider ?? "generic");
  const candidateRank = providerRank(candidate.provider ?? "generic");
  return candidateRank < currentRank;
}

/** Deterministic strongest-decision composition for generic and domain authorities. */
export function composeHookDecision(
  baseline: HookDecision,
  providerResults: readonly HookProviderResult[],
): HookDecisionTrace {
  let selected = boundHookDecision(baseline);
  const ordered = [...providerResults].sort((left, right) => {
    const rank = providerRank(left.provider) - providerRank(right.provider);
    return rank !== 0 ? rank : left.reason.localeCompare(right.reason);
  });

  for (const result of ordered) {
    const candidate = candidateFor(result, baseline) ?? nonAuthoritativeCandidate(result, baseline);
    if (candidate !== undefined && shouldReplace(selected, candidate)) selected = candidate;
  }

  return { baseline: boundHookDecision(baseline), decision: boundHookDecision(selected), providers: ordered };
}
