import { compareText } from "../ir/canonical.js";
import type { RepositorySemanticSnapshot, SemanticEntity, SourceReference } from "../ir/types.js";
import type { SemanticChangeSet, UnknownRegion } from "../diff/types.js";
import { budgetStructuredProjection, capItems, resolveSemanticProjectionBudget } from "./budget.js";
import {
  allEntityReferences,
  createProjectionModel,
  entityReference,
  factsFor,
  projectedProvenance,
  relationName,
  relationsFor,
  sourceReadsFor,
  uniqueReads,
  type ProjectionModel,
} from "./model.js";
import type {
  AgentContextProjection,
  AgentDeltaContext,
  AgentImpactContext,
  AgentProjectionContext,
  AgentProjectionInput,
  AgentProjectionOptions,
  ProjectionOmission,
  ProjectionUnknown,
  ProjectedEntityReference,
  ProjectedFact,
  ProjectedRelation,
  ProjectedText,
  SemanticProjectionBudgetOptions,
  SemanticProjectionBudget,
  EntityId,
} from "./types.js";

function emptyContext(): AgentProjectionContext {
  return {
    symbols: [],
    capabilities: [],
    contracts: [],
    invariants: [],
    constraints: [],
    effects: [],
    dependencies: [],
    callers: [],
    callees: [],
    evidence: [],
    tests: [],
    rationales: [],
    reviewGuidance: [],
  };
}

function entityText(model: ProjectionModel, entity: SemanticEntity | undefined, value: string): ProjectedText {
  const provenance = entity?.provenance ?? model.snapshot.declarations.project.provenance;
  const authority = entity?.authority ?? "integrity";
  return {
    value,
    authority,
    provenance,
    authoritative: model.authoritative(authority, provenance),
  };
}

function kindOf(model: ProjectionModel, id: EntityId): string {
  return model.entity(id)?.kind ?? "unknown";
}

function otherIds(model: ProjectionModel, id: EntityId, kinds: readonly string[]): EntityId[] {
  const allowed = new Set(kinds);
  return model
    .relationsFor(id)
    .map((relation) => (relation.from === id ? relation.to : relation.from))
    .filter((otherId) => allowed.has(kindOf(model, otherId)))
    .sort(compareText);
}

function relationTargets(model: ProjectionModel, id: EntityId, kinds: readonly string[]): ProjectedRelation[] {
  const allowed = new Set(kinds);
  return relationsFor(model, id)
    .filter((relation) => allowed.has(relation.kind))
    .sort((left, right) => compareText(left.id, right.id));
}

function refs(model: ProjectionModel, ids: readonly EntityId[]): ProjectedEntityReference[] {
  return allEntityReferences(model, [...new Set(ids)].sort(compareText));
}

function factsWithPredicate(
  model: ProjectionModel,
  ids: readonly EntityId[],
  test: (name: string) => boolean,
): ProjectedFact[] {
  const result: ProjectedFact[] = [];
  for (const id of ids) for (const fact of factsFor(model, id)) if (test(fact.name)) result.push(fact);
  return result.sort((left, right) => compareText(`${left.name}:${left.id ?? ""}`, `${right.name}:${right.id ?? ""}`));
}

function ownerIds(model: ProjectionModel, id: EntityId): EntityId[] {
  return model
    .relationsFor(id)
    .filter((relation) => ["owns", "shares"].includes(relationName(relation.kind)))
    .map((relation) => (relation.to === id ? relation.from : relation.to))
    .filter((candidate) => kindOf(model, candidate) === "component")
    .sort(compareText);
}

function ownedSymbolIds(model: ProjectionModel, id: EntityId): EntityId[] {
  const entity = model.entity(id);
  if (entity?.kind !== "component") return entity?.kind === "symbol" ? [id] : [];
  return model
    .relationsFor(id)
    .filter((relation) => ["owns", "shares", "contains"].includes(relationName(relation.kind)))
    .map((relation) => (relation.from === id ? relation.to : relation.from))
    .filter((candidate) => kindOf(model, candidate) === "symbol")
    .sort(compareText);
}

/**
 * Return the entities that are explicitly part of a target's local semantic
 * neighborhood.  A change set's global affectedEntities list is not a target
 * filter: it may contain changes for other targets in the same transaction.
 */
function relevantTargetIds(model: ProjectionModel, targetId: EntityId): ReadonlySet<EntityId> {
  const seeds = [targetId, ...ownedSymbolIds(model, targetId), ...ownerIds(model, targetId)];
  const relevant = new Set<EntityId>(seeds);
  for (const id of seeds) {
    for (const relation of model.relationsFor(id)) {
      relevant.add(relation.from === id ? relation.to : relation.from);
    }
  }
  return relevant;
}

function callRefs(
  model: ProjectionModel,
  symbolIds: readonly EntityId[],
  direction: "callers" | "callees",
): ProjectedEntityReference[] {
  const result = new Set<EntityId>();
  for (const symbolId of symbolIds) {
    for (const relation of model.relationsFor(symbolId)) {
      if (relationName(relation.kind) !== "calls") continue;
      const candidate =
        direction === "callees" && relation.from === symbolId
          ? relation.to
          : direction === "callers" && relation.to === symbolId
            ? relation.from
            : undefined;
      if (candidate !== undefined && kindOf(model, candidate) === "symbol") result.add(candidate);
    }
  }
  return refs(model, [...result]);
}

function materialGuidance(
  model: ProjectionModel,
  targetId: EntityId,
  task: string | undefined,
  options: AgentProjectionOptions,
): { rationales: ProjectedText[]; guidance: ProjectedText[] } {
  const target = model.entity(targetId);
  const componentIds = target?.kind === "component" ? [targetId] : ownerIds(model, targetId);
  const subjects = [...new Set([targetId, ...componentIds])];
  const taskWords = new Set(
    (task ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((word) => word.length > 2),
  );
  const matchesTask = (text: string): boolean => {
    if (taskWords.size === 0) return false;
    const lower = text.toLowerCase();
    return [...taskWords].some((word) => lower.includes(word));
  };
  const guidance = model.snapshot.declarations.reviewGuidance
    .filter((item) => subjects.includes(item.subject))
    .filter(
      (item) =>
        options.includeReviewGuidance === true ||
        item.level === "L2" ||
        item.level === "L3" ||
        matchesTask(item.guidance),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => entityText(model, model.entity(item.subject), item.guidance));
  const rationaleIds = new Set<EntityId>();
  for (const policy of [
    ...model.snapshot.declarations.effectPolicies,
    ...model.snapshot.declarations.dependencyPolicies,
  ]) {
    if (subjects.includes(policy.subject)) for (const rationaleId of policy.rationaleIds) rationaleIds.add(rationaleId);
  }
  for (const link of model.snapshot.declarations.decisionLinks)
    if (subjects.includes(link.subject)) rationaleIds.add(link.decisionId);
  const rationales = [...rationaleIds]
    .map((id) => model.entity(id))
    .filter((item): item is SemanticEntity => item?.kind === "rationale" || item?.kind === "decision")
    .filter(
      (item) =>
        options.includeRationale === true ||
        matchesTask(item.description ?? ("statement" in item ? item.statement : item.name)),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => entityText(model, item, "statement" in item ? item.statement : (item.description ?? item.name)));
  const material = guidance.length > 0 || rationales.length > 0 || model.unknownsFor(targetId).length > 0;
  if (!material && options.includeRationale !== true && options.includeReviewGuidance !== true)
    return { rationales: [], guidance: [] };
  return { rationales, guidance };
}

function unknownFromRegion(region: UnknownRegion, index: number): ProjectionUnknown {
  return {
    id: region.id || `unknown:change-set:${index}`,
    code: region.code,
    message: region.message,
    subjects: region.subjects,
    material: region.material,
    authoritative: false,
    recommendedSourceReads: region.recommendedSourceReads,
  };
}

function targetFallback(model: ProjectionModel, targetId: EntityId): ProjectedEntityReference {
  return (
    entityReference(model, targetId) ?? {
      id: targetId,
      kind: "unknown",
      name: targetId,
      authority: "integrity",
      provenance: model.snapshot.declarations.project.provenance,
      authoritative: false,
    }
  );
}

function contextFor(
  model: ProjectionModel,
  targetId: EntityId,
  options: AgentProjectionOptions,
): AgentProjectionContext {
  if (model.status === "invalid") return emptyContext();
  const target = model.entity(targetId);
  const symbols = ownedSymbolIds(model, targetId);
  const subjectIds = [...new Set([targetId, ...symbols])];
  const related = (kinds: readonly string[]): ProjectedEntityReference[] =>
    refs(
      model,
      subjectIds.flatMap((id) => otherIds(model, id, kinds)),
    );
  const componentIds = target?.kind === "component" ? [targetId] : ownerIds(model, targetId);
  const guidance = materialGuidance(model, targetId, options.targetTask, options);
  const responsibility =
    target?.kind === "component" || target?.kind === "project"
      ? entityText(model, target, target.responsibility)
      : componentIds[0] === undefined
        ? undefined
        : (() => {
            const component = model.entity(componentIds[0]!);
            return component?.kind === "component" ? entityText(model, component, component.responsibility) : undefined;
          })();
  return {
    ...(responsibility === undefined ? {} : { responsibility }),
    symbols: refs(model, symbols),
    capabilities: related(["capability"]),
    contracts: related(["contract"]),
    invariants: related(["invariant"]),
    constraints: related(["constraint"]),
    effects: factsWithPredicate(model, subjectIds, (name) => name.startsWith("effect.") || name.includes("effect")),
    dependencies: relationTargets(model, targetId, ["depends-on", "uses-package", "imports-api"]),
    callers: callRefs(model, symbols.length === 0 ? [targetId] : symbols, "callers"),
    callees: callRefs(model, symbols.length === 0 ? [targetId] : symbols, "callees"),
    evidence: related(["evidence"]),
    tests: related(["test"]),
    rationales: guidance.rationales,
    reviewGuidance: guidance.guidance,
  };
}

function projectAgentUnknowns(
  model: ProjectionModel,
  targetId: EntityId,
  changeSet?: SemanticChangeSet,
): ProjectionUnknown[] {
  const unknowns = model.unknownsFor(targetId);
  if (changeSet !== undefined) {
    for (const [index, region] of changeSet.unknownRegions.entries()) {
      if (region.subjects.length === 0 || region.subjects.some((subject) => String(subject) === targetId))
        unknowns.push(unknownFromRegion(region, index));
    }
  }
  return unknowns.sort((left, right) => compareText(left.id, right.id));
}

function sourceReadsForTarget(
  model: ProjectionModel,
  targetId: EntityId,
  max: number,
): { reads: SourceReference[]; omission?: ProjectionOmission } {
  const targetSymbols = ownedSymbolIds(model, targetId);
  const reads = uniqueReads([
    ...sourceReadsFor(model, targetId),
    ...targetSymbols.flatMap((id) => sourceReadsFor(model, id)),
  ]);
  const bounded = capItems(
    reads,
    max,
    "recommendedSourceReads",
    "additional exact source escalation targets omitted",
    "navigation",
  );
  return { reads: [...bounded.items], omission: bounded.omission };
}

function deltaForTarget(
  changeSet: SemanticChangeSet | undefined,
  relevantIds: ReadonlySet<EntityId>,
): AgentDeltaContext | undefined {
  if (changeSet === undefined) return undefined;
  const semanticDeltas = changeSet.semanticDeltas
    .filter((item) => relevantIds.has(String(item.subject)))
    .sort((left, right) => compareText(left.id, right.id));
  const implementationChanges = changeSet.derivedChanges
    .filter((item) => relevantIds.has(String(item.entityId)))
    .sort((left, right) => compareText(left.id, right.id));
  const unknowns = changeSet.unknownRegions
    .filter((item) => item.subjects.some((id) => relevantIds.has(String(id))) || item.subjects.length === 0)
    .sort((left, right) => compareText(left.id, right.id));
  if (semanticDeltas.length === 0 && implementationChanges.length === 0 && unknowns.length === 0) return undefined;
  return { reviewLevel: changeSet.reviewLevel, semanticDeltas, implementationChanges, unknowns };
}

function boundedContext(
  context: AgentProjectionContext,
  budget: SemanticProjectionBudget,
): { context: AgentProjectionContext; omissions: ProjectionOmission[] } {
  const omissions: ProjectionOmission[] = [];
  const cap = <T>(
    field: string,
    items: readonly T[],
    limit: number,
    priority: ProjectionOmission["priority"],
  ): readonly T[] => {
    const bounded = capItems(items, limit, field, `${field} exceeded its deterministic structural limit`, priority);
    if (bounded.omission !== undefined) omissions.push(bounded.omission);
    return bounded.items;
  };
  return {
    context: {
      ...context,
      symbols: cap("context.symbols", context.symbols, budget.maxSymbols, "semantic"),
      capabilities: cap("context.capabilities", context.capabilities, budget.maxFacts, "semantic"),
      contracts: cap("context.contracts", context.contracts, budget.maxFacts, "semantic"),
      invariants: cap("context.invariants", context.invariants, budget.maxFacts, "semantic"),
      constraints: cap("context.constraints", context.constraints, budget.maxFacts, "semantic"),
      effects: cap("context.effects", context.effects, budget.maxFacts, "semantic"),
      dependencies: cap("context.dependencies", context.dependencies, budget.maxRelations, "navigation"),
      callers: cap("context.callers", context.callers, budget.maxRelations, "navigation"),
      callees: cap("context.callees", context.callees, budget.maxRelations, "navigation"),
      evidence: cap("context.evidence", context.evidence, budget.maxEvidence, "evidence"),
      tests: cap("context.tests", context.tests, budget.maxEvidence, "evidence"),
      rationales: cap("context.rationales", context.rationales, budget.maxRationales, "semantic"),
      reviewGuidance: cap("context.reviewGuidance", context.reviewGuidance, budget.maxGuidance, "semantic"),
    },
    omissions,
  };
}

export function projectAgentContext(input: AgentProjectionInput): AgentContextProjection {
  const model = createProjectionModel(input.snapshot);
  const options = input.options ?? {};
  const resolved = resolveSemanticProjectionBudget(options);
  const target = targetFallback(model, input.targetId);
  const scope =
    target.kind === "symbol" || target.kind === "component" || target.kind === "project" ? target.kind : "entity";
  const source = sourceReadsForTarget(model, input.targetId, resolved.maxSourceReads);
  const unknowns = projectAgentUnknowns(model, input.targetId, input.changeSet);
  const boundedContextResult = boundedContext(contextFor(model, input.targetId, options), resolved);
  const guidance = boundedContextResult.context;
  const targetEntity = model.entity(input.targetId);
  const summary =
    targetEntity === undefined
      ? undefined
      : entityText(model, targetEntity, targetEntity.description ?? targetEntity.name);
  const relevantIds = relevantTargetIds(model, input.targetId);
  const unboundedDelta = deltaForTarget(input.changeSet, relevantIds);
  const deltaCaps =
    unboundedDelta === undefined
      ? undefined
      : {
          semanticDeltas: capItems(
            unboundedDelta.semanticDeltas,
            resolved.maxChanges,
            "delta.semanticDeltas",
            "semantic deltas exceeded their deterministic structural limit",
            "semantic",
          ),
          implementationChanges: capItems(
            unboundedDelta.implementationChanges,
            resolved.maxChanges,
            "delta.implementationChanges",
            "implementation changes exceeded their deterministic structural limit",
            "evidence",
          ),
          unknowns: capItems(
            unboundedDelta.unknowns,
            resolved.maxChanges,
            "delta.unknowns",
            "delta unknowns exceeded their deterministic structural limit",
            "required",
          ),
        };
  const delta =
    unboundedDelta === undefined || deltaCaps === undefined
      ? undefined
      : {
          ...unboundedDelta,
          semanticDeltas: deltaCaps.semanticDeltas.items,
          implementationChanges: deltaCaps.implementationChanges.items,
          unknowns: deltaCaps.unknowns.items,
        };
  const impactCaps =
    input.changeSet === undefined
      ? undefined
      : {
          affectedEntities: capItems(
            input.changeSet.affectedEntities.filter((id) => relevantIds.has(String(id))),
            resolved.maxSymbols,
            "impact.affectedEntities",
            "affected entities exceeded their deterministic structural limit",
            "semantic",
          ),
          paths: capItems(
            input.changeSet.impactPaths.filter((path) => path.entityIds.some((id) => relevantIds.has(String(id)))),
            resolved.maxImpactPaths,
            "impact.paths",
            "impact paths exceeded their deterministic structural limit",
            "semantic",
          ),
          stopBoundaries: capItems(
            input.changeSet.propagationStopPoints.filter(
              (point) =>
                relevantIds.has(String(point.entityId)) || point.path.some((id) => relevantIds.has(String(id))),
            ),
            resolved.maxImpactPaths,
            "impact.stopBoundaries",
            "propagation stop boundaries exceeded their deterministic structural limit",
            "semantic",
          ),
        };
  const impact =
    impactCaps === undefined
      ? undefined
      : ({
          affectedEntities: impactCaps.affectedEntities.items,
          paths: impactCaps.paths.items,
          stopBoundaries: impactCaps.stopBoundaries.items,
        } satisfies AgentImpactContext);
  const facts = model.status === "invalid" ? [] : factsFor(model, input.targetId);
  const relations = model.status === "invalid" ? [] : relationsFor(model, input.targetId);
  const state = model.state;
  const readsOmission: ProjectionOmission[] = [
    ...boundedContextResult.omissions,
    ...(source.omission === undefined ? [] : [source.omission]),
    ...(deltaCaps === undefined
      ? []
      : [
          ...(deltaCaps.semanticDeltas.omission === undefined ? [] : [deltaCaps.semanticDeltas.omission]),
          ...(deltaCaps.implementationChanges.omission === undefined ? [] : [deltaCaps.implementationChanges.omission]),
          ...(deltaCaps.unknowns.omission === undefined ? [] : [deltaCaps.unknowns.omission]),
        ]),
    ...(impactCaps === undefined
      ? []
      : [
          ...(impactCaps.affectedEntities.omission === undefined ? [] : [impactCaps.affectedEntities.omission]),
          ...(impactCaps.paths.omission === undefined ? [] : [impactCaps.paths.omission]),
          ...(impactCaps.stopBoundaries.omission === undefined ? [] : [impactCaps.stopBoundaries.omission]),
        ]),
  ];
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "agent",
    target: { ...target, scope },
    ...(summary === undefined ? {} : { summary }),
    model: state,
    source: {
      available: false,
      reason: "raw source bodies are excluded; use only the exact metadata/range escalation targets returned here",
    },
    provenance: projectedProvenance(
      model,
      model.status === "fresh" ? "derived" : "integrity",
      "bounded Agent projection over the live Repository Model",
    ),
  };
  const groups = [
    {
      field: "context",
      value: guidance,
      priority: "semantic" as const,
      emptyValue: emptyContext(),
      omissionReason: "semantic context omitted under response budget",
    },
    {
      field: "facts",
      value: facts,
      priority: "semantic" as const,
      emptyValue: [],
      omissionReason: "facts omitted under response budget",
      count: facts.length,
    },
    {
      field: "relations",
      value: relations,
      priority: "navigation" as const,
      emptyValue: [],
      omissionReason: "relations omitted under response budget",
      count: relations.length,
    },
    ...(delta === undefined
      ? []
      : [
          {
            field: "delta",
            value: delta,
            priority: "semantic" as const,
            emptyValue: undefined,
            omissionReason: "current semantic delta omitted under response budget",
          },
        ]),
    ...(impact === undefined
      ? []
      : [
          {
            field: "impact",
            value: impact,
            priority: "semantic" as const,
            emptyValue: undefined,
            omissionReason: "impact context omitted under response budget",
          },
        ]),
    {
      field: "unknowns",
      value: unknowns,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "unknowns omitted under response budget",
      count: unknowns.length,
    },
    {
      field: "recommendedSourceReads",
      value: source.reads,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "exact source escalation targets omitted under response budget",
      count: source.reads.length,
    },
    {
      field: "expansionTargets",
      value: source.reads,
      priority: "navigation" as const,
      emptyValue: [],
      omissionReason: "expansion targets omitted under response budget",
      count: source.reads.length,
    },
  ];
  const bounded = budgetStructuredProjection(base, groups, resolved, readsOmission);
  return {
    ...bounded.value,
    apiVersion: 1,
    kind: "agent",
    omissions: bounded.omissions,
    budget: bounded.budget,
  } as AgentContextProjection;
}

export const projectAgentProjection = projectAgentContext;

export function unavailableAgentContext(
  targetId: EntityId,
  reason: string,
  options: SemanticProjectionBudgetOptions = {},
): AgentContextProjection {
  const provenance = {
    kind: "inferred" as const,
    producer: { name: "mottainai-semantic-projections", version: "1" },
    sourceRevision: { repositoryId: "unknown" },
    completeness: "unknown" as const,
  };
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "agent",
    target: {
      id: targetId,
      kind: "unknown",
      name: targetId,
      scope: "entity",
      authority: "integrity",
      provenance,
      authoritative: false,
    },
    model: { status: "unavailable", integrity: "invalid", authoritative: false, reason },
    source: { available: false, reason },
    provenance: {
      provider: "mottainai-semantic-projections",
      authority: "integrity",
      status: "unavailable",
      authoritative: false,
      note: reason,
    },
  };
  const groups = [
    {
      field: "context",
      value: emptyContext(),
      priority: "required" as const,
      emptyValue: emptyContext(),
      omissionReason: "no semantic context is available",
    },
    {
      field: "facts",
      value: [],
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "no facts are available",
    },
    {
      field: "relations",
      value: [],
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "no relations are available",
    },
    {
      field: "unknowns",
      value: [
        {
          id: "unknown:unavailable-model",
          code: "unavailable-model",
          message: reason,
          subjects: [targetId],
          material: true,
          authoritative: false,
          recommendedSourceReads: [],
        },
      ],
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "unavailable model unknown",
    },
    {
      field: "recommendedSourceReads",
      value: [],
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "no source reads are available",
    },
    {
      field: "expansionTargets",
      value: [],
      priority: "navigation" as const,
      emptyValue: [],
      omissionReason: "no expansion targets are available",
    },
  ];
  const bounded = budgetStructuredProjection(base, groups, options);
  return {
    ...bounded.value,
    apiVersion: 1,
    kind: "agent",
    omissions: bounded.omissions,
    budget: bounded.budget,
  } as AgentContextProjection;
}
