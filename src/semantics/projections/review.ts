import type { RepositorySemanticSnapshot, SourceReference } from "../ir/types.js";
import { compareText } from "../ir/canonical.js";
import type { DerivedChange, SemanticChangeSet, SemanticDeltaRecord, UnknownRegion } from "../diff/types.js";
import type { SemanticChangeSetView } from "../query.js";
import { budgetStructuredProjection, capItems, resolveSemanticProjectionBudget } from "./budget.js";
import {
  createProjectionModel,
  entityReference,
  projectedProvenance,
  sourceReadsFor,
  uniqueReads,
  type ProjectionModel,
} from "./model.js";
import type {
  ProjectionModelState,
  ProjectionOmission,
  ProjectionUnknown,
  ProjectedEntityReference,
  ReviewProjection,
  ReviewProjectionInput,
  SemanticProjectionBudgetOptions,
  SupportedProjectionChangeSet,
  EntityId,
} from "./types.js";

function isCanonical(changeSet: SupportedProjectionChangeSet): changeSet is SemanticChangeSet {
  return "baseSnapshotId" in changeSet && "semanticDeltas" in changeSet;
}

function canonicalDeltas(changeSet: SupportedProjectionChangeSet): readonly SemanticDeltaRecord[] {
  if (isCanonical(changeSet)) return changeSet.semanticDeltas;
  return (changeSet.semanticDeltas ?? changeSet.entries).map((entry) => {
    if ("subject" in entry) return entry;
    return {
      id: entry.id,
      subject: entry.entityId as SemanticDeltaRecord["subject"],
      kind: entry.kind,
      summary: entry.summary,
      reviewLevel: entry.reviewLevel,
      compatibility: "unknown" as const,
      sourceChangeIds: [],
      protected: entry.reviewLevel === "L3",
      breaking: entry.reviewLevel === "L3",
    };
  });
}

function changedSymbolIds(changeSet: SupportedProjectionChangeSet): readonly EntityId[] {
  if (isCanonical(changeSet)) return changeSet.changedSymbols;
  return (
    changeSet.changedSymbolIds ??
    changeSet.symbolChanges
      ?.flatMap((item) => [item.beforeId, item.afterId])
      .filter((id) => id !== undefined)
      .map((id) => String(id)) ??
    []
  );
}

function implementationChanges(changeSet: SupportedProjectionChangeSet): readonly DerivedChange[] {
  return changeSet.derivedChanges ?? [];
}

function unknownRegions(changeSet: SupportedProjectionChangeSet): readonly UnknownRegion[] {
  return changeSet.unknownRegions ?? [];
}

function modelFor(snapshot: RepositorySemanticSnapshot | undefined): {
  model?: ProjectionModel;
  state: ProjectionModelState;
} {
  if (snapshot !== undefined) {
    const model = createProjectionModel(snapshot);
    return { model, state: model.state };
  }
  return {
    state: {
      status: "unknown",
      integrity: "stale",
      authoritative: false,
      reason: "no live snapshot was supplied to the review projection",
    },
  };
}

function unknownProjection(region: UnknownRegion, index: number): ProjectionUnknown {
  return {
    id: region.id || `unknown:review:${index}`,
    code: region.code,
    message: region.message,
    subjects: region.subjects,
    material: region.material,
    authoritative: false,
    recommendedSourceReads: region.recommendedSourceReads,
  };
}

function referencesFor(model: ProjectionModel | undefined, ids: readonly EntityId[]): ProjectedEntityReference[] {
  if (model === undefined) return [];
  return [...new Set(ids)]
    .sort(compareText)
    .map((id) => entityReference(model, id))
    .filter((item): item is ProjectedEntityReference => item !== undefined);
}

function affectedSymbolIds(changeSet: SupportedProjectionChangeSet, model: ProjectionModel | undefined): EntityId[] {
  const ids = [...new Set([...changedSymbolIds(changeSet), ...(changeSet.affectedEntities ?? [])])];
  return ids
    .filter((id) => model?.entity(id)?.kind === "symbol" || (model === undefined && id.startsWith("symbol:")))
    .sort(compareText);
}

function sourceReads(changeSet: SupportedProjectionChangeSet, model: ProjectionModel | undefined): SourceReference[] {
  const reads = [...(isCanonical(changeSet) ? changeSet.recommendedSourceReads : changeSet.recommendedReads)];
  if (model !== undefined) for (const id of changedSymbolIds(changeSet)) reads.push(...sourceReadsFor(model, id));
  return uniqueReads(reads);
}

function statusForChangeSet(
  changeSet: SupportedProjectionChangeSet,
): "fresh" | "stale" | "invalid" | "unavailable" | "unknown" {
  if (isCanonical(changeSet)) return changeSet.unknownRegions.length > 0 ? "stale" : "fresh";
  return changeSet.provenance.status === "unavailable"
    ? "unavailable"
    : changeSet.provenance.status === "fixture"
      ? "fresh"
      : "stale";
}

export function projectReview(input: ReviewProjectionInput): ReviewProjection {
  const changeSet = input.changeSet;
  const options = input.options ?? {};
  const resolved = resolveSemanticProjectionBudget(options);
  const { model, state: snapshotState } = modelFor(input.snapshot);
  const deltas = [...canonicalDeltas(changeSet)].sort((left, right) => compareText(left.id, right.id));
  const boundedDeltas = capItems(
    deltas,
    resolved.maxChanges,
    "semanticDelta",
    "semantic deltas exceeded their deterministic structural limit",
    "required",
  );
  const boundedAffectedEntities = capItems(
    changeSet.affectedEntities ?? [],
    resolved.maxSymbols,
    "impact.affectedEntities",
    "affected entities exceeded their deterministic structural limit",
    "required",
  );
  const boundedPaths = capItems(
    changeSet.impactPaths ?? [],
    resolved.maxImpactPaths,
    "impact.paths",
    "impact paths exceeded their deterministic structural limit",
    "required",
  );
  const boundedStopBoundaries = capItems(
    changeSet.propagationStopPoints ?? [],
    resolved.maxImpactPaths,
    "impact.stopBoundaries",
    "propagation stop boundaries exceeded their deterministic structural limit",
    "required",
  );
  const symbols = referencesFor(model, affectedSymbolIds(changeSet, model).slice(0, resolved.maxSymbols));
  const boundedUnknowns = capItems(
    unknownRegions(changeSet),
    resolved.maxChanges,
    "unknowns",
    "review unknowns exceeded their deterministic structural limit",
    "required",
  );
  const unknowns = boundedUnknowns.items.map(unknownProjection);
  const reads = sourceReads(changeSet, model);
  const boundedReads = capItems(
    reads,
    resolved.maxSourceReads,
    "recommendedSourceReads",
    "additional exact review source reads omitted",
    "navigation",
  );
  const modelState: ProjectionModelState =
    model === undefined
      ? { ...snapshotState, status: statusForChangeSet(changeSet), authoritative: false }
      : snapshotState;
  const provenance =
    isCanonical(changeSet) && model !== undefined
      ? projectedProvenance(
          model,
          "analysis",
          "Review projection consumes #54 Semantic Change Set without reclassification",
          undefined,
        )
      : isCanonical(changeSet)
        ? {
            provider: "mottainai-semantic-diff-engine",
            authority: "analysis" as const,
            status: modelState.status,
            authoritative: false,
            note: "canonical #54 change set was supplied without a live snapshot; current authority is unavailable",
          }
        : {
            provider: changeSet.provenance.provider,
            authority: changeSet.provenance.authority,
            status: modelState.status,
            authoritative: modelState.authoritative,
            note: "Review projection consumes the existing RepositorySemanticQuery change-set view without reclassification",
          };
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "review",
    model: modelState,
    ...(changeSet.reviewLevel === undefined ? {} : { reviewLevel: changeSet.reviewLevel }),
    reviewReasons: changeSet.reviewReasons ?? [],
    provenance,
  };
  const boundedImplementation = capItems(
    implementationChanges(changeSet),
    resolved.maxChanges,
    "implementationChanges",
    "implementation changes exceeded their deterministic structural limit",
    "evidence",
  );
  const boundedSymbolChanges = capItems(
    changeSet.symbolChanges ?? [],
    resolved.maxSymbols,
    "symbolChanges",
    "Symbol changes exceeded their deterministic structural limit",
    "verbose",
  );
  const boundedEvidenceRefresh = capItems(
    changeSet.evidenceRefreshNeeds ?? [],
    resolved.maxEvidence,
    "evidenceRefresh",
    "evidence refresh needs exceeded their deterministic structural limit",
    "evidence",
  );
  const boundedEffectViolations = capItems(
    changeSet.effectViolations ?? [],
    resolved.maxEvidence,
    "effectViolations",
    "effect violations exceeded their deterministic structural limit",
    "evidence",
  );
  const semanticDelta = boundedDeltas.items;
  const implementation = boundedImplementation.items;
  const symbolChangeList = boundedSymbolChanges.items;
  const evidenceRefresh = boundedEvidenceRefresh.items;
  const effectViolations = boundedEffectViolations.items;
  const groups = [
    {
      field: "semanticDelta",
      value: semanticDelta,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "semantic delta omitted under response budget",
      count: deltas.length,
    },
    {
      field: "impact",
      value: {
        affectedEntities: boundedAffectedEntities.items,
        affectedSymbols: symbols,
        paths: boundedPaths.items,
        stopBoundaries: boundedStopBoundaries.items,
      },
      priority: "required" as const,
      emptyValue: { affectedEntities: [], affectedSymbols: [], paths: [], stopBoundaries: [] },
      omissionReason: "impact propagation omitted under response budget",
    },
    ...(changeSet.authorizedVsActual === undefined
      ? []
      : [
          {
            field: "authorizedVsActual",
            value: changeSet.authorizedVsActual,
            priority: "required" as const,
            emptyValue: undefined,
            omissionReason: "authorized-vs-actual transaction omitted under response budget",
          },
        ]),
    {
      field: "evidenceRefresh",
      value: evidenceRefresh,
      priority: "evidence" as const,
      emptyValue: [],
      omissionReason: "evidence refresh detail omitted under response budget",
      count: (changeSet.evidenceRefreshNeeds ?? []).length,
    },
    {
      field: "unknowns",
      value: unknowns,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "review unknowns omitted under response budget",
      count: unknowns.length,
    },
    {
      field: "implementationChanges",
      value: implementation,
      priority: "evidence" as const,
      emptyValue: [],
      omissionReason: "implementation-only churn omitted after semantic review data",
      count: implementationChanges(changeSet).length,
    },
    {
      field: "symbolChanges",
      value: symbolChangeList,
      priority: "verbose" as const,
      emptyValue: [],
      omissionReason: "Symbol locator churn omitted after semantic review data",
      count: (changeSet.symbolChanges ?? []).length,
    },
    {
      field: "effectViolations",
      value: effectViolations,
      priority: "evidence" as const,
      emptyValue: [],
      omissionReason: "effect violation detail omitted under response budget",
      count: (changeSet.effectViolations ?? []).length,
    },
    {
      field: "recommendedSourceReads",
      value: boundedReads.items,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "exact review source reads omitted under response budget",
      count: boundedReads.items.length,
    },
  ];
  const initialOmissions: ProjectionOmission[] = [
    boundedReads.omission,
    boundedDeltas.omission,
    boundedAffectedEntities.omission,
    boundedPaths.omission,
    boundedStopBoundaries.omission,
    boundedUnknowns.omission,
    boundedImplementation.omission,
    boundedSymbolChanges.omission,
    boundedEvidenceRefresh.omission,
    boundedEffectViolations.omission,
  ].filter((item): item is ProjectionOmission => item !== undefined);
  const bounded = budgetStructuredProjection(base, groups, resolved, initialOmissions);
  return {
    ...bounded.value,
    apiVersion: 1,
    kind: "review",
    omissions: bounded.omissions,
    budget: bounded.budget,
  } as ReviewProjection;
}

export const projectReviewProjection = projectReview;
