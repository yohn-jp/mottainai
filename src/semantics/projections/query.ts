import type { JsonValue, Provenance as IrProvenance } from "../ir/types.js";
import type { LogicalId } from "../ir/ids.js";
import type { RepositorySemanticQuery, EntityView, FactView, SemanticRelation as QueryRelation } from "../query.js";
import { SemanticQueryError } from "../query.js";
import { unavailableAgentContext } from "./agent.js";
import { unavailableJsdocProjection } from "./jsdoc.js";
import { projectReview } from "./review.js";
import { budgetStructuredProjection, capItems } from "./budget.js";
import type {
  AgentContextProjection,
  AgentProjectionOptions,
  JsdocProjection,
  JsdocProjectionOptions,
  ReviewProjection,
  ReviewProjectionOptions,
  ProjectionOmission,
  EntityId,
} from "./types.js";

export interface SemanticProjectionProvider {
  getAgentContext(
    id: EntityId,
    options?: AgentProjectionOptions,
  ): AgentContextProjection | Promise<AgentContextProjection>;
  getReviewProjection(options?: ReviewProjectionOptions): ReviewProjection | Promise<ReviewProjection>;
  getJsdocProjection(id: EntityId, options?: JsdocProjectionOptions): JsdocProjection | Promise<JsdocProjection>;
}

export interface SemanticProjectionQuery {
  getAgentContext(id: EntityId, options?: AgentProjectionOptions): Promise<AgentContextProjection>;
  getReviewProjection(options?: ReviewProjectionOptions): Promise<ReviewProjection>;
  getJsdocProjection(id: EntityId, options?: JsdocProjectionOptions): Promise<JsdocProjection>;
}

function providerFor(query: RepositorySemanticQuery): Partial<SemanticProjectionProvider> {
  return query as RepositorySemanticQuery & Partial<SemanticProjectionProvider>;
}

function legacyProvenance(authority: FactView["authority"], source: string): IrProvenance {
  const kind = authority === "analysis" || authority === "integrity" ? "inferred" : authority;
  return {
    kind,
    producer: { name: "repository-semantic-query", version: "v1" },
    sourceRevision: { repositoryId: "query-provider" as LogicalId },
    completeness: "complete",
    ...(source.length === 0 ? {} : { evidence: [{ kind: "query", ref: source }] }),
  };
}

function legacyReference(entity: EntityView): Record<string, unknown> {
  const provenance = legacyProvenance(entity.authority, entity.id);
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    summary: entity.summary,
    authority: entity.authority,
    provenance,
    authoritative: entity.provenance.status === "fixture" && entity.authority !== "analysis",
  };
}

function legacyFact(fact: FactView): Record<string, unknown> {
  const provenance = legacyProvenance(fact.authority, fact.name);
  return {
    name: fact.name,
    value: fact.value as JsonValue,
    authority: fact.authority,
    provenance,
    inferred: fact.authority === "analysis" || fact.provenance.authority === "analysis",
    authoritative: fact.authority !== "analysis" && fact.provenance.status === "fixture",
  };
}

function legacyRelation(relation: QueryRelation): Record<string, unknown> {
  return {
    id: relation.id,
    kind: relation.kind,
    from: relation.from,
    to: relation.to,
    authority: relation.authority,
    provenance: legacyProvenance(relation.authority, relation.id),
    authoritative: relation.provenance.status === "fixture" && relation.authority !== "analysis",
  };
}

async function projectAgentFromQuery(
  query: RepositorySemanticQuery,
  id: EntityId,
  options: AgentProjectionOptions,
): Promise<AgentContextProjection> {
  const entity = await query.getEntity(id);
  if (entity === undefined) throw new SemanticQueryError("not_found", `unknown semantic entity: ${id}`);
  const relatedIds = [
    ...new Set(entity.relations.flatMap((relation) => [relation.from, relation.to]).filter((item) => item !== id)),
  ].sort();
  const related = (await Promise.all(relatedIds.map((relatedId) => query.getEntity(relatedId)))).filter(
    (item): item is EntityView => item !== undefined,
  );
  const references = related.map(legacyReference);
  const byKind = (kind: string): Record<string, unknown>[] => references.filter((item) => item.kind === kind);
  const symbols =
    entity.kind === "component" ? byKind("symbol") : entity.kind === "symbol" ? [legacyReference(entity)] : [];
  const facts = entity.facts.map(legacyFact);
  const relations = entity.relations.map(legacyRelation);
  const calls = entity.relations.filter((relation) => relation.kind === "calls");
  const refById = new Map(related.map((item) => [item.id, legacyReference(item)]));
  const callers = calls
    .filter((relation) => relation.to === id)
    .map((relation) => refById.get(relation.from))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const callees = calls
    .filter((relation) => relation.from === id)
    .map((relation) => refById.get(relation.to))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const sourceReads = capItems(
    entity.agentProjection.recommendedReads,
    options.maxSourceReads ?? 24,
    "recommendedSourceReads",
    "additional exact source reads omitted",
    "navigation",
  );
  const unknowns = (await query.getChangeSet()).unknownRegions ?? [];
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "agent",
    target: {
      ...legacyReference(entity),
      scope: entity.kind === "symbol" || entity.kind === "component" ? entity.kind : "entity",
    },
    summary: {
      value: entity.summary,
      authority: entity.authority,
      provenance: legacyProvenance(entity.authority, entity.id),
      authoritative: entity.provenance.status === "fixture" && entity.authority !== "analysis",
    },
    model: {
      status: "fresh",
      integrity: "fresh",
      authoritative: false,
      reason: "fixture/query projection retains fixture provenance",
    },
    source: entity.agentProjection.source,
    provenance: {
      provider: entity.provenance.provider,
      authority: entity.authority,
      status: "fresh",
      authoritative: false,
      note: "bounded projection over the same RepositorySemanticQuery provider used by Dashboard",
    },
  };
  const emptyContext = {
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
  const context = {
    symbols,
    capabilities: byKind("capability"),
    contracts: byKind("contract"),
    invariants: byKind("invariant"),
    constraints: byKind("constraint"),
    effects: facts.filter((fact) => typeof fact.name === "string" && fact.name.includes("effect")),
    dependencies: relations.filter((relation) =>
      ["depends-on", "uses-package", "imports-api"].includes(String(relation.kind)),
    ),
    callers,
    callees,
    evidence: byKind("evidence"),
    tests: byKind("test"),
    rationales: [],
    reviewGuidance: [],
  };
  const projectionUnknowns = unknowns.map((unknown, index) => ({
    id: unknown.id || `unknown:query:${index}`,
    code: unknown.code,
    message: unknown.message,
    subjects: unknown.subjects ?? [],
    material: true,
    authoritative: false as const,
    recommendedSourceReads: [],
  }));
  const groups = [
    {
      field: "context",
      value: context,
      priority: "semantic" as const,
      emptyValue: emptyContext,
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
    {
      field: "unknowns",
      value: projectionUnknowns,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "unknowns omitted under response budget",
      count: projectionUnknowns.length,
    },
    {
      field: "recommendedSourceReads",
      value: sourceReads.items,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "exact source reads omitted under response budget",
      count: sourceReads.items.length,
    },
    {
      field: "expansionTargets",
      value: sourceReads.items,
      priority: "navigation" as const,
      emptyValue: [],
      omissionReason: "expansion targets omitted under response budget",
      count: sourceReads.items.length,
    },
  ];
  const omissions: ProjectionOmission[] = sourceReads.omission === undefined ? [] : [sourceReads.omission];
  const bounded = budgetStructuredProjection(base, groups, options, omissions);
  return {
    ...bounded.value,
    apiVersion: 1,
    kind: "agent",
    omissions: bounded.omissions,
    budget: bounded.budget,
  } as AgentContextProjection;
}

/** Domain adapter used by Dashboard/MCP transports; it never owns semantic rules. */
export function createSemanticProjectionQuery(query: RepositorySemanticQuery): SemanticProjectionQuery {
  const provider = providerFor(query);
  return {
    async getAgentContext(id, options = {}) {
      if (provider.getAgentContext !== undefined) return provider.getAgentContext(id, options);
      return projectAgentFromQuery(query, id, options);
    },
    async getReviewProjection(options = {}) {
      if (provider.getReviewProjection !== undefined) return provider.getReviewProjection(options);
      return projectReview({ changeSet: await query.getChangeSet(), options });
    },
    async getJsdocProjection(id, options = {}) {
      if (provider.getJsdocProjection !== undefined) return provider.getJsdocProjection(id, options);
      if ((await query.getEntity(id)) === undefined)
        throw new SemanticQueryError("not_found", `unknown semantic entity: ${id}`);
      return unavailableJsdocProjection(
        id,
        "query provider does not expose declared semantics and exact signature facts",
      );
    },
  };
}
