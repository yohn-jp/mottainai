/**
 * Mottainai Repository Semantic Model — v1 design draft.
 *
 * This file describes the storage-independent contract consumed by the
 * Semantic Project Viewer. It is design documentation, not a mutation API.
 */

export type EntityId = string;
export type RevisionId = string;
export type Digest = string;

export const AUTHORITY_LAYERS = ["declared", "derived", "observed", "analysis", "integrity"] as const;
export type AuthorityLayer = (typeof AUTHORITY_LAYERS)[number];

export type FixtureState = "fixture" | "partial" | "unavailable";

export interface Provenance {
  authority: AuthorityLayer;
  state: FixtureState;
  producer: string;
  sourceRefs: string[];
  sourceRevision?: RevisionId;
  extractorVersion?: string;
  digest?: Digest;
  note?: string;
}

/** Declared facts are authored semantic intent and review boundaries. */
export interface DeclaredFacts {
  responsibility?: string;
  ownership?: EntityId;
  capabilities?: EntityId[];
  contracts?: EntityId[];
  invariants?: EntityId[];
  rationale?: EntityId[];
  constraints?: string[];
  effectPolicy?: EffectPolicy;
  dependencyPolicy?: string;
  reviewGuidance?: string[];
  stability?: "experimental" | "stable" | "protected";
  terminology?: EntityId[];
}

/** Derived facts come from a reproducible extractor or compiler. */
export interface DerivedFacts {
  files?: EntityId[];
  fingerprints?: Digest[];
  symbols?: EntityId[];
  bindings?: string[];
  signatures?: string[];
  visibility?: string;
  imports?: EntityId[];
  exports?: EntityId[];
  references?: EntityId[];
  calls?: EntityId[];
  actualEffects?: EffectDomain[];
  complexity?: number;
  packages?: EntityId[];
  git?: { revision: RevisionId; changedAt?: string; churn30d?: number };
}

/** Observed facts are execution, test, CI, or runtime evidence. */
export interface ObservedFacts {
  evidenceIds: EntityId[];
  status: "passing" | "failing" | "stale" | "unknown";
  coverage?: { lines?: number; branches?: number; functions?: number };
  observedRevision?: RevisionId;
  observedAt?: string;
}

/** Analysis facts are computed projections; #83 only supplies fixture values. */
export interface AnalysisFacts {
  conformance?: "conforming" | "violation" | "unknown";
  semanticDelta?: SemanticDeltaKind[];
  impact?: EntityId[];
  reviewLevel?: ReviewLevel;
  evidenceFreshness?: "fresh" | "stale" | "invalid" | "unknown";
  modelGaps?: string[];
  health?: "healthy" | "degraded" | "review-required" | "unknown";
  recommendedSourceReads?: SourceReference[];
}

/** Integrity describes identity and whether facts can be trusted for a revision. */
export interface IntegrityState {
  repositoryId: string;
  revision: RevisionId;
  worktreeId?: string;
  contentFingerprints: Digest[];
  schemaVersion: string;
  extractorVersion?: string;
  modelDigest: Digest;
  state: "fresh" | "stale" | "invalid";
}

export interface Project {
  kind: "project";
  id: EntityId;
  name: string;
  componentIds: EntityId[];
  declared: DeclaredFacts;
  derived: DerivedFacts;
  observed: ObservedFacts;
  analysis: AnalysisFacts;
  integrity: IntegrityState;
  provenance: Provenance[];
}

export interface Component {
  kind: "component";
  id: EntityId;
  name: string;
  /** Explicit architectural responsibility and aggregation boundary. */
  declared: DeclaredFacts;
  derived: DerivedFacts;
  observed: ObservedFacts;
  analysis: AnalysisFacts;
  provenance: Provenance[];
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "module";

export interface Symbol {
  kind: "symbol";
  id: EntityId;
  name: string;
  symbolKind: SymbolKind;
  /** Managed Symbols have one owner unless the fixture explicitly marks Shared. */
  ownership: { type: "component"; componentId: EntityId } | { type: "shared"; group?: string };
  binding: SourceBinding;
  declared: DeclaredFacts;
  derived: DerivedFacts;
  observed: ObservedFacts;
  analysis: AnalysisFacts;
  provenance: Provenance[];
}

export interface SourceBinding {
  language: string;
  modulePath: string;
  qualifiedName: string;
  sourceRange?: { startLine: number; endLine: number };
  symbolKey: string;
}

export type SemanticEntity = Project | Component | Symbol | { kind: string; id: EntityId; name: string };

/** One extensible relation graph backs component, symbol, evidence, and dependency views. */
export interface SemanticRelation {
  id: string;
  kind:
    | "contains"
    | "owns"
    | "shares"
    | "provides"
    | "requires"
    | "depends-on"
    | "calls"
    | "references"
    | "imports"
    | "uses-package"
    | "imports-api"
    | "tests"
    | "verifies"
    | "governs"
    | "evidence-for"
    | string;
  from: EntityId;
  to: EntityId;
  provenance: Provenance[];
}

export type EffectDomain =
  | "filesystem.read"
  | "filesystem.write"
  | "network.read"
  | "network.write"
  | "process.spawn"
  | "git.read"
  | "git.write"
  | "environment.read"
  | "environment.write"
  | "database.read"
  | "database.write"
  | `custom.${string}`;

export interface EffectPolicy {
  purity?: "pure" | "readonly" | "effectful" | "unknown";
  allow?: EffectDomain[];
  deny?: EffectDomain[];
}

export interface SourceReference {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  reason: string;
}

/** Exactly one semantic-delta vocabulary is used by the viewer and future analysis. */
export type SemanticDeltaKind =
  | "responsibility"
  | "capability"
  | "contract"
  | "effect"
  | "invariant"
  | "dependency-policy"
  | "public-surface";

/** Exactly one review vocabulary is used by the viewer and future analysis. */
export type ReviewLevel =
  | "L0" // implementation-only
  | "L1" // compatible semantic change
  | "L2" // review-required semantic change
  | "L3"; // protected, breaking, or violation

export interface SemanticChangeSet {
  baseRevision: RevisionId;
  headRevision: RevisionId;
  changedFiles: EntityId[];
  changedSymbols: EntityId[];
  changedComponents: EntityId[];
  entries: { entityId: EntityId; kind: SemanticDeltaKind; reviewLevel: ReviewLevel; summary: string }[];
  affectedEntities: EntityId[];
  evidenceToRefresh: EntityId[];
  recommendedSourceReads: SourceReference[];
  provenance: Provenance[];
}

export interface AgentProjection {
  entityId: EntityId;
  semanticSummary: string;
  facts: Record<string, unknown>;
  relations: EntityId[];
  recommendedSourceReads: SourceReference[];
  /** Source bodies are never part of this projection. */
  source: { available: false; reason: string };
}

/**
 * The viewer consumes this contract. HTTP, browser DOM, MCP, and a physical
 * database are adapters or providers, not members of the domain boundary.
 */
export interface RepositorySemanticQuery {
  getProject(): ProjectView | Promise<ProjectView>;
  getGraph(query?: GraphQuery): GraphView | Promise<GraphView>;
  getEntity(id: EntityId): EntityView | undefined | Promise<EntityView | undefined>;
  listComponents(query?: ComponentQuery): ComponentView[] | Promise<ComponentView[]>;
  getDependencies(query?: DependencyQuery): DependencyView | Promise<DependencyView>;
  getChangeSet(query?: ChangeQuery): SemanticChangeSet | Promise<SemanticChangeSet>;
  getKnowledge(query?: KnowledgeQuery): KnowledgeView | Promise<KnowledgeView>;
  getAgentProjection(id: EntityId): AgentProjection | Promise<AgentProjection>;
}

export interface ProjectView {
  project: Project;
  counts: Record<string, number>;
  health: AnalysisFacts["health"];
}

export interface GraphQuery {
  componentId?: EntityId;
  entityId?: EntityId;
  relationKinds?: string[];
  limit?: number;
}

export interface GraphView {
  nodes: SemanticEntity[];
  relations: SemanticRelation[];
  truncated: boolean;
}

export interface ComponentQuery {
  search?: string;
  status?: string;
  limit?: number;
}

export interface ComponentView extends Component {
  ownedSymbolIds: EntityId[];
}

export interface DependencyQuery {
  componentId?: EntityId;
  limit?: number;
}

export interface DependencyView {
  relations: SemanticRelation[];
  packages: EntityId[];
}

export interface ChangeQuery {
  reviewLevel?: ReviewLevel;
}

export interface KnowledgeQuery {
  kind?: "decision" | "policy" | "experiment" | "evidence";
}

export interface KnowledgeView {
  entries: EntityId[];
  provenance: Provenance[];
}

export interface EntityView {
  entity: SemanticEntity;
  relations: SemanticRelation[];
  history: EntityId[];
  agentProjection: AgentProjection;
}

/**
 * Canonical semantic prose is formal English. Human translation, LLM
 * compression, and JSDoc are projections. Human semantic comments/JSDoc are
 * not canonical; only narrowly allowlisted machine/compiler/legal directives
 * may eventually remain inline.
 */
export const CANONICAL_PROSE_POLICY = {
  canonical: "formal English",
  humanTranslation: "projection",
  llmCompression: "projection",
  jsdoc: "projection",
  sourceCommentsCanonical: false,
} as const;
