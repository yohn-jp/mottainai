import type { HookEvent } from "../types.js";
import type { HookPolicyProvider, HookProviderResult } from "./types.js";

/**
 * The current main baseline exposes semantic mutation/validation services, but no
 * repository-bound fresh pre-operation decision provider. Keep that gap explicit;
 * this adapter must not infer semantic scope from hook paths or source text.
 */
export function createSemanticPolicyProvider(): HookPolicyProvider {
  return {
    provider: "semantic",
    evaluate(event: HookEvent): HookProviderResult {
      if (event.operation !== "source.write" && event.operation !== "git.mutate") {
        return { provider: "semantic", state: "not_applicable", reason: "unsupported_operation" };
      }
      return {
        provider: "semantic",
        state: "unavailable",
        reason: "semantic_authority_unavailable",
        rule: "repository-semantics.fresh-pre-operation",
        diagnostic: "fresh_decision_unavailable",
      };
    },
  };
}
