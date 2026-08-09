import { createHash } from "node:crypto";
import type {
  AnalysisState,
  ContentDigest,
  DeclaredState,
  DerivedState,
  EvidenceEntity,
  ObservedState,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticClaim,
  SemanticEntity,
  SemanticFact,
  SemanticRelation,
  VerificationAnalysis,
  VerificationAssessment,
  VerificationEvidence,
  VerificationPerspective,
  VerificationRequirement,
  VerificationSummary,
} from "./types.js";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableStringifyValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringifyValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringifyValue(entry)}`).join(",")}}`;
  }
  throw new Error("semantic serialization encountered an unsupported value");
}

function sortByKey<T>(items: T[], keyOf: (item: T) => unknown): T[] {
  return items
    .map((item) => ({ item, key: stableStringifyValue(keyOf(item)) }))
    .sort((left, right) => compareText(left.key, right.key))
    .map((entry) => entry.item);
}

function canonicalizeProvenance(provenance: Provenance): Provenance {
  return {
    ...provenance,
    ...(provenance.evidence === undefined ? {} : { evidence: sortByKey([...provenance.evidence], (item) => item) }),
    ...(provenance.ambiguity === undefined
      ? {}
      : {
          ambiguity: {
            ...provenance.ambiguity,
            ...(provenance.ambiguity.candidates === undefined
              ? {}
              : { candidates: [...provenance.ambiguity.candidates].sort(compareText) }),
          },
        }),
  };
}

function canonicalizeEntity<T extends SemanticEntity>(entity: T): T {
  const canonical = {
    ...entity,
    provenance: canonicalizeProvenance(entity.provenance),
  } as T;
  if (canonical.kind === "symbol") {
    return canonical as T;
  }
  if (canonical.kind === "contract") {
    return {
      ...canonical,
      definition: {
        ...canonical.definition,
        outputs: {
          ...canonical.definition.outputs,
          effects: [...canonical.definition.outputs.effects].sort(compareText),
        },
      },
    } as T;
  }
  if (canonical.kind === "decision") {
    return {
      ...canonical,
      rationaleIds: [...canonical.rationaleIds].sort(compareText),
      constraintIds: [...canonical.constraintIds].sort(compareText),
    } as T;
  }
  if (canonical.kind === "rationale") {
    return { ...canonical, decisionIds: [...canonical.decisionIds].sort(compareText) } as T;
  }
  if (canonical.kind === "test") {
    return { ...canonical, evidenceIds: [...canonical.evidenceIds].sort(compareText) } as T;
  }
  return canonical;
}

function canonicalizeFact(fact: SemanticFact): SemanticFact {
  return { ...fact, provenance: canonicalizeProvenance(fact.provenance) };
}

function canonicalizeClaim(claim: SemanticClaim): SemanticClaim {
  return { ...claim, provenance: canonicalizeProvenance(claim.provenance) };
}

function canonicalizeRelation(relation: SemanticRelation): SemanticRelation {
  return { ...relation, provenance: canonicalizeProvenance(relation.provenance) };
}

function canonicalizeVerificationPerspective(perspective: VerificationPerspective): VerificationPerspective {
  return { ...perspective, provenance: canonicalizeProvenance(perspective.provenance) };
}

function canonicalizeVerificationRequirement(requirement: VerificationRequirement): VerificationRequirement {
  return {
    ...requirement,
    provenance: canonicalizeProvenance(requirement.provenance),
  };
}

function canonicalizeVerificationEvidence(evidence: VerificationEvidence): VerificationEvidence {
  return { ...evidence, provenance: canonicalizeProvenance(evidence.provenance) };
}

function canonicalizeVerificationAssessment(assessment: VerificationAssessment): VerificationAssessment {
  return {
    ...assessment,
    evidenceIds: [...assessment.evidenceIds].sort(compareText),
    satisfyingEvidenceIds: [...assessment.satisfyingEvidenceIds].sort(compareText),
    ...(assessment.missingEvidenceKinds === undefined
      ? {}
      : { missingEvidenceKinds: [...assessment.missingEvidenceKinds].sort(compareText) }),
  };
}

function canonicalizeVerificationSummary(summary: VerificationSummary): VerificationSummary {
  return { ...summary, gapRequirementIds: [...summary.gapRequirementIds].sort(compareText) };
}

function canonicalizeVerificationAnalysis(verification: VerificationAnalysis): VerificationAnalysis {
  return {
    ...verification,
    assessments: verification.assessments
      .map(canonicalizeVerificationAssessment)
      .sort((left, right) =>
        compareText(`${left.target.id}:${left.requirementId}`, `${right.target.id}:${right.requirementId}`),
      ),
    summaries: verification.summaries
      .map(canonicalizeVerificationSummary)
      .sort((left, right) => compareText(`${left.scope}:${left.targetId}`, `${right.scope}:${right.targetId}`)),
    ...(verification.inferredRequirements === undefined
      ? {}
      : {
          inferredRequirements: verification.inferredRequirements
            .map(canonicalizeVerificationRequirement)
            .sort((left, right) => compareText(left.id, right.id)),
        }),
  };
}

function canonicalizeDeclared(declarations: DeclaredState): DeclaredState {
  return {
    ...declarations,
    components: declarations.components.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    capabilities: declarations.capabilities
      .map(canonicalizeEntity)
      .sort((left, right) => compareText(left.id, right.id)),
    contracts: declarations.contracts.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    invariants: declarations.invariants.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    decisions: declarations.decisions.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    rationales: declarations.rationales.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    constraints: declarations.constraints.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    facts: declarations.facts.map(canonicalizeFact).sort((left, right) => compareText(left.id, right.id)),
    effectPolicies: sortByKey(
      [...declarations.effectPolicies].map((item) => ({
        ...item,
        allow: [...item.allow].sort(compareText),
        deny: [...item.deny].sort(compareText),
        rationaleIds: [...item.rationaleIds].sort(compareText),
      })),
      (item) => item,
    ),
    dependencyPolicies: sortByKey(
      [...declarations.dependencyPolicies].map((item) => ({
        ...item,
        allowedPackageIds: [...item.allowedPackageIds].sort(compareText),
        deniedPackageIds: [...item.deniedPackageIds].sort(compareText),
        rationaleIds: [...item.rationaleIds].sort(compareText),
      })),
      (item) => item,
    ),
    reviewGuidance: sortByKey([...declarations.reviewGuidance], (item) => item),
    stability: sortByKey([...declarations.stability], (item) => item),
    terminology: sortByKey(
      [...declarations.terminology].map((item) => ({
        ...item,
        relatedEntityIds: [...item.relatedEntityIds].sort(compareText),
      })),
      (item) => item,
    ),
    decisionLinks: sortByKey([...declarations.decisionLinks], (item) => item),
    ...(declarations.verificationPerspectives === undefined
      ? {}
      : {
          verificationPerspectives: declarations.verificationPerspectives
            .map(canonicalizeVerificationPerspective)
            .sort((left, right) => compareText(left.id, right.id)),
        }),
    ...(declarations.verificationRequirements === undefined
      ? {}
      : {
          verificationRequirements: declarations.verificationRequirements
            .map(canonicalizeVerificationRequirement)
            .sort((left, right) => compareText(left.id, right.id)),
        }),
    commentPolicy: {
      ...declarations.commentPolicy,
      semanticCommentKinds: [...declarations.commentPolicy.semanticCommentKinds].sort(compareText),
      inlineDirectives: [...declarations.commentPolicy.inlineDirectives].sort(compareText),
    },
  };
}

function canonicalizeDerived(derived: DerivedState): DerivedState {
  return {
    ...derived,
    files: derived.files.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    symbols: derived.symbols.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    packages: derived.packages.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    externalDependencies: derived.externalDependencies
      .map(canonicalizeEntity)
      .sort((left, right) => compareText(left.id, right.id)),
    externalApis: derived.externalApis.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    facts: derived.facts.map(canonicalizeFact).sort((left, right) => compareText(left.id, right.id)),
    ...(derived.verificationRequirements === undefined
      ? {}
      : {
          verificationRequirements: derived.verificationRequirements
            .map(canonicalizeVerificationRequirement)
            .sort((left, right) => compareText(left.id, right.id)),
        }),
  };
}

function canonicalizeObserved(observed: ObservedState): ObservedState {
  const evidences: EvidenceEntity[] = observed.evidences.map(canonicalizeEntity);
  return {
    ...observed,
    evidences: evidences.sort((left, right) => compareText(left.id, right.id)),
    tests: observed.tests.map(canonicalizeEntity).sort((left, right) => compareText(left.id, right.id)),
    facts: observed.facts.map(canonicalizeFact).sort((left, right) => compareText(left.id, right.id)),
    ...(observed.verificationEvidence === undefined
      ? {}
      : {
          verificationEvidence: observed.verificationEvidence
            .map(canonicalizeVerificationEvidence)
            .sort((left, right) => compareText(left.id, right.id)),
        }),
  };
}

function canonicalizeAnalysis(analysis: AnalysisState): AnalysisState {
  return {
    ...analysis,
    semanticDelta: {
      ...analysis.semanticDelta,
      entries: sortByKey([...analysis.semanticDelta.entries], (item) => [item.subject, item.kind, item.id]),
    },
    facts: analysis.facts.map(canonicalizeFact).sort((left, right) => compareText(left.id, right.id)),
    claims: analysis.claims.map(canonicalizeClaim).sort((left, right) => compareText(left.id, right.id)),
    unknowns: sortByKey(
      [...analysis.unknowns].map((unknown) => ({
        ...unknown,
        ...(unknown.subjects === undefined ? {} : { subjects: [...unknown.subjects].sort(compareText) }),
      })),
      (item) => item,
    ),
    recommendedSourceReads: sortByKey([...analysis.recommendedSourceReads], (item) => item),
    diagnostics: sortByKey([...analysis.diagnostics], (item) => item),
    ...(analysis.verification === undefined
      ? {}
      : { verification: canonicalizeVerificationAnalysis(analysis.verification) }),
  };
}

function canonicalizeIntegrity(
  integrity: RepositorySemanticSnapshot["integrity"],
): RepositorySemanticSnapshot["integrity"] {
  return {
    ...integrity,
    trackedFiles: sortByKey([...integrity.trackedFiles], (item) => item.path),
    extractors: sortByKey([...integrity.extractors], (item) => item),
  };
}

export function canonicalizeSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  return {
    ...snapshot,
    declarations: canonicalizeDeclared(snapshot.declarations),
    derived: canonicalizeDerived(snapshot.derived),
    observed: canonicalizeObserved(snapshot.observed),
    analysis: canonicalizeAnalysis(snapshot.analysis),
    integrity: canonicalizeIntegrity(snapshot.integrity),
    graph: {
      relations: sortByKey(snapshot.graph.relations.map(canonicalizeRelation), (relation) => [
        relation.kind,
        relation.from,
        relation.to,
        relation.id,
      ]),
    },
  };
}

export function digestCanonicalValue(value: unknown): ContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(stableStringifyValue(value), "utf8").digest("hex"),
  };
}

/**
 * Recursion-free digest recomputation for a snapshot that has already passed schema/reference
 * validation. Must not call validateSnapshot: validateReferences() uses this to fail-close on
 * digest/status inconsistency, and validateSnapshot() is what produces the validated snapshot
 * these digests describe.
 */
export function computeIntegrityDigestsFromValidated(snapshot: RepositorySemanticSnapshot): {
  semanticStateDigest: ContentDigest;
  modelDigest: ContentDigest;
  snapshotDigest: ContentDigest;
} {
  const canonical = canonicalizeSnapshot(snapshot);
  const semanticStateDigest = digestCanonicalValue({
    declarations: canonical.declarations,
    derived: canonical.derived,
    observed: canonical.observed,
    analysis: canonical.analysis,
    graph: canonical.graph,
  });
  const modelDigest = digestCanonicalValue({
    schemaVersion: canonical.schemaVersion,
    modelVersion: canonical.modelVersion,
    repositoryIdentity: canonical.repositoryIdentity,
    revisionIdentity: canonical.revisionIdentity,
    declarations: canonical.declarations,
    derived: canonical.derived,
    observed: canonical.observed,
    analysis: canonical.analysis,
    graph: canonical.graph,
  });
  const snapshotDigest = digestCanonicalValue({
    ...canonical,
    integrity: {
      ...canonical.integrity,
      semanticStateDigest: undefined,
      modelDigest: undefined,
      snapshotDigest: undefined,
    },
  });
  return { semanticStateDigest, modelDigest, snapshotDigest };
}
