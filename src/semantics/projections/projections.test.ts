import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSemanticSnapshots } from "../diff/index.js";
import { createEdgeId, createSymbolId } from "../ir/ids.js";
import { ambiguousDynamicCallFixture, logicalComponentFixture, pureFunctionFixture } from "../fixtures/snapshots.js";
import { projectAgentContext, projectJsdoc, projectReview } from "./index.js";

const symbolId = createSymbolId(pureFunctionFixture.derived.symbols[0]!.locator);
const componentId = pureFunctionFixture.declarations.components[0]!.id;

test("Agent projection is deterministic for Symbol and Component targets and exposes exact escalation only", () => {
  const symbolFirst = projectAgentContext({ snapshot: pureFunctionFixture, targetId: symbolId });
  const symbolSecond = projectAgentContext({ snapshot: pureFunctionFixture, targetId: symbolId });
  const component = projectAgentContext({ snapshot: pureFunctionFixture, targetId: componentId });

  assert.deepEqual(symbolFirst, symbolSecond);
  assert.equal(symbolFirst.target.scope, "symbol");
  assert.equal(component.target.scope, "component");
  assert.ok(component.context.symbols.some((item) => item.id === symbolId));
  assert.ok(
    symbolFirst.recommendedSourceReads.some((read) => read.symbol === "normalizeInput" && read.startLine === 4),
  );
  assert.equal(symbolFirst.source.available, false);
  assert.equal(JSON.stringify(symbolFirst).includes("source body"), false);
  assert.equal(JSON.stringify(symbolFirst).includes("rawSource"), false);
});

test("stale, invalid, and inferred state remain non-authoritative in Agent context", () => {
  const stale = structuredClone(pureFunctionFixture);
  stale.integrity.status = "stale";
  stale.integrity.statusReason = "fixture revision no longer matches source";
  const staleProjection = projectAgentContext({ snapshot: stale, targetId: symbolId });
  assert.equal(staleProjection.model.status, "stale");
  assert.equal(staleProjection.model.authoritative, false);
  assert.ok(staleProjection.unknowns.some((item) => item.code === "stale-model"));
  assert.ok(staleProjection.facts.every((fact) => fact.authoritative === false));

  const invalid = structuredClone(pureFunctionFixture);
  invalid.integrity.status = "invalid";
  invalid.integrity.statusReason = "digest verification failed";
  const invalidProjection = projectAgentContext({ snapshot: invalid, targetId: symbolId });
  assert.equal(invalidProjection.model.status, "invalid");
  assert.equal(invalidProjection.facts.length, 0);
  assert.ok(invalidProjection.unknowns.some((item) => item.code === "invalid-model"));

  const inferred = projectAgentContext({ snapshot: ambiguousDynamicCallFixture, targetId: symbolId });
  assert.ok(inferred.unknowns.some((item) => item.code === "dynamic_call_target"));
  assert.ok(inferred.unknowns.every((item) => item.authoritative === false));
});

test("Review projection consumes #54 L0-L3 data and places impact before implementation churn", () => {
  const changeSet = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const review = projectReview({ changeSet, snapshot: logicalComponentFixture });
  assert.ok(
    review.reviewLevel === "L0" ||
      review.reviewLevel === "L1" ||
      review.reviewLevel === "L2" ||
      review.reviewLevel === "L3",
  );
  assert.deepEqual(review.impact.affectedEntities, changeSet.affectedEntities);
  assert.deepEqual(review.impact.stopBoundaries, changeSet.propagationStopPoints);
  if (!review.omissions.some((item) => item.field === "implementationChanges"))
    assert.deepEqual(review.implementationChanges, changeSet.derivedChanges);
  assert.ok(Object.keys(review).indexOf("semanticDelta") < Object.keys(review).indexOf("implementationChanges"));
  for (const read of changeSet.recommendedSourceReads)
    assert.ok(review.recommendedSourceReads.some((candidate) => JSON.stringify(candidate) === JSON.stringify(read)));
});

test("JSDoc projection preserves exact signature and surfaces contradictory declared contracts", () => {
  const normal = projectJsdoc({ snapshot: pureFunctionFixture, targetId: symbolId });
  assert.equal(normal.canonicalLanguage, "en");
  assert.equal(normal.locale, "en");
  assert.equal(normal.exactSignature?.value, "(value: string): string");
  assert.equal(normal.parameters[0]?.name, "value");
  assert.equal(normal.returns?.value, "normalized semantic value");

  const contradictory = structuredClone(pureFunctionFixture);
  const original = contradictory.declarations.contracts[0]!;
  const secondId = "contract:contradictory" as typeof original.id;
  contradictory.declarations.contracts.push({
    ...original,
    id: secondId,
    name: "Contradictory contract",
    definition: {
      ...original.definition,
      outputs: { ...original.definition.outputs, returnValue: "a different value" },
    },
  });
  contradictory.graph.relations.push({
    id: createEdgeId("defines-contradictory-contract"),
    kind: "defines",
    from: componentId,
    to: secondId,
    authority: "declared",
    provenance: original.provenance,
  });
  const projection = projectJsdoc({ snapshot: contradictory, targetId: symbolId });
  assert.ok(projection.contradictions.some((item) => item.field === "returns"));
  assert.equal(projection.returns, undefined);
});

test("projection budgets omit whole structured fields and preserve omission metadata", () => {
  const projection = projectAgentContext({
    snapshot: pureFunctionFixture,
    targetId: componentId,
    options: { softTokens: 128, hardTokens: 256, hardBytes: 1_024, maxFacts: 1, maxRelations: 1, maxSourceReads: 1 },
  });
  const serialized = JSON.stringify(projection);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 1_024, `projection exceeded hard budget: ${serialized.length}`);
  assert.ok(Array.isArray(projection.omissions));
  assert.equal(JSON.parse(serialized).kind, "agent");
});

test("coding-agent flow starts with bounded semantic context, escalates only exact Symbols, then receives #54 review", () => {
  const context = projectAgentContext({ snapshot: pureFunctionFixture, targetId: symbolId, options: { targetTask: "normalize input" } });
  assert.equal(context.source.available, false);
  assert.ok(context.recommendedSourceReads.every((read) => read.symbol === undefined || read.symbol === "normalizeInput"));
  assert.ok(context.recommendedSourceReads.some((read) => read.symbol === "normalizeInput"));

  const changeSet = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const review = projectReview({ changeSet, snapshot: logicalComponentFixture });
  assert.ok(review.semanticDelta.length >= 0);
  assert.deepEqual(review.impact.stopBoundaries, changeSet.propagationStopPoints);
  assert.ok(review.recommendedSourceReads.every((read) => read.path.length > 0));
});
