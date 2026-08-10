import { compareText } from "../ir/canonical.js";
import { SEMANTIC_PROJECTION_PROVIDER } from "./types.js";
import type {
  AuthorityLayer,
  JsonValue,
  Provenance,
  RepositorySemanticSnapshot,
  SemanticEntity,
  SemanticFact,
  SemanticRelation,
  SourceReference,
} from "../ir/types.js";
import type {
  ProjectionModelState,
  ProjectedEntityReference,
  ProjectedFact,
  ProjectedRelation,
  ProjectionProvenance,
  SemanticProjectionStatus as ProjectionStatus,
  ProjectionUnknown,
  EntityId,
} from "./types.js";

export interface ProjectionModel {
  readonly snapshot: RepositorySemanticSnapshot;
  readonly entities: ReadonlyMap<EntityId, SemanticEntity>;
  readonly facts: ReadonlyMap<EntityId, readonly SemanticFact[]>;
  readonly relations: readonly SemanticRelation[];
  readonly status: ProjectionStatus;
  readonly state: ProjectionModelState;
  entity(id: EntityId): SemanticEntity | undefined;
  factsFor(id: EntityId): readonly SemanticFact[];
  relationsFor(id: EntityId): readonly SemanticRelation[];
  reference(id: EntityId): ProjectedEntityReference | undefined;
  fact(fact: SemanticFact): ProjectedFact | undefined;
  relation(relation: SemanticRelation): ProjectedRelation;
  sourceReadsFor(id: EntityId): SourceReference[];
  unknownsFor(id?: EntityId): ProjectionUnknown[];
  authoritative(authority: AuthorityLayer, provenance: Provenance): boolean;
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

/** Strip source bodies recursively while retaining metadata, fingerprints and ranges. */
export function safeProjectionValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map((item) => safeProjectionValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSourceBodyKey(key))
        .map(([key, item]) => [key, safeProjectionValue(item)]),
    );
  }
  return null;
}

function entityDescription(entity: SemanticEntity): string {
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
      return entity.packageName;
    case "external_dependency":
      return entity.packageName;
    case "external_api":
      return entity.apiName;
    case "capability":
      return entity.meaning;
    case "contract":
      return "Declared contract";
    case "invariant":
    case "rationale":
    case "constraint":
      return entity.statement;
    case "decision":
      return entity.statement;
    case "evidence":
      return entity.summary;
    case "test":
      return entity.testName;
    default:
      return "";
  }
}

function normalizeStatus(snapshot: RepositorySemanticSnapshot): ProjectionStatus {
  switch (snapshot.integrity.status) {
    case "fresh":
      return "fresh";
    case "stale":
      return "stale";
    case "invalid":
      return "invalid";
  }
}

export function sourceRevision(snapshot: RepositorySemanticSnapshot): string | undefined {
  return snapshot.revisionIdentity?.revision ?? snapshot.integrity.git?.revision;
}

function state(snapshot: RepositorySemanticSnapshot): ProjectionModelState {
  const status = normalizeStatus(snapshot);
  return {
    status,
    integrity: snapshot.integrity.status,
    authoritative: status === "fresh",
    ...(snapshot.declarations.project.provenance.completeness === undefined
      ? {}
      : { completeness: snapshot.declarations.project.provenance.completeness }),
    ...(sourceRevision(snapshot) === undefined ? {} : { revision: sourceRevision(snapshot) }),
    modelDigest: snapshot.integrity.modelDigest.value,
    ...(snapshot.integrity.statusReason === undefined ? {} : { reason: snapshot.integrity.statusReason }),
  };
}

function entityLists(snapshot: RepositorySemanticSnapshot): SemanticEntity[] {
  return [
    snapshot.declarations.project,
    ...snapshot.declarations.components,
    ...snapshot.declarations.capabilities,
    ...snapshot.declarations.contracts,
    ...snapshot.declarations.invariants,
    ...snapshot.declarations.decisions,
    ...snapshot.declarations.rationales,
    ...snapshot.declarations.constraints,
    ...snapshot.derived.files,
    ...snapshot.derived.symbols,
    ...snapshot.derived.packages,
    ...snapshot.derived.externalDependencies,
    ...snapshot.derived.externalApis,
    ...snapshot.observed.evidences,
    ...snapshot.observed.tests,
  ];
}

function sourceReferenceForEntity(entity: SemanticEntity, reason: string): SourceReference | undefined {
  if (entity.kind === "symbol") {
    if (entity.locator.file === undefined) return undefined;
    return {
      path: entity.locator.file,
      symbol: entity.locator.symbol,
      ...(entity.locator.range === undefined
        ? {}
        : {
            startLine: entity.locator.range.start.line,
            ...(entity.locator.range.end === undefined ? {} : { endLine: entity.locator.range.end.line }),
          }),
      reason,
    };
  }
  if (entity.kind === "file") return { path: entity.path, reason };
  return undefined;
}

function uniqueSourceReads(reads: readonly SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return reads
    .filter((read) => {
      const key = JSON.stringify(read);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      compareText(
        `${left.path}:${left.symbol ?? ""}:${left.startLine ?? 0}:${left.endLine ?? 0}:${left.reason}`,
        `${right.path}:${right.symbol ?? ""}:${right.startLine ?? 0}:${right.endLine ?? 0}:${right.reason}`,
      ),
    );
}

function relationName(kind: string): string {
  return kind.replaceAll("_", "-");
}

function buildProjectionModel(snapshot: RepositorySemanticSnapshot): ProjectionModel {
  const entities = new Map<EntityId, SemanticEntity>();
  for (const entity of entityLists(snapshot)) if (!entities.has(entity.id)) entities.set(entity.id, entity);
  const factMap = new Map<EntityId, SemanticFact[]>();
  for (const facts of [
    snapshot.declarations.facts,
    snapshot.derived.facts,
    snapshot.observed.facts,
    snapshot.analysis.facts,
  ]) {
    for (const fact of facts) factMap.set(fact.subject, [...(factMap.get(fact.subject) ?? []), fact]);
  }
  const relations = [...snapshot.graph.relations].sort((left, right) => compareText(left.id, right.id));
  const projectionStatus = normalizeStatus(snapshot);
  const analysisReadsForEntity = (id: EntityId): SourceReference[] => {
    const entity = entities.get(id);
    if (entity === undefined) return [];
    return snapshot.analysis.recommendedSourceReads.filter((read) => {
      if (entity.kind === "symbol") {
        if (read.path === entity.locator.file) return true;
        return read.symbol === entity.locator.symbol && entity.locator.file === undefined;
      }
      if (entity.kind === "file") return read.path === entity.path;
      return false;
    });
  };
  return {
    snapshot,
    entities,
    facts: factMap,
    relations,
    status: projectionStatus,
    state: state(snapshot),
    entity: (id) => entities.get(id),
    factsFor: (id) => [...(factMap.get(id) ?? [])].sort((left, right) => compareText(left.id, right.id)),
    relationsFor: (id) => relations.filter((relation) => relation.from === id || relation.to === id),
    reference: (id) => {
      const entity = entities.get(id);
      if (entity === undefined) return undefined;
      return {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        summary: entityDescription(entity),
        authority: entity.authority,
        provenance: entity.provenance,
        inferred: entity.provenance.kind === "inferred" || entity.authority === "analysis",
        authoritative: projectionStatus === "fresh" && entity.provenance.kind !== "inferred",
      };
    },
    fact: (fact) => {
      if (isSourceBodyKey(fact.predicate)) return undefined;
      const inferred = fact.provenance.kind === "inferred" || fact.authority === "analysis";
      return {
        id: fact.id,
        name: fact.predicate,
        value: safeProjectionValue(fact.value),
        authority: fact.authority,
        provenance: fact.provenance,
        inferred,
        authoritative: projectionStatus === "fresh" && !inferred,
      };
    },
    relation: (relation) => ({
      id: relation.id,
      kind: relationName(relation.kind),
      from: relation.from,
      to: relation.to,
      authority: relation.authority,
      provenance: relation.provenance,
      inferred: relation.provenance.kind === "inferred" || relation.authority === "analysis",
      authoritative: projectionStatus === "fresh" && relation.provenance.kind !== "inferred",
    }),
    sourceReadsFor: (id) => {
      const entity = entities.get(id);
      const direct =
        entity === undefined ? undefined : sourceReferenceForEntity(entity, "exact Symbol/file metadata escalation");
      const fromAnalysis = entity === undefined ? [] : analysisReadsForEntity(id);
      const directReads: SourceReference[] = direct === undefined ? [] : [direct];
      return uniqueSourceReads([...directReads, ...fromAnalysis]);
    },
    unknownsFor: (id) => {
      const unknowns = snapshot.analysis.unknowns
        .filter(
          (unknown) =>
            id === undefined ||
            unknown.subjects === undefined ||
            unknown.subjects.some((subject) => String(subject) === id),
        )
        .map((unknown, index) => ({
          id: `unknown:${unknown.code}:${index}`,
          code: unknown.code,
          message: unknown.message,
          subjects: unknown.subjects ?? (id === undefined ? [] : [id]),
          material: true,
          authoritative: false as const,
          recommendedSourceReads: id === undefined ? [] : analysisReadsForEntity(id),
        }));
      if (projectionStatus === "invalid") {
        unknowns.unshift({
          id: "unknown:invalid-model",
          code: "invalid-model",
          message: snapshot.integrity.statusReason ?? "Repository Semantic Model integrity is invalid",
          subjects: id === undefined ? [] : [id],
          material: true,
          authoritative: false as const,
          recommendedSourceReads: [],
        });
      }
      if (projectionStatus === "stale") {
        unknowns.unshift({
          id: "unknown:stale-model",
          code: "stale-model",
          message: snapshot.integrity.statusReason ?? "Repository Semantic Model is stale for the current revision",
          subjects: id === undefined ? [] : [id],
          material: true,
          authoritative: false as const,
          recommendedSourceReads: id === undefined ? [] : analysisReadsForEntity(id),
        });
      }
      return unknowns;
    },
    authoritative: (authority, provenance) =>
      projectionStatus === "fresh" && authority !== "analysis" && provenance.kind !== "inferred",
  };
}

export function createProjectionModel(snapshot: RepositorySemanticSnapshot): ProjectionModel {
  return buildProjectionModel(snapshot);
}

export function entityReference(model: ProjectionModel, id: EntityId): ProjectedEntityReference | undefined {
  return model.reference(id);
}

export function factsFor(model: ProjectionModel, id: EntityId): ProjectedFact[] {
  return model
    .factsFor(id)
    .map((fact) => model.fact(fact))
    .filter((fact): fact is ProjectedFact => fact !== undefined);
}

export function relationsFor(model: ProjectionModel, id: EntityId): ProjectedRelation[] {
  return model.relationsFor(id).map(model.relation);
}

export function sourceReadsFor(model: ProjectionModel, id: EntityId): SourceReference[] {
  return model.sourceReadsFor(id);
}

export function projectedProvenance(
  model: ProjectionModel,
  authority: AuthorityLayer | "integrity",
  note: string,
  sourceProvenance: Provenance = model.snapshot.declarations.project.provenance,
): ProjectionProvenance {
  return {
    provider: SEMANTIC_PROJECTION_PROVIDER,
    authority,
    ...(sourceRevision(model.snapshot) === undefined ? {} : { sourceRevision: sourceRevision(model.snapshot) }),
    sourceProvenance,
    ...(sourceProvenance.completeness === undefined ? {} : { completeness: sourceProvenance.completeness }),
    status: model.status,
    authoritative: model.state.authoritative && authority !== "integrity" && sourceProvenance?.kind !== "inferred",
    note,
  };
}

export function allEntityReferences(model: ProjectionModel, ids: readonly EntityId[]): ProjectedEntityReference[] {
  return ids.map((id) => model.reference(id)).filter((item): item is ProjectedEntityReference => item !== undefined);
}

export function relationIds(model: ProjectionModel, id: EntityId, kinds: readonly string[]): EntityId[] {
  const allowed = new Set(kinds.map(relationName));
  return model
    .relationsFor(id)
    .filter((relation) => allowed.has(relationName(relation.kind)))
    .map((relation) => (relation.from === id ? relation.to : relation.from))
    .sort(compareText);
}

export function uniqueReads(reads: readonly SourceReference[]): SourceReference[] {
  return uniqueSourceReads(reads);
}

export { entityDescription, isSourceBodyKey, relationName };
