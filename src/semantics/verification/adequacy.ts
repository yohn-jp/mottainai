import { compareText } from "../ir/canonical.js";
import { createLogicalId } from "../ir/ids.js";
import type {
  ProducerIdentity,
  SourceRevision,
  VerificationAnalysis,
  VerificationAssessment,
  VerificationCounts,
  VerificationEvidence,
  VerificationEvidenceStrength,
  VerificationHealthStatus,
  VerificationPerspective,
  VerificationRequirement,
  VerificationScopeKind,
  VerificationSummary,
  VerificationTarget,
} from "../ir/types.js";
import type { LogicalId } from "../ir/ids.js";

export const SECURITY_DENIAL_PERSPECTIVE_ID = createLogicalId("perspective", "security-denial");
export const SECURITY_ESCALATION_PERSPECTIVE_ID = createLogicalId("perspective", "security-escalation");
export const EFFECT_FAILURE_PERSPECTIVE_ID = createLogicalId("perspective", "effect-failure");

export interface VerificationAggregationScope {
  scope: VerificationScopeKind;
  targetId: LogicalId;
  /** Descendant targets are explicit so aggregation never guesses ownership or hierarchy. */
  memberTargetIds?: readonly LogicalId[];
}

export interface KnownVerificationFacts {
  sourceRevision: SourceRevision;
  authorizationBoundaries?: readonly VerificationTarget[];
  effectfulSymbols?: readonly VerificationTarget[];
  producer?: ProducerIdentity;
}

const EVIDENCE_STRENGTH_RANK: Readonly<Record<string, number>> = {
  association: 0,
  observation: 1,
  verification: 2,
};

function evidenceStrengthRank(strength: VerificationEvidenceStrength | undefined): number {
  return strength === undefined ? -1 : (EVIDENCE_STRENGTH_RANK[strength] ?? -1);
}

function targetKey(target: VerificationTarget): string {
  return `${target.kind}:${target.id}`;
}

function isAuthoritativeRequirement(requirement: VerificationRequirement): boolean {
  return requirement.authority === "declared" || requirement.authority === "derived";
}

function minimumEvidenceRank(requirement: VerificationRequirement): number {
  const configured = evidenceStrengthRank(requirement.minimumEvidenceStrength ?? "verification");
  if (configured < 0) return -1;
  // Required perspectives always need proof-strength evidence, even if a caller requests a weaker floor.
  return requirement.strength === "required" ? Math.max(configured, EVIDENCE_STRENGTH_RANK.verification!) : configured;
}

function evidenceCanSatisfy(requirement: VerificationRequirement, evidence: VerificationEvidence): boolean {
  if (evidence.status !== "passed" || evidence.freshness !== "current") return false;
  const minimumRank = minimumEvidenceRank(requirement);
  return minimumRank >= 0 && evidenceStrengthRank(evidence.strength) >= minimumRank;
}

function assessmentFor(
  requirement: VerificationRequirement,
  evidence: readonly VerificationEvidence[],
  perspective: VerificationPerspective | undefined,
): VerificationAssessment {
  const matching = evidence
    .filter(
      (item) =>
        targetKey(item.target) === targetKey(requirement.target) && item.perspectiveId === requirement.perspectiveId,
    )
    .sort((left, right) => compareText(left.id, right.id));
  const evidenceIds = matching.map((item) => item.id);

  if (perspective === undefined || perspective.known === false) {
    return {
      requirementId: requirement.id,
      target: requirement.target,
      perspectiveId: requirement.perspectiveId,
      strength: requirement.strength,
      status: "unknown",
      evidenceIds,
      satisfyingEvidenceIds: [],
      ...(matching.length === 0
        ? {}
        : { missingEvidenceKinds: [...new Set(matching.map((item) => item.kind))].sort(compareText) }),
    };
  }

  const failed = matching.filter((item) => item.status === "failed");
  if (failed.length > 0) {
    return {
      requirementId: requirement.id,
      target: requirement.target,
      perspectiveId: requirement.perspectiveId,
      strength: requirement.strength,
      status: "failed",
      evidenceIds,
      satisfyingEvidenceIds: [],
    };
  }

  const satisfying = matching.filter((item) => evidenceCanSatisfy(requirement, item));
  if (satisfying.length > 0) {
    return {
      requirementId: requirement.id,
      target: requirement.target,
      perspectiveId: requirement.perspectiveId,
      strength: requirement.strength,
      status: "satisfied",
      evidenceIds,
      satisfyingEvidenceIds: satisfying.map((item) => item.id),
    };
  }

  const staleSufficient = matching.filter(
    (item) =>
      minimumEvidenceRank(requirement) >= 0 &&
      item.status === "passed" &&
      item.freshness === "stale" &&
      evidenceStrengthRank(item.strength) >= minimumEvidenceRank(requirement),
  );
  if (staleSufficient.length > 0) {
    return {
      requirementId: requirement.id,
      target: requirement.target,
      perspectiveId: requirement.perspectiveId,
      strength: requirement.strength,
      status: "stale",
      evidenceIds,
      satisfyingEvidenceIds: [],
    };
  }

  if (matching.length === 0) {
    return {
      requirementId: requirement.id,
      target: requirement.target,
      perspectiveId: requirement.perspectiveId,
      strength: requirement.strength,
      status: "missing",
      evidenceIds: [],
      satisfyingEvidenceIds: [],
    };
  }

  return {
    requirementId: requirement.id,
    target: requirement.target,
    perspectiveId: requirement.perspectiveId,
    strength: requirement.strength,
    status: "inadequate",
    evidenceIds,
    satisfyingEvidenceIds: [],
    missingEvidenceKinds: [...new Set(matching.map((item) => item.kind))].sort(compareText),
  };
}

/** Compare authoritative requirements with observed evidence without side effects or provider-specific inference. */
export function evaluateVerification(
  requirements: readonly VerificationRequirement[],
  evidence: readonly VerificationEvidence[],
  perspectives: readonly VerificationPerspective[],
): VerificationAssessment[] {
  const perspectiveById = new Map(perspectives.map((perspective) => [perspective.id, perspective]));
  return requirements
    .filter(isAuthoritativeRequirement)
    .map((requirement) => assessmentFor(requirement, evidence, perspectiveById.get(requirement.perspectiveId)))
    .sort((left, right) =>
      compareText(`${left.target.id}:${left.requirementId}`, `${right.target.id}:${right.requirementId}`),
    );
}

function emptyCounts(): VerificationCounts {
  return { total: 0, satisfied: 0, missing: 0, stale: 0, failed: 0, inadequate: 0, unknown: 0 };
}

function countAssessment(counts: VerificationCounts, status: VerificationAssessment["status"]): void {
  counts.total += 1;
  if (status === "satisfied") counts.satisfied += 1;
  else if (status === "missing") counts.missing += 1;
  else if (status === "stale") counts.stale += 1;
  else if (status === "failed") counts.failed += 1;
  else if (status === "inadequate") counts.inadequate += 1;
  else counts.unknown += 1;
}

function healthStatus(required: VerificationCounts, recommended: VerificationCounts): VerificationHealthStatus {
  if (required.total === 0 && recommended.total === 0) return "unknown";
  if (required.failed > 0) return "failed";
  if (required.unknown > 0) return "unknown";
  if (required.missing + required.stale + required.inadequate > 0) return "incomplete";
  return "healthy";
}

/** Aggregate explicit assessment membership into a Symbol, Component, or Project summary. */
export function aggregateVerification(
  assessments: readonly VerificationAssessment[],
  scope: VerificationAggregationScope,
): VerificationSummary {
  const memberIds = new Set([scope.targetId, ...(scope.memberTargetIds ?? [])]);
  const selected = assessments.filter((assessment) => memberIds.has(assessment.target.id));
  const required = emptyCounts();
  const recommended = emptyCounts();
  const gapRequirementIds = new Set<LogicalId>();

  for (const assessment of selected) {
    const counts = assessment.strength === "required" ? required : recommended;
    countAssessment(counts, assessment.status);
    if (assessment.status !== "satisfied") gapRequirementIds.add(assessment.requirementId);
  }

  const status = healthStatus(required, recommended);
  const score =
    required.total === 0
      ? recommended.total === 0
        ? 0
        : 100
      : Math.floor((required.satisfied / required.total) * 100);
  return {
    scope: scope.scope,
    targetId: scope.targetId,
    status,
    score,
    required,
    recommended,
    gapRequirementIds: [...gapRequirementIds].sort(compareText),
  };
}

/** Build the analysis projection for detailed Symbol assessments and explicit aggregate scopes. */
export function buildVerificationAnalysis(
  requirements: readonly VerificationRequirement[],
  evidence: readonly VerificationEvidence[],
  perspectives: readonly VerificationPerspective[],
  scopes: readonly VerificationAggregationScope[],
  inferredRequirements: readonly VerificationRequirement[] = [],
): VerificationAnalysis {
  const assessments = evaluateVerification(requirements, evidence, perspectives);
  return {
    authority: "analysis",
    assessments,
    summaries: scopes.map((scope) => aggregateVerification(assessments, scope)),
    ...(inferredRequirements.length === 0 ? {} : { inferredRequirements: [...inferredRequirements] }),
  };
}

function derivedRequirement(
  target: VerificationTarget,
  perspectiveId: LogicalId,
  ruleId: string,
  rationale: string,
  sourceRevision: SourceRevision,
  producer: ProducerIdentity,
): VerificationRequirement {
  return {
    id: createLogicalId("requirement", `${ruleId}:${target.kind}:${target.id}`),
    target,
    perspectiveId,
    strength: "required",
    rationale,
    requirementProvenance: { kind: "deterministic-derived-rule", ruleId },
    minimumEvidenceStrength: "verification",
    authority: "derived",
    provenance: { kind: "derived", producer, sourceRevision, completeness: "complete" },
  };
}

/** Consume caller-supplied known facts; this function does not inspect or infer effects/authorization. */
export function deriveVerificationRequirements(facts: KnownVerificationFacts): VerificationRequirement[] {
  const producer = facts.producer ?? { name: "mottainai-verification-rules", version: "1" };
  const requirements = [
    ...(facts.authorizationBoundaries ?? []).flatMap((target) => [
      derivedRequirement(
        target,
        SECURITY_DENIAL_PERSPECTIVE_ID,
        "known-authorization-boundary-denial",
        "A known authorization boundary requires denial evidence.",
        facts.sourceRevision,
        producer,
      ),
      derivedRequirement(
        target,
        SECURITY_ESCALATION_PERSPECTIVE_ID,
        "known-authorization-boundary-escalation",
        "A known authorization boundary requires escalation evidence.",
        facts.sourceRevision,
        producer,
      ),
    ]),
    ...(facts.effectfulSymbols ?? []).map((target) =>
      derivedRequirement(
        target,
        EFFECT_FAILURE_PERSPECTIVE_ID,
        "known-effectful-symbol-failure",
        "A known effectful Symbol requires effect-failure evidence.",
        facts.sourceRevision,
        producer,
      ),
    ),
  ];
  return requirements.sort((left, right) => compareText(left.id, right.id));
}
