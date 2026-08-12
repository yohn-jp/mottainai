/**
 * Semantic intent stays in Mottainai.  This type is deliberately independent
 * of Nawabari's CLI/domain types; only the concrete declaration projection is
 * sent across the companion boundary.
 */

export const SEMANTIC_EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;

export type SemanticExecutionTargetKind = "symbol" | "component" | "path";

export interface SemanticExecutionTarget {
  kind: SemanticExecutionTargetKind;
  id: string;
  paths?: readonly string[];
}

export interface ExecutionClaim {
  resource: string;
  mode: "read" | "write" | "exclusive-write";
}

export interface ClaimGenerationProvenance {
  strategy: "declared" | "conservative-broad" | "blocked";
  reason: string;
  source: "repository-semantics" | "explicit-paths" | "explicit-claims" | "unknown-scope";
  warnings: readonly string[];
}

export interface VerificationIntent {
  requiredChecks: readonly string[];
  rationale: string;
}

export interface SemanticExecutionPlan {
  schemaVersion: typeof SEMANTIC_EXECUTION_PLAN_SCHEMA_VERSION;
  semanticTargets: readonly SemanticExecutionTarget[];
  claims: readonly ExecutionClaim[];
  claimGeneration: ClaimGenerationProvenance;
  verification: VerificationIntent;
}

export interface CreateSemanticExecutionPlanInput {
  semanticTargets?: readonly SemanticExecutionTarget[];
  explicitPaths?: readonly string[];
  claims?: readonly ExecutionClaim[];
  verification?: Partial<VerificationIntent>;
  /** Strict mode blocks when semantic ownership cannot produce a bounded claim. */
  strict?: boolean;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizePath).filter((value) => value.length > 0))].sort();
}

function normalizeClaims(claims: readonly ExecutionClaim[]): ExecutionClaim[] {
  const seen = new Map<string, ExecutionClaim>();
  for (const claim of claims) {
    const resource = normalizePath(claim.resource);
    if (resource.length === 0) continue;
    const key = `${resource}\u0000${claim.mode}`;
    if (!seen.has(key)) seen.set(key, { resource, mode: claim.mode });
  }
  return [...seen.values()].sort((left, right) =>
    `${left.resource}\u0000${left.mode}`.localeCompare(`${right.resource}\u0000${right.mode}`),
  );
}

/**
 * Build the only Mottainai-owned execution intent. Unknown semantic scope is
 * never narrowed to a guessed path: it is either represented by an explicit
 * broad claim with provenance or blocked in strict mode.
 */
export function createSemanticExecutionPlan(input: CreateSemanticExecutionPlanInput = {}): SemanticExecutionPlan {
  const semanticTargets = [...(input.semanticTargets ?? [])];
  const explicitPaths = unique(input.explicitPaths ?? []);
  const suppliedClaims = normalizeClaims(input.claims ?? []);
  const semanticPaths = unique(semanticTargets.flatMap((target) => target.paths ?? []));
  const declaredPaths = unique([...explicitPaths, ...semanticPaths]);
  const warnings: string[] = [];

  let claims: ExecutionClaim[];
  let provenance: ClaimGenerationProvenance;
  if (declaredPaths.length > 0) {
    // Explicit claims never suppress paths supplied by Repository Semantics.
    // If the two declarations disagree, Nawabari receives the non-narrowed
    // union and can reject contradictory modes deterministically.
    const derivedClaims = declaredPaths.map((resource) => ({ resource, mode: "exclusive-write" as const }));
    claims = normalizeClaims(suppliedClaims.length > 0 ? [...suppliedClaims, ...derivedClaims] : derivedClaims);
    provenance = {
      strategy: "declared",
      reason: "claims were derived from declared semantic or explicit path scope",
      source: semanticPaths.length > 0 ? "repository-semantics" : "explicit-paths",
      warnings,
    };
  } else if (suppliedClaims.length > 0) {
    // A caller-supplied claim is already a concrete declaration. Do not add an
    // implicit exclusive-write claim for the same resource: doing so would
    // silently escalate a deliberate read-only control-plane declaration.
    claims = suppliedClaims;
    provenance = {
      strategy: "declared",
      reason: "claims were supplied explicitly by task orchestration",
      source: "explicit-claims",
      warnings,
    };
  } else if (input.strict === true) {
    claims = [];
    warnings.push("semantic scope is incomplete; strict managed execution is blocked");
    provenance = {
      strategy: "blocked",
      reason: "no declared semantic/path scope was available",
      source: "unknown-scope",
      warnings,
    };
  } else {
    claims = [{ resource: "**", mode: "exclusive-write" }];
    warnings.push("semantic scope is incomplete; using an explicit repository-wide conservative claim");
    provenance = {
      strategy: "conservative-broad",
      reason: "unknown semantic ownership must not be silently under-claimed",
      source: "unknown-scope",
      warnings,
    };
  }

  return {
    schemaVersion: SEMANTIC_EXECUTION_PLAN_SCHEMA_VERSION,
    semanticTargets,
    claims,
    claimGeneration: provenance,
    verification: {
      requiredChecks: unique(input.verification?.requiredChecks ?? []),
      rationale: input.verification?.rationale?.trim() || "verification remains a Mottainai semantic/task decision",
    },
  };
}

export interface NawabariDeclaration {
  schemaVersion: 1;
  contractId: "nawabari.standalone-execution.v1";
  branch: string;
  base: string;
  claims: readonly ExecutionClaim[];
}

/** Project only concrete local execution data; semantic labels never cross this boundary. */
export function projectNawabariDeclaration(input: {
  plan: SemanticExecutionPlan;
  branch: string;
  base?: string;
}): NawabariDeclaration {
  if (input.plan.claimGeneration.strategy === "blocked")
    throw new Error(`semantic execution plan is blocked: ${input.plan.claimGeneration.reason}`);
  return {
    schemaVersion: 1,
    contractId: "nawabari.standalone-execution.v1",
    branch: input.branch,
    base: input.base ?? "HEAD",
    claims: input.plan.claims,
  };
}
