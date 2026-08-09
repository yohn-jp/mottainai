import { compareText } from "../ir/canonical.js";
import type { VerificationAssessment, VerificationSummary } from "../ir/types.js";
import type { Provenance, VerificationGapView, VerificationHealthView, VerificationView } from "../query.js";

/** Convert canonical analysis records into the additive query projection without changing adequacy truth. */
export function toVerificationHealthView(
  summary: VerificationSummary,
  assessments: readonly VerificationAssessment[],
): VerificationHealthView {
  const gaps: VerificationGapView[] = assessments
    .filter((assessment) => assessment.status !== "satisfied")
    .map((assessment) => ({
      requirementId: assessment.requirementId,
      perspectiveId: assessment.perspectiveId,
      targetId: assessment.target.id,
      targetKind: assessment.target.kind,
      strength: assessment.strength,
      status: assessment.status,
      evidenceIds: assessment.evidenceIds,
      missingEvidenceKinds: assessment.missingEvidenceKinds ?? [],
    }))
    .sort((left, right) =>
      compareText(`${left.targetId}:${left.requirementId}`, `${right.targetId}:${right.requirementId}`),
    );
  return {
    ...summary,
    gapRequirementIds: summary.gapRequirementIds,
    gaps,
  };
}

export function toVerificationView(
  summary: VerificationSummary,
  assessments: readonly VerificationAssessment[],
  provenance: Provenance,
): VerificationView {
  return {
    apiVersion: "v1",
    target: { id: summary.targetId, kind: summary.scope },
    health: toVerificationHealthView(summary, assessments),
    provenance,
  };
}
