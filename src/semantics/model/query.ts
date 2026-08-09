import { performance } from "node:perf_hooks";
import { compareText } from "../ir/canonical.js";
import { toVerificationView } from "../verification/projection.js";
import {
  SemanticQueryError,
  boundedLimit,
  type AgentProjection,
  type AuthorityLayer,
  type ComponentQuery,
  type ComponentView,
  type DependencyQuery,
  type DependencyView,
  type EntityId,
  type EntityKind,
  type EntityStatus,
  type EntitySummary,
  type EntityView,
  type FactView,
  type FixtureStatus,
  type GraphQuery,
  type GraphView,
  type HistoryEntry,
  type JsonValue,
  type KnowledgeEntry,
  type KnowledgeQuery,
  type KnowledgeView,
  type ProjectView,
  type Provenance as QueryProvenance,
  type RelationKind,
  type RepositorySemanticQuery,
  type SemanticChangeSetView,
  type SemanticRelation as QuerySemanticRelation,
  type SourceReference as QuerySourceReference,
  type VerificationQuery,
  type VerificationView,
} from "../query.js";
import type {
  DerivedState,
  SemanticEntity as IrEntity,
  IntegrityStatus,
  Provenance as IrProvenance,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticFact,
  SemanticRelation as IrSemanticRelation,
  VerificationSummary,
} from "../ir/types.js";
import type { TypeScriptFactCounts } from "../extractors/types.js";

/** Source state supplied to the live query adapter after compilation and integrity validation. */
export interface RepositoryModelSource {
  snapshot?: RepositorySemanticSnapshot;
  diagnostics: readonly SemanticDiagnostic[];
  integrityStatus: IntegrityStatus;
  integrityReason?: string;
  benchmark: RepositoryModelBenchmark;
}

export interface RepositoryModelBenchmark {
  compileMs: number;
  queryCount: number;
  queryMs: number;
  lastQueryMs?: number;
  factCounts?: TypeScriptFactCounts;
}

export const LIVE_REPOSITORY_MODEL_PROVIDER = "live-repository-model" as const;

const QUERY_ENTITY_KINDS: readonly EntityKind[] = [
  "project",
  "component",
  "symbol",
  "capability",
  "contract",
  "invariant",
  "evidence",
  "test",
  "decision",
  "file",
  "package",
  "external-api",
];

const DEPENDENCY_RELATIONS = new Set<RelationKind>(["depends-on", "uses-package", "imports-api"]);

interface IndexedEntity {
  source: IrEntity;
  kind: EntityKind;
}

interface OwnershipIndex {
  owned: Map<EntityId, EntityId[]>;
  shared: Map<EntityId, EntityId[]>;
}

interface TraversalNode {
  id: EntityId;
  depth: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareText(left.id, right.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceBodyKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0 || words.some((word) => ["fingerprint", "hash", "digest"].includes(word))) return false;
  return (
    words.includes("body") ||
    words.includes("content") ||
    (words.includes("source") && (words.includes("body") || words.includes("text"))) ||
    (words.includes("raw") && words.includes("source"))
  );
}

/** Strip source bodies from arbitrary fact payloads while retaining fingerprints, ranges and metrics. */
function safeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map((item) => safeJsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSourceBodyKey(key))
        .map(([key, item]) => [key, safeJsonValue(item)]),
    );
  }
  return null;
}

function providerStatus(integrityStatus: IntegrityStatus): FixtureStatus {
  return integrityStatus === "invalid" ? "unavailable" : "partial";
}

function mapEntityKind(kind: IrEntity["kind"]): EntityKind | undefined {
  switch (kind) {
    case "project":
    case "component":
    case "symbol":
    case "capability":
    case "contract":
    case "invariant":
    case "evidence":
    case "test":
    case "decision":
    case "file":
    case "package":
      return kind;
    case "external_api":
      return "external-api";
    case "external_dependency":
      return "package";
    case "rationale":
    case "constraint":
      return undefined;
    default:
      return undefined;
  }
}

function mapRelationKind(kind: string): RelationKind | undefined {
  switch (kind) {
    case "contains":
    case "owns":
    case "shares":
    case "defines":
    case "provides":
    case "requires":
    case "calls":
    case "references":
    case "imports":
    case "extends":
    case "implements":
    case "tests":
    case "verifies":
    case "governs":
    case "evidence_for":
      return kind === "evidence_for" ? "evidence-for" : kind;
    case "constrained_by":
      return "constrained-by";
    case "depends_on":
      return "depends-on";
    case "uses_package":
      return "uses-package";
    case "imports_api":
      return "imports-api";
    default:
      return undefined;
  }
}

function entityDescription(entity: IrEntity): string {
  if (entity.description !== undefined) return entity.description;
  switch (entity.kind) {
    case "project":
    case "component":
      return entity.responsibility;
    case "symbol":
      return `${entity.locator.symbol}${entity.locator.file === undefined ? "" : ` in ${entity.locator.file}`}`;
    case "file":
      return entity.path;
    case "package":
    case "external_dependency":
      return entity.packageName;
    case "external_api":
      return `${entity.apiName} (${entity.packageId})`;
    case "capability":
      return entity.meaning;
    case "contract":
      return entity.definition.outputs.returnValue ?? "Declared contract";
    case "invariant":
    case "decision":
    case "rationale":
    case "constraint":
      return entity.statement;
    case "evidence":
      return entity.summary;
    case "test":
      return entity.testName;
  }
}

function countRecord(): Record<EntityKind, number> {
  return Object.fromEntries(QUERY_ENTITY_KINDS.map((kind) => [kind, 0])) as Record<EntityKind, number>;
}

function sourceProvenanceLabel(provenance: IrProvenance | undefined): string {
  if (provenance === undefined) return "source-provenance=unknown";
  const producer = `${provenance.producer.name}@${provenance.producer.version}`;
  const completeness = provenance.completeness === undefined ? "unknown" : provenance.completeness;
  return `source-provenance=${provenance.kind}/${producer}/${completeness}`;
}

export class LiveRepositoryModelQuery implements RepositorySemanticQuery {
  private readonly snapshot: RepositorySemanticSnapshot | undefined;
  private readonly diagnostics: readonly SemanticDiagnostic[];
  private readonly integrityStatus: IntegrityStatus;
  private readonly integrityReason: string | undefined;
  private readonly benchmark: RepositoryModelBenchmark;
  private readonly entitiesById = new Map<EntityId, IndexedEntity>();
  private readonly factsBySubject = new Map<EntityId, SemanticFact[]>();
  private readonly relations: QuerySemanticRelation[] = [];
  private readonly ownership: OwnershipIndex = { owned: new Map(), shared: new Map() };
  private readonly modelGapSymbols = new Set<EntityId>();
  private readonly projectId: EntityId | undefined;
  private readonly unavailableProjectId = "project:unavailable";

  constructor(source: RepositoryModelSource) {
    this.snapshot = source.snapshot;
    this.diagnostics = source.diagnostics;
    this.integrityStatus = source.integrityStatus;
    this.integrityReason = source.integrityReason;
    this.benchmark = source.benchmark;
    this.projectId = source.snapshot?.declarations.project.id;
    if (source.snapshot !== undefined) this.indexSnapshot(source.snapshot);
  }

  getBenchmark(): RepositoryModelBenchmark {
    return clone(this.benchmark);
  }

  getProject(): ProjectView {
    return this.measure(() => {
      const project = this.projectId === undefined ? undefined : this.entitiesById.get(this.projectId);
      const projectSummary = project === undefined ? this.unavailableProjectSummary() : this.summary(project);
      const counts = countRecord();
      for (const item of this.entitiesById.values()) counts[item.kind] += 1;
      const health = this.snapshot?.analysis.health;
      const modelGaps = this.modelGapSymbols.size + (health?.modelGaps ?? 0);
      const status = this.projectHealthStatus(modelGaps);
      return clone({
        apiVersion: "v1" as const,
        project: projectSummary,
        revision: {
          base: this.snapshot?.revisionIdentity?.parentIds?.[0] ?? "unknown",
          head: this.snapshot?.revisionIdentity?.revision ?? "unknown",
          worktree: this.snapshot?.integrity.worktree.id ?? "unknown",
        },
        health: {
          status,
          score: this.snapshot === undefined ? 0 : Math.max(0, Math.min(100, health?.score ?? 0)),
          staleEvidence: (health?.staleEvidence ?? 0) + this.staleObservedEvidenceCount(),
          modelGaps,
          reviewRequired: this.reviewRequiredCount(),
        },
        counts,
        componentIds: sortById(
          [...this.entitiesById.values()]
            .filter((item) => item.kind === "component")
            .map((item) => ({ id: item.source.id })),
        ).map((item) => item.id),
        entityIds: [...this.entitiesById.keys()].sort(compareText),
        provenance: this.provenance(
          "integrity",
          "project summary and health are derived from the live repository model",
        ),
      });
    });
  }

  getGraph(query: GraphQuery = {}): GraphView {
    return this.measure(() => {
      const nodeLimit = boundedLimit(query.nodeLimit ?? query.limit, 80);
      const edgeLimit = boundedLimit(query.edgeLimit, 200, 500);
      const depth = this.depthLimit(
        query.depth,
        query.entityId !== undefined || query.componentId !== undefined ? 1 : undefined,
      );
      const direction = query.direction ?? "both";
      const relationKinds = query.relationKinds === undefined ? undefined : new Set(query.relationKinds);
      const seed = query.entityId ?? query.componentId;
      const selected = new Set<EntityId>();
      const traversedRelations = new Set<string>();
      let truncated = false;

      if (seed !== undefined) {
        this.requireEntity(seed);
        selected.add(seed);
        const queue: TraversalNode[] = [{ id: seed, depth: 0 }];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (depth !== undefined && current.depth >= depth) continue;
          const incident = this.relations.filter((relation) => {
            if (relationKinds !== undefined && !relationKinds.has(relation.kind)) return false;
            return this.traverses(relation, current.id, direction);
          });
          for (const relation of incident) {
            traversedRelations.add(relation.id);
            const target = relation.from === current.id ? relation.to : relation.from;
            if (selected.has(target)) continue;
            if (selected.size >= nodeLimit) {
              truncated = true;
              continue;
            }
            selected.add(target);
            queue.push({ id: target, depth: current.depth + 1 });
          }
        }
        if (queue.length > 0) truncated = true;
      } else {
        const allIds = [...this.entitiesById.keys()].sort(compareText);
        if (allIds.length > nodeLimit) truncated = true;
        for (const id of allIds.slice(0, nodeLimit)) selected.add(id);
      }

      const nodes = [...selected]
        .sort(compareText)
        .map((id) => this.entitiesById.get(id))
        .filter((item): item is IndexedEntity => item !== undefined)
        .map((item) => this.summary(item));
      const nodeIds = new Set(nodes.map((node) => node.id));
      let relations = this.relations.filter(
        (relation) =>
          nodeIds.has(relation.from) &&
          nodeIds.has(relation.to) &&
          (relationKinds === undefined || relationKinds.has(relation.kind)) &&
          (seed === undefined || traversedRelations.has(relation.id)),
      );
      relations = sortById(relations);
      if (relations.length > edgeLimit) {
        truncated = true;
        relations = relations.slice(0, edgeLimit);
      }
      return clone({
        apiVersion: "v1" as const,
        query,
        nodes,
        relations,
        truncated,
        provenance: this.provenance("derived", "graph slice uses one bounded universal relation graph"),
      });
    });
  }

  getEntity(id: EntityId): EntityView | undefined {
    return this.measure(() => {
      if (id === this.unavailableProjectId && this.snapshot === undefined) {
        const summary = this.unavailableProjectSummary();
        return {
          ...summary,
          facts: [],
          relations: [],
          history: [],
          agentProjection: this.unavailableAgentProjection(summary),
        };
      }
      const entity = this.entitiesById.get(id);
      if (entity === undefined) return undefined;
      const relations = this.relations.filter((item) => item.from === id || item.to === id);
      const facts = this.factViews(entity.source.id);
      const history: HistoryEntry[] = [];
      const agentProjection = this.agentProjection(entity, relations);
      return clone({
        ...this.summary(entity),
        facts,
        relations,
        history,
        agentProjection,
        ...(this.verificationFor(id, this.scopeForKind(entity.kind)) === undefined
          ? {}
          : { verification: this.verificationFor(id, this.scopeForKind(entity.kind))?.health }),
      });
    });
  }

  listComponents(query: ComponentQuery = {}): ComponentView[] {
    return this.measure(() => {
      const limit = boundedLimit(query.limit, 50);
      const search = query.search?.trim().toLowerCase();
      const components = [...this.entitiesById.values()]
        .filter((item) => item.kind === "component")
        .filter((item) => query.status === undefined || this.statusFor(item) === query.status)
        .filter((item) => {
          if (search === undefined || search.length === 0) return true;
          return `${item.source.name} ${entityDescription(item.source)} ${item.source.kind === "component" ? item.source.responsibility : ""}`
            .toLowerCase()
            .includes(search);
        })
        .sort((left, right) => compareText(left.source.id, right.source.id))
        .map((item) => this.componentView(item));
      return clone(components.slice(0, limit));
    });
  }

  getDependencies(query: DependencyQuery = {}): DependencyView {
    return this.measure(() => {
      const limit = boundedLimit(query.limit, 50);
      if (query.componentId !== undefined) this.requireEntity(query.componentId);
      const items = this.dependencyItems(query.componentId);
      const packageUsage = this.packageUsage();
      return clone({
        apiVersion: "v1" as const,
        items: items.slice(0, limit),
        packageUsage,
        provenance: this.provenance(
          "derived",
          "dependency surfaces aggregate only explicit Symbol ownership and live package/API facts",
        ),
      });
    });
  }

  getChangeSet(query: { reviewLevel?: "L0" | "L1" | "L2" | "L3" } = {}): SemanticChangeSetView {
    return this.measure(() => {
      // #54 owns semantic delta computation. An empty unavailable set is explicit, rather
      // than a fixture-shaped change result; the optional filter has no data to filter.
      const entries: SemanticChangeSetView["entries"] = [];
      return clone({
        apiVersion: "v1" as const,
        baseRevision: this.snapshot?.revisionIdentity?.parentIds?.[0] ?? "unknown",
        headRevision: this.snapshot?.revisionIdentity?.revision ?? "unknown",
        filesChanged: 0,
        symbolsChanged: 0,
        componentsChanged: 0,
        contractsTouched: 0,
        staleEvidence: this.staleObservedEvidenceCount(),
        recommendedReads: this.recommendedReads(),
        entries,
        impactPaths: [],
        provenance: this.provenance("analysis", "unavailable: semantic delta and impact classification belong to #54"),
      });
    });
  }

  getKnowledge(query: KnowledgeQuery = {}): KnowledgeView {
    return this.measure(() => {
      const allEntries = this.knowledgeEntries();
      const entries = allEntries.filter(
        (item) =>
          (query.kind === undefined || item.kind === query.kind) &&
          (query.status === undefined || item.status === query.status),
      );
      const counts: Record<KnowledgeEntry["kind"], number> = { decision: 0, policy: 0, experiment: 0, evidence: 0 };
      for (const entry of entries) counts[entry.kind] += 1;
      return clone({
        apiVersion: "v1" as const,
        entries,
        counts,
        provenance: this.provenance(
          "declared",
          "knowledge inventory contains only declared decisions/policies and observed evidence",
        ),
      });
    });
  }

  getAgentProjection(id: EntityId): AgentProjection {
    return this.measure(() => {
      const entity = this.requireEntity(id);
      const relations = this.relations.filter((item) => item.from === id || item.to === id);
      return clone(this.agentProjection(entity, relations));
    });
  }

  getVerification(query: VerificationQuery = {}): VerificationView | undefined {
    return this.measure(() => {
      if (this.snapshot?.analysis.verification === undefined) return undefined;
      const summaries = this.snapshot.analysis.verification.summaries;
      const summary = summaries.find(
        (item) =>
          (query.targetId === undefined || item.targetId === query.targetId) &&
          (query.scope === undefined || item.scope === query.scope),
      );
      if (summary === undefined) return undefined;
      return this.verificationView(summary);
    });
  }

  private measure<T>(operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      const elapsed = performance.now() - startedAt;
      this.benchmark.queryCount += 1;
      this.benchmark.queryMs += elapsed;
      this.benchmark.lastQueryMs = elapsed;
    }
  }

  private indexSnapshot(snapshot: RepositorySemanticSnapshot): void {
    const add = (entity: IrEntity): void => {
      const kind = mapEntityKind(entity.kind);
      if (kind === undefined) return;
      if (
        entity.kind === "external_dependency" &&
        [...this.entitiesById.values()].some(
          (item) => item.source.kind === "package" && item.source.packageName === entity.packageName,
        )
      ) {
        return;
      }
      const existing = this.entitiesById.get(entity.id);
      if (existing === undefined || (existing.source.kind === "external_dependency" && entity.kind === "package")) {
        this.entitiesById.set(entity.id, { source: entity, kind });
      }
    };
    const declarations = snapshot.declarations;
    add(declarations.project);
    for (const entity of declarations.components) add(entity);
    for (const entity of declarations.capabilities) add(entity);
    for (const entity of declarations.contracts) add(entity);
    for (const entity of declarations.invariants) add(entity);
    for (const entity of declarations.decisions) add(entity);
    for (const entity of declarations.rationales) add(entity);
    for (const entity of declarations.constraints) add(entity);
    this.addDerivedEntities(snapshot.derived, add);
    for (const entity of snapshot.observed.evidences) add(entity);
    for (const entity of snapshot.observed.tests) add(entity);
    this.collectFacts(snapshot);
    for (const relation of snapshot.graph.relations) this.addRelation(relation);
    this.indexOwnership();
    for (const entity of this.entitiesById.values()) {
      if (entity.kind !== "symbol") continue;
      const owned = this.ownership.owned.get(entity.source.id) ?? [];
      const shared = this.ownership.shared.get(entity.source.id) ?? [];
      if (owned.length === 0 && shared.length === 0) this.modelGapSymbols.add(entity.source.id);
    }
  }

  private addDerivedEntities(derived: DerivedState, add: (entity: IrEntity) => void): void {
    for (const entity of derived.files) add(entity);
    for (const entity of derived.symbols) add(entity);
    for (const entity of derived.packages) add(entity);
    for (const entity of derived.externalDependencies) add(entity);
    for (const entity of derived.externalApis) add(entity);
  }

  private collectFacts(snapshot: RepositorySemanticSnapshot): void {
    const append = (facts: readonly SemanticFact[]): void => {
      for (const fact of facts) {
        const current = this.factsBySubject.get(fact.subject) ?? [];
        current.push(fact);
        this.factsBySubject.set(fact.subject, current);
      }
    };
    append(snapshot.declarations.facts);
    append(snapshot.derived.facts);
    append(snapshot.observed.facts);
    append(snapshot.analysis.facts);
  }

  private addRelation(relation: IrSemanticRelation): void {
    const kind = mapRelationKind(relation.kind);
    if (kind === undefined || !this.entitiesById.has(relation.from) || !this.entitiesById.has(relation.to)) return;
    this.relations.push({
      id: relation.id,
      kind,
      from: relation.from,
      to: relation.to,
      authority: relation.authority,
      provenance: this.provenance(relation.authority, `live relation ${relation.kind}`, relation.provenance),
    });
  }

  private indexOwnership(): void {
    for (const relation of this.relations) {
      if (relation.kind !== "owns" && relation.kind !== "shares") continue;
      // Only #49 declarations are authoritative for Component ownership. A
      // derived relation with the same shape is a fact, not a declaration.
      if (relation.authority !== "declared") continue;
      const from = this.entitiesById.get(relation.from);
      const to = this.entitiesById.get(relation.to);
      if (from?.kind !== "component" || to?.kind !== "symbol") continue;
      const target = relation.kind === "owns" ? this.ownership.owned : this.ownership.shared;
      const ids = target.get(to.source.id) ?? [];
      if (!ids.includes(from.source.id)) ids.push(from.source.id);
      ids.sort(compareText);
      target.set(to.source.id, ids);
    }
  }

  private summary(entity: IndexedEntity): EntitySummary {
    const componentIds = entity.kind === "symbol" ? (this.ownership.owned.get(entity.source.id) ?? []) : [];
    const sharedIds = entity.kind === "symbol" ? (this.ownership.shared.get(entity.source.id) ?? []) : [];
    const tags = new Set<string>(["live", `authority:${entity.source.authority}`]);
    if (this.modelGapSymbols.has(entity.source.id)) {
      tags.add("model-gap");
      tags.add("unowned-symbol");
    }
    if (sharedIds.length > 0) tags.add("shared-symbol");
    return {
      id: entity.source.id,
      kind: entity.kind,
      name: entity.source.name,
      summary: entityDescription(entity.source),
      status: this.statusFor(entity),
      authority: entity.source.authority,
      provenance: this.provenance(
        entity.source.authority,
        `live ${entity.source.kind} entity`,
        entity.source.provenance,
      ),
      ...(componentIds.length === 1 ? { componentId: componentIds[0] } : {}),
      tags: [...tags].sort(compareText),
    };
  }

  private factViews(subject: EntityId): FactView[] {
    const facts = sortById(
      (this.factsBySubject.get(subject) ?? []).map((fact) => ({ id: `${fact.id}:${fact.predicate}`, fact })),
    ).map((item) => item.fact);
    const result: FactView[] = facts
      .filter((fact) => !isSourceBodyKey(fact.predicate))
      .map((fact) => ({
        name: fact.predicate,
        value: safeJsonValue(fact.value),
        authority: fact.authority,
        provenance: this.provenance(fact.authority, `live fact ${fact.predicate}`, fact.provenance),
      }));
    if (this.modelGapSymbols.has(subject)) {
      result.push({
        name: "model-gap",
        value: "unowned-symbol",
        authority: "analysis",
        provenance: this.provenance("analysis", "no explicit declared Component ownership exists for this Symbol"),
      });
    }
    return result;
  }

  private componentView(entity: IndexedEntity): ComponentView {
    const componentId = entity.source.id;
    const ownedSymbolIds = [...this.ownership.owned.entries()]
      .filter(([, componentIds]) => componentIds.includes(componentId))
      .map(([symbolId]) => symbolId)
      .sort(compareText);
    const ownedSymbols = ownedSymbolIds
      .map((id) => this.entitiesById.get(id))
      .filter((item): item is IndexedEntity => item !== undefined && item.kind === "symbol");
    const fileIds = new Set<EntityId>();
    for (const relation of this.relations) {
      if (relation.kind !== "defines" && relation.kind !== "contains") continue;
      if (
        relation.kind === "defines" &&
        ownedSymbolIds.includes(relation.to) &&
        this.entitiesById.get(relation.from)?.kind === "file"
      ) {
        fileIds.add(relation.from);
      }
      if (
        relation.kind === "contains" &&
        relation.from === componentId &&
        this.entitiesById.get(relation.to)?.kind === "file"
      ) {
        fileIds.add(relation.to);
      }
    }
    const packageIds = new Set<EntityId>();
    const evidenceIds = new Set<EntityId>();
    for (const relation of this.relations) {
      const sourceIsOwned = ownedSymbolIds.includes(relation.from);
      if (relation.kind === "evidence-for" && (ownedSymbolIds.includes(relation.to) || relation.to === componentId)) {
        const evidenceId = this.entitiesById.get(relation.from)?.kind === "evidence" ? relation.from : relation.to;
        if (this.entitiesById.get(evidenceId)?.kind === "evidence") evidenceIds.add(evidenceId);
        continue;
      }
      if (!sourceIsOwned && relation.from !== componentId) continue;
      if (relation.kind === "uses-package" || relation.kind === "imports-api" || relation.kind === "depends-on") {
        if (this.entitiesById.get(relation.to)?.kind === "package") packageIds.add(relation.to);
        const target = this.entitiesById.get(relation.to);
        if (target?.kind === "external-api") {
          const packageId = target.source.kind === "external_api" ? target.source.packageId : undefined;
          if (packageId !== undefined) packageIds.add(packageId);
        }
      }
      if (relation.kind === "evidence-for" && this.entitiesById.get(relation.from)?.kind === "evidence")
        evidenceIds.add(relation.from);
      if (relation.kind === "evidence-for" && this.entitiesById.get(relation.to)?.kind === "evidence")
        evidenceIds.add(relation.to);
    }
    const metrics: Record<string, JsonValue> = {
      symbolCount: ownedSymbols.length,
      fileCount: fileIds.size,
      relationCount: this.relations.filter(
        (relation) => ownedSymbolIds.includes(relation.from) || ownedSymbolIds.includes(relation.to),
      ).length,
      dependencyCount: this.dependencyItems(componentId).length,
      lines: 0,
      cyclomaticComplexity: this.sumMetric(ownedSymbolIds, "cyclomaticComplexity"),
      references: this.sumMetric(ownedSymbolIds, "references"),
      calls: this.sumMetric(ownedSymbolIds, "calls"),
    };
    // `lines` is an object-valued fact in the extractor, so use the same aggregation path
    // as the other symbol metrics instead of exposing a misleading zero.
    metrics.lines = this.sumMetric(ownedSymbolIds, "lines");
    return {
      ...this.summary(entity),
      responsibility:
        entity.source.kind === "component" ? entity.source.responsibility : entityDescription(entity.source),
      ownedSymbolIds,
      capabilityIds: this.relatedIds(componentId, new Set(["provides", "contains"]), "capability"),
      contractIds: this.relatedIds(componentId, new Set(["requires", "contains"]), "contract"),
      invariantIds: this.relatedIds(componentId, new Set(["constrained-by", "contains"]), "invariant"),
      fileIds: [...fileIds].sort(compareText),
      evidenceIds: [...evidenceIds].sort(compareText),
      packageIds: [...packageIds].sort(compareText),
      metrics,
    };
  }

  private sumMetric(symbolIds: readonly EntityId[], metricName: string): number {
    return symbolIds.reduce((sum, symbolId) => {
      const fact = (this.factsBySubject.get(symbolId) ?? []).find((item) => item.predicate === "symbol.metrics");
      if (!isRecord(fact?.value)) return sum;
      const value = fact.value[metricName];
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
  }

  private relatedIds(sourceId: EntityId, relationKinds: Set<RelationKind>, kind: EntityKind): EntityId[] {
    return this.relations
      .filter(
        (relation) =>
          relation.from === sourceId &&
          relationKinds.has(relation.kind) &&
          this.entitiesById.get(relation.to)?.kind === kind,
      )
      .map((relation) => relation.to)
      .sort(compareText);
  }

  private dependencyItems(
    componentId: EntityId | undefined,
  ): Array<{ from: EntitySummary; to: EntitySummary; relation: QuerySemanticRelation }> {
    const direct = this.relations.filter((relation) => DEPENDENCY_RELATIONS.has(relation.kind));
    const items = new Map<string, { from: EntitySummary; to: EntitySummary; relation: QuerySemanticRelation }>();
    for (const relation of direct) {
      const target = this.entitiesById.get(relation.to);
      const source = this.entitiesById.get(relation.from);
      if (target === undefined || source === undefined) continue;
      if (componentId === undefined) {
        items.set(relation.id, { from: this.summary(source), to: this.summary(target), relation });
        continue;
      }
      if (relation.from === componentId) {
        items.set(relation.id, { from: this.summary(source), to: this.summary(target), relation });
        continue;
      }
      const owners = this.ownership.owned.get(relation.from) ?? [];
      if (!owners.includes(componentId)) continue;
      const aggregateId = `component-dependency:${componentId}:${relation.kind}:${relation.to}`;
      if (!items.has(aggregateId)) {
        const component = this.entitiesById.get(componentId);
        if (component === undefined) continue;
        const aggregateRelation: QuerySemanticRelation = {
          id: aggregateId,
          kind: relation.kind,
          from: componentId,
          to: relation.to,
          authority: "analysis",
          provenance: this.provenance("analysis", "component dependency aggregated from explicitly owned Symbols"),
        };
        items.set(aggregateId, {
          from: this.summary(component),
          to: this.summary(target),
          relation: aggregateRelation,
        });
      }
    }
    if (componentId !== undefined) {
      const component = this.entitiesById.get(componentId);
      if (component !== undefined) {
        const ownedSymbolIds = [...this.ownership.owned.entries()]
          .filter(([, owners]) => owners.includes(componentId))
          .map(([symbolId]) => symbolId);
        const internal = this.relations.filter(
          (relation) =>
            (relation.kind === "calls" ||
              relation.kind === "references" ||
              relation.kind === "extends" ||
              relation.kind === "implements") &&
            ownedSymbolIds.includes(relation.from),
        );
        for (const relation of internal) {
          const targetOwners = this.ownership.owned.get(relation.to) ?? [];
          const targetIds: EntityId[] =
            targetOwners.length === 1 && targetOwners[0] !== componentId ? targetOwners : [relation.to];
          for (const targetId of targetIds) {
            if (targetId === componentId) continue;
            const target = this.entitiesById.get(targetId);
            if (target === undefined) continue;
            const aggregateId = `component-dependency:${componentId}:depends-on:${targetId}`;
            if (items.has(aggregateId)) continue;
            items.set(aggregateId, {
              from: this.summary(component),
              to: this.summary(target),
              relation: {
                id: aggregateId,
                kind: "depends-on",
                from: componentId,
                to: targetId,
                authority: "analysis",
                provenance: this.provenance(
                  "analysis",
                  "Component dependency aggregated from explicitly owned Symbol relations",
                ),
              },
            });
          }
        }
      }
    }
    return [...items.values()].sort((left, right) => compareText(left.relation.id, right.relation.id));
  }

  private packageUsage(): DependencyView["packageUsage"] {
    const packages = [...this.entitiesById.values()]
      .filter((item) => item.kind === "package")
      .sort((left, right) => compareText(left.source.id, right.source.id));
    return packages.map((pkg) => {
      const componentIds = new Set<EntityId>();
      const importedApiIds = new Set<EntityId>();
      for (const relation of this.relations) {
        if (relation.kind === "uses-package" && relation.to === pkg.source.id)
          this.addOwnerComponent(componentIds, relation.from);
        if (relation.kind === "imports-api") {
          const api = this.entitiesById.get(relation.to);
          const apiPackageId = api?.source.kind === "external_api" ? api.source.packageId : undefined;
          if (apiPackageId === pkg.source.id) {
            importedApiIds.add(relation.to);
            this.addOwnerComponent(componentIds, relation.from);
          }
        }
      }
      return {
        package: this.summary(pkg),
        componentIds: [...componentIds].sort(compareText),
        importedApiIds: [...importedApiIds].sort(compareText),
      };
    });
  }

  private addOwnerComponent(componentIds: Set<EntityId>, sourceId: EntityId): void {
    const source = this.entitiesById.get(sourceId);
    if (source?.kind === "component") {
      componentIds.add(sourceId);
      return;
    }
    const owners = this.ownership.owned.get(sourceId) ?? [];
    for (const owner of owners) componentIds.add(owner);
    if (source?.kind === "file") {
      for (const relation of this.relations) {
        if ((relation.kind !== "defines" && relation.kind !== "contains") || relation.from !== sourceId) continue;
        for (const owner of this.ownership.owned.get(relation.to) ?? []) componentIds.add(owner);
      }
    }
  }

  private knowledgeEntries(): KnowledgeEntry[] {
    if (this.snapshot === undefined) return [];
    const entries: KnowledgeEntry[] = [];
    for (const decision of this.snapshot.declarations.decisions) {
      const status: KnowledgeEntry["status"] =
        decision.status === "accepted" ? "accepted" : decision.status === "superseded" ? "stale" : "draft";
      entries.push({
        id: decision.id,
        kind: "decision",
        title: decision.name,
        summary: decision.statement,
        status: this.integrityStatus === "stale" ? "stale" : status,
        linkedEntityIds: this.relations
          .filter(
            (relation) => relation.kind === "governs" && (relation.from === decision.id || relation.to === decision.id),
          )
          .map((relation) => (relation.from === decision.id ? relation.to : relation.from))
          .sort(compareText),
        authority: decision.authority,
        provenance: this.provenance(decision.authority, "declared decision", decision.provenance),
      });
    }
    const policies = [
      ...this.snapshot.declarations.effectPolicies.map((policy) => ({
        id: policy.id,
        subject: policy.subject,
        kind: "effect",
      })),
      ...this.snapshot.declarations.dependencyPolicies.map((policy) => ({
        id: policy.id,
        subject: policy.subject,
        kind: "dependency",
      })),
    ];
    for (const policy of policies) {
      entries.push({
        id: policy.id,
        kind: "policy",
        title: `${policy.kind} policy`,
        summary: `Declared ${policy.kind} policy for ${policy.subject}`,
        status: this.integrityStatus === "stale" ? "stale" : "protected",
        linkedEntityIds: [policy.subject],
        authority: "declared",
        provenance: this.provenance("declared", "declared policy", undefined),
      });
    }
    for (const evidence of this.snapshot.observed.evidences) {
      entries.push({
        id: evidence.id,
        kind: "evidence",
        title: evidence.name,
        summary: evidence.summary,
        status: this.integrityStatus === "stale" ? "stale" : "observed",
        linkedEntityIds: this.relations
          .filter(
            (relation) =>
              relation.kind === "evidence-for" && (relation.from === evidence.id || relation.to === evidence.id),
          )
          .map((relation) => (relation.from === evidence.id ? relation.to : relation.from))
          .sort(compareText),
        authority: evidence.authority,
        provenance: this.provenance(evidence.authority, "observed evidence", evidence.provenance),
      });
    }
    return entries.sort((left, right) => compareText(left.id, right.id));
  }

  private agentProjection(entity: IndexedEntity, relations: readonly QuerySemanticRelation[]): AgentProjection {
    return {
      entityId: entity.source.id,
      status: providerStatus(this.integrityStatus),
      summary: entityDescription(entity.source),
      facts: this.factViews(entity.source.id),
      relations,
      recommendedReads: this.recommendedReads(),
      source: {
        available: false,
        reason: "source bodies are never returned by Repository Semantic Query; use metadata-only escalation reads",
      },
      ...(this.verificationFor(entity.source.id, this.scopeForKind(entity.kind))?.health === undefined
        ? {}
        : { verification: this.verificationFor(entity.source.id, this.scopeForKind(entity.kind))?.health }),
    };
  }

  private unavailableAgentProjection(summary: EntitySummary): AgentProjection {
    return {
      entityId: summary.id,
      status: "unavailable",
      summary: "Live Repository Model is unavailable",
      facts: [],
      relations: [],
      recommendedReads: [],
      source: { available: false, reason: this.statusNote("invalid semantic state") },
    };
  }

  private recommendedReads(): QuerySourceReference[] {
    return (this.snapshot?.analysis.recommendedSourceReads ?? []).map((reference) => ({
      path: reference.path,
      ...(reference.symbol === undefined ? {} : { symbol: reference.symbol }),
      ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
      ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
      reason: reference.reason,
    }));
  }

  private verificationView(summary: VerificationSummary): VerificationView {
    const assessments =
      this.snapshot?.analysis.verification?.assessments.filter((item) => item.target.id === summary.targetId) ?? [];
    return toVerificationView(
      summary,
      assessments,
      this.provenance("analysis", "verification projection from live analysis"),
    );
  }

  private verificationFor(
    id: EntityId,
    scope: "symbol" | "component" | "project" | undefined,
  ): VerificationView | undefined {
    if (scope === undefined || this.snapshot?.analysis.verification === undefined) return undefined;
    const summary = this.snapshot.analysis.verification.summaries.find(
      (item) => item.targetId === id && item.scope === scope,
    );
    return summary === undefined ? undefined : this.verificationView(summary);
  }

  private scopeForKind(kind: EntityKind): "symbol" | "component" | "project" | undefined {
    return kind === "symbol" || kind === "component" || kind === "project" ? kind : undefined;
  }

  private requireEntity(id: EntityId): IndexedEntity {
    const entity = this.entitiesById.get(id);
    if (entity === undefined) throw new SemanticQueryError("not_found", `unknown semantic entity: ${id}`);
    return entity;
  }

  private unavailableProjectSummary(): EntitySummary {
    return {
      id: this.unavailableProjectId,
      kind: "project",
      name: "unavailable",
      summary: "Live Repository Model is unavailable",
      status: "unknown",
      authority: "integrity",
      provenance: this.provenance("integrity", "invalid semantic state cannot be served authoritatively"),
      tags: ["live", "unavailable"],
    };
  }

  private statusFor(entity: IndexedEntity): EntityStatus {
    if (this.integrityStatus === "invalid") return "unknown";
    if (this.integrityStatus === "stale") return "stale";
    if (this.modelGapSymbols.has(entity.source.id)) return "partial";
    if (entity.source.provenance.completeness === "partial") return "partial";
    if (this.snapshot?.analysis.health.status === "protected") return "protected";
    if (this.snapshot?.analysis.health.status === "review-required") return "review-required";
    if (this.snapshot?.analysis.health.status === "unknown") return "unknown";
    if (this.snapshot?.analysis.health.status === "partial") return "partial";
    return "healthy";
  }

  private projectHealthStatus(modelGaps: number): EntityStatus {
    if (this.integrityStatus === "invalid") return "unknown";
    if (this.integrityStatus === "stale") return "stale";
    if (modelGaps > 0) return "partial";
    return this.snapshot?.analysis.health.status === "healthy"
      ? "healthy"
      : (this.snapshot?.analysis.health.status ?? "unknown");
  }

  private reviewRequiredCount(): number {
    const reviewLevel = this.snapshot?.analysis.reviewLevel;
    const errors = this.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    return errors + (reviewLevel === "L2" || reviewLevel === "L3" ? 1 : 0);
  }

  private staleObservedEvidenceCount(): number {
    return (
      this.snapshot?.observed.verificationEvidence?.filter((evidence) => evidence.freshness === "stale").length ?? 0
    );
  }

  private depthLimit(value: number | undefined, fallback: number | undefined): number | undefined {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 0 || value > 20) {
      throw new SemanticQueryError("invalid_query", "depth must be an integer between 0 and 20");
    }
    return value;
  }

  private traverses(relation: QuerySemanticRelation, currentId: EntityId, direction: GraphQuery["direction"]): boolean {
    if (direction === "outgoing") return relation.from === currentId;
    if (direction === "incoming") return relation.to === currentId;
    return relation.from === currentId || relation.to === currentId;
  }

  private provenance(authority: AuthorityLayer, note: string, original?: IrProvenance): QueryProvenance {
    return {
      authority,
      status: providerStatus(this.integrityStatus),
      provider: LIVE_REPOSITORY_MODEL_PROVIDER,
      note: `${note}; ${this.statusNote(sourceProvenanceLabel(original))}`,
    };
  }

  private statusNote(context: string): string {
    const reason = this.integrityReason === undefined ? "" : `:${this.integrityReason}`;
    const diagnosticCodes =
      this.diagnostics
        .map((diagnostic) => diagnostic.code)
        .sort(compareText)
        .join(",") || "none";
    return `${context}; integrity=${this.integrityStatus}${reason}; diagnostics=${diagnosticCodes}`;
  }
}
