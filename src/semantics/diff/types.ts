import type { EffectAnalysis, EffectAnalysisDelta, EffectViolation } from "../effects/types.js";
import type { LogicalId } from "../ir/ids.js";
import type {
  ContentDigest,
  JsonValue,
  RepositorySemanticSnapshot,
  ReviewLevel,
  SemanticDeltaKind,
  SemanticIntent,
  SemanticTransaction,
  SourceReference,
} from "../ir/types.js";

export const SEMANTIC_CHANGE_SET_VERSION = 1 as const;
export const DIFF_ENGINE_PRODUCER = "mottainai-semantic-diff-engine" as const;

export type ChangeKind = "added" | "removed" | "modified" | "moved" | "renamed" | "identity-ambiguous";
export type IdentityStatus = "unchanged" | "moved" | "renamed" | "changed" | "added" | "removed" | "ambiguous";

/** A model/physical difference which is deliberately not itself a semantic delta. */
export interface DerivedChange {
  id: string;
  entityId: LogicalId;
  entityKind: string;
  path: string;
  changeKind: ChangeKind;
  before?: JsonValue;
  after?: JsonValue;
  summary: string;
}

export interface SymbolChange {
  beforeId?: LogicalId;
  afterId?: LogicalId;
  identityStatus: IdentityStatus;
  beforeFile?: string;
  afterFile?: string;
  beforeSymbol?: string;
  afterSymbol?: string;
  derivedChangeIds: readonly string[];
  semanticDeltaIds: readonly string[];
}

export type CompatibilityResult = "unchanged" | "compatible" | "review-required" | "breaking" | "unknown";

/** Canonical semantic meaning change. Only the seven v1 kinds can occur here. */
export interface SemanticDeltaRecord {
  id: string;
  subject: LogicalId;
  kind: SemanticDeltaKind;
  summary: string;
  reviewLevel: ReviewLevel;
  compatibility: CompatibilityResult;
  sourceChangeIds: readonly string[];
  protected: boolean;
  breaking: boolean;
}

export interface UnknownRegion {
  id: string;
  code: string;
  message: string;
  subjects: readonly LogicalId[];
  material: true;
  recommendedSourceReads: readonly SourceReference[];
}

export interface EvidenceRefreshNeed {
  id: string;
  subject: LogicalId;
  evidenceIds: readonly LogicalId[];
  testIds: readonly LogicalId[];
  required: boolean;
  reason: string;
  sourceReads: readonly SourceReference[];
}

export interface ImpactPath {
  entityIds: readonly LogicalId[];
  stopReason: string;
  propagated: boolean;
}

export interface PropagationStopPoint {
  entityId: LogicalId;
  componentId?: LogicalId;
  reason: string;
  path: readonly LogicalId[];
}

export type TransactionComparisonStatus =
  | "not-provided"
  | "matched"
  | "unauthorized"
  | "excess"
  | "missing"
  | "excess-and-missing";

export interface AuthorizedActualComparison {
  transactionId?: string;
  intent?: SemanticIntent;
  authorizedKinds: readonly SemanticDeltaKind[];
  actualKinds: readonly SemanticDeltaKind[];
  excessKinds: readonly SemanticDeltaKind[];
  missingKinds: readonly SemanticDeltaKind[];
  status: TransactionComparisonStatus;
  unauthorized: boolean;
  stopEvent?: {
    kind: "unauthorized-semantic-delta";
    level: "L3";
    reason: string;
  };
}

export interface SemanticChangeSet {
  version: typeof SEMANTIC_CHANGE_SET_VERSION;
  apiVersion: "v1";
  baseSnapshotId: string;
  headSnapshotId: string;
  baseSnapshotDigest: ContentDigest;
  headSnapshotDigest: ContentDigest;
  baseRevision: string;
  headRevision: string;
  changedFiles: readonly LogicalId[];
  changedSymbols: readonly LogicalId[];
  symbolChanges: readonly SymbolChange[];
  changedComponents: readonly LogicalId[];
  derivedChanges: readonly DerivedChange[];
  semanticDeltas: readonly SemanticDeltaRecord[];
  contractChanges: readonly SemanticDeltaRecord[];
  effectChanges: readonly SemanticDeltaRecord[];
  invariantChanges: readonly SemanticDeltaRecord[];
  dependencyPolicyChanges: readonly SemanticDeltaRecord[];
  publicSurfaceChanges: readonly SemanticDeltaRecord[];
  responsibilityChanges: readonly SemanticDeltaRecord[];
  capabilityChanges: readonly SemanticDeltaRecord[];
  authorizedVsActual: AuthorizedActualComparison;
  affectedEntities: readonly LogicalId[];
  impactPaths: readonly ImpactPath[];
  propagationStopPoints: readonly PropagationStopPoint[];
  evidenceRefreshNeeds: readonly EvidenceRefreshNeed[];
  unknownRegions: readonly UnknownRegion[];
  reviewLevel: ReviewLevel;
  reviewReasons: readonly string[];
  recommendedSourceReads: readonly SourceReference[];
  /** Existing #51 violations are consumed as evidence; the diff engine never recomputes effects. */
  effectViolations: readonly EffectViolation[];
  provenance: {
    producer: typeof DIFF_ENGINE_PRODUCER;
    version: "1.0.0";
    note: string;
  };
}

export interface EffectInputs {
  delta?: EffectAnalysisDelta;
  before?: EffectAnalysis;
  after?: EffectAnalysis;
}

export interface SemanticDiffOptions {
  transaction?: SemanticTransaction;
  effectDelta?: EffectAnalysisDelta;
  effects?: EffectInputs;
  /** Upper bound for graph propagation. Omit for the deterministic default. */
  maxImpactDepth?: number;
}

export interface SemanticDiffInput extends SemanticDiffOptions {
  baseSnapshot: RepositorySemanticSnapshot;
  headSnapshot: RepositorySemanticSnapshot;
}
