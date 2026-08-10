import { compareText } from "../ir/canonical.js";
import type { LogicalId } from "../ir/ids.js";
import type {
  RepositorySemanticSnapshot,
  SemanticDeltaKind,
  VerificationAssessment,
  VerificationAssessmentStatus,
  VerificationEvidence,
  VerificationRequirement,
  VerificationTargetKind,
} from "../ir/types.js";
import type { SemanticChangeSet } from "../diff/types.js";

export const VERIFICATION_PLAN_VERSION = 1 as const;
export const VERIFICATION_PLANNER_PRODUCER = "mottainai-verification-planner" as const;

export type VerificationPlanMode = "shadow";
export type VerificationPlanStatus = "sufficient" | "broader-verification-required";
export type VerificationPlanItemKind =
  | "test"
  | "static"
  | "type"
  | "build"
  | "package"
  | "perspective"
  | "contract"
  | "invariant"
  | "full";
export type VerificationPlanItemState =
  | "must-run"
  | "must-verify"
  | "missing"
  | "stale"
  | "failed"
  | "uncertain"
  | "skipped";

export type VerificationPlannerSourceKind =
  | "semantic-delta"
  | "semantic-impact"
  | "verification-requirement"
  | "verification-evidence"
  | "model-integrity"
  | "shadow-observation";

/** Machine-readable reason for a planner decision; the planner never invents upstream facts. */
export interface VerificationPlanProvenance {
  authority: "analysis";
  producer: typeof VERIFICATION_PLANNER_PRODUCER;
  ruleId: string;
  reasonCode: string;
  sourceKinds: readonly VerificationPlannerSourceKind[];
  sourceIds: readonly string[];
  changedSymbolIds: readonly LogicalId[];
  affectedEntityIds: readonly LogicalId[];
  explanation: string;
  confidence: "deterministic" | "conservative";
}

export interface VerificationCheckDefinition {
  id: string;
  kind: "static" | "type" | "build" | "package";
  command: string;
  /** Empty means the check is not selected by the default semantic-change rules. */
  requiredFor: readonly ("any-change" | SemanticDeltaKind)[];
}

export interface FullVerificationDefinition {
  id: string;
  command: string;
  label: string;
}

export interface VerificationPlannerInput {
  /** Canonical #54 result. Omitting it is an explicit uncertainty and requires full verification. */
  changeSet?: SemanticChangeSet;
  /** Live #53 snapshot containing #86 authoritative requirements/evidence and analysis assessments. */
  snapshot?: RepositorySemanticSnapshot;
  mode?: VerificationPlanMode;
  checks?: readonly VerificationCheckDefinition[];
  fullVerification?: FullVerificationDefinition;
}

export interface VerificationPlanItem {
  id: string;
  kind: VerificationPlanItemKind;
  state: VerificationPlanItemState;
  label: string;
  command?: string;
  testId?: LogicalId;
  targetIds: readonly LogicalId[];
  requirementIds: readonly LogicalId[];
  perspectiveIds: readonly LogicalId[];
  evidenceIds: readonly LogicalId[];
  required: boolean;
  evidenceStatus?: VerificationAssessmentStatus;
  provenance: VerificationPlanProvenance;
}

export interface BroaderVerificationRequirement {
  required: true;
  command: string;
  reasonCodes: readonly string[];
  reasons: readonly string[];
  provenance: VerificationPlanProvenance;
}

export interface VerificationPlan {
  apiVersion: "v1";
  version: typeof VERIFICATION_PLAN_VERSION;
  mode: VerificationPlanMode;
  status: VerificationPlanStatus;
  sufficient: boolean;
  changedSymbolIds: readonly LogicalId[];
  affectedEntityIds: readonly LogicalId[];
  selectionTargetIds: readonly LogicalId[];
  predictedItemIds: readonly string[];
  items: readonly VerificationPlanItem[];
  requiredTests: readonly VerificationPlanItem[];
  requiredChecks: readonly VerificationPlanItem[];
  requiredEvidence: readonly VerificationPlanItem[];
  mustRun: readonly VerificationPlanItem[];
  mustVerify: readonly VerificationPlanItem[];
  missing: readonly VerificationPlanItem[];
  stale: readonly VerificationPlanItem[];
  failed: readonly VerificationPlanItem[];
  uncertain: readonly VerificationPlanItem[];
  skipped: readonly VerificationPlanItem[];
  broaderVerification: BroaderVerificationRequirement | undefined;
  fullVerification: VerificationPlanItem;
  provenance: VerificationPlanProvenance;
}

export type VerificationRunStatus = "passed" | "failed" | "skipped" | "unknown";

export interface VerificationRunObservation {
  suite: "selected" | "full";
  status: VerificationRunStatus;
  executedItemIds: readonly string[];
  failedItemIds: readonly string[];
  /** Independent oracle for affected verification items, when the full runner can provide it. */
  relevantItemIds?: readonly string[];
  durationMs: number;
}

export interface VerificationShadowMiss {
  id: string;
  observedItemId: string;
  summary: string;
  targetIds: readonly LogicalId[];
  requirementIds: readonly LogicalId[];
  provenance: VerificationPlanProvenance;
}

export interface VerificationShadowMetrics {
  selectionRecall: number;
  predictedItemCount: number;
  observedRelevantItemCount: number;
  coveredRelevantItemCount: number;
  missCount: number;
  unnecessarySelectionCount: number;
  overSelectionRate: number;
  selectedRuntimeMs: number;
  fullRuntimeMs: number;
  runtimeReductionMs: number;
  runtimeReductionRatio: number;
}

export interface VerificationPromotionRecord {
  eligible: false;
  status: "not-authorized";
  reasonCode: "explicit-evidence-gate-required";
  explanation: string;
}

export interface VerificationShadowComparison {
  apiVersion: "v1";
  mode: "shadow";
  status: "no-miss" | "miss" | "inconclusive";
  plan: VerificationPlan;
  selected: VerificationRunObservation;
  full: VerificationRunObservation;
  metrics: VerificationShadowMetrics;
  misses: readonly VerificationShadowMiss[];
  promotion: VerificationPromotionRecord;
  provenance: VerificationPlanProvenance;
}

export interface VerificationShadowRunners {
  runSelected(plan: VerificationPlan): Promise<VerificationRunObservation>;
  runFull(plan: VerificationPlan): Promise<VerificationRunObservation>;
}

export const DEFAULT_VERIFICATION_CHECKS: readonly VerificationCheckDefinition[] = [
  { id: "static-analysis", kind: "static", command: "pnpm run lint", requiredFor: ["any-change"] },
  { id: "typecheck", kind: "type", command: "pnpm run typecheck", requiredFor: ["any-change"] },
  {
    id: "build",
    kind: "build",
    command: "pnpm run build",
    requiredFor: ["contract", "capability", "effect", "invariant", "dependency-policy", "public-surface"],
  },
  {
    id: "package",
    kind: "package",
    command: "pnpm run test:package",
    requiredFor: ["dependency-policy", "public-surface"],
  },
] as const;

export const DEFAULT_FULL_VERIFICATION: FullVerificationDefinition = {
  id: "full-repository-verification",
  command: "pnpm run verify",
  label: "full repository verification",
};

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function targetKey(kind: VerificationTargetKind, id: LogicalId): string {
  return `${kind}:${id}`;
}

function sourceRevisionIds(snapshot: RepositorySemanticSnapshot | undefined): string[] {
  if (snapshot === undefined) return [];
  return uniqueSorted(
    [
      snapshot.integrity.snapshotDigest.value,
      snapshot.revisionIdentity?.id ?? "",
      snapshot.revisionIdentity?.revision ?? "",
    ].filter((item) => item.length > 0),
  );
}

function changeSetSourceIds(changeSet: SemanticChangeSet | undefined): string[] {
  if (changeSet === undefined) return [];
  return uniqueSorted([changeSet.baseSnapshotId, changeSet.headSnapshotId]);
}

function makeProvenance(options: {
  ruleId: string;
  reasonCode: string;
  sourceKinds: readonly VerificationPlannerSourceKind[];
  sourceIds?: readonly string[];
  changedSymbolIds: readonly LogicalId[];
  affectedEntityIds: readonly LogicalId[];
  explanation: string;
  confidence?: "deterministic" | "conservative";
}): VerificationPlanProvenance {
  return {
    authority: "analysis",
    producer: VERIFICATION_PLANNER_PRODUCER,
    ruleId: options.ruleId,
    reasonCode: options.reasonCode,
    sourceKinds: uniqueSorted(options.sourceKinds),
    sourceIds: uniqueSorted(options.sourceIds ?? []),
    changedSymbolIds: uniqueSorted(options.changedSymbolIds),
    affectedEntityIds: uniqueSorted(options.affectedEntityIds),
    explanation: options.explanation,
    confidence: options.confidence ?? "deterministic",
  };
}

function itemKind(targetKind: VerificationTargetKind): VerificationPlanItemKind {
  if (targetKind === "contract") return "contract";
  if (targetKind === "invariant") return "invariant";
  return "perspective";
}

function itemState(status: VerificationAssessmentStatus): VerificationPlanItemState {
  if (status === "satisfied") return "skipped";
  if (status === "missing") return "missing";
  if (status === "stale") return "stale";
  if (status === "failed") return "failed";
  if (status === "unknown") return "uncertain";
  return "must-verify";
}

function metadataCommand(metadata: Record<string, unknown> | undefined, fallback: string): string {
  const command = metadata?.command;
  return typeof command === "string" && command.length > 0 ? command : fallback;
}

function evidenceForRequirement(
  requirement: VerificationRequirement,
  evidence: readonly VerificationEvidence[],
): VerificationEvidence[] {
  return evidence
    .filter(
      (item) =>
        targetKey(item.target.kind, item.target.id) === targetKey(requirement.target.kind, requirement.target.id) &&
        item.perspectiveId === requirement.perspectiveId,
    )
    .sort((left, right) => compareText(left.id, right.id));
}

function assessmentFor(
  requirement: VerificationRequirement,
  assessments: ReadonlyMap<LogicalId, VerificationAssessment>,
  evidence: readonly VerificationEvidence[],
): VerificationAssessment {
  const existing = assessments.get(requirement.id);
  if (existing !== undefined) return existing;
  return {
    requirementId: requirement.id,
    target: requirement.target,
    perspectiveId: requirement.perspectiveId,
    strength: requirement.strength,
    status: "unknown",
    evidenceIds: evidenceForRequirement(requirement, evidence).map((item) => item.id),
    satisfyingEvidenceIds: [],
  };
}

function isMeaningfulChange(changeSet: SemanticChangeSet | undefined): boolean {
  if (changeSet === undefined) return true;
  return (
    changeSet.changedFiles.length > 0 ||
    changeSet.changedSymbols.length > 0 ||
    changeSet.changedComponents.length > 0 ||
    changeSet.semanticDeltas.length > 0 ||
    changeSet.unknownRegions.length > 0
  );
}

function selectionTargets(changeSet: SemanticChangeSet | undefined): LogicalId[] {
  if (changeSet === undefined) return [];
  const direct = new Set<LogicalId>([
    ...changeSet.changedSymbols,
    ...changeSet.changedComponents,
    ...changeSet.semanticDeltas.map((item) => item.subject),
  ]);
  const stoppedAtBoundary = new Set(
    changeSet.propagationStopPoints
      .filter((item) => {
        const reason = item.reason.toLowerCase();
        return reason.includes("boundary") || reason.includes("stop");
      })
      .flatMap((item) => (item.componentId === undefined ? [item.entityId] : [item.entityId, item.componentId])),
  );
  return uniqueSorted(
    [...new Set(changeSet.affectedEntities)].filter((id) => direct.has(id) || !stoppedAtBoundary.has(id)),
  );
}

function requirementIsRelevant(
  requirement: VerificationRequirement,
  selectionTargetIds: ReadonlySet<LogicalId>,
  changed: boolean,
): boolean {
  if (!changed) return false;
  if (requirement.target.kind === "project") return true;
  return selectionTargetIds.has(requirement.target.id);
}

function testCandidates(
  requirement: VerificationRequirement,
  matchingEvidence: readonly VerificationEvidence[],
  snapshot: RepositorySemanticSnapshot,
): LogicalId[] {
  const evidenceIds = new Set(matchingEvidence.map((item) => item.id));
  const candidates = new Set<LogicalId>();
  for (const item of matchingEvidence) if (item.testId !== undefined) candidates.add(item.testId);
  for (const test of snapshot.observed.tests) {
    if (test.evidenceIds.some((id) => evidenceIds.has(id))) candidates.add(test.id);
  }
  for (const relation of snapshot.graph.relations) {
    if (relation.kind !== "verifies" || relation.to !== requirement.target.id) continue;
    if (snapshot.observed.tests.some((test) => test.id === relation.from)) candidates.add(relation.from);
  }
  return uniqueSorted([...candidates]);
}

function addReason(
  reasons: Array<{
    code: string;
    explanation: string;
    sourceKinds: VerificationPlannerSourceKind[];
    sourceIds: string[];
  }>,
  reason: {
    code: string;
    explanation: string;
    sourceKinds: VerificationPlannerSourceKind[];
    sourceIds?: readonly string[];
  },
): void {
  if (reasons.some((item) => item.code === reason.code)) return;
  reasons.push({ ...reason, sourceIds: [...(reason.sourceIds ?? [])] });
}

function checkIsRequired(
  check: VerificationCheckDefinition,
  deltaKinds: ReadonlySet<SemanticDeltaKind>,
  changed: boolean,
): boolean {
  return check.requiredFor.some((trigger) => (trigger === "any-change" ? changed : deltaKinds.has(trigger)));
}

function sortItems(items: readonly VerificationPlanItem[]): VerificationPlanItem[] {
  return [...items].sort((left, right) => compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`));
}

function indexItemsById(items: readonly VerificationPlanItem[]): Map<string, VerificationPlanItem> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Select a deterministic minimum sufficient set from canonical #54 impact and #86 evidence.
 * The function only consumes those authorities; it never recomputes impact or requirements.
 */
export function planMinimumSufficientVerification(input: VerificationPlannerInput = {}): VerificationPlan {
  const changeSet = input.changeSet;
  const snapshot = input.snapshot;
  const mode = input.mode ?? "shadow";
  const changedSymbolIds = uniqueSorted(changeSet?.changedSymbols ?? []);
  const affectedEntityIds = uniqueSorted(changeSet?.affectedEntities ?? []);
  const selectionTargetIds = selectionTargets(changeSet);
  const selectionTargetSet = new Set(selectionTargetIds);
  const changed = isMeaningfulChange(changeSet);
  const deltaKinds = new Set(changeSet?.semanticDeltas.map((item) => item.kind) ?? []);
  const sourceIds = uniqueSorted([...changeSetSourceIds(changeSet), ...sourceRevisionIds(snapshot)]);
  const reasons: Array<{
    code: string;
    explanation: string;
    sourceKinds: VerificationPlannerSourceKind[];
    sourceIds: string[];
  }> = [];

  if (changeSet === undefined) {
    addReason(reasons, {
      code: "missing-change-set",
      explanation: "Canonical Semantic Change Set is unavailable; the planner cannot establish Symbol-level impact.",
      sourceKinds: ["semantic-delta", "semantic-impact"],
    });
  }
  if (snapshot === undefined) {
    addReason(reasons, {
      code: "missing-live-model",
      explanation: "The live Repository Model is unavailable; requirements, evidence, and impact cannot be trusted.",
      sourceKinds: ["model-integrity", "verification-requirement", "verification-evidence"],
    });
  }
  if (snapshot !== undefined && snapshot.integrity.status !== "fresh") {
    addReason(reasons, {
      code: "non-fresh-model",
      explanation: `Repository Model integrity is ${snapshot.integrity.status}; broader verification remains required.`,
      sourceKinds: ["model-integrity"],
      sourceIds: sourceRevisionIds(snapshot),
    });
  }
  if (snapshot !== undefined && snapshot.analysis.health.status !== "healthy") {
    addReason(reasons, {
      code: "incomplete-model-analysis",
      explanation: `Repository Model analysis health is ${snapshot.analysis.health.status}; selection is conservative.`,
      sourceKinds: ["model-integrity", "semantic-impact", "verification-evidence"],
    });
  }
  if (snapshot !== undefined && snapshot.analysis.unknowns.length > 0) {
    addReason(reasons, {
      code: "unknown-model-region",
      explanation:
        "The live model reports material unknown regions; focused selection cannot establish sufficient coverage.",
      sourceKinds: ["semantic-impact", "model-integrity"],
      sourceIds: snapshot.analysis.unknowns.flatMap((item) => item.subjects ?? []),
    });
  }
  if (changeSet !== undefined && changeSet.unknownRegions.length > 0) {
    addReason(reasons, {
      code: "unknown-impact-region",
      explanation: "The canonical impact analysis reports material unknown regions.",
      sourceKinds: ["semantic-impact"],
      sourceIds: changeSet.unknownRegions.flatMap((item) => [item.id, ...item.subjects]),
    });
  }
  if (
    changeSet !== undefined &&
    changedSymbolIds.length > 0 &&
    (changeSet.impactPaths.length === 0 || changedSymbolIds.some((id) => !changeSet.affectedEntities.includes(id)))
  ) {
    addReason(reasons, {
      code: "incomplete-symbol-impact",
      explanation: "Changed Symbols are not covered by canonical impact paths; dependency reachability is not guessed.",
      sourceKinds: ["semantic-delta", "semantic-impact"],
      sourceIds: changedSymbolIds,
    });
  }
  if (
    changeSet !== undefined &&
    changed &&
    changedSymbolIds.length === 0 &&
    (changeSet.changedFiles.length > 0 || changeSet.semanticDeltas.length > 0)
  ) {
    addReason(reasons, {
      code: "symbol-resolution-incomplete",
      explanation: "The change contains file or semantic meaning changes without a resolved changed Symbol.",
      sourceKinds: ["semantic-delta", "semantic-impact"],
      sourceIds: changeSet.changedFiles,
    });
  }
  if (changeSet !== undefined && changed && affectedEntityIds.length === 0) {
    addReason(reasons, {
      code: "empty-impact-result",
      explanation: "A change was reported without affected entities; broader verification is the safe fallback.",
      sourceKinds: ["semantic-impact"],
    });
  }
  if (
    changeSet !== undefined &&
    snapshot !== undefined &&
    changeSet.headSnapshotId !== snapshot.integrity.snapshotDigest.value
  ) {
    addReason(reasons, {
      code: "snapshot-mismatch",
      explanation: "The change-set head does not match the live model snapshot; evidence and impact are not aligned.",
      sourceKinds: ["semantic-delta", "model-integrity"],
      sourceIds: [changeSet.headSnapshotId, snapshot.integrity.snapshotDigest.value],
    });
  }
  if (changeSet?.reviewLevel === "L3") {
    addReason(reasons, {
      code: "protected-or-breaking-change",
      explanation: "The canonical Semantic Change Set is L3; full verification remains required.",
      sourceKinds: ["semantic-delta", "semantic-impact"],
      sourceIds: changeSet.semanticDeltas.map((item) => item.id),
    });
  }
  if (changeSet?.authorizedVsActual.unauthorized === true) {
    addReason(reasons, {
      code: "unauthorized-semantic-change",
      explanation: "The canonical transaction comparison reports an unauthorized semantic delta.",
      sourceKinds: ["semantic-delta"],
      sourceIds: [changeSet.authorizedVsActual.transactionId ?? "unauthorized-semantic-delta"],
    });
  }

  const requirements =
    snapshot === undefined
      ? []
      : [
          ...(snapshot.declarations.verificationRequirements ?? []),
          ...(snapshot.derived.verificationRequirements ?? []),
        ]
          .filter((item) => item.authority === "declared" || item.authority === "derived")
          .sort((left, right) => compareText(left.id, right.id));
  const evidence = snapshot?.observed.verificationEvidence ?? [];
  const assessments = new Map<LogicalId, VerificationAssessment>(
    snapshot?.analysis.verification?.assessments.map((item) => [item.requirementId, item]) ?? [],
  );
  const invalidatedEvidenceIds = new Set(changeSet?.evidenceRefreshNeeds.flatMap((item) => item.evidenceIds) ?? []);
  const relevantRequirements = requirements.filter((item) => requirementIsRelevant(item, selectionTargetSet, changed));

  if (snapshot !== undefined && changed && snapshot.analysis.verification === undefined) {
    addReason(reasons, {
      code: "missing-verification-analysis",
      explanation: "The #86 verification analysis is unavailable for a semantic change.",
      sourceKinds: ["verification-requirement", "verification-evidence"],
      sourceIds: requirements.map((item) => item.id),
    });
  }
  if (snapshot !== undefined && changed && relevantRequirements.length > 0 && assessments.size === 0) {
    addReason(reasons, {
      code: "unassessed-verification-requirements",
      explanation: "Relevant authoritative verification requirements have no current assessments.",
      sourceKinds: ["verification-requirement", "verification-evidence"],
      sourceIds: relevantRequirements.map((item) => item.id),
    });
  }

  const planItems: VerificationPlanItem[] = [];
  const requirementItems: VerificationPlanItem[] = [];
  const testSelections = new Map<
    LogicalId,
    {
      requirementIds: Set<LogicalId>;
      perspectiveIds: Set<LogicalId>;
      targetIds: Set<LogicalId>;
      evidenceIds: Set<LogicalId>;
    }
  >();
  const unresolvedTestIds: LogicalId[] = [];

  for (const requirement of relevantRequirements) {
    const assessment = assessmentFor(requirement, assessments, evidence);
    const matchingEvidence = evidenceForRequirement(requirement, evidence);
    const assessmentEvidenceIds = uniqueSorted([...assessment.evidenceIds, ...matchingEvidence.map((item) => item.id)]);
    const invalidated = assessmentEvidenceIds.some((id) => invalidatedEvidenceIds.has(id));
    const status: VerificationAssessmentStatus =
      invalidated && assessment.status === "satisfied" ? "stale" : assessment.status;
    const item = {
      id: `verification-item:${itemKind(requirement.target.kind)}:${requirement.id}`,
      kind: itemKind(requirement.target.kind),
      state: itemState(status),
      label: `${requirement.target.kind} verification perspective ${requirement.perspectiveId}`,
      targetIds: [requirement.target.id],
      requirementIds: [requirement.id],
      perspectiveIds: [requirement.perspectiveId],
      evidenceIds: assessmentEvidenceIds,
      required: requirement.strength === "required",
      evidenceStatus: status,
      provenance: makeProvenance({
        ruleId: "requirement-assessment",
        reasonCode: status === "satisfied" ? "current-sufficient-evidence" : `evidence-${status}`,
        sourceKinds: invalidated
          ? (["verification-requirement", "verification-evidence", "semantic-impact"] as const)
          : (["verification-requirement", "verification-evidence"] as const),
        sourceIds: [requirement.id, requirement.perspectiveId, ...assessmentEvidenceIds],
        changedSymbolIds,
        affectedEntityIds: selectionTargetIds,
        explanation:
          status === "satisfied"
            ? "Current sufficient evidence exists; the perspective is retained as skipped in the focused plan."
            : invalidated
              ? "Impact analysis invalidated associated evidence; the perspective must be verified again."
              : `The #86 verification authority reports ${status} evidence for this requirement.`,
        confidence: status === "unknown" ? "conservative" : "deterministic",
      }),
    } satisfies VerificationPlanItem;
    requirementItems.push(item);
    planItems.push(item);

    if (status !== "satisfied" && requirement.strength === "required" && snapshot !== undefined) {
      for (const testId of testCandidates(requirement, matchingEvidence, snapshot)) {
        const selection = testSelections.get(testId) ?? {
          requirementIds: new Set<LogicalId>(),
          perspectiveIds: new Set<LogicalId>(),
          targetIds: new Set<LogicalId>(),
          evidenceIds: new Set<LogicalId>(),
        };
        selection.requirementIds.add(requirement.id);
        selection.perspectiveIds.add(requirement.perspectiveId);
        selection.targetIds.add(requirement.target.id);
        for (const evidenceItem of matchingEvidence) selection.evidenceIds.add(evidenceItem.id);
        testSelections.set(testId, selection);
      }
    }

    if (requirement.strength === "required" && status !== "satisfied") {
      addReason(reasons, {
        code: `required-evidence-${status}`,
        explanation: `A required ${requirement.target.kind} verification perspective is ${status}.`,
        sourceKinds: ["verification-requirement", "verification-evidence"],
        sourceIds: [requirement.id, ...assessmentEvidenceIds],
      });
    }
  }

  for (const need of changeSet?.evidenceRefreshNeeds ?? []) {
    if (
      selectionTargetIds.length > 0 &&
      !selectionTargetSet.has(need.subject) &&
      !changedSymbolIds.includes(need.subject)
    )
      continue;
    const relatedRequirements = requirements.filter((item) => item.target.id === need.subject);
    const item: VerificationPlanItem = {
      id: `verification-item:evidence-refresh:${need.id}`,
      kind: "perspective",
      state: "stale",
      label: `refresh verification evidence for ${need.subject}`,
      targetIds: [need.subject],
      requirementIds: relatedRequirements.map((item) => item.id).sort(compareText),
      perspectiveIds: relatedRequirements.map((item) => item.perspectiveId).sort(compareText),
      evidenceIds: uniqueSorted(need.evidenceIds),
      required: need.required,
      evidenceStatus: "stale",
      provenance: makeProvenance({
        ruleId: "impact-evidence-refresh",
        reasonCode: need.required ? "required-evidence-invalidated" : "evidence-invalidated",
        sourceKinds: ["semantic-impact", "verification-evidence"],
        sourceIds: [need.id, need.subject, ...need.evidenceIds, ...need.testIds],
        changedSymbolIds,
        affectedEntityIds: selectionTargetIds,
        explanation: need.reason,
      }),
    };
    planItems.push(item);
    if (need.required) {
      addReason(reasons, {
        code: "required-evidence-refresh",
        explanation: need.reason,
        sourceKinds: ["semantic-impact", "verification-evidence"],
        sourceIds: [need.id, ...need.evidenceIds],
      });
    }
  }

  const testEntities = new Map(snapshot?.observed.tests.map((item) => [item.id, item]) ?? []);
  for (const testId of [...testSelections.keys()].sort(compareText)) {
    const test = testEntities.get(testId);
    const selection = testSelections.get(testId)!;
    const requirementIds = uniqueSorted([...selection.requirementIds]);
    const perspectiveIds = uniqueSorted([...selection.perspectiveIds]);
    const targetIds = uniqueSorted([...selection.targetIds]);
    const evidenceIds = uniqueSorted([...selection.evidenceIds]);
    if (test === undefined) {
      unresolvedTestIds.push(testId);
      planItems.push({
        id: `verification-item:test:unresolved:${testId}`,
        kind: "test",
        state: "uncertain",
        label: `unresolved verification test ${testId}`,
        testId,
        targetIds,
        requirementIds,
        perspectiveIds,
        evidenceIds,
        required: false,
        provenance: makeProvenance({
          ruleId: "requirement-test-association",
          reasonCode: "unresolved-evidence-test-id",
          sourceKinds: ["verification-requirement", "verification-evidence", "model-integrity"],
          sourceIds: [testId, ...requirementIds, ...evidenceIds],
          changedSymbolIds,
          affectedEntityIds: selectionTargetIds,
          explanation:
            "Authoritative verification evidence references a test absent from the live model; the test association cannot be resolved and broader verification is required.",
          confidence: "conservative",
        }),
      });
      continue;
    }
    planItems.push({
      id: `verification-item:test:${test.id}`,
      kind: "test",
      state: "must-run",
      label: test.testName,
      command: metadataCommand(test.metadata as Record<string, unknown> | undefined, test.testName),
      testId: test.id,
      targetIds,
      requirementIds,
      perspectiveIds,
      evidenceIds,
      required: true,
      provenance: makeProvenance({
        ruleId: "requirement-test-association",
        reasonCode: "required-perspective-needs-test",
        sourceKinds: ["verification-requirement", "verification-evidence"],
        sourceIds: [test.id, ...requirementIds, ...evidenceIds],
        changedSymbolIds,
        affectedEntityIds: selectionTargetIds,
        explanation:
          "An explicit test/evidence association is selected to establish the affected required perspective.",
      }),
    });
  }
  if (unresolvedTestIds.length > 0) {
    addReason(reasons, {
      code: "unresolved-evidence-test-id",
      explanation:
        "Required verification evidence references one or more tests absent from the live model; focused selection cannot establish complete coverage.",
      sourceKinds: ["verification-requirement", "verification-evidence", "model-integrity"],
      sourceIds: unresolvedTestIds,
    });
  }

  const checks = input.checks ?? DEFAULT_VERIFICATION_CHECKS;
  const checkItems: VerificationPlanItem[] = [];
  for (const check of [...checks].sort((left, right) => compareText(left.id, right.id))) {
    if (!checkIsRequired(check, deltaKinds, changed)) continue;
    const item: VerificationPlanItem = {
      id: `verification-item:${check.kind}:${check.id}`,
      kind: check.kind,
      state: "must-run",
      label: check.id,
      command: check.command,
      targetIds: selectionTargetIds,
      requirementIds: [],
      perspectiveIds: [],
      evidenceIds: [],
      required: true,
      provenance: makeProvenance({
        ruleId: "semantic-check-selection",
        reasonCode: check.requiredFor.includes("any-change") ? "any-semantic-change" : "semantic-delta-kind",
        sourceKinds: ["semantic-delta", "semantic-impact"],
        sourceIds: [...(changeSet?.semanticDeltas.map((delta) => delta.id) ?? []), ...selectionTargetIds],
        changedSymbolIds,
        affectedEntityIds: selectionTargetIds,
        explanation: `The ${check.kind} check is required by the deterministic semantic-change rule for ${check.id}.`,
      }),
    };
    checkItems.push(item);
    planItems.push(item);
  }

  const fullDefinition = input.fullVerification ?? DEFAULT_FULL_VERIFICATION;
  const fullVerification: VerificationPlanItem = {
    id: `verification-item:full:${fullDefinition.id}`,
    kind: "full",
    state: reasons.length > 0 ? "must-run" : "skipped",
    label: fullDefinition.label,
    command: fullDefinition.command,
    targetIds: affectedEntityIds,
    requirementIds: [],
    perspectiveIds: [],
    evidenceIds: [],
    required: reasons.length > 0,
    provenance: makeProvenance({
      ruleId: "conservative-full-verification-fallback",
      reasonCode: reasons.length > 0 ? reasons[0]!.code : "shadow-only-full-available",
      sourceKinds: ["semantic-delta", "semantic-impact", "verification-requirement", "verification-evidence"],
      sourceIds,
      changedSymbolIds,
      affectedEntityIds,
      explanation:
        reasons.length > 0
          ? "Full verification is required because one or more deterministic safety conditions could not be established."
          : "Full verification remains available independently during shadow rollout and is not removed from CI.",
      confidence: reasons.length > 0 ? "conservative" : "deterministic",
    }),
  };
  planItems.push(fullVerification);

  const allItems = sortItems(planItems);
  const itemIndex = indexItemsById(allItems);
  const requiredTests = sortItems(allItems.filter((item) => item.kind === "test" && item.required));
  const requiredChecks = sortItems(
    allItems.filter((item) => ["static", "type", "build", "package"].includes(item.kind) && item.required),
  );
  const requiredEvidence = sortItems(
    requirementItems.filter((item) => item.required && item.evidenceStatus !== "satisfied"),
  );
  const mustRun = sortItems(allItems.filter((item) => item.state === "must-run"));
  const mustVerify = sortItems(
    requirementItems.filter((item) => item.evidenceStatus !== "satisfied" || item.state === "stale"),
  );
  const missing = sortItems(allItems.filter((item) => item.state === "missing"));
  const stale = sortItems(allItems.filter((item) => item.state === "stale"));
  const failed = sortItems(allItems.filter((item) => item.state === "failed"));
  const uncertain = sortItems(allItems.filter((item) => item.state === "uncertain"));
  const skipped = sortItems(allItems.filter((item) => item.state === "skipped"));
  const predictedItemIds = uniqueSorted([...requiredTests, ...requiredChecks].map((item) => item.id));
  const broaderProvenance =
    reasons.length === 0
      ? undefined
      : makeProvenance({
          ruleId: "broader-verification-required",
          reasonCode: "conservative-fallback",
          sourceKinds: uniqueSorted(reasons.flatMap((item) => item.sourceKinds)),
          sourceIds: reasons.flatMap((item) => item.sourceIds),
          changedSymbolIds,
          affectedEntityIds,
          explanation: reasons.map((item) => item.explanation).join(" "),
          confidence: "conservative",
        });
  const broaderVerification =
    broaderProvenance === undefined
      ? undefined
      : {
          required: true as const,
          command: fullDefinition.command,
          reasonCodes: uniqueSorted(reasons.map((item) => item.code)),
          reasons: reasons.map((item) => item.explanation),
          provenance: broaderProvenance,
        };
  const planProvenance = makeProvenance({
    ruleId: "minimum-sufficient-verification",
    reasonCode: broaderVerification === undefined ? "focused-selection" : "conservative-broader-selection",
    sourceKinds: [
      "semantic-delta",
      "semantic-impact",
      "verification-requirement",
      "verification-evidence",
      "model-integrity",
    ],
    sourceIds,
    changedSymbolIds,
    affectedEntityIds,
    explanation:
      broaderVerification === undefined
        ? "Selection is derived deterministically from Symbol-level semantic impact and current verification evidence."
        : "Selection remains deterministic, but full verification is required because evidence or model completeness is uncertain.",
    confidence: broaderVerification === undefined ? "deterministic" : "conservative",
  });

  // Keep this lookup as a structural assertion point for adapters that consume item IDs.
  // It also makes the returned collections share the exact canonical item instances.
  const canonicalItems = allItems.map((item) => itemIndex.get(item.id)!);
  return {
    apiVersion: "v1",
    version: VERIFICATION_PLAN_VERSION,
    mode,
    status: broaderVerification === undefined ? "sufficient" : "broader-verification-required",
    sufficient: broaderVerification === undefined,
    changedSymbolIds,
    affectedEntityIds,
    selectionTargetIds,
    predictedItemIds,
    items: canonicalItems,
    requiredTests,
    requiredChecks,
    requiredEvidence,
    mustRun,
    mustVerify,
    missing,
    stale,
    failed,
    uncertain,
    skipped,
    broaderVerification,
    fullVerification,
    provenance: planProvenance,
  };
}

function observationIds(observation: VerificationRunObservation): string[] {
  return uniqueSorted([...observation.executedItemIds, ...observation.failedItemIds]);
}

/** IDs accepted when matching shadow observations; metrics remain canonical-only. */
function shadowMatchIds(plan: VerificationPlan): Set<string> {
  const aliases = new Set<string>(plan.predictedItemIds);
  for (const item of plan.requiredTests) if (item.testId !== undefined) aliases.add(item.testId);
  return aliases;
}

function shadowProvenance(
  plan: VerificationPlan,
  reasonCode: string,
  sourceIds: readonly string[],
  explanation: string,
  targetIds: readonly LogicalId[],
  requirementIds: readonly LogicalId[],
): VerificationPlanProvenance {
  return makeProvenance({
    ruleId: "shadow-prediction-vs-observation",
    reasonCode,
    sourceKinds: ["shadow-observation", "semantic-delta", "semantic-impact", "verification-requirement"],
    sourceIds: [...sourceIds, ...plan.provenance.sourceIds],
    changedSymbolIds: plan.changedSymbolIds,
    affectedEntityIds: targetIds.length > 0 ? targetIds : plan.affectedEntityIds,
    explanation: `${explanation} Review the canonical impact relation and verification requirement before adding a test-specific exception.`,
    confidence: "conservative",
  });
}

/** Compare focused prediction with an independent full-verification observation. */
export function compareVerificationShadow(input: {
  plan: VerificationPlan;
  selected: VerificationRunObservation;
  full: VerificationRunObservation;
}): VerificationShadowComparison {
  const { plan, selected, full } = input;
  const predictedItemIds = uniqueSorted(plan.predictedItemIds);
  const shadowIds = shadowMatchIds(plan);
  const failedIds = uniqueSorted(full.failedItemIds);
  const misses: VerificationShadowMiss[] = [];
  const itemsById = indexItemsById(plan.items);
  for (const observedItemId of failedIds) {
    if (shadowIds.has(observedItemId)) continue;
    const matching = itemsById.get(observedItemId) ?? plan.items.find((item) => item.testId === observedItemId);
    misses.push({
      id: `shadow-miss:${observedItemId}`,
      observedItemId,
      summary: "Full verification failed outside the predicted verification set.",
      targetIds: matching?.targetIds ?? plan.selectionTargetIds,
      requirementIds: matching?.requirementIds ?? [],
      provenance: shadowProvenance(
        plan,
        "full-failure-outside-prediction",
        [observedItemId, ...(matching?.evidenceIds ?? [])],
        "The independent full verification observed a failure not selected by the planner.",
        matching?.targetIds ?? [],
        matching?.requirementIds ?? [],
      ),
    });
  }
  if (full.status === "failed" && failedIds.length === 0) {
    misses.push({
      id: "shadow-miss:unattributed-full-failure",
      observedItemId: "unattributed-full-failure",
      summary: "Full verification failed without an attributable item identifier.",
      targetIds: plan.selectionTargetIds,
      requirementIds: [],
      provenance: shadowProvenance(
        plan,
        "unattributed-full-failure",
        ["unattributed-full-failure"],
        "The full runner did not provide enough observation detail to prove that the focused prediction covered the failure.",
        [],
        [],
      ),
    });
  }

  const relevant = uniqueSorted(full.relevantItemIds ?? failedIds);
  const covered = relevant.filter((id) => shadowIds.has(id));
  const oracle = uniqueSorted(full.relevantItemIds ?? observationIds(full));
  const oracleSet = new Set(oracle);
  const testAliases = new Map(
    plan.requiredTests.filter((item) => item.testId !== undefined).map((item) => [item.id, item.testId!] as const),
  );
  const unnecessary = predictedItemIds.filter((id) => !oracleSet.has(id) && !oracleSet.has(testAliases.get(id) ?? id));
  const selectionRecall = relevant.length === 0 ? (misses.length === 0 ? 1 : 0) : covered.length / relevant.length;
  const selectedRuntimeMs = Number.isFinite(selected.durationMs) ? selected.durationMs : 0;
  const fullRuntimeMs = Number.isFinite(full.durationMs) ? full.durationMs : 0;
  const runtimeReductionMs = fullRuntimeMs - selectedRuntimeMs;
  const runtimeReductionRatio = fullRuntimeMs === 0 ? 0 : runtimeReductionMs / fullRuntimeMs;
  const metrics: VerificationShadowMetrics = {
    selectionRecall,
    predictedItemCount: predictedItemIds.length,
    observedRelevantItemCount: relevant.length,
    coveredRelevantItemCount: covered.length,
    missCount: misses.length,
    unnecessarySelectionCount: unnecessary.length,
    overSelectionRate: predictedItemIds.length === 0 ? 0 : unnecessary.length / predictedItemIds.length,
    selectedRuntimeMs,
    fullRuntimeMs,
    runtimeReductionMs,
    runtimeReductionRatio,
  };
  const status =
    full.status === "unknown" || full.status === "skipped" ? "inconclusive" : misses.length > 0 ? "miss" : "no-miss";
  return {
    apiVersion: "v1",
    mode: "shadow",
    status,
    plan,
    selected,
    full,
    metrics,
    misses: misses.sort((left, right) => compareText(left.id, right.id)),
    promotion: {
      eligible: false,
      status: "not-authorized",
      reasonCode: "explicit-evidence-gate-required",
      explanation:
        "Shadow observations never reduce mandatory CI automatically; promotion requires an explicit evidence-based maintainer change.",
    },
    provenance: shadowProvenance(
      plan,
      status === "miss" ? "selector-miss" : "shadow-comparison-recorded",
      [...selected.executedItemIds, ...full.executedItemIds, ...full.failedItemIds],
      "Prediction and independent full-verification observations were compared without changing CI policy.",
      plan.selectionTargetIds,
      [],
    ),
  };
}

export const compareShadowVerification = compareVerificationShadow;

/** Run both adapters concurrently; adapters remain responsible for actual command execution. */
export async function runVerificationShadow(
  plan: VerificationPlan,
  runners: VerificationShadowRunners,
): Promise<VerificationShadowComparison> {
  const [selected, full] = await Promise.all([runners.runSelected(plan), runners.runFull(plan)]);
  return compareVerificationShadow({ plan, selected, full });
}

export const buildVerificationPlan = planMinimumSufficientVerification;
