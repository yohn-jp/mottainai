export const QUERY_API_VERSION = "v1" as const;
export const FIXTURE_PROVIDER_VERSION = "fixture-1" as const;

export const AUTHORITY_LAYERS = ["declared", "derived", "observed", "analysis", "integrity"] as const;
export type AuthorityLayer = (typeof AUTHORITY_LAYERS)[number];

export const SEMANTIC_DELTA_KINDS = [
  "responsibility",
  "capability",
  "contract",
  "effect",
  "invariant",
  "dependency-policy",
  "public-surface",
] as const;
export type SemanticDeltaKind = (typeof SEMANTIC_DELTA_KINDS)[number];

export const REVIEW_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export type EntityId = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type EntityKind =
  | "project"
  | "component"
  | "symbol"
  | "capability"
  | "contract"
  | "invariant"
  | "evidence"
  | "test"
  | "decision"
  | "file"
  | "package"
  | "external-api";
export const ENTITY_STATUSES = ["healthy", "partial", "review-required", "protected", "stale", "unknown"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];
export type FixtureStatus = "fixture" | "partial" | "unavailable";

export const VERIFICATION_VIEW_STATUSES = ["satisfied", "missing", "stale", "failed", "inadequate", "unknown"] as const;
export type VerificationViewStatus = (typeof VERIFICATION_VIEW_STATUSES)[number];
export type VerificationViewStrength = "required" | "recommended";
export type VerificationViewScope = "symbol" | "component" | "project";

export interface VerificationCountView {
  total: number;
  satisfied: number;
  missing: number;
  stale: number;
  failed: number;
  inadequate: number;
  unknown: number;
}

export interface VerificationGapView {
  requirementId: EntityId;
  perspectiveId: EntityId;
  targetId: EntityId;
  targetKind: "symbol" | "component" | "contract" | "invariant" | "project";
  strength: VerificationViewStrength;
  status: VerificationViewStatus;
  evidenceIds: readonly EntityId[];
  missingEvidenceKinds: readonly string[];
}

export interface VerificationHealthView {
  scope: VerificationViewScope;
  targetId: EntityId;
  status: "healthy" | "incomplete" | "failed" | "unknown";
  score: number;
  required: VerificationCountView;
  recommended: VerificationCountView;
  gapRequirementIds: readonly EntityId[];
  gaps: readonly VerificationGapView[];
}

export interface VerificationQuery {
  targetId?: EntityId;
  scope?: VerificationViewScope;
}

export interface VerificationView {
  apiVersion: typeof QUERY_API_VERSION;
  target: { id: EntityId; kind: VerificationViewScope };
  health: VerificationHealthView;
  provenance: Provenance;
}

export interface Provenance {
  authority: AuthorityLayer;
  status: FixtureStatus;
  provider: string;
  note: string;
}

export interface SemanticEntity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  summary: string;
  status: EntityStatus;
  authority: AuthorityLayer;
  provenance: Provenance;
  componentId?: EntityId;
  tags: readonly string[];
  facts: Readonly<Record<string, JsonValue>>;
}

export type RelationKind =
  | "contains"
  | "owns"
  | "shares"
  | "defines"
  | "provides"
  | "requires"
  | "constrained-by"
  | "depends-on"
  | "calls"
  | "references"
  | "imports"
  | "extends"
  | "implements"
  | "uses-package"
  | "imports-api"
  | "tests"
  | "verifies"
  | "governs"
  | "evidence-for";

export interface SemanticRelation {
  id: string;
  kind: RelationKind;
  from: EntityId;
  to: EntityId;
  authority: AuthorityLayer;
  provenance: Provenance;
}

export interface EntitySummary {
  id: EntityId;
  kind: EntityKind;
  name: string;
  summary: string;
  status: EntityStatus;
  authority: AuthorityLayer;
  provenance: Provenance;
  componentId?: EntityId;
  tags: readonly string[];
}

export interface FactView {
  name: string;
  value: JsonValue;
  authority: AuthorityLayer;
  provenance: Provenance;
}

export interface HistoryEntry {
  id: string;
  label: string;
  summary: string;
  authority: AuthorityLayer;
  provenance: Provenance;
}

export interface SourceReference {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  reason: string;
}

export interface AgentProjection {
  entityId: EntityId;
  status: FixtureStatus;
  summary: string;
  facts: readonly FactView[];
  relations: readonly SemanticRelation[];
  recommendedReads: readonly SourceReference[];
  source: {
    available: false;
    reason: string;
  };
  verification?: VerificationHealthView;
}

export interface EntityView extends EntitySummary {
  facts: readonly FactView[];
  relations: readonly SemanticRelation[];
  history: readonly HistoryEntry[];
  agentProjection: AgentProjection;
  verification?: VerificationHealthView;
}

export interface ProjectView {
  apiVersion: typeof QUERY_API_VERSION;
  project: EntitySummary;
  revision: {
    base: string;
    head: string;
    worktree: string;
  };
  health: {
    status: EntityStatus;
    score: number;
    staleEvidence: number;
    modelGaps: number;
    reviewRequired: number;
  };
  verification?: VerificationHealthView;
  counts: Readonly<Record<EntityKind, number>>;
  componentIds: readonly EntityId[];
  entityIds: readonly EntityId[];
  provenance: Provenance;
}

export interface GraphQuery {
  componentId?: EntityId;
  entityId?: EntityId;
  relationKinds?: readonly RelationKind[];
  /** Traverse from the selected entity in this direction. Defaults to both directions. */
  direction?: "outgoing" | "incoming" | "both";
  /** Maximum number of relation hops from the selected entity. Defaults to one. */
  depth?: number;
  /** Node budget. `limit` remains the backward-compatible alias. */
  nodeLimit?: number;
  /** Edge budget for the returned slice. */
  edgeLimit?: number;
  limit?: number;
}

export interface GraphView {
  apiVersion: typeof QUERY_API_VERSION;
  query: GraphQuery;
  nodes: readonly EntitySummary[];
  relations: readonly SemanticRelation[];
  truncated: boolean;
  provenance: Provenance;
}

export interface ComponentQuery {
  search?: string;
  status?: EntityStatus;
  limit?: number;
}

export interface ComponentView extends EntitySummary {
  responsibility: string;
  ownedSymbolIds: readonly EntityId[];
  capabilityIds: readonly EntityId[];
  contractIds: readonly EntityId[];
  invariantIds: readonly EntityId[];
  fileIds: readonly EntityId[];
  evidenceIds: readonly EntityId[];
  packageIds: readonly EntityId[];
  metrics: Readonly<Record<string, JsonValue>>;
  verification?: VerificationHealthView;
}

export interface DependencyQuery {
  componentId?: EntityId;
  limit?: number;
}

export interface DependencyView {
  apiVersion: typeof QUERY_API_VERSION;
  items: readonly {
    from: EntitySummary;
    to: EntitySummary;
    relation: SemanticRelation;
  }[];
  packageUsage: readonly {
    package: EntitySummary;
    componentIds: readonly EntityId[];
    importedApiIds: readonly EntityId[];
  }[];
  provenance: Provenance;
}

export interface ChangeQuery {
  reviewLevel?: ReviewLevel;
}

export interface SemanticChangeEntry {
  id: string;
  entityId: EntityId;
  kind: SemanticDeltaKind;
  summary: string;
  reviewLevel: ReviewLevel;
  authority: AuthorityLayer;
  provenance: Provenance;
}

export interface SemanticChangeSetView {
  apiVersion: typeof QUERY_API_VERSION;
  baseRevision: string;
  headRevision: string;
  filesChanged: number;
  symbolsChanged: number;
  componentsChanged: number;
  contractsTouched: number;
  staleEvidence: number;
  recommendedReads: readonly SourceReference[];
  entries: readonly SemanticChangeEntry[];
  impactPaths: readonly {
    entityIds: readonly EntityId[];
    stopReason: string;
  }[];
  provenance: Provenance;
}

export const KNOWLEDGE_ENTRY_KINDS = ["decision", "policy", "experiment", "evidence"] as const;
export const KNOWLEDGE_ENTRY_STATUSES = ["accepted", "draft", "protected", "observed", "stale"] as const;

export interface KnowledgeEntry {
  id: EntityId;
  kind: (typeof KNOWLEDGE_ENTRY_KINDS)[number];
  title: string;
  summary: string;
  status: (typeof KNOWLEDGE_ENTRY_STATUSES)[number];
  linkedEntityIds: readonly EntityId[];
  authority: AuthorityLayer;
  provenance: Provenance;
}

export interface KnowledgeView {
  apiVersion: typeof QUERY_API_VERSION;
  entries: readonly KnowledgeEntry[];
  counts: Readonly<Record<KnowledgeEntry["kind"], number>>;
  provenance: Provenance;
}

export interface RepositorySemanticQuery {
  getProject(): ProjectView | Promise<ProjectView>;
  getGraph(query?: GraphQuery): GraphView | Promise<GraphView>;
  getEntity(id: EntityId): EntityView | undefined | Promise<EntityView | undefined>;
  listComponents(query?: ComponentQuery): ComponentView[] | Promise<ComponentView[]>;
  getDependencies(query?: DependencyQuery): DependencyView | Promise<DependencyView>;
  getChangeSet(query?: ChangeQuery): SemanticChangeSetView | Promise<SemanticChangeSetView>;
  getKnowledge(query?: KnowledgeQuery): KnowledgeView | Promise<KnowledgeView>;
  getAgentProjection(id: EntityId): AgentProjection | Promise<AgentProjection>;
  getVerification?(query?: VerificationQuery): VerificationView | undefined | Promise<VerificationView | undefined>;
}

export interface KnowledgeQuery {
  kind?: KnowledgeEntry["kind"];
  status?: KnowledgeEntry["status"];
}

export class SemanticQueryError extends Error {
  readonly code: "invalid_query" | "not_found";
  readonly statusCode: 400 | 404;

  constructor(code: "invalid_query" | "not_found", message: string) {
    super(message);
    this.name = "SemanticQueryError";
    this.code = code;
    this.statusCode = code === "not_found" ? 404 : 400;
  }
}

export function boundedLimit(value: number | undefined, fallback: number, maximum = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new SemanticQueryError("invalid_query", `limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}
