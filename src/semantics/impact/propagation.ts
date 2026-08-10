import { compareText } from "../ir/canonical.js";
import type { LogicalId } from "../ir/ids.js";
import type { RepositorySemanticSnapshot, SemanticEntity, SemanticRelation } from "../ir/types.js";
import type { ImpactPath, PropagationStopPoint } from "../diff/types.js";
import type { ImpactPropagationInput, ImpactPropagationResult } from "./types.js";

const PROPAGATING_RELATIONS = new Set([
  "calls",
  "references",
  "imports",
  "requires",
  "provides",
  "implements",
  "depends_on",
  "depends-on",
  "uses_package",
  "uses-package",
  "imports_api",
  "imports-api",
]);
const DEFAULT_MAX_DEPTH = 20;

function compareIds(left: { id: string }, right: { id: string }): number {
  return compareText(left.id, right.id);
}

function allEntities(snapshot: RepositorySemanticSnapshot): Map<LogicalId, SemanticEntity> {
  const values = [
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
  return new Map(values.map((item) => [item.id, item]));
}

function relationKey(relation: SemanticRelation): string {
  return `${relation.kind}:${relation.from}:${relation.to}`;
}

function mergedRelations(base: RepositorySemanticSnapshot, head: RepositorySemanticSnapshot): SemanticRelation[] {
  const relations = new Map<string, SemanticRelation>();
  for (const relation of [...base.graph.relations, ...head.graph.relations])
    relations.set(relationKey(relation), relation);
  return [...relations.values()].sort((left, right) => compareText(relationKey(left), relationKey(right)));
}

function ownership(base: RepositorySemanticSnapshot, head: RepositorySemanticSnapshot): Map<LogicalId, LogicalId[]> {
  const entities = allEntities(head);
  for (const [id, entity] of allEntities(base)) if (!entities.has(id)) entities.set(id, entity);
  const result = new Map<LogicalId, Set<LogicalId>>();
  for (const relation of mergedRelations(base, head)) {
    if (relation.authority !== "declared" || (relation.kind !== "owns" && relation.kind !== "shares")) continue;
    if (entities.get(relation.from)?.kind !== "component" || entities.get(relation.to)?.kind !== "symbol") continue;
    const owners = result.get(relation.to) ?? new Set<LogicalId>();
    owners.add(relation.from);
    result.set(relation.to, owners);
  }
  return new Map([...result].map(([id, values]) => [id, [...values].sort(compareText)]));
}

function entityKind(
  baseEntities: Map<LogicalId, { kind: string }>,
  headEntities: Map<LogicalId, { kind: string }>,
  id: LogicalId,
): string | undefined {
  return headEntities.get(id)?.kind ?? baseEntities.get(id)?.kind;
}

/**
 * Propagate semantic impact through explicit graph relations only.
 *
 * A Symbol's owner is a semantic boundary. If neither the Symbol's externally
 * visible surface nor its Component boundary changed, propagation stops there;
 * a calls/imports/dependency edge by itself is never enough to cross it.
 */
export function propagateSemanticImpact(input: ImpactPropagationInput): ImpactPropagationResult {
  const baseEntities = allEntities(input.baseSnapshot);
  const headEntities = allEntities(input.headSnapshot);
  const kinds = new Map<LogicalId, string>();
  for (const [id, entity] of baseEntities) kinds.set(id, entity.kind);
  for (const [id, entity] of headEntities) kinds.set(id, entity.kind);
  const owners = ownership(input.baseSnapshot, input.headSnapshot);
  const boundaryComponents = new Set(input.changedComponentIds);
  const boundarySymbols = new Set(input.boundaryChangedSymbolIds ?? []);
  const unknownSymbols = new Set(input.unknownSymbolIds ?? []);
  const affected = new Set<LogicalId>();
  const paths: ImpactPath[] = [];
  const stopPoints: PropagationStopPoint[] = [];
  const visited = new Set<string>();
  const relations = mergedRelations(input.baseSnapshot, input.headSnapshot);
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;

  const addStop = (entityId: LogicalId, reason: string, path: readonly LogicalId[], componentId?: LogicalId): void => {
    const key = `${entityId}:${componentId ?? ""}:${reason}:${path.join(">")}`;
    if (
      stopPoints.some(
        (item) => `${item.entityId}:${item.componentId ?? ""}:${item.reason}:${item.path.join(">")}` === key,
      )
    )
      return;
    stopPoints.push({ entityId, ...(componentId === undefined ? {} : { componentId }), reason, path: [...path] });
    paths.push({ entityIds: [...path], stopReason: reason, propagated: path.length > 1 });
  };

  const boundaryPreserved = (symbolId: LogicalId, componentId: LogicalId): boolean =>
    !boundarySymbols.has(symbolId) && !boundaryComponents.has(componentId);

  const walk = (currentId: LogicalId, path: readonly LogicalId[], depth: number): void => {
    const visitKey = `${currentId}:${path[path.length - 2] ?? ""}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    if (depth >= maxDepth) {
      addStop(currentId, "maximum propagation depth reached", path);
      return;
    }
    const incoming = relations.filter(
      (relation) =>
        relation.to === currentId && PROPAGATING_RELATIONS.has(relation.kind) && relation.from !== currentId,
    );
    if (incoming.length === 0) {
      addStop(currentId, "no explicit consuming relation", path);
      return;
    }
    let propagated = false;
    for (const relation of incoming) {
      const consumer = relation.from;
      const nextPath = [...path, consumer];
      affected.add(consumer);
      const kind = entityKind(baseEntities, headEntities, consumer);
      if (kind === "symbol") {
        const consumerOwners = owners.get(consumer) ?? [];
        if (consumerOwners.length === 0) {
          unknownSymbols.add(consumer);
          addStop(consumer, "consumer Symbol has no explicit Component ownership", nextPath);
          continue;
        }
        for (const componentId of consumerOwners) {
          affected.add(componentId);
          const componentPath = [...nextPath, componentId];
          if (boundaryPreserved(consumer, componentId)) {
            addStop(consumer, "preserved conforming Component boundary", componentPath, componentId);
          } else {
            propagated = true;
            walk(componentId, componentPath, depth + 1);
          }
        }
      } else if (kind === "component") {
        if (boundaryComponents.has(consumer)) {
          propagated = true;
          walk(consumer, nextPath, depth + 1);
        } else {
          addStop(consumer, "preserved conforming Component boundary", nextPath, consumer);
        }
      } else {
        propagated = true;
        walk(consumer, nextPath, depth + 1);
      }
    }
    if (!propagated && incoming.length > 0 && path.length === 1) {
      addStop(currentId, "consumers stop at preserved Component boundaries", path);
    }
  };

  const seedSymbols = [...new Set(input.changedSymbolIds)].sort(compareText);
  for (const symbolId of seedSymbols) {
    affected.add(symbolId);
    const symbolOwners = owners.get(symbolId) ?? [];
    if (symbolOwners.length === 0) {
      unknownSymbols.add(symbolId);
      addStop(symbolId, "changed Symbol has no explicit Component ownership", [symbolId]);
      continue;
    }
    for (const componentId of symbolOwners) {
      affected.add(componentId);
      const path = [symbolId, componentId] as LogicalId[];
      if (boundaryPreserved(symbolId, componentId)) {
        addStop(symbolId, "preserved conforming Component boundary", path, componentId);
      } else {
        walk(componentId, path, 0);
      }
    }
  }

  for (const componentId of [...new Set(input.changedComponentIds)].sort(compareText)) {
    affected.add(componentId);
    walk(componentId, [componentId], 0);
  }

  const sortedPaths = [...paths].sort((left, right) =>
    compareText(`${left.entityIds.join(">")}:${left.stopReason}`, `${right.entityIds.join(">")}:${right.stopReason}`),
  );
  const sortedStops = [...stopPoints].sort((left, right) =>
    compareText(`${left.entityId}:${left.path.join(">")}`, `${right.entityId}:${right.path.join(">")}`),
  );
  return {
    affectedEntities: [...affected].sort(compareText),
    impactPaths: sortedPaths,
    stopPoints: sortedStops,
    unknownSymbolIds: [...unknownSymbols].sort(compareText),
  };
}
