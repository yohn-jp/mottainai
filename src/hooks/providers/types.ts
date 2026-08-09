import type {
  HookDecisionKind,
  HookEvent,
  HookProviderName,
  HookProviderState,
  HookReasonCode,
} from "../types.js";

/** A provider result contains identifiers only; client payloads never cross this boundary. */
export interface HookProviderResult {
  provider: Exclude<HookProviderName, "generic">;
  state: HookProviderState;
  reason: HookReasonCode;
  action?: HookDecisionKind;
  replacement?: string;
  rule?: string;
  diagnostic?: string;
}
export interface HookPolicyProvider {
  readonly provider: Exclude<HookProviderName, "generic">;
  evaluate(event: HookEvent): HookProviderResult | Promise<HookProviderResult>;
}
