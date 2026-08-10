import type { ProjectionBudget, ProjectionBudgetConfig } from "../../context-runtime/types.js";
import type {
  AuthorityLayer,
  Completeness,
  JsonValue,
  Provenance,
  RepositorySemanticSnapshot,
  ReviewLevel,
  SemanticEntity,
  SemanticFact,
  SemanticRelation,
  SourceReference,
} from "../ir/types.js";
import type {
  AuthorizedActualComparison,
  DerivedChange,
  EvidenceRefreshNeed,
  ImpactPath,
  PropagationStopPoint,
  SemanticChangeSet,
  SemanticDeltaRecord,
  SymbolChange,
  UnknownRegion,
} from "../diff/types.js";
import type { SemanticChangeSetView } from "../query.js";

export type EntityId = string;

export const SEMANTIC_PROJECTION_API_VERSION = 1 as const;
export const SEMANTIC_PROJECTION_PROVIDER = "mottainai-semantic-projections" as const;

export type SemanticProjectionStatus = "fresh" | "stale" | "invalid" | "unavailable" | "unknown";
export type SemanticProjectionPriority = "required" | "semantic" | "navigation" | "evidence" | "verbose";

export interface SemanticProjectionBudgetOptions extends ProjectionBudgetConfig {
  /** Structural caps are applied before the shared byte/token budget. */
  maxFacts?: number;
  maxRelations?: number;
  maxSymbols?: number;
  maxSourceReads?: number;
  maxEvidence?: number;
  maxChanges?: number;
  maxImpactPaths?: number;
  maxRationales?: number;
  maxGuidance?: number;
}

export interface SemanticProjectionBudget extends ProjectionBudget {
  maxFacts: number;
  maxRelations: number;
  maxSymbols: number;
  maxSourceReads: number;
  maxEvidence: number;
  maxChanges: number;
  maxImpactPaths: number;
  maxRationales: number;
  maxGuidance: number;
}

export interface ProjectionBudgetMetadata {
  softTokens: number;
  hardTokens: number;
  hardBytes: number;
  projectedBytes: number;
  projectedTokens: number;
  truncated: boolean;
}

export interface ProjectionExpansion {
  kind: "source-read" | "entity" | "projection";
  targets: readonly (EntityId | SourceReference)[];
  reason: string;
}

export interface ProjectionOmission {
  field: string;
  reason: string;
  count?: number;
  priority: SemanticProjectionPriority;
  expansion?: ProjectionExpansion;
}

export interface ProjectionModelState {
  status: SemanticProjectionStatus;
  integrity: RepositorySemanticSnapshot["integrity"]["status"];
  authoritative: boolean;
  completeness?: Completeness;
  revision?: string;
  modelDigest?: string;
  reason?: string;
}

export interface ProjectionProvenance {
  provider: string;
  authority: AuthorityLayer | "integrity";
  sourceRevision?: string;
  sourceProvenance?: Provenance;
  completeness?: Completeness;
  status: SemanticProjectionStatus;
  authoritative: boolean;
  note: string;
}

export interface ProjectedFact {
  id?: EntityId;
  name: string;
  value: JsonValue;
  authority: AuthorityLayer;
  provenance: Provenance;
  inferred: boolean;
  authoritative: boolean;
}

export interface ProjectedEntityReference {
  id: EntityId;
  kind: string;
  name: string;
  summary?: string;
  authority: AuthorityLayer;
  provenance: Provenance;
  inferred?: boolean;
  authoritative: boolean;
}

export interface ProjectedRelation {
  id: string;
  kind: string;
  from: EntityId;
  to: EntityId;
  authority: AuthorityLayer;
  provenance: Provenance;
  inferred?: boolean;
  authoritative: boolean;
}

export interface ProjectionUnknown {
  id: string;
  code: string;
  message: string;
  subjects: readonly EntityId[];
  material: boolean;
  authoritative: false;
  recommendedSourceReads: readonly SourceReference[];
}

export interface ProjectedText {
  value: string;
  authority: AuthorityLayer;
  provenance: Provenance;
  authoritative: boolean;
}

export interface AgentProjectionOptions extends SemanticProjectionBudgetOptions {
  targetTask?: string;
  includeRationale?: boolean;
  includeReviewGuidance?: boolean;
}

export interface AgentProjectionInput {
  snapshot: RepositorySemanticSnapshot;
  targetId: EntityId;
  changeSet?: SemanticChangeSet;
  options?: AgentProjectionOptions;
}

export interface AgentProjectionTarget extends ProjectedEntityReference {
  scope: "symbol" | "component" | "project" | "entity";
}

export interface AgentProjectionContext {
  responsibility?: ProjectedText;
  symbols: readonly ProjectedEntityReference[];
  capabilities: readonly ProjectedEntityReference[];
  contracts: readonly ProjectedEntityReference[];
  invariants: readonly ProjectedEntityReference[];
  constraints: readonly ProjectedEntityReference[];
  effects: readonly ProjectedFact[];
  dependencies: readonly ProjectedRelation[];
  callers: readonly ProjectedEntityReference[];
  callees: readonly ProjectedEntityReference[];
  evidence: readonly ProjectedEntityReference[];
  tests: readonly ProjectedEntityReference[];
  rationales: readonly ProjectedText[];
  reviewGuidance: readonly ProjectedText[];
}

export interface AgentDeltaContext {
  reviewLevel?: ReviewLevel;
  semanticDeltas: readonly SemanticDeltaRecord[];
  implementationChanges: readonly DerivedChange[];
  unknowns: readonly UnknownRegion[];
}

export interface AgentImpactContext {
  affectedEntities: readonly EntityId[];
  paths: readonly ImpactPath[];
  stopBoundaries: readonly PropagationStopPoint[];
}

export interface AgentContextProjection {
  apiVersion: typeof SEMANTIC_PROJECTION_API_VERSION;
  kind: "agent";
  target: AgentProjectionTarget;
  summary?: ProjectedText;
  model: ProjectionModelState;
  context: AgentProjectionContext;
  facts: readonly ProjectedFact[];
  relations: readonly ProjectedRelation[];
  delta?: AgentDeltaContext;
  impact?: AgentImpactContext;
  unknowns: readonly ProjectionUnknown[];
  recommendedSourceReads: readonly SourceReference[];
  expansionTargets: readonly SourceReference[];
  source: { available: false; reason: string };
  provenance: ProjectionProvenance;
  omissions: readonly ProjectionOmission[];
  budget: ProjectionBudgetMetadata;
}

/** Stable descriptive aliases for transport/domain callers. */
export type AgentProjection = AgentContextProjection;

export interface ReviewProjectionOptions extends SemanticProjectionBudgetOptions {}

export interface ReviewProjectionInput {
  changeSet: SemanticChangeSet | SemanticChangeSetView;
  snapshot?: RepositorySemanticSnapshot;
  options?: ReviewProjectionOptions;
}

export interface ReviewProjection {
  apiVersion: typeof SEMANTIC_PROJECTION_API_VERSION;
  kind: "review";
  model: ProjectionModelState;
  reviewLevel?: ReviewLevel;
  reviewReasons: readonly string[];
  semanticDelta: readonly SemanticDeltaRecord[];
  impact: {
    affectedEntities: readonly EntityId[];
    affectedSymbols: readonly ProjectedEntityReference[];
    paths: readonly ImpactPath[];
    stopBoundaries: readonly PropagationStopPoint[];
  };
  authorizedVsActual?: AuthorizedActualComparison;
  evidenceRefresh: readonly EvidenceRefreshNeed[];
  unknowns: readonly ProjectionUnknown[];
  implementationChanges: readonly DerivedChange[];
  symbolChanges: readonly SymbolChange[];
  effectViolations: readonly unknown[];
  recommendedSourceReads: readonly SourceReference[];
  provenance: ProjectionProvenance;
  omissions: readonly ProjectionOmission[];
  budget: ProjectionBudgetMetadata;
}

export interface JsdocProjectionOptions extends SemanticProjectionBudgetOptions {
  locale?: "en" | string;
}

export interface JsdocParameter {
  name: string;
  type?: string;
  required?: boolean;
  domain?: string;
  sourceIds: readonly EntityId[];
}

export interface JsdocConstraint {
  text: string;
  sourceIds: readonly EntityId[];
}

export interface JsdocThrows {
  type: string;
  condition?: string;
  description?: string;
  sourceIds: readonly EntityId[];
}

export interface JsdocContradiction {
  field: string;
  reason: string;
  sourceIds: readonly EntityId[];
  values: readonly JsonValue[];
}

export interface JsdocProjectionInput {
  snapshot: RepositorySemanticSnapshot;
  targetId: EntityId;
  options?: JsdocProjectionOptions;
}

export interface JsdocProjection {
  apiVersion: typeof SEMANTIC_PROJECTION_API_VERSION;
  kind: "jsdoc";
  canonicalLanguage: "en";
  locale: string;
  target: ProjectedEntityReference;
  model: ProjectionModelState;
  exactSignature?: {
    value: string;
    sourceId: EntityId;
    provenance: Provenance;
    authoritative: boolean;
  };
  summary?: ProjectedText;
  parameters: readonly JsdocParameter[];
  constraints: readonly JsdocConstraint[];
  returns?: { value: string; sourceIds: readonly EntityId[] };
  throws: readonly JsdocThrows[];
  deprecation?: { value: string; sourceIds: readonly EntityId[] };
  stability?: { value: string; sourceIds: readonly EntityId[] };
  contradictions: readonly JsdocContradiction[];
  recommendedSourceReads: readonly SourceReference[];
  source: { available: false; reason: string };
  provenance: ProjectionProvenance;
  omissions: readonly ProjectionOmission[];
  budget: ProjectionBudgetMetadata;
}

export type JSDocProjection = JsdocProjection;
export type ProjectionBudgetOptions = SemanticProjectionBudgetOptions;

export interface ProjectionModelInput {
  snapshot: RepositorySemanticSnapshot;
  targetId?: EntityId;
}

export type SupportedProjectionChangeSet = SemanticChangeSet | SemanticChangeSetView;

export type { SemanticEntity, SemanticFact, SemanticRelation };
