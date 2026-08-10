import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSemanticSnapshots } from "../diff/index.js";
import type { SemanticDeltaRecord } from "../diff/types.js";
import { createEdgeId, createSymbolId } from "../ir/ids.js";
import { ambiguousDynamicCallFixture, logicalComponentFixture, pureFunctionFixture } from "../fixtures/snapshots.js";
import { createFixtureQuery } from "../fixtures/dashboard-fixture.js";
import { budgetStructuredProjection } from "./budget.js";
import { projectAgentContext, projectJsdoc, projectReview } from "./index.js";
import { createSemanticProjectionQuery } from "./query.js";
import type { ProjectionFieldGroup } from "./budget.js";

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

test("analysis source reads stay scoped to the target Symbol/file and stale unknown", () => {
  const snapshot = structuredClone(pureFunctionFixture);
  const targetFile = snapshot.derived.symbols[0]!.locator.file!;
  const targetSymbol = snapshot.derived.symbols[0]!.locator.symbol;
  const template = snapshot.analysis.recommendedSourceReads[0]!;
  snapshot.analysis.recommendedSourceReads = [
    { ...template, path: targetFile, symbol: undefined },
    { ...template, path: "src/unrelated.ts", symbol: "unrelated" },
    { ...template, path: "src/same-name-other.ts", symbol: targetSymbol },
    { ...template, path: "src/unrelated-contract.ts", symbol: undefined },
  ];
  const projection = projectAgentContext({ snapshot, targetId: symbolId });
  assert.ok(projection.recommendedSourceReads.some((read) => read.path === targetFile));
  assert.equal(
    projection.recommendedSourceReads.some((read) => read.path.includes("unrelated")),
    false,
  );
  assert.equal(
    projection.recommendedSourceReads.some((read) => read.path === "src/same-name-other.ts"),
    false,
  );

  snapshot.integrity.status = "stale";
  const stale = projectAgentContext({ snapshot, targetId: symbolId });
  const unknown = stale.unknowns.find((item) => item.code === "stale-model");
  assert.ok(unknown);
  assert.ok(unknown.recommendedSourceReads.some((read) => read.path === targetFile));
  assert.equal(
    unknown.recommendedSourceReads.some((read) => read.path.includes("unrelated")),
    false,
  );
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

test("Review caps affected Symbols through capItems and reports deterministic omission metadata", () => {
  const changeSet = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const symbolIds = logicalComponentFixture.derived.symbols.map((item) => createSymbolId(item.locator));
  const review = projectReview({
    changeSet: { ...changeSet, affectedEntities: symbolIds },
    snapshot: logicalComponentFixture,
    options: { maxSymbols: 1 },
  });

  assert.equal(review.impact.affectedSymbols.length, 1);
  assert.deepEqual(review.omissions.find((item) => item.field === "impact.affectedSymbols"), {
    field: "impact.affectedSymbols",
    reason: "affected Symbols exceeded their deterministic structural limit",
    count: symbolIds.length - 1,
    priority: "required",
  });
});

test("Agent target filtering excludes unrelated deltas and retains target paths before the cap", () => {
  const original = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const unrelated = "symbol:unrelated" as typeof symbolId;
  const template: SemanticDeltaRecord = original.semanticDeltas[0] ?? {
    id: "delta:template",
    subject: symbolId,
    kind: "responsibility",
    summary: "target semantic change",
    reviewLevel: "L2",
    compatibility: "review-required",
    sourceChangeIds: [],
    protected: false,
    breaking: false,
  };
  const changeSet = {
    ...original,
    semanticDeltas: [
      { ...template, id: "delta:target", subject: symbolId },
      { ...template, id: "delta:unrelated", subject: unrelated },
    ],
    derivedChanges: [
      {
        id: "change:unrelated",
        entityId: unrelated,
        entityKind: "symbol",
        path: "src/unrelated.ts",
        changeKind: "modified" as const,
        summary: "unrelated implementation change",
      },
    ],
    affectedEntities: [unrelated, symbolId],
    impactPaths: [
      { entityIds: [unrelated], stopReason: "unrelated", propagated: true },
      { entityIds: [symbolId], stopReason: "target", propagated: true },
    ],
    propagationStopPoints: [
      { entityId: unrelated, reason: "unrelated", path: [unrelated] },
      { entityId: symbolId, reason: "target", path: [symbolId] },
    ],
  };
  const projection = projectAgentContext({
    snapshot: pureFunctionFixture,
    targetId: symbolId,
    changeSet,
    options: { maxImpactPaths: 1 },
  });

  assert.deepEqual(
    projection.delta?.semanticDeltas.map((delta) => delta.id),
    ["delta:target"],
  );
  assert.equal(
    projection.delta?.implementationChanges.some((change) => change.entityId === unrelated),
    false,
  );
  assert.deepEqual(projection.impact?.affectedEntities, [symbolId]);
  assert.deepEqual(
    projection.impact?.paths.map((path) => path.stopReason),
    ["target"],
  );
  assert.deepEqual(
    projection.impact?.stopBoundaries.map((point) => point.reason),
    ["target"],
  );
});

test("Agent impact caps target-relevant collections with explicit omission metadata", () => {
  const original = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const path = original.impactPaths[0] ?? { entityIds: [symbolId], stopReason: "target", propagated: true };
  const stop = original.propagationStopPoints[0] ?? { entityId: symbolId, reason: "target", path: [symbolId] };
  const changeSet = {
    ...original,
    affectedEntities: [symbolId, symbolId, symbolId],
    impactPaths: [
      { ...path, entityIds: [symbolId], stopReason: "target-1" },
      { ...path, entityIds: [symbolId], stopReason: "target-2" },
    ],
    propagationStopPoints: [
      { ...stop, entityId: symbolId, reason: "target-1" },
      { ...stop, entityId: symbolId, reason: "target-2" },
    ],
  };
  const projection = projectAgentContext({
    snapshot: pureFunctionFixture,
    targetId: symbolId,
    changeSet,
    options: { maxSymbols: 1, maxImpactPaths: 1 },
  });

  assert.equal(projection.impact?.affectedEntities.length, 1);
  assert.equal(projection.impact?.paths.length, 1);
  assert.equal(projection.impact?.stopBoundaries.length, 1);
  assert.ok(projection.omissions.some((item) => item.field === "impact.affectedEntities"));
  assert.ok(projection.omissions.some((item) => item.field === "impact.paths"));
  assert.ok(projection.omissions.some((item) => item.field === "impact.stopBoundaries"));
});

test("Agent delta unknown regions are sorted before the structural cap", () => {
  const changeSet = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const unknowns = [
    {
      id: "unknown:z-last",
      code: "unresolved",
      message: "last",
      subjects: [symbolId],
      material: true as const,
      recommendedSourceReads: [],
    },
    {
      id: "unknown:a-first",
      code: "unresolved",
      message: "first",
      subjects: [symbolId],
      material: true as const,
      recommendedSourceReads: [],
    },
  ];
  const projection = projectAgentContext({
    snapshot: pureFunctionFixture,
    targetId: symbolId,
    changeSet: { ...changeSet, semanticDeltas: [], derivedChanges: [], unknownRegions: unknowns },
    options: { maxChanges: 1 },
  });

  assert.deepEqual(projection.delta?.unknowns.map((item) => item.id), ["unknown:a-first"]);
  assert.ok(projection.omissions.some((item) => item.field === "delta.unknowns"));
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
  const contradictoryParameters = original.definition.inputs.parameters.map((parameter, index) =>
    index === 0 ? { ...parameter, type: parameter.type === "string" ? "number" : "string" } : parameter,
  );
  contradictory.declarations.contracts.push({
    ...original,
    id: secondId,
    name: "Contradictory contract",
    definition: {
      ...original.definition,
      inputs: { ...original.definition.inputs, parameters: contradictoryParameters },
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
  assert.equal(projection.contradictions.filter((item) => item.field === "parameters").length, 1);
  assert.equal(projection.returns, undefined);
});

test("JSDoc serializes structured return guarantees deterministically", () => {
  const snapshot = structuredClone(pureFunctionFixture);
  snapshot.declarations.contracts[0]!.definition.outputs.returnValue = {
    z: 1,
    a: ["value", { b: 2, a: 1 }],
  };
  const projection = projectJsdoc({ snapshot, targetId: symbolId });
  assert.equal(projection.returns?.value, '{"a":["value",{"a":1,"b":2}],"z":1}');
  assert.equal(projection.returns?.value.includes("[object Object]"), false);
});

test("query fallback derives freshness and integrity from provider provenance", async () => {
  const query = createFixtureQuery();
  const targetId = "symbol:decide-read";
  const entity = await query.getEntity(targetId);
  assert.ok(entity);
  const staleQuery = new Proxy(query, {
    get(target, property, receiver) {
      if (property === "getEntity")
        return () => ({ ...entity, provenance: { ...entity.provenance, status: "partial" as const } });
      return Reflect.get(target, property, receiver);
    },
  });
  const projection = await createSemanticProjectionQuery(staleQuery).getAgentContext(targetId);
  assert.equal(projection.model.status, "stale");
  assert.equal(projection.model.integrity, "stale");
  assert.equal(projection.provenance.status, "stale");
  assert.match(projection.model.reason ?? "", /partial|stale/);
  assert.match(projection.provenance.note, /partial|stale/);

  const unavailableQuery = new Proxy(query, {
    get(target, property, receiver) {
      if (property === "getEntity")
        return () => ({ ...entity, provenance: { ...entity.provenance, status: "unavailable" as const } });
      return Reflect.get(target, property, receiver);
    },
  });
  const unavailable = await createSemanticProjectionQuery(unavailableQuery).getAgentContext(targetId);
  assert.equal(unavailable.model.status, "unavailable");
  assert.equal(unavailable.model.integrity, "invalid");
  assert.match(unavailable.model.reason ?? "", /unavailable/);
  assert.match(unavailable.provenance.note, /unavailable/);
});

test("minimum hard budget keeps every declared projection contract key and byte cap", () => {
  const options = { softTokens: 128, hardTokens: 256, hardBytes: 1_024 };
  const agent = projectAgentContext({ snapshot: pureFunctionFixture, targetId: componentId, options });
  const review = projectReview({
    changeSet: compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture),
    snapshot: logicalComponentFixture,
    options,
  });
  const jsdoc = projectJsdoc({ snapshot: pureFunctionFixture, targetId: symbolId, options });
  const projections = [agent, review, jsdoc] as const;
  for (const projection of projections) {
    const serialized = JSON.stringify(projection);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    assert.ok(serializedBytes <= options.hardBytes, `${projection.kind} exceeded hard byte budget`);
    assert.equal(projection.budget.projectedBytes, serializedBytes);
    assert.equal(projection.budget.projectedTokens, Math.ceil(serializedBytes / 4));
  }
  for (const key of [
    "apiVersion",
    "kind",
    "target",
    "model",
    "context",
    "facts",
    "relations",
    "unknowns",
    "recommendedSourceReads",
    "expansionTargets",
    "source",
    "provenance",
    "omissions",
    "budget",
  ])
    assert.ok(Object.hasOwn(agent, key), `agent missing ${key}`);
  for (const key of [
    "apiVersion",
    "kind",
    "model",
    "reviewReasons",
    "semanticDelta",
    "impact",
    "evidenceRefresh",
    "unknowns",
    "implementationChanges",
    "symbolChanges",
    "effectViolations",
    "recommendedSourceReads",
    "provenance",
    "omissions",
    "budget",
  ])
    assert.ok(Object.hasOwn(review, key), `review missing ${key}`);
  for (const key of [
    "apiVersion",
    "kind",
    "canonicalLanguage",
    "locale",
    "target",
    "model",
    "parameters",
    "constraints",
    "throws",
    "contradictions",
    "recommendedSourceReads",
    "source",
    "provenance",
    "omissions",
    "budget",
  ])
    assert.ok(Object.hasOwn(jsdoc, key), `jsdoc missing ${key}`);
  assert.ok(Object.hasOwn(agent.target, "provenance"));
  for (const key of [
    "symbols",
    "capabilities",
    "contracts",
    "invariants",
    "constraints",
    "effects",
    "dependencies",
    "callers",
    "callees",
    "evidence",
    "tests",
    "rationales",
    "reviewGuidance",
  ])
    assert.ok(Object.hasOwn(agent.context, key), `agent context missing ${key}`);
  assert.equal(agent.budget.truncated, true);
  assert.equal(agent.context.responsibility, undefined);
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

test("budgeting is pure and final serialized metadata fits the hard byte/token boundary", () => {
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "agent",
    target: { id: "symbol:target", kind: "symbol", name: "target", authoritative: true },
    model: { status: "fresh", integrity: "fresh", authoritative: true },
    source: { available: false, reason: "source bodies excluded" },
    provenance: { provider: "test", authority: "derived", status: "fresh", authoritative: true },
  };
  const groups: ProjectionFieldGroup[] = [
    {
      field: "unknowns",
      value: [{ id: "unknown:large", code: "incomplete", message: "unknown detail".repeat(200) }],
      priority: "required",
      emptyValue: [],
      omissionReason: "unknowns omitted",
    },
    {
      field: "recommendedSourceReads",
      value: [{ path: "src/target.ts", symbol: "target", startLine: 1, endLine: 3, reason: "exact read" }],
      priority: "required",
      emptyValue: [],
      omissionReason: "source reads omitted",
    },
    {
      field: "optional",
      value: "optional detail".repeat(500),
      priority: "verbose",
      emptyValue: undefined,
      omissionReason: "optional detail omitted",
    },
  ];
  const originalBase = structuredClone(base);
  const originalGroups = structuredClone(groups);
  const bounded = budgetStructuredProjection(base, groups, {
    softTokens: 256,
    hardTokens: 256,
    hardBytes: 1_024,
  });
  const serialized = JSON.stringify(bounded.value);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");

  assert.deepEqual(base, originalBase);
  assert.deepEqual(groups, originalGroups);
  assert.ok(serializedBytes <= bounded.budget.hardBytes);
  assert.ok(Math.ceil(serializedBytes / 4) <= bounded.budget.hardTokens);
  assert.equal(bounded.budget.projectedBytes, serializedBytes);
  assert.equal(bounded.budget.projectedTokens, Math.ceil(serializedBytes / 4));
});

test("required uncertainty and exact source reads survive compact fallback", () => {
  const read = { path: "src/target.ts", symbol: "target", startLine: 4, endLine: 8, reason: "exact read" };
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "agent",
    target: { id: "symbol:target", kind: "symbol", name: "target", authoritative: false },
    model: { status: "stale", integrity: "stale", authoritative: false, reason: "stale model" },
    source: { available: false, reason: "source bodies excluded" },
    provenance: { provider: "test", authority: "integrity", status: "stale", authoritative: false },
  };
  const groups: ProjectionFieldGroup[] = [
    {
      field: "unknowns",
      value: [
        { id: "unknown:target", code: "incomplete", message: "uncertainty".repeat(2_000), subjects: ["symbol:target"] },
      ],
      priority: "required",
      emptyValue: [],
      omissionReason: "unknowns omitted",
    },
    {
      field: "recommendedSourceReads",
      value: [read],
      priority: "required",
      emptyValue: [],
      omissionReason: "source reads omitted",
    },
  ];
  const bounded = budgetStructuredProjection(base, groups, {
    softTokens: 512,
    hardTokens: 1_024,
    hardBytes: 4_096,
  });
  const value = bounded.value as Record<string, unknown>;
  const reads = value.recommendedSourceReads as Array<Record<string, unknown>>;
  assert.deepEqual(reads[0], read);
  assert.equal((value.unknowns as Array<Record<string, unknown>>)[0]?.id, "unknown:target");
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= bounded.budget.hardBytes);
});

test("final semantic projection hard byte cap bounds malformed runtime provider values and keeps omission identity", () => {
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "malformed-kind".repeat(10_000),
    canonicalLanguage: "malformed-language".repeat(10_000),
    target: {
      id: "symbol:target".repeat(10_000),
      kind: "symbol",
      name: "target".repeat(10_000),
      authority: "derived",
      provenance: {
        kind: "inferred",
        producer: { name: "producer".repeat(10_000), version: "version".repeat(10_000) },
        sourceRevision: { repositoryId: "revision".repeat(10_000) },
      },
      authoritative: false,
    },
    model: { status: "malformed-status".repeat(10_000), integrity: "malformed-integrity".repeat(10_000) },
    source: { available: false, reason: "source reason".repeat(10_000) },
    provenance: {
      provider: "provider".repeat(10_000),
      authority: "derived",
      status: "malformed-status".repeat(10_000),
      authoritative: false,
      note: "provenance note".repeat(10_000),
    },
  };
  const bounded = budgetStructuredProjection(
    base,
    [
      {
        field: "unknowns",
        value: [{ id: "unknown:large", message: "unknown".repeat(100_000) }],
        priority: "required",
        emptyValue: [],
        omissionReason: "unknowns omitted",
      },
      {
        field: "recommendedSourceReads",
        value: [{ path: "src/target.ts", reason: "read".repeat(100_000) }],
        priority: "required",
        emptyValue: [],
        omissionReason: "source reads omitted",
      },
    ],
    { softTokens: 256, hardTokens: 256, hardBytes: 1_024 },
    [
      {
        field: "impact.affectedSymbols",
        reason: "affected Symbols exceeded their deterministic structural limit",
        priority: "required",
      },
    ],
  );
  const serialized = JSON.stringify(bounded.value);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");

  assert.ok(serializedBytes <= bounded.budget.hardBytes, `projection exceeded hard byte budget: ${serializedBytes}`);
  assert.equal(bounded.budget.projectedBytes, serializedBytes);
  const omission = (bounded.value.omissions as Array<Record<string, unknown>>)[0];
  assert.equal(typeof omission?.field, "string");
  assert.ok(String(omission?.field).length > 0);
  assert.equal(typeof omission?.reason, "string");
  assert.ok(String(omission?.reason).length > 0);
});

test("coding-agent flow starts with bounded semantic context, escalates only exact Symbols, then receives #54 review", () => {
  const context = projectAgentContext({
    snapshot: pureFunctionFixture,
    targetId: symbolId,
    options: { targetTask: "normalize input" },
  });
  assert.equal(context.source.available, false);
  assert.ok(
    context.recommendedSourceReads.every((read) => read.symbol === undefined || read.symbol === "normalizeInput"),
  );
  assert.ok(context.recommendedSourceReads.some((read) => read.symbol === "normalizeInput"));

  const changeSet = compareSemanticSnapshots(pureFunctionFixture, logicalComponentFixture);
  const review = projectReview({ changeSet, snapshot: logicalComponentFixture });
  assert.ok(review.semanticDelta.length >= 0);
  assert.deepEqual(review.impact.stopBoundaries, changeSet.propagationStopPoints);
  assert.ok(review.recommendedSourceReads.every((read) => read.path.length > 0));
});
