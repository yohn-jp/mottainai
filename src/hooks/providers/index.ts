import type { ReadGovernorPolicy } from "../../context-runtime/read-policy.js";
import type { HookPolicyProvider } from "./types.js";
import { createContextReadPolicyProvider } from "./context.js";
import { createSemanticPolicyProvider } from "./semantic.js";

export type { HookDecisionTrace } from "./composition.js";
export { composeHookDecision } from "./composition.js";
export { createContextReadPolicyProvider } from "./context.js";
export { createSemanticPolicyProvider } from "./semantic.js";
export type { HookPolicyProvider, HookProviderResult } from "./types.js";

export interface HookProviderFactoryOptions {
  workspaceRoot: string;
  readPolicy?: ReadGovernorPolicy;
  workflowProvider?: HookPolicyProvider;
}

export function createHookPolicyProviders(options: HookProviderFactoryOptions): readonly HookPolicyProvider[] {
  return [
    ...(options.workflowProvider === undefined ? [] : [options.workflowProvider]),
    createContextReadPolicyProvider({ workspaceRoot: options.workspaceRoot, readPolicy: options.readPolicy }),
    createSemanticPolicyProvider(),
  ];
}
