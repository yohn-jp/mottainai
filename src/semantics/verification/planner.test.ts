import assert from "node:assert/strict";
import test from "node:test";
import { computeIntegrityDigestsFromValidated } from "../ir/canonical.js";
import { createLogicalId, type LogicalId } from "../ir/ids.js";
import type {
  ContentDigest,
  Provenance,
  RepositorySemanticSnapshot,
  VerificationEvidence,
  VerificationPerspective,
  VerificationRequirement,
  VerificationTarget,
} from "../ir/types.js";
import type { SemanticChangeSet as CanonicalSemanticChangeSet } from "../diff/types.js";
import { pureFunctionFixture } from "../fixtures/snapshots.js";
import { buildVerificationAnalysis } from "./adequacy.js";
import { compareVerificationShadow, planMinimumSufficientVerification, type VerificationPlan } from "./planner.js";

const symbolId = pureFunctionFixture.derived.symbols[0]!.id;
const componentId = pureFunctionFixture.declarations.components[0]!.id;
const testId = pureFunctionFixture.observed.tests[0]!.id;
const sourceRevision = pureFunctionFixture.derived.symbols[0]!.provenance.sourceRevision;

function provenance(kind: Provenance["kind"]): Provenance {
  return {
    kind,
    producer: { name: "planner-test", version: "1" },
    sourceRevision,
  };
}

function perspective(id: LogicalId): VerificationPerspective {
  return {
    id,
    kind: "assertion",
    category: "semantic",
    name: "semantic assertion",
    known: true,
    authority: "declared",
    provenance: provenance("declared"),
  };
}

function target(kind: VerificationTarget["kind"], id: LogicalId): VerificationTarget {
  return { kind, id };
}

function requirement(id: string, targetValue: VerificationTarget, perspectiveId: LogicalId): VerificationRequirement {
  return {
    id: createLogicalId("requirement", id),
    target: targetValue,
    perspectiveId,
    strength: "required",
    rationale: `Planner requirement ${id}`,
    requirementProvenance: { kind: "explicit-declaration" },
    minimumEvidenceStrength: "verification",
    authority: "declared",
    provenance: provenance("declared"),
  };
}

function evidence(
  id: string,
  targetValue: VerificationTarget,
  perspectiveId: LogicalId,
  freshness: VerificationEvidence["freshness"] = "current",
): VerificationEvidence {
  return {
    id: createLogicalId("verification", id),
    target: targetValue,
    perspectiveId,
    testId,
    kind: "assertion",
    strength: "verification",
    freshness,
    status: "passed",
    reference: `artifact:${id}`,
    summary: `Planner evidence ${id}`,
    authority: "observed",
    provenance: provenance("observed"),
  };
}

function freshSnapshot(options: {
  requirements: readonly VerificationRequirement[];
  perspectives: readonly VerificationPerspective[];
  evidence?: readonly VerificationEvidence[];
}): RepositorySemanticSnapshot {
  const snapshot = structuredClone(pureFunctionFixture);
  snapshot.declarations.verificationPerspectives = [...options.perspectives];
  snapshot.declarations.verificationRequirements = [...options.requirements];
  snapshot.derived.verificationRequirements = [];
  snapshot.observed.verificationEvidence = [...(options.evidence ?? [])];
  snapshot.analysis.verification = buildVerificationAnalysis(
    options.requirements,
    options.evidence ?? [],
    options.perspectives,
    [{ scope: "symbol", targetId: symbolId }],
  );
  snapshot.integrity = {
    ...snapshot.integrity,
    status: "fresh",
    statusReason: undefined,
    ...computeIntegrityDigestsFromValidated({
      ...snapshot,
      integrity: { ...snapshot.integrity, status: "fresh", statusReason: undefined },
    }),
  };
  return snapshot;
}

function digest(value: ContentDigest): ContentDigest {
  return value;
}

function changeSet(
  snapshot: RepositorySemanticSnapshot,
  overrides: Partial<CanonicalSemanticChangeSet> = {},
): CanonicalSemanticChangeSet {
  const snapshotDigest = digest(snapshot.integrity.snapshotDigest);
  const base: CanonicalSemanticChangeSet = {
    version: 1,
    apiVersion: "v1",
    baseSnapshotId: "snapshot:base",
    headSnapshotId: snapshotDigest.value,
    baseSnapshotDigest: snapshotDigest,
    headSnapshotDigest: snapshotDigest,
    baseRevision: "base",
    headRevision: snapshot.revisionIdentity?.revision ?? "head",
    changedFiles: [],
    changedSymbols: [symbolId],
    symbolChanges: [],
    changedComponents: [],
    derivedChanges: [],
    semanticDeltas: [],
    contractChanges: [],
    effectChanges: [],
    invariantChanges: [],
    dependencyPolicyChanges: [],
    publicSurfaceChanges: [],
    responsibilityChanges: [],
    capabilityChanges: [],
    authorizedVsActual: {
      authorizedKinds: [],
      actualKinds: [],
      excessKinds: [],
      missingKinds: [],
      status: "matched",
      unauthorized: false,
    },
    affectedEntities: [symbolId, componentId],
    impactPaths: [
      { entityIds: [symbolId, componentId], stopReason: "preserved conforming Component boundary", propagated: false },
    ],
    propagationStopPoints: [],
    evidenceRefreshNeeds: [],
    unknownRegions: [],
    reviewLevel: "L0",
    reviewReasons: [],
    recommendedSourceReads: [],
    effectViolations: [],
    provenance: {
      producer: "mottainai-semantic-diff-engine",
      version: "1.0.0",
      note: "deterministic planner fixture",
    },
  };
  return { ...base, ...overrides };
}

function exactFixture(): {
  snapshot: RepositorySemanticSnapshot;
  requirement: VerificationRequirement;
  evidence: VerificationEvidence;
  perspective: VerificationPerspective;
} {
  const perspectiveValue = perspective(createLogicalId("perspective", "exact-selection"));
  const requirementValue = requirement("exact-selection", target("symbol", symbolId), perspectiveValue.id);
  const evidenceValue = evidence("exact-selection", target("symbol", symbolId), perspectiveValue.id);
  return {
    snapshot: freshSnapshot({
      requirements: [requirementValue],
      perspectives: [perspectiveValue],
      evidence: [evidenceValue],
    }),
    requirement: requirementValue,
    evidence: evidenceValue,
    perspective: perspectiveValue,
  };
}

test("deterministically selects focused checks and an explicitly associated test", () => {
  const fixture = exactFixture();
  const plan = planMinimumSufficientVerification({
    snapshot: fixture.snapshot,
    changeSet: changeSet(fixture.snapshot, {
      evidenceRefreshNeeds: [
        {
          id: "refresh:exact-selection",
          subject: symbolId,
          evidenceIds: [fixture.evidence.id],
          testIds: [testId],
          required: true,
          reason: "the changed Symbol invalidates its previous verification evidence",
          sourceReads: [],
        },
      ],
    }),
  });

  assert.equal(plan.mode, "shadow");
  assert.equal(plan.status, "broader-verification-required");
  assert.deepEqual(
    plan.requiredTests.map((item) => item.testId),
    [testId],
  );
  assert.deepEqual(
    plan.requiredChecks.map((item) => item.kind),
    ["static", "type"],
  );
  assert.equal(
    plan.requiredChecks.some((item) => item.kind === "build"),
    false,
  );
  assert.ok(plan.stale.some((item) => item.evidenceIds.includes(fixture.evidence.id)));
  assert.ok(plan.fullVerification.state === "must-run");
  assert.ok(plan.items.every((item) => item.provenance.ruleId.length > 0 && item.provenance.sourceKinds.length > 0));
});

test("required missing evidence is explicit and blocks sufficiency", () => {
  const perspectiveValue = perspective(createLogicalId("perspective", "missing-evidence"));
  const requirementValue = requirement("missing-evidence", target("symbol", symbolId), perspectiveValue.id);
  const snapshot = freshSnapshot({ requirements: [requirementValue], perspectives: [perspectiveValue] });
  const plan = planMinimumSufficientVerification({ snapshot, changeSet: changeSet(snapshot) });

  assert.equal(plan.sufficient, false);
  assert.ok(plan.broaderVerification?.reasonCodes.includes("required-evidence-missing"));
  assert.ok(plan.missing.some((item) => item.requirementIds.includes(requirementValue.id)));
  assert.deepEqual(plan.requiredTests, []);
  assert.equal(plan.fullVerification.state, "must-run");
});

test("an unresolved evidence test ID is explicit uncertainty and a blocking reason", () => {
  const perspectiveValue = perspective(createLogicalId("perspective", "unresolved-test"));
  const requirementValue = requirement("unresolved-test", target("symbol", symbolId), perspectiveValue.id);
  const unresolvedTestId = createLogicalId("test", "unresolved-evidence");
  const evidenceValue = {
    ...evidence("unresolved-test", target("symbol", symbolId), perspectiveValue.id),
    testId: unresolvedTestId,
  };
  const snapshot = freshSnapshot({
    requirements: [requirementValue],
    perspectives: [perspectiveValue],
    evidence: [evidenceValue],
  });
  const plan = planMinimumSufficientVerification({
    snapshot,
    changeSet: changeSet(snapshot, {
      evidenceRefreshNeeds: [
        {
          id: "refresh:unresolved-test",
          subject: symbolId,
          evidenceIds: [evidenceValue.id],
          testIds: [unresolvedTestId],
          required: true,
          reason: "the changed Symbol invalidates its previous verification evidence",
          sourceReads: [],
        },
      ],
    }),
  });

  const unresolved = plan.uncertain.find((item) => item.testId === unresolvedTestId);
  assert.ok(unresolved);
  assert.equal(unresolved?.provenance.reasonCode, "unresolved-evidence-test-id");
  assert.ok(unresolved?.provenance.sourceIds.includes(unresolvedTestId));
  assert.equal(plan.broaderVerification?.reasonCodes.includes("unresolved-evidence-test-id"), true);
  assert.equal(plan.sufficient, false);
  assert.equal(plan.fullVerification.state, "must-run");
  assert.equal(
    plan.requiredTests.some((item) => item.testId === unresolvedTestId),
    false,
  );
});

test("stale evidence is reported separately and conservatively escalates", () => {
  const perspectiveValue = perspective(createLogicalId("perspective", "stale-evidence"));
  const requirementValue = requirement("stale-evidence", target("symbol", symbolId), perspectiveValue.id);
  const evidenceValue = evidence("stale-evidence", target("symbol", symbolId), perspectiveValue.id, "stale");
  const snapshot = freshSnapshot({
    requirements: [requirementValue],
    perspectives: [perspectiveValue],
    evidence: [evidenceValue],
  });
  const plan = planMinimumSufficientVerification({ snapshot, changeSet: changeSet(snapshot) });

  assert.equal(plan.sufficient, false);
  assert.ok(plan.stale.some((item) => item.evidenceIds.includes(evidenceValue.id)));
  assert.ok(plan.broaderVerification?.reasonCodes.includes("required-evidence-stale"));
});

test("unknown impact cannot silently produce a focused plan", () => {
  const fixture = exactFixture();
  const plan = planMinimumSufficientVerification({
    snapshot: fixture.snapshot,
    changeSet: changeSet(fixture.snapshot, {
      impactPaths: [],
      unknownRegions: [
        {
          id: "unknown:dynamic-region",
          code: "dynamic-dispatch",
          message: "dynamic dispatch could not be classified",
          subjects: [symbolId],
          material: true,
          recommendedSourceReads: [],
        },
      ],
    }),
  });

  assert.equal(plan.sufficient, false);
  assert.ok(plan.broaderVerification?.reasonCodes.includes("unknown-impact-region"));
  assert.ok(plan.broaderVerification?.reasonCodes.includes("incomplete-symbol-impact"));
});

test("selection honors a preserved Component boundary instead of selecting downstream requirements", () => {
  const downstreamSymbol = "symbol:downstream" as LogicalId;
  const downstreamComponent = "component:downstream" as LogicalId;
  const sourcePerspective = perspective(createLogicalId("perspective", "source-boundary"));
  const downstreamPerspective = perspective(createLogicalId("perspective", "downstream-boundary"));
  const sourceRequirement = requirement("source-boundary", target("symbol", symbolId), sourcePerspective.id);
  const downstreamRequirement = requirement(
    "downstream-boundary",
    target("symbol", downstreamSymbol),
    downstreamPerspective.id,
  );
  const snapshot = freshSnapshot({
    requirements: [sourceRequirement, downstreamRequirement],
    perspectives: [sourcePerspective, downstreamPerspective],
    evidence: [evidence("source-boundary", target("symbol", symbolId), sourcePerspective.id)],
  });
  const plan = planMinimumSufficientVerification({
    snapshot,
    changeSet: changeSet(snapshot, {
      affectedEntities: [symbolId, componentId, downstreamSymbol, downstreamComponent],
      propagationStopPoints: [
        {
          entityId: downstreamSymbol,
          componentId: downstreamComponent,
          reason: "preserved conforming Component boundary",
          path: [symbolId, componentId, downstreamSymbol, downstreamComponent],
        },
      ],
    }),
  });

  assert.equal(
    plan.items.some((item) => item.requirementIds.includes(downstreamRequirement.id)),
    false,
  );
  assert.equal(
    plan.items.some((item) => item.requirementIds.includes(sourceRequirement.id)),
    true,
  );
});

test("shadow comparison records an unpredicted full-suite failure and never authorizes promotion", () => {
  const fixture = exactFixture();
  const plan = planMinimumSufficientVerification({
    snapshot: fixture.snapshot,
    changeSet: changeSet(fixture.snapshot),
  });
  const unexpectedFailure = "verification-item:test:unmodeled-regression";
  const comparison = compareVerificationShadow({
    plan,
    selected: {
      suite: "selected",
      status: "passed",
      executedItemIds: plan.predictedItemIds,
      failedItemIds: [],
      durationMs: 25,
    },
    full: {
      suite: "full",
      status: "failed",
      executedItemIds: [...plan.predictedItemIds, unexpectedFailure],
      failedItemIds: [unexpectedFailure],
      relevantItemIds: [unexpectedFailure],
      durationMs: 100,
    },
  });

  assert.equal(comparison.status, "miss");
  assert.equal(comparison.metrics.selectionRecall, 0);
  assert.equal(comparison.metrics.missCount, 1);
  assert.equal(comparison.metrics.runtimeReductionRatio, 0.75);
  assert.equal(comparison.misses[0]?.observedItemId, unexpectedFailure);
  assert.equal(comparison.misses[0]?.provenance.reasonCode, "full-failure-outside-prediction");
  assert.equal(comparison.promotion.eligible, false);
});

test("shadow metrics count canonical predictions once while test aliases match observations", () => {
  const fixture = exactFixture();
  const plan = planMinimumSufficientVerification({
    snapshot: fixture.snapshot,
    changeSet: changeSet(fixture.snapshot, {
      evidenceRefreshNeeds: [
        {
          id: "refresh:shadow-alias",
          subject: symbolId,
          evidenceIds: [fixture.evidence.id],
          testIds: [testId],
          required: true,
          reason: "the changed Symbol invalidates its previous verification evidence",
          sourceReads: [],
        },
      ],
    }),
  });
  const canonicalTest = plan.requiredTests.find((item) => item.testId === testId);
  assert.ok(canonicalTest);

  const comparison = compareVerificationShadow({
    plan,
    selected: {
      suite: "selected",
      status: "passed",
      executedItemIds: plan.predictedItemIds,
      failedItemIds: [],
      durationMs: 25,
    },
    full: {
      suite: "full",
      status: "passed",
      executedItemIds: [testId, ...plan.predictedItemIds],
      failedItemIds: [],
      relevantItemIds: [testId],
      durationMs: 100,
    },
  });

  const unnecessaryCount = plan.predictedItemIds.length - 1;
  assert.equal(comparison.status, "no-miss");
  assert.equal(comparison.metrics.selectionRecall, 1);
  assert.equal(comparison.metrics.coveredRelevantItemCount, 1);
  assert.equal(comparison.metrics.predictedItemCount, plan.predictedItemIds.length);
  assert.equal(comparison.metrics.unnecessarySelectionCount, unnecessaryCount);
  assert.equal(comparison.metrics.overSelectionRate, unnecessaryCount / plan.predictedItemIds.length);
  assert.equal(comparison.metrics.unnecessarySelectionCount <= plan.predictedItemIds.length, true);
  assert.equal(plan.predictedItemIds.includes(testId), false);
  assert.equal(plan.predictedItemIds.includes(canonicalTest!.id), true);
});

test("live model query exposes the canonical planner without replacing the query contract", async () => {
  const fixture = exactFixture();
  const { compileRepositoryModel } = await import("../model/compiler.js");
  const query = compileRepositoryModel({ snapshot: fixture.snapshot, baseSnapshot: fixture.snapshot }).query;
  const plan: VerificationPlan = query.getVerificationPlan();
  assert.equal(plan.apiVersion, "v1");
  assert.equal(plan.mode, "shadow");
  assert.ok(plan.provenance.producer.length > 0);
});
