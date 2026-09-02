export type AutonomousReviewResultSchemaVersion = "mottainai.autonomous-review.result/v1";

export type AutonomousReviewVerdict = "APPROVE" | "CHANGES_REQUIRED" | "INCONCLUSIVE";

export type AutonomousReviewStatus = "pending" | "complete" | "failed";

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type ReviewFindingStatus = "new" | "open" | "resolved" | "accepted" | "dismissed" | "superseded";

export interface AutonomousReviewIdentity {
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
}

export interface ReviewEvidenceReference {
  resource: string;
  reference: string;
  excerpt?: string;
}

export interface ReviewSourcePosition {
  line: number;
  column?: number;
}

export interface ReviewSourceLocation {
  path: string;
  start: ReviewSourcePosition;
  end: ReviewSourcePosition;
}

export interface AutonomousReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  blocking: boolean;
  title: string;
  rationale: string;
  evidence: ReviewEvidenceReference[];
  location?: ReviewSourceLocation;
  status: ReviewFindingStatus;
}

export interface InspectedReviewInput {
  resource: string;
  references?: string[];
}

export interface OmittedReviewInput {
  resource: string;
  reason: string;
}

export interface AutonomousReviewInputs {
  inspected: InspectedReviewInput[];
  omitted: OmittedReviewInput[];
}

export interface AutonomousReviewUnknown {
  id: string;
  reason: string;
}

export interface AutonomousReviewResult {
  schemaVersion: AutonomousReviewResultSchemaVersion;
  identity: AutonomousReviewIdentity;
  status: AutonomousReviewStatus;
  verdict: AutonomousReviewVerdict;
  findings: AutonomousReviewFinding[];
  confidence: number;
  inputs: AutonomousReviewInputs;
  unknowns: AutonomousReviewUnknown[];
}
