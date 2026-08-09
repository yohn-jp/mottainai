import type { LogicalId } from "./ids.js";

export const MODEL_VERSION = "symbol-first-v1" as const;
export type ModelVersion = typeof MODEL_VERSION;

/** #48のnumeric v1と衝突しない、symbol-first v1のschema世代。 */
export type SchemaVersion = 2;
export const CURRENT_SCHEMA_VERSION: SchemaVersion = 2;

export const AUTHORITY_LAYERS = ["declared", "derived", "observed", "analysis", "integrity"] as const;
export type AuthorityLayer = (typeof AUTHORITY_LAYERS)[number];

export const NODE_KINDS = [
  "project",
  "repository",
  "component",
  "symbol",
  "capability",
  "contract",
  "invariant",
  "decision",
  "rationale",
  "constraint",
  "evidence",
  "test",
  "file",
  "package",
  "external_dependency",
  "external_api",
  "module",
  "document",
  "document_section",
] as const;

export type KnownNodeKind = (typeof NODE_KINDS)[number];
export type NodeKind = KnownNodeKind | (string & {});

export const RELATIONSHIP_KINDS = [
  "contains",
  "owns",
  "shares",
  "defines",
  "references",
  "calls",
  "imports",
  "provides",
  "requires",
  "depends_on",
  "implements",
  "tests",
  "verifies",
  "documents",
  "governs",
  "constrained_by",
  "uses_package",
  "imports_api",
  "evidence_for",
] as const;

export type KnownRelationshipKind = (typeof RELATIONSHIP_KINDS)[number];
export type RelationshipKind = KnownRelationshipKind | (string & {});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ExtensionMetadata = Record<string, JsonValue>;

export const PROVENANCE_KINDS = ["declared", "derived", "observed", "inferred"] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];
export type Completeness = "complete" | "partial" | "unknown";
export type AmbiguityStatus = "none" | "possible" | "ambiguous";
export type EnforcementAuthority = "none" | "advisory" | "authoritative";

export const VERIFICATION_PERSPECTIVE_CATEGORIES = [
  "generic",
  "semantic",
  "effect-specific",
  "security",
  "state",
  "compatibility",
] as const;
export type VerificationPerspectiveCategory = (typeof VERIFICATION_PERSPECTIVE_CATEGORIES)[number] | (string & {});

export const VERIFICATION_EVIDENCE_KINDS = [
  "intended",
  "static-linkage",
  "execution",
  "coverage",
  "assertion",
  "contract",
] as const;
export type VerificationEvidenceKind = (typeof VERIFICATION_EVIDENCE_KINDS)[number] | (string & {});

export const VERIFICATION_EVIDENCE_STRENGTHS = ["association", "observation", "verification"] as const;
export type VerificationEvidenceStrength = (typeof VERIFICATION_EVIDENCE_STRENGTHS)[number] | (string & {});

export type VerificationEvidenceFreshness = "current" | "stale";
export type VerificationEvidenceStatus = "passed" | "failed" | "skipped" | "inadequate" | "missing";
export type VerificationRequirementStrength = "required" | "recommended";
export type VerificationAssessmentStatus = "satisfied" | "missing" | "stale" | "failed" | "inadequate" | "unknown";
export type VerificationHealthStatus = "healthy" | "incomplete" | "failed" | "unknown";

export const VERIFICATION_TARGET_KINDS = ["project", "component", "symbol", "contract", "invariant"] as const;
export type VerificationTargetKind = (typeof VERIFICATION_TARGET_KINDS)[number];

export interface VerificationTarget {
  kind: VerificationTargetKind;
  id: LogicalId;
}

export const VERIFICATION_REQUIREMENT_PROVENANCES = [
  "project-policy",
  "component-policy",
  "explicit-declaration",
  "contract",
  "invariant",
  "deterministic-derived-rule",
  "inferred",
] as const;
export type VerificationRequirementProvenanceKind =
  | (typeof VERIFICATION_REQUIREMENT_PROVENANCES)[number]
  | (string & {});

export interface ProducerIdentity {
  name: string;
  version: string;
}

export interface SourceRevision {
  repositoryId: LogicalId;
  revisionId?: LogicalId;
}

export interface EvidenceReference {
  kind: string;
  ref: string;
  target?: LogicalId;
  locator?: PhysicalLocator;
  note?: string;
}

/** Declared verification vocabulary; `kind` remains open for future perspectives. */
export interface VerificationPerspective {
  id: LogicalId;
  kind: string;
  category: VerificationPerspectiveCategory;
  name: string;
  description?: string;
  /** False marks an intentionally preserved but not yet understood taxonomy entry. */
  known?: boolean;
  authority: "declared";
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

/** A requirement is authoritative only in declared/derived containers. Analysis may carry inferred suggestions. */
export interface VerificationRequirement {
  id: LogicalId;
  target: VerificationTarget;
  perspectiveId: LogicalId;
  strength: VerificationRequirementStrength;
  rationale: string;
  requirementProvenance: {
    kind: VerificationRequirementProvenanceKind;
    sourceId?: LogicalId;
    ruleId?: string;
  };
  minimumEvidenceStrength?: VerificationEvidenceStrength;
  authority: "declared" | "derived" | "analysis";
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

/** Observed verification relation; association, observation and proof are deliberately distinct. */
export interface VerificationEvidence {
  id: LogicalId;
  target: VerificationTarget;
  perspectiveId: LogicalId;
  testId?: LogicalId;
  kind: VerificationEvidenceKind;
  strength: VerificationEvidenceStrength;
  freshness: VerificationEvidenceFreshness;
  status: VerificationEvidenceStatus;
  reference: string;
  summary: string;
  coverage?: number;
  authority: "observed";
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export interface VerificationAssessment {
  requirementId: LogicalId;
  target: VerificationTarget;
  perspectiveId: LogicalId;
  strength: VerificationRequirementStrength;
  status: VerificationAssessmentStatus;
  evidenceIds: LogicalId[];
  satisfyingEvidenceIds: LogicalId[];
  missingEvidenceKinds?: string[];
}

export interface VerificationCounts {
  total: number;
  satisfied: number;
  missing: number;
  stale: number;
  failed: number;
  inadequate: number;
  unknown: number;
}

export type VerificationScopeKind = "symbol" | "component" | "project";

export interface VerificationSummary {
  scope: VerificationScopeKind;
  targetId: LogicalId;
  status: VerificationHealthStatus;
  score: number;
  required: VerificationCounts;
  recommended: VerificationCounts;
  gapRequirementIds: LogicalId[];
}

export interface VerificationAnalysis {
  authority: "analysis";
  assessments: VerificationAssessment[];
  summaries: VerificationSummary[];
  /** Non-authoritative suggestions; never consumed as requirements by adequacy. */
  inferredRequirements?: VerificationRequirement[];
}

export interface AmbiguityMetadata {
  status: AmbiguityStatus;
  reason?: string;
  candidates?: LogicalId[];
}

/** Authority layer and provenance origin remain separate fields by design. */
export interface Provenance {
  kind: ProvenanceKind;
  producer: ProducerIdentity;
  sourceRevision: SourceRevision;
  evidence?: EvidenceReference[];
  confidence?: number;
  completeness?: Completeness;
  ambiguity?: AmbiguityMetadata;
}

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end?: SourcePosition;
}

export interface SymbolLocator {
  kind: "symbol";
  language: string;
  package?: string;
  module?: string;
  file?: string;
  symbol: string;
  signature?: string;
  /** 物理位置。symbol logical IDの生成には使わない。 */
  range?: SourceRange;
}

export interface FileLocator {
  kind: "file";
  path: string;
  package?: string;
  module?: string;
  language?: string;
  range?: SourceRange;
}

export interface ModuleLocator {
  kind: "module";
  name: string;
  package?: string;
  file?: string;
  range?: SourceRange;
}

export interface DocumentLocator {
  kind: "document";
  path: string;
  section?: string;
  range?: SourceRange;
}

export type PhysicalLocator = SymbolLocator | FileLocator | ModuleLocator | DocumentLocator;

export interface NodeIdentity {
  logicalId: LogicalId;
  locators?: PhysicalLocator[];
  aliases?: LogicalId[];
}

export interface RepositoryIdentity {
  id: LogicalId;
  canonicalName: string;
  remote?: string;
}

export interface RevisionIdentity {
  id: LogicalId;
  revision: string;
  tree?: string;
  kind?: string;
  parentIds?: LogicalId[];
}

export interface ContractAssertion {
  expression: string;
  description?: string;
}

export interface ContractParameter {
  name: string;
  type?: string;
  required?: boolean;
  domain?: string;
}

export interface CapabilityRequirement {
  name: string;
  description?: string;
}

export interface ExternalResource {
  name: string;
  kind: string;
  access: string;
  description?: string;
}

export interface ContractError {
  type: string;
  condition?: string;
  description?: string;
}

export interface StateTransition {
  from?: string;
  to: string;
  trigger?: string;
  description?: string;
}

export interface ExternalCall {
  target: string;
  operation?: string;
  description?: string;
}

export interface ExternalEvent {
  name: string;
  payload?: string;
  description?: string;
}

export type EffectId = string & { readonly __effectId: unique symbol };

export interface ContractInputs {
  parameters: ContractParameter[];
  acceptedDomain: ContractAssertion[];
  preconditions: ContractAssertion[];
  dependencies: CapabilityRequirement[];
  externalResources: ExternalResource[];
}

export interface ContractOutputs {
  returnValue?: string;
  postconditions: ContractAssertion[];
  errors: ContractError[];
  stateTransitions: StateTransition[];
  externalCalls: ExternalCall[];
  externalEvents: ExternalEvent[];
  effects: EffectId[];
}

export interface Contract {
  inputs: ContractInputs;
  outputs: ContractOutputs;
}

export type Stability = "experimental" | "unstable" | "stable" | "protected" | "deprecated";
export type ReviewLevel = "L0" | "L1" | "L2" | "L3";
export const REVIEW_LEVELS = ["L0", "L1", "L2", "L3"] as const;
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
export type SemanticIntent = "semantic-neutral" | "semantic-change";
export const SEMANTIC_VOCABULARY_VERSION = 1 as const;

export interface SemanticEntityBase {
  id: LogicalId;
  name: string;
  description?: string;
  authority: AuthorityLayer;
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export interface ProjectEntity extends SemanticEntityBase {
  kind: "project";
  canonicalName: string;
  responsibility: string;
  stability: Stability;
  reviewLevel: ReviewLevel;
}

export interface ComponentEntity extends SemanticEntityBase {
  kind: "component";
  responsibility: string;
  stability: Stability;
  reviewLevel: ReviewLevel;
}

export interface SymbolEntity extends SemanticEntityBase {
  kind: "symbol";
  locator: SymbolLocator;
  classification: "managed" | "shared";
}

/** Declared ownership is authoritative; derived Symbol classification is extractor-owned metadata. */
export interface SymbolOwnershipDeclaration {
  id: LogicalId;
  symbolId: LogicalId;
  classification: "managed" | "shared";
  componentId?: LogicalId;
}

export interface CapabilityEntity extends SemanticEntityBase {
  kind: "capability";
  meaning: string;
  stability: Stability;
  reviewLevel: ReviewLevel;
}

export interface ContractEntity extends SemanticEntityBase {
  kind: "contract";
  definition: Contract;
  stability: Stability;
  reviewLevel: ReviewLevel;
}

export interface InvariantEntity extends SemanticEntityBase {
  kind: "invariant";
  statement: string;
  severity: "info" | "warning" | "error";
  stability: Stability;
}

export interface DecisionEntity extends SemanticEntityBase {
  kind: "decision";
  statement: string;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  rationaleIds: LogicalId[];
  constraintIds: LogicalId[];
}

export interface RationaleEntity extends SemanticEntityBase {
  kind: "rationale";
  statement: string;
  decisionIds: LogicalId[];
}

export interface ConstraintEntity extends SemanticEntityBase {
  kind: "constraint";
  statement: string;
  scope: string;
  enforcement: "advisory" | "required" | "protected";
}

export interface SemanticDebtIntent {
  id: LogicalId;
  subject: LogicalId;
  statement: string;
  status: "open" | "accepted" | "resolved";
  priority: "low" | "medium" | "high";
}

export interface FileEntity extends SemanticEntityBase {
  kind: "file";
  path: string;
  language?: string;
  tracked: boolean;
}

export interface PackageEntity extends SemanticEntityBase {
  kind: "package";
  packageName: string;
  dependencyType: "internal" | "external";
  version?: string;
}

export interface ExternalDependencyEntity extends SemanticEntityBase {
  kind: "external_dependency";
  packageName: string;
  version?: string;
  registry?: string;
}

export interface ExternalApiEntity extends SemanticEntityBase {
  kind: "external_api";
  packageId: LogicalId;
  apiName: string;
  version?: string;
}

export interface EvidenceEntity extends SemanticEntityBase {
  kind: "evidence";
  evidenceKind: string;
  reference: string;
  summary: string;
}

export interface TestEntity extends SemanticEntityBase {
  kind: "test";
  testName: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  evidenceIds: LogicalId[];
}

export type SemanticEntity =
  | ProjectEntity
  | ComponentEntity
  | SymbolEntity
  | CapabilityEntity
  | ContractEntity
  | InvariantEntity
  | DecisionEntity
  | RationaleEntity
  | ConstraintEntity
  | FileEntity
  | PackageEntity
  | ExternalDependencyEntity
  | ExternalApiEntity
  | EvidenceEntity
  | TestEntity;

export interface SemanticRelation {
  id: LogicalId;
  kind: RelationshipKind;
  from: LogicalId;
  to: LogicalId;
  authority: AuthorityLayer;
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export interface UniversalRelationGraph {
  relations: SemanticRelation[];
}

export interface SemanticFact {
  id: LogicalId;
  subject: LogicalId;
  predicate: string;
  value: JsonValue;
  authority: AuthorityLayer;
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export type ClaimStatus = "supported" | "uncertain" | "rejected" | "open";

export interface SemanticClaim {
  id: LogicalId;
  subject: LogicalId;
  statement: string;
  object?: LogicalId;
  status: ClaimStatus;
  authority: AuthorityLayer;
  enforcement: EnforcementAuthority;
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export interface EffectPolicy {
  id: LogicalId;
  subject: LogicalId;
  allow: EffectId[];
  deny: EffectId[];
  rationaleIds: LogicalId[];
}

export interface DependencyPolicy {
  id: LogicalId;
  subject: LogicalId;
  allowedPackageIds: LogicalId[];
  deniedPackageIds: LogicalId[];
  rationaleIds: LogicalId[];
}

export interface ReviewGuidance {
  id: LogicalId;
  subject: LogicalId;
  level: ReviewLevel;
  guidance: string;
}

export interface StabilityDeclaration {
  subject: LogicalId;
  stability: Stability;
  rationaleId?: LogicalId;
}

export interface TerminologyLink {
  term: string;
  definition: string;
  relatedEntityIds: LogicalId[];
}

export interface DecisionLink {
  subject: LogicalId;
  decisionId: LogicalId;
  relation: "motivated_by" | "constrained_by" | "supersedes";
}

export interface CanonicalProsePolicy {
  canonicalLanguage: "en";
  canonicalForm: "formal-english";
  humanLocalization: "projection";
  llmTokenCompression: "projection";
  sourceCodeSemantics: "implementation-only";
  semanticCommentKinds: Array<"rationale" | "todo-debt-intent" | "review-note" | "constraint" | "api-meaning">;
  inlineDirectives: string[];
  jsdoc: "projection";
}

export interface DeclaredState {
  project: ProjectEntity;
  components: ComponentEntity[];
  capabilities: CapabilityEntity[];
  contracts: ContractEntity[];
  invariants: InvariantEntity[];
  decisions: DecisionEntity[];
  rationales: RationaleEntity[];
  constraints: ConstraintEntity[];
  facts: SemanticFact[];
  effectPolicies: EffectPolicy[];
  dependencyPolicies: DependencyPolicy[];
  reviewGuidance: ReviewGuidance[];
  stability: StabilityDeclaration[];
  terminology: TerminologyLink[];
  decisionLinks: DecisionLink[];
  commentPolicy: CanonicalProsePolicy;
  symbolOwnership?: SymbolOwnershipDeclaration[];
  semanticDebt?: SemanticDebtIntent[];
  verificationPerspectives?: VerificationPerspective[];
  verificationRequirements?: VerificationRequirement[];
}

export interface DerivedState {
  files: FileEntity[];
  symbols: SymbolEntity[];
  packages: PackageEntity[];
  externalDependencies: ExternalDependencyEntity[];
  externalApis: ExternalApiEntity[];
  facts: SemanticFact[];
  verificationRequirements?: VerificationRequirement[];
}

export interface ObservedState {
  evidences: EvidenceEntity[];
  tests: TestEntity[];
  facts: SemanticFact[];
  verificationEvidence?: VerificationEvidence[];
}

export interface SemanticDeltaEntry {
  id: LogicalId;
  subject: LogicalId;
  kind: SemanticDeltaKind;
  summary: string;
  reviewLevel: ReviewLevel;
}

export interface SemanticDelta {
  version: typeof SEMANTIC_VOCABULARY_VERSION;
  intent: SemanticIntent;
  entries: SemanticDeltaEntry[];
  /** semantic-neutral transactionが実際のdeltaを出した場合にtrue。 */
  unauthorized: boolean;
}

export interface SemanticTransaction {
  version: typeof SEMANTIC_VOCABULARY_VERSION;
  intent: SemanticIntent;
  delta: SemanticDelta;
  provenance: Provenance;
  reason?: string;
  authorizedDeltaKinds?: SemanticDeltaKind[];
  protectedChanges?: LogicalId[];
  transactionProvenance?: {
    actor?: string;
    issue?: string;
    task?: string;
    ref?: string;
  };
}

export interface AnalysisUnknown {
  code: string;
  message: string;
  subjects?: LogicalId[];
}

export interface SourceReference {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  reason: string;
}

export interface AnalysisHealth {
  status: "healthy" | "partial" | "review-required" | "protected" | "unknown";
  score: number;
  staleEvidence: number;
  modelGaps: number;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface SemanticDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  subject?: LogicalId;
  path?: string;
  details?: JsonValue;
}

export interface AnalysisState {
  health: AnalysisHealth;
  reviewLevel: ReviewLevel;
  semanticDelta: SemanticDelta;
  facts: SemanticFact[];
  claims: SemanticClaim[];
  unknowns: AnalysisUnknown[];
  recommendedSourceReads: SourceReference[];
  diagnostics: SemanticDiagnostic[];
  verification?: VerificationAnalysis;
}

export type DigestAlgorithm = "sha256" | (string & {});

export interface ContentDigest {
  algorithm: DigestAlgorithm;
  value: string;
}

export interface GitIdentity {
  revision?: string;
  tree?: string;
}

export interface WorktreeIdentity {
  id: LogicalId;
  root?: string;
  branch?: string;
  gitCommonDir?: string;
  dirty?: boolean;
}

export interface TrackedFileFingerprint {
  path: string;
  physicalFingerprint: ContentDigest;
  semanticFingerprint?: ContentDigest;
  extractorFingerprint?: ContentDigest;
}

export interface ExtractorFingerprint {
  id: string;
  version: string;
  optionsFingerprint?: ContentDigest;
}

export type IntegrityStatus = "fresh" | "stale" | "invalid";

export interface RepositoryIntegrity {
  repositoryId: LogicalId;
  git?: GitIdentity;
  worktree: WorktreeIdentity;
  trackedFiles: TrackedFileFingerprint[];
  extractors: ExtractorFingerprint[];
  schemaVersion: SchemaVersion;
  semanticStateDigest: ContentDigest;
  modelDigest: ContentDigest;
  snapshotDigest: ContentDigest;
  status: IntegrityStatus;
  statusReason?: string;
}

export interface RepositorySemanticSnapshot {
  schemaVersion: SchemaVersion;
  modelVersion: ModelVersion;
  repositoryIdentity: RepositoryIdentity;
  revisionIdentity?: RevisionIdentity;
  declarations: DeclaredState;
  derived: DerivedState;
  observed: ObservedState;
  analysis: AnalysisState;
  integrity: RepositoryIntegrity;
  graph: UniversalRelationGraph;
}

export type SnapshotValidationResult =
  | { ok: true; snapshot: RepositorySemanticSnapshot; diagnostics: SemanticDiagnostic[] }
  | { ok: false; diagnostics: SemanticDiagnostic[] };
