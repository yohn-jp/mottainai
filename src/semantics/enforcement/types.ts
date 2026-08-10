import type { EffectAnalysis } from "../effects/types.js";
import type { LogicalId } from "../ir/ids.js";
import type {
  ContentDigest,
  IntegrityStatus,
  RepositorySemanticSnapshot,
  ReviewLevel,
  SemanticDiagnostic,
  SemanticIntent,
  SemanticTransaction,
  SourceReference,
} from "../ir/types.js";
import type { SemanticChangeSet } from "../diff/types.js";
import type { VerificationPlan } from "../verification/planner.js";

export const SEMANTIC_ENFORCEMENT_API_VERSION = "v1" as const;
export const SEMANTIC_ENFORCEMENT_MODES = ["off", "observe", "warn", "enforce"] as const;
export type SemanticEnforcementMode = (typeof SEMANTIC_ENFORCEMENT_MODES)[number];

export type SemanticEnforcementDecision = "allow" | "observe" | "warn" | "block";

export interface SemanticBlocker {
  code: string;
  message: string;
  subject?: LogicalId;
  path?: string;
  details?: Record<string, unknown>;
}

export interface SemanticIntegrityReport {
  status: IntegrityStatus;
  sourceAvailable: boolean;
  sourceCanonical: boolean;
  directEdits: readonly string[];
  staleReasons: readonly string[];
  diagnostics: readonly SemanticDiagnostic[];
  snapshotDigest?: ContentDigest;
}

export interface SemanticOwnershipReport {
  managedSymbolIds: readonly LogicalId[];
  ownedSymbolIds: readonly LogicalId[];
  sharedSymbolIds: readonly LogicalId[];
  missingSymbolIds: readonly LogicalId[];
  invalidSymbolIds: readonly LogicalId[];
}

export interface SemanticCommentFinding {
  path: string;
  line: number;
  column: number;
  kind: "human" | "todo-debt-intent" | "jsdoc" | "allowed";
  text: string;
  reason: string;
}

export interface SemanticCommentReport {
  managedPaths: readonly string[];
  findings: readonly SemanticCommentFinding[];
  humanCommentCount: number;
  todoDebtCount: number;
  jsdocCount: number;
  allowedCount: number;
}

export interface SemanticTransactionReport {
  provided: boolean;
  intent?: SemanticIntent;
  actualKinds: readonly string[];
  authorizedKinds: readonly string[];
  status: string;
  unauthorized: boolean;
  missing: boolean;
  directEdit: boolean;
}

export interface SemanticReviewReport {
  level: ReviewLevel;
  reasons: readonly string[];
  l3: boolean;
  protectedSubjects: readonly LogicalId[];
  recommendedSourceReads: readonly SourceReference[];
}

/** Bounded projection of the canonical #54 Change Set for CLI/CI consumers. */
export interface SemanticDiffSummary {
  baseSnapshotId: string;
  headSnapshotId: string;
  changedFiles: readonly LogicalId[];
  changedSymbols: readonly LogicalId[];
  changedComponents: readonly LogicalId[];
  semanticDeltas: readonly {
    subject: LogicalId;
    kind: string;
    summary: string;
    reviewLevel: ReviewLevel;
    compatibility: string;
    protected: boolean;
    breaking: boolean;
  }[];
  affectedEntities: readonly LogicalId[];
  evidenceRefreshNeeds: readonly string[];
  unknownRegions: readonly string[];
  authorizedVsActual: {
    status: string;
    authorizedKinds: readonly string[];
    actualKinds: readonly string[];
    excessKinds: readonly string[];
    missingKinds: readonly string[];
    unauthorized: boolean;
  };
  reviewLevel: ReviewLevel;
  reviewReasons: readonly string[];
  recommendedSourceReads: readonly SourceReference[];
}

export interface SemanticVerificationReport {
  status: VerificationPlan["status"] | "unavailable";
  sufficient: boolean;
  missing: readonly string[];
  stale: readonly string[];
  failed: readonly string[];
  uncertain: readonly string[];
}

export interface SemanticEffectReport {
  status: "conforming" | "violation" | "unknown" | "unavailable";
  violations: number;
  unknowns: number;
  completeness?: string;
}

export interface SemanticManagedScope {
  paths: readonly string[];
  symbolIds: readonly LogicalId[];
  fullyManaged: boolean;
}

export interface SemanticEnforcementOptions {
  rootDir?: string;
  /** Optional Git ref used as the canonical source baseline for CI/direct-edit checks. */
  baselineRef?: string;
  environment?: NodeJS.ProcessEnv;
  mode?: SemanticEnforcementMode;
  snapshot?: RepositorySemanticSnapshot;
  baseSnapshot?: RepositorySemanticSnapshot;
  transaction?: SemanticTransaction;
  intent?: SemanticIntent;
  changeSet?: SemanticChangeSet;
  effectAnalysis?: EffectAnalysis;
  baseEffectAnalysis?: EffectAnalysis;
  verificationPlan?: VerificationPlan;
  managedPaths?: readonly string[];
  managedSymbolIds?: readonly LogicalId[];
  /** Default true whenever a managed scope is supplied. */
  commentZero?: boolean;
  /** A caller may explicitly state that the current source came from the mutation boundary. */
  supportedMutation?: boolean;
}

export interface SemanticEnforcementReport {
  apiVersion: typeof SEMANTIC_ENFORCEMENT_API_VERSION;
  mode: SemanticEnforcementMode;
  decision: SemanticEnforcementDecision;
  authoritative: boolean;
  managed: SemanticManagedScope;
  integrity: SemanticIntegrityReport;
  ownership: SemanticOwnershipReport;
  comments: SemanticCommentReport;
  transaction: SemanticTransactionReport;
  diff?: SemanticDiffSummary;
  review: SemanticReviewReport;
  verification: SemanticVerificationReport;
  effects: SemanticEffectReport;
  blockers: readonly SemanticBlocker[];
  warnings: readonly SemanticBlocker[];
  diagnostics: readonly SemanticDiagnostic[];
  query: {
    available: boolean;
    successful: boolean;
    provider?: string;
    reason?: string;
  };
  provenance: {
    producer: "mottainai-semantic-enforcement";
    version: "1.0.0";
    authority: "analysis";
  };
}
