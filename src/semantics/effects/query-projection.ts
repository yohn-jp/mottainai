import type { LogicalId } from "../ir/ids.js";
import type { FactView, Provenance as QueryProvenance } from "../query.js";
import type { EffectAnalysis } from "./types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function queryProvenance(analysis: EffectAnalysis, authority: "derived" | "analysis"): QueryProvenance {
  const completeness = analysis.completeness;
  return {
    authority,
    status: completeness === "unknown" ? "unavailable" : completeness === "partial" ? "partial" : "fixture",
    provider: analysis.provenance.producer.name,
    note: `Symbol effect analysis (${completeness}); complete live results use the existing v1 query fact contract`,
  };
}

/**
 * Projects effect facts into the stable #83 fact surface. #53 can merge these
 * facts into its live entity model without adding a competing query method or
 * rerunning effect analysis.
 */
export function projectEffectsToQuery(analysis: EffectAnalysis): {
  factsFor(entityId: LogicalId): readonly FactView[];
  entities: ReadonlyMap<LogicalId, readonly FactView[]>;
} {
  const byEntity = new Map<LogicalId, FactView[]>();
  for (const fact of [...analysis.derivedFacts, ...analysis.analysisFacts]) {
    const values = byEntity.get(fact.subject) ?? [];
    values.push({
      name: fact.predicate,
      value: fact.value,
      authority: fact.authority,
      provenance: queryProvenance(analysis, fact.authority === "analysis" ? "analysis" : "derived"),
    });
    byEntity.set(fact.subject, values);
  }
  const entities = new Map<LogicalId, readonly FactView[]>(
    [...byEntity.entries()].map(([id, facts]) => [
      id,
      [...facts].sort((left, right) => compareText(left.name, right.name)),
    ]),
  );
  return {
    factsFor: (entityId) => entities.get(entityId) ?? [],
    entities,
  };
}
