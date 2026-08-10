import { SEMANTIC_ENFORCEMENT_MODES, type SemanticEnforcementMode } from "./types.js";

export const SEMANTIC_ENFORCEMENT_ENV = "MOTTAINAI_SEMANTIC_ENFORCEMENT" as const;

export function parseSemanticEnforcementMode(value: string | undefined): SemanticEnforcementMode {
  if (value === undefined || value.trim() === "") return "off";
  const normalized = value.trim().toLowerCase();
  if ((SEMANTIC_ENFORCEMENT_MODES as readonly string[]).includes(normalized))
    return normalized as SemanticEnforcementMode;
  throw new Error(`invalid semantic enforcement mode: ${value} (expected ${SEMANTIC_ENFORCEMENT_MODES.join("|")})`);
}

export function configuredSemanticEnforcementMode(environment: NodeJS.ProcessEnv = {}): SemanticEnforcementMode {
  return parseSemanticEnforcementMode(environment[SEMANTIC_ENFORCEMENT_ENV]);
}

export function semanticDecision(
  mode: SemanticEnforcementMode,
  blockerCount: number,
  warningCount: number,
): "allow" | "observe" | "warn" | "block" {
  if (mode === "off") return "allow";
  if (mode === "observe") return blockerCount > 0 || warningCount > 0 ? "observe" : "allow";
  if (mode === "warn") return blockerCount > 0 || warningCount > 0 ? "warn" : "allow";
  return blockerCount > 0 ? "block" : warningCount > 0 ? "warn" : "allow";
}
