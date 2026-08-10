import { compareText } from "../ir/canonical.js";
import type { RepositorySemanticSnapshot, SemanticEntity, SourceReference } from "../ir/types.js";
import type { SemanticChangeSet, UnknownRegion } from "../diff/types.js";
import { budgetStructuredProjection, capItems } from "./budget.js";
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

function deltaForTarget(changeSet: SemanticChangeSet | undefined, targetId: EntityId): AgentDeltaContext | undefined {
  if (changeSet === undefined) return undefined;
  const semanticDeltas = changeSet.semanticDeltas.filter(
    (item) => String(item.subject) === targetId || changeSet.affectedEntities.some((id) => String(id) === targetId),
  );
  const implementationChanges = changeSet.derivedChanges.filter((item) => String(item.entityId) === targetId);
  const unknowns = changeSet.unknownRegions.filter(
    (item) => item.subjects.some((id) => String(id) === targetId) || item.subjects.length === 0,
  );
  if (semanticDeltas.length === 0 && implementationChanges.length === 0 && unknowns.length === 0) return undefined;
  return { reviewLevel: changeSet.reviewLevel, semanticDeltas, implementationChanges, unknowns };
}

function boundedContext(
  context: AgentProjectionContext,
  options: AgentProjectionOptions,
): { context: AgentProjectionContext; omissions: ProjectionOmission[] } {
  const omissions: ProjectionOmission[] = [];
  const cap = <T>(field: string, items: readonly T[], limit: number, priority: ProjectionOmission["priority"]): readonly T[] => {
    const bounded = capItems(items, limit, field, `${field} exceeded its deterministic structural limit`, priority);
    if (bounded.omission !== undefined) omissions.push(bounded.omission);
    return bounded.items;
  };
  return {
    context: {
      ...context,
      symbols: cap("context.symbols", context.symbols, options.maxSymbols ?? 48, "semantic"),
      capabilities: cap("context.capabilities", context.capabilities, options.maxFacts ?? 48, "semantic"),
      contracts: cap("context.contracts", context.contracts, options.maxFacts ?? 48, "semantic"),
      invariants: cap("context.invariants", context.invariants, options.maxFacts ?? 48, "semantic"),
      constraints: cap("context.constraints", context.constraints, options.maxFacts ?? 48, "semantic"),
      effects: cap("context.effects", context.effects, options.maxFacts ?? 48, "semantic"),
      dependencies: cap("context.dependencies", context.dependencies, options.maxRelations ?? 64, "navigation"),
      callers: cap("context.callers", context.callers, options.maxRelations ?? 64, "navigation"),
      callees: cap("context.callees", context.callees, options.maxRelations ?? 64, "navigation"),
      evidence: cap("context.evidence", context.evidence, options.maxEvidence ?? 24, "evidence"),
      tests: cap("context.tests", context.tests, options.maxEvidence ?? 24, "evidence"),
      rationales: cap("context.rationales", context.rationales, options.maxRationales ?? 8, "semantic"),
      reviewGuidance: cap("context.reviewGuidance", context.reviewGuidance, options.maxGuidance ?? 8, "semantic"),
    },
    omissions,
  };
}

export function projectAgentContext(input: AgentProjectionInput): AgentContextProjection {
  const model = createProjectionModel(input.snapshot);
  const options = input.options ?? {};
  const target = targetFallback(model, input.targetId);
  const scope =
    target.kind === "symbol" || target.kind === "component" || target.kind === "project" ? target.kind : "entity";
  const source = sourceReadsForTarget(model, input.targetId, options.maxSourceReads ?? 24);
  const unknowns = projectAgentUnknowns(model, input.targetId, input.changeSet);
  const boundedContextResult = boundedContext(contextFor(model, input.targetId, options), options);
  const guidance = boundedContextResult.context;
  const targetEntity = model.entity(input.targetId);
  const summary =
    targetEntity === undefined
      ? undefined
      : entityText(model, targetEntity, targetEntity.description ?? targetEntity.name);
  const unboundedDelta = deltaForTarget(input.changeSet, input.targetId);
  const delta = unboundedDelta === undefined ? undefined : {
    ...unboundedDelta,
    semanticDeltas: capItems(unboundedDelta.semanticDeltas, options.maxChanges ?? 32, "delta.semanticDeltas", "semantic deltas exceeded their deterministic structural limit", "semantic").items,
    implementationChanges: capItems(unboundedDelta.implementationChanges, options.maxChanges ?? 32, "delta.implementationChanges", "implementation changes exceeded their deterministic structural limit", "evidence").items,
    unknowns: capItems(unboundedDelta.unknowns, options.maxChanges ?? 32, "delta.unknowns", "delta unknowns exceeded their deterministic structural limit", "required").items,
  };
  const impact =
    input.changeSet === undefined
      ? undefined
      : ({
          affectedEntities: input.changeSet.affectedEntities.slice(0, options.maxSymbols ?? 48),
          paths: input.changeSet.impactPaths.slice(0, options.maxImpactPaths ?? 24).filter((path) =>
            path.entityIds.some((id) => String(id) === input.targetId),
          ),
          stopBoundaries: input.changeSet.propagationStopPoints.slice(0, options.maxImpactPaths ?? 24).filter(
            (point) =>
              String(point.entityId) === input.targetId || point.path.some((id) => String(id) === input.targetId),
          ),
        } satisfies AgentImpactContext);
  const facts = model.status === "invalid" ? [] : factsFor(model, input.targetId);
  const relations = model.status === "invalid" ? [] : relationsFor(model, input.targetId);
  const state = model.state;
  const readsOmission: ProjectionOmission[] = [
    ...boundedContextResult.omissions,
    ...(source.omission === undefined ? [] : [source.omission]),
    ...(unboundedDelta === undefined || delta === undefined ? [] : [
      ...(unboundedDelta.semanticDeltas.length === delta.semanticDeltas.length ? [] : [{ field: "delta.semanticDeltas", reason: "semantic delta structural limit applied", count: unboundedDelta.semanticDeltas.length - delta.semanticDeltas.length, priority: "semantic" as const }]),
      ...(unboundedDelta.implementationChanges.length === delta.implementationChanges.length ? [] : [{ field: "delta.implementationChanges", reason: "implementation change structural limit applied", count: unboundedDelta.implementationChanges.length - delta.implementationChanges.length, priority: "evidence" as const }]),
      ...(unboundedDelta.unknowns.length === delta.unknowns.length ? [] : [{ field: "delta.unknowns", reason: "delta unknown structural limit applied", count: unboundedDelta.unknowns.length - delta.unknowns.length, priority: "required" as const }]),
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
  const bounded = budgetStructuredProjection(base, groups, options, readsOmission);
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
