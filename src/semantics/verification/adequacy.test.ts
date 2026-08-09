import assert from "node:assert/strict";
import test from "node:test";
import { computeIntegrityDigestsFromValidated, canonicalizeSnapshot } from "../ir/canonical.js";
import { createLogicalId, type LogicalId } from "../ir/ids.js";
import { parseSnapshot, serializeSnapshot } from "../ir/serialize.js";
import type {
  Provenance,
  RepositorySemanticSnapshot,
  VerificationAnalysis,
  VerificationEvidence,
  VerificationPerspective,
  VerificationRequirement,
  VerificationRequirementStrength,
  VerificationTarget,
} from "../ir/types.js";
import { pureFunctionFixture } from "../fixtures/snapshots.js";
import { validateSnapshot } from "../ir/schema.js";
import { toVerificationView } from "./projection.js";
import {
  aggregateVerification,
  buildVerificationAnalysis,
  deriveVerificationRequirements,
  EFFECT_FAILURE_PERSPECTIVE_ID,
  evaluateVerification,
  SECURITY_DENIAL_PERSPECTIVE_ID,
  SECURITY_ESCALATION_PERSPECTIVE_ID,
} from "./adequacy.js";

const symbolId = pureFunctionFixture.derived.symbols[0]!.id;
const componentId = pureFunctionFixture.declarations.components[0]!.id;
const projectId = pureFunctionFixture.declarations.project.id;
const contractId = pureFunctionFixture.declarations.contracts[0]!.id;
const invariantId = pureFunctionFixture.declarations.invariants[0]!.id;
const testId = pureFunctionFixture.observed.tests[0]!.id;
const sourceRevision = pureFunctionFixture.derived.symbols[0]!.provenance.sourceRevision;

function provenance(kind: Provenance["kind"]): Provenance {
  return {
    kind,
    producer: { name: "verification-test", version: "1" },
    sourceRevision,
  };
}

function perspective(
  id: LogicalId = createLogicalId("perspective", "semantic-assertion"),
  kind = "assertion",
  known = true,
): VerificationPerspective {
  return {
    id,
    kind,
    category: "semantic",
    name: kind,
    known,
    authority: "declared",
    provenance: provenance("declared"),
  };
}

function target(kind: VerificationTarget["kind"], id: LogicalId): VerificationTarget {
  return { kind, id };
}

function requirement(
  id: string,
  targetValue: VerificationTarget,
  perspectiveId: LogicalId,
  options: {
    strength?: VerificationRequirementStrength;
    origin?: VerificationRequirement["requirementProvenance"]["kind"];
    sourceId?: LogicalId;
    authority?: VerificationRequirement["authority"];
    provenanceKind?: Provenance["kind"];
    minimumEvidenceStrength?: VerificationRequirement["minimumEvidenceStrength"];
  } = {},
): VerificationRequirement {
  return {
    id: createLogicalId("requirement", id),
    target: targetValue,
    perspectiveId,
    strength: options.strength ?? "required",
    rationale: `Requirement ${id}`,
    requirementProvenance: {
      kind: options.origin ?? "explicit-declaration",
      ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    },
    ...(options.minimumEvidenceStrength === undefined
      ? {}
      : { minimumEvidenceStrength: options.minimumEvidenceStrength }),
    authority: options.authority ?? "declared",
    provenance: provenance(options.provenanceKind ?? "declared"),
  };
}

function evidence(
  id: string,
  targetValue: VerificationTarget,
  perspectiveId: LogicalId,
  options: {
    kind: string;
    strength: string;
    freshness?: VerificationEvidence["freshness"];
    status?: VerificationEvidence["status"];
    coverage?: number;
  },
): VerificationEvidence {
  return {
    id: createLogicalId("verification", id),
    target: targetValue,
    perspectiveId,
    testId,
    kind: options.kind,
    strength: options.strength,
    freshness: options.freshness ?? "current",
    status: options.status ?? "passed",
    reference: `artifact:${id}`,
    summary: `Verification evidence ${id}`,
    ...(options.coverage === undefined ? {} : { coverage: options.coverage }),
    authority: "observed",
    provenance: provenance("observed"),
  };
}

function freshSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  return {
    ...snapshot,
    integrity: {
      ...snapshot.integrity,
      status: "fresh",
      statusReason: undefined,
      ...computeIntegrityDigestsFromValidated(snapshot),
    },
  };
}

function snapshotWithVerification(options: {
  perspectives?: VerificationPerspective[];
  requirements?: VerificationRequirement[];
  derivedRequirements?: VerificationRequirement[];
  evidence?: VerificationEvidence[];
  analysis?: VerificationAnalysis;
}): RepositorySemanticSnapshot {
  const snapshot = structuredClone(pureFunctionFixture);
  const perspectives = options.perspectives ?? [perspective()];
  const requirements = options.requirements ?? [];
  const evidenceItems = options.evidence ?? [];
  snapshot.declarations.verificationPerspectives = perspectives;
  snapshot.declarations.verificationRequirements = requirements;
  snapshot.derived.verificationRequirements = options.derivedRequirements ?? [];
  snapshot.observed.verificationEvidence = evidenceItems;
  snapshot.analysis.verification =
    options.analysis ??
    buildVerificationAnalysis([...requirements, ...(options.derivedRequirements ?? [])], evidenceItems, perspectives, [
      { scope: "symbol", targetId: symbolId },
    ]);
  return freshSnapshot(snapshot);
}

test("required perspective is satisfied only by sufficient current verification evidence", () => {
  const perspectiveId = createLogicalId("perspective", "required-current");
  const req = requirement("required-current", target("symbol", symbolId), perspectiveId);
  const proof = evidence("assertion-current", target("symbol", symbolId), perspectiveId, {
    kind: "assertion",
    strength: "verification",
  });
  const [assessment] = evaluateVerification([req], [proof], [perspective(perspectiveId)]);
  assert.equal(assessment?.status, "satisfied");
  const summary = aggregateVerification([assessment!], { scope: "symbol", targetId: symbolId });
  assert.equal(summary.status, "healthy");
  assert.deepEqual(summary.gapRequirementIds, []);
});

test("required missing and recommended missing remain distinct health signals", () => {
  const perspectiveId = createLogicalId("perspective", "missing");
  const required = requirement("required-missing", target("symbol", symbolId), perspectiveId);
  const recommended = requirement("recommended-missing", target("symbol", symbolId), perspectiveId, {
    strength: "recommended",
  });
  const assessments = evaluateVerification([required, recommended], [], [perspective(perspectiveId)]);
  const summary = aggregateVerification(assessments, { scope: "symbol", targetId: symbolId });
  assert.equal(summary.required.missing, 1);
  assert.equal(summary.recommended.missing, 1);
  assert.equal(summary.status, "incomplete");
  assert.deepEqual(summary.gapRequirementIds, [required.id, recommended.id].sort());

  const recommendedOnly = aggregateVerification([assessments.find((item) => item.requirementId === recommended.id)!], {
    scope: "symbol",
    targetId: symbolId,
  });
  assert.equal(recommendedOnly.status, "healthy");
  assert.deepEqual(recommendedOnly.gapRequirementIds, [recommended.id]);
});

test("stale and failed evidence are not current satisfaction", () => {
  const stalePerspectiveId = createLogicalId("perspective", "stale");
  const failedPerspectiveId = createLogicalId("perspective", "failed");
  const staleRequirement = requirement("stale", target("symbol", symbolId), stalePerspectiveId);
  const failedRequirement = requirement("failed", target("symbol", symbolId), failedPerspectiveId);
  const assessments = evaluateVerification(
    [staleRequirement, failedRequirement],
    [
      evidence("stale-proof", target("symbol", symbolId), stalePerspectiveId, {
        kind: "assertion",
        strength: "verification",
        freshness: "stale",
      }),
      evidence("failed-proof", target("symbol", symbolId), failedPerspectiveId, {
        kind: "assertion",
        strength: "verification",
        status: "failed",
      }),
    ],
    [perspective(stalePerspectiveId), perspective(failedPerspectiveId)],
  );
  assert.deepEqual(assessments.map((item) => item.status).sort(), ["failed", "stale"].sort());
});

test("a stale historical failure does not permanently block a current passing proof", () => {
  const perspectiveId = createLogicalId("perspective", "stale-failure-recovery");
  const req = requirement("stale-failure-recovery", target("symbol", symbolId), perspectiveId);
  const assessments = evaluateVerification(
    [req],
    [
      evidence("stale-failed-proof", target("symbol", symbolId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
        status: "failed",
        freshness: "stale",
      }),
      evidence("current-passed-proof", target("symbol", symbolId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
      }),
    ],
    [perspective(perspectiveId)],
  );
  assert.equal(assessments[0]?.status, "satisfied");
  assert.deepEqual(assessments[0]?.satisfyingEvidenceIds, [createLogicalId("verification", "current-passed-proof")]);
});

test("a current failure still blocks satisfaction even alongside stale passing proof", () => {
  const perspectiveId = createLogicalId("perspective", "current-failure-blocks");
  const req = requirement("current-failure-blocks", target("symbol", symbolId), perspectiveId);
  const assessments = evaluateVerification(
    [req],
    [
      evidence("current-failed-proof", target("symbol", symbolId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
        status: "failed",
      }),
      evidence("stale-passed-proof", target("symbol", symbolId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
        freshness: "stale",
      }),
    ],
    [perspective(perspectiveId)],
  );
  assert.equal(assessments[0]?.status, "failed");
});

test("intended, static linkage, execution, and coverage remain insufficient without proof strength", () => {
  const kinds = [
    ["intended", "association"],
    ["static-linkage", "association"],
    ["execution", "observation"],
    ["coverage", "observation"],
  ] as const;
  const perspectiveId = createLogicalId("perspective", "insufficient");
  for (const [kind, strength] of kinds) {
    const req = requirement(`insufficient-${kind}`, target("symbol", symbolId), perspectiveId);
    const observed = evidence(`observed-${kind}`, target("symbol", symbolId), perspectiveId, {
      kind,
      strength,
      ...(kind === "coverage" ? { coverage: 100 } : {}),
    });
    const [assessment] = evaluateVerification([req], [observed], [perspective(perspectiveId)]);
    assert.equal(assessment?.status, "inadequate", kind);
  }
});

test("a required perspective cannot lower its proof floor to make coverage sufficient", () => {
  const perspectiveId = createLogicalId("perspective", "required-floor");
  const req = requirement("required-floor", target("symbol", symbolId), perspectiveId, {
    minimumEvidenceStrength: "observation",
  });
  const [assessment] = evaluateVerification(
    [req],
    [
      evidence("required-floor-coverage", target("symbol", symbolId), perspectiveId, {
        kind: "coverage",
        strength: "observation",
        coverage: 100,
      }),
    ],
    [perspective(perspectiveId)],
  );
  assert.equal(assessment?.status, "inadequate");
});

test("Contract and Invariant targets remain typed logical identities", () => {
  const perspectiveId = createLogicalId("perspective", "contract-invariant");
  const contractRequirement = requirement("contract-target", target("contract", contractId), perspectiveId, {
    origin: "contract",
    sourceId: contractId,
  });
  const invariantRequirement = requirement("invariant-target", target("invariant", invariantId), perspectiveId, {
    origin: "invariant",
    sourceId: invariantId,
  });
  const assessments = evaluateVerification(
    [contractRequirement, invariantRequirement],
    [
      evidence("contract-proof", target("contract", contractId), perspectiveId, {
        kind: "contract",
        strength: "verification",
      }),
      evidence("invariant-proof", target("invariant", invariantId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
      }),
    ],
    [perspective(perspectiveId)],
  );
  assert.deepEqual(
    assessments.map((item) => item.status),
    ["satisfied", "satisfied"],
  );
  assert.equal(
    snapshotWithVerification({ requirements: [contractRequirement, invariantRequirement] }).integrity.status,
    "fresh",
  );
});

test("Symbol -> Component -> Project aggregation preserves requirement gaps", () => {
  const perspectiveId = createLogicalId("perspective", "aggregation");
  const secondSymbolId = pureFunctionFixture.derived.symbols[0]!.id;
  const missing = requirement("aggregate-gap", target("symbol", secondSymbolId), perspectiveId);
  const satisfied = requirement("aggregate-satisfied", target("component", componentId), perspectiveId);
  const proof = evidence("component-proof", target("component", componentId), perspectiveId, {
    kind: "assertion",
    strength: "verification",
  });
  const assessments = evaluateVerification([missing, satisfied], [proof], [perspective(perspectiveId)]);
  const component = aggregateVerification(assessments, {
    scope: "component",
    targetId: componentId,
    memberTargetIds: [secondSymbolId],
  });
  const project = aggregateVerification(assessments, {
    scope: "project",
    targetId: projectId,
    memberTargetIds: [componentId, secondSymbolId],
  });
  assert.equal(component.status, "incomplete");
  assert.equal(project.status, "incomplete");
  assert.deepEqual(component.gapRequirementIds, [missing.id]);
  assert.deepEqual(project.gapRequirementIds, [missing.id]);
});

test("unknown perspective kind is preserved and does not become healthy", () => {
  const perspectiveId = createLogicalId("perspective", "future-taxonomy");
  const req = requirement("unknown-perspective", target("symbol", symbolId), perspectiveId);
  const proof = evidence("future-proof", target("symbol", symbolId), perspectiveId, {
    kind: "future-provider-proof",
    strength: "verification",
  });
  const [assessment] = evaluateVerification(
    [req],
    [proof],
    [perspective(perspectiveId, "future-security-kind", false)],
  );
  assert.equal(assessment?.status, "unknown");
  assert.equal(aggregateVerification([assessment!], { scope: "symbol", targetId: symbolId }).status, "unknown");
});

test("deterministic requirement rules consume known facts and do not infer effects", () => {
  const requirements = deriveVerificationRequirements({
    sourceRevision,
    authorizationBoundaries: [target("symbol", symbolId)],
    effectfulSymbols: [target("symbol", symbolId)],
  });
  assert.equal(requirements.length, 3);
  assert.ok(requirements.every((item) => item.authority === "derived"));
  assert.ok(requirements.every((item) => item.requirementProvenance.kind === "deterministic-derived-rule"));
  assert.ok(requirements.some((item) => item.perspectiveId === SECURITY_DENIAL_PERSPECTIVE_ID));
  assert.ok(requirements.some((item) => item.perspectiveId === SECURITY_ESCALATION_PERSPECTIVE_ID));
  assert.ok(requirements.some((item) => item.perspectiveId === EFFECT_FAILURE_PERSPECTIVE_ID));
});

test("schema validates derived rule authority and rejects free-path or inferred authoritative requirements", () => {
  const derivedPerspectives = [
    perspective(SECURITY_DENIAL_PERSPECTIVE_ID, "security-denial"),
    perspective(SECURITY_ESCALATION_PERSPECTIVE_ID, "security-escalation"),
    perspective(EFFECT_FAILURE_PERSPECTIVE_ID, "effect-failure"),
  ];
  const derivedRequirements = deriveVerificationRequirements({
    sourceRevision,
    authorizationBoundaries: [target("symbol", symbolId)],
    effectfulSymbols: [target("symbol", symbolId)],
  });
  assert.equal(
    validateSnapshot(snapshotWithVerification({ perspectives: derivedPerspectives, derivedRequirements })).ok,
    true,
  );

  const invalidTarget = structuredClone(pureFunctionFixture) as RepositorySemanticSnapshot & {
    declarations: RepositorySemanticSnapshot["declarations"] & {
      verificationPerspectives: VerificationPerspective[];
      verificationRequirements: VerificationRequirement[];
    };
  };
  const perspectiveId = createLogicalId("perspective", "schema-rejection");
  invalidTarget.declarations.verificationPerspectives = [perspective(perspectiveId)];
  invalidTarget.declarations.verificationRequirements = [
    requirement("bad-target", target("symbol", symbolId), perspectiveId),
  ];
  invalidTarget.declarations.verificationRequirements[0]!.target = {
    kind: "symbol",
    id: "src/not-a-logical-id" as LogicalId,
  };
  assert.equal(validateSnapshot(invalidTarget).ok, false);

  const inferredAsDeclared = structuredClone(pureFunctionFixture);
  inferredAsDeclared.declarations.verificationPerspectives = [perspective(perspectiveId)];
  inferredAsDeclared.declarations.verificationRequirements = [
    requirement("bad-inference", target("symbol", symbolId), perspectiveId, {
      origin: "inferred",
    }),
  ];
  const inferredResult = validateSnapshot(inferredAsDeclared);
  assert.equal(inferredResult.ok, false);
  if (!inferredResult.ok)
    assert.ok(inferredResult.diagnostics.some((item) => item.code === "inferred_requirement_not_authoritative"));
});

test("inferred requirements remain analysis suggestions and are ignored by adequacy", () => {
  const perspectiveId = createLogicalId("perspective", "inferred");
  const inferred = requirement("inferred", target("symbol", symbolId), perspectiveId, {
    origin: "inferred",
    authority: "analysis",
    provenanceKind: "inferred",
  });
  assert.deepEqual(evaluateVerification([inferred], [], [perspective(perspectiveId)]), []);
  const snapshot = snapshotWithVerification({
    analysis: {
      authority: "analysis",
      assessments: [],
      summaries: [],
      inferredRequirements: [inferred],
    },
    perspectives: [perspective(perspectiveId)],
  });
  assert.equal(validateSnapshot(snapshot).ok, true);
});

test("verification records have deterministic canonical ordering and schema v2 stays backward compatible", () => {
  const perspectiveId = createLogicalId("perspective", "canonical");
  const first = requirement("canonical-a", target("symbol", symbolId), perspectiveId);
  const second = requirement("canonical-b", target("symbol", symbolId), perspectiveId, { strength: "recommended" });
  const firstEvidence = evidence("canonical-a", target("symbol", symbolId), perspectiveId, {
    kind: "assertion",
    strength: "verification",
  });
  const secondEvidence = evidence("canonical-b", target("symbol", symbolId), perspectiveId, {
    kind: "coverage",
    strength: "observation",
    coverage: 100,
  });
  const snapshot = snapshotWithVerification({
    perspectives: [perspective(perspectiveId)],
    requirements: [second, first],
    evidence: [secondEvidence, firstEvidence],
  });
  const shuffled = structuredClone(snapshot);
  shuffled.declarations.verificationRequirements = [...snapshot.declarations.verificationRequirements!].reverse();
  shuffled.observed.verificationEvidence = [...snapshot.observed.verificationEvidence!].reverse();
  shuffled.analysis.verification!.assessments = [...shuffled.analysis.verification!.assessments].reverse();
  shuffled.analysis.verification!.summaries = [...shuffled.analysis.verification!.summaries].reverse();
  assert.equal(serializeSnapshot(shuffled), serializeSnapshot(snapshot));
  assert.equal(validateSnapshot(pureFunctionFixture).ok, true);
  assert.equal(pureFunctionFixture.schemaVersion, 2);
  assert.equal(canonicalizeSnapshot(snapshot).declarations.verificationRequirements?.[0]?.id, first.id);
  const parsed = parseSnapshot(serializeSnapshot(snapshot));
  assert.equal(parsed.ok, true);
});

test("query projection exposes required, missing, stale, and gap drilldown additively", () => {
  const perspectiveId = createLogicalId("perspective", "query");
  const req = requirement("query-gap", target("symbol", symbolId), perspectiveId);
  const [assessment] = evaluateVerification(
    [req],
    [
      evidence("query-stale", target("symbol", symbolId), perspectiveId, {
        kind: "assertion",
        strength: "verification",
        freshness: "stale",
      }),
    ],
    [perspective(perspectiveId)],
  );
  const summary = aggregateVerification([assessment!], { scope: "symbol", targetId: symbolId });
  const view = toVerificationView(summary, [assessment!], {
    authority: "analysis",
    status: "fixture",
    provider: "verification-test",
    note: "deterministic test projection",
  });
  assert.equal(view.health.required.stale, 1);
  assert.deepEqual(view.health.gapRequirementIds, [req.id]);
  assert.equal(view.health.gaps[0]?.status, "stale");
});
