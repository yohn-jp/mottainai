import type { LogicalId } from "./ids.js";

export const NODE_KINDS = [
  "repository",
  "package",
  "module",
  "file",
  "symbol",
  "component",
  "contract",
  "invariant",
  "decision",
  "policy",
  "test",
  "document",
  "document_section",
] as const;

export type KnownNodeKind = (typeof NODE_KINDS)[number];
/** v1の既知語彙を補完しつつ、将来のkindを保存可能にする開放型。 */
export type NodeKind = KnownNodeKind | string;

export const RELATIONSHIP_KINDS = [
  "contains",
  "defines",
  "references",
  "imports",
  "calls",
  "implements",
  "implemented_by",
  "tests",
  "documents",
  "governs",
  "constrained_by",
  "evidence_for",
  "resolves_to",
  "binds_to",
] as const;

export type KnownRelationshipKind = (typeof RELATIONSHIP_KINDS)[number];
/** DB enumに固定せず、未知の将来edge kindをそのまま保持する。 */
export type RelationshipKind = KnownRelationshipKind | string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ExtensionMetadata = Record<string, JsonValue>;

export type SchemaVersion = 1;
export const CURRENT_SCHEMA_VERSION: SchemaVersion = 1;

export type ProvenanceKind = "declared" | "derived" | "observed" | "inferred";
export type Completeness = "complete" | "partial" | "unknown";
export type AmbiguityStatus = "none" | "possible" | "ambiguous";

export interface ProducerIdentity {
  name: string;
  version: string;
}

export interface SourceRevision {
  repositoryId: LogicalId;
  revisionId: LogicalId;
}

export interface EvidenceReference {
  kind: string;
  ref: string;
  target?: LogicalId;
  locator?: PhysicalLocator;
  note?: string;
}

export interface AmbiguityMetadata {
  status: AmbiguityStatus;
  reason?: string;
  candidates?: LogicalId[];
}

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
  /** 物理位置。logicalIdの生成には使わない。 */
  range?: SourceRange;
}

export interface FileLocator {
  kind: "file";
  path: string;
  package?: string;
  module?: string;
  language?: string;
  /** 物理位置。logicalIdの生成には使わない。 */
  range?: SourceRange;
}

export interface ModuleLocator {
  kind: "module";
  name: string;
  package?: string;
  file?: string;
  /** 物理位置。logicalIdの生成には使わない。 */
  range?: SourceRange;
}

export interface DocumentLocator {
  kind: "document";
  path: string;
  section?: string;
  /** 物理位置。logicalIdの生成には使わない。 */
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

export interface SemanticNodeBase {
  identity: NodeIdentity;
  name: string;
  description?: string;
  provenance: Provenance;
  contract?: Contract;
  metadata?: ExtensionMetadata;
}

export type KnownSemanticNode = {
  [Kind in KnownNodeKind]: SemanticNodeBase & { kind: Kind }
}[KnownNodeKind];

/** v1外のkindも保存できる拡張node。既知kindはKnownSemanticNodeで型分岐可能。 */
export interface ExtendedSemanticNode extends SemanticNodeBase {
  kind: string;
}

export type SemanticNode = KnownSemanticNode | ExtendedSemanticNode;

export interface SemanticEdge {
  id: LogicalId;
  kind: RelationshipKind;
  from: LogicalId;
  to: LogicalId;
  provenance: Provenance;
  metadata?: ExtensionMetadata;
}

export interface SemanticFact {
  id: LogicalId;
  subject: LogicalId;
  predicate: string;
  value: JsonValue;
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
  provenance: Provenance;
  metadata?: ExtensionMetadata;
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

export interface AnalysisUnknown {
  code: string;
  message: string;
  subjects?: LogicalId[];
}

export interface AnalysisSummary {
  completeness: Completeness;
  unknowns: AnalysisUnknown[];
}

export interface RepositorySemanticSnapshot {
  schemaVersion: SchemaVersion;
  repositoryIdentity: RepositoryIdentity;
  revisionIdentity: RevisionIdentity;
  analysis: AnalysisSummary;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  facts: SemanticFact[];
  claims: SemanticClaim[];
  diagnostics: SemanticDiagnostic[];
}

export type SnapshotValidationResult =
  | { ok: true; snapshot: RepositorySemanticSnapshot; diagnostics: SemanticDiagnostic[] }
  | { ok: false; diagnostics: SemanticDiagnostic[] };
