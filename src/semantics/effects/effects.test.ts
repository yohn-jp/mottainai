import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createComponentId, createEdgeId, createEffectId, createLogicalId } from "../ir/ids.js";
import type {
  ComponentEntity,
  EffectId,
  RepositorySemanticSnapshot,
  SemanticRelation,
  SymbolEntity,
} from "../ir/types.js";
import { extractTypeScriptFacts } from "../extractors/typescript/extractor.js";
import {
  analyzeTypeScriptEffects,
  computeEffectAnalysisDelta,
  createEffectTaxonomy,
  CORE_EFFECT_TAXONOMY,
  projectEffectsToQuery,
} from "./index.js";
import type { EffectAnalysis } from "./types.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/effects");

function extract(): RepositorySemanticSnapshot {
  return extractTypeScriptFacts({
    rootDir: fixtureRoot,
    tsconfigPath: resolve(fixtureRoot, "tsconfig.json"),
    repositoryName: "effects-fixture",
    packageName: "semantic-effects-fixture",
    revision: "fixture-revision",
  }).snapshot;
}

function symbol(snapshot: RepositorySemanticSnapshot, name: string): SymbolEntity {
  const result = snapshot.derived.symbols.find((item) => item.name === name && item.locator.file === "src/effects.ts");
  assert.ok(result, `missing Symbol ${name}`);
  return result;
}

function analyze(snapshot = extract()): EffectAnalysis {
  return analyzeTypeScriptEffects({
    rootDir: fixtureRoot,
    tsconfigPath: resolve(fixtureRoot, "tsconfig.json"),
    snapshot,
  });
}

function effects(result: {
  direct: readonly { effect: EffectId }[];
  transitive: readonly { effect: EffectId }[];
}): Set<EffectId> {
  return new Set([...result.direct, ...result.transitive].map((item) => item.effect));
}

function withPolicy(
  snapshot: RepositorySemanticSnapshot,
  policies: readonly Record<string, unknown>[],
  ownedSymbolIds: readonly string[],
): RepositorySemanticSnapshot {
  const componentId = createComponentId("effects");
  const component: ComponentEntity = {
    id: componentId,
    name: "Effects",
    kind: "component",
    responsibility: "Effect fixture component",
    stability: "stable",
    reviewLevel: "L2",
    authority: "declared",
    provenance: snapshot.declarations.project.provenance,
  };
  const ownership: SemanticRelation[] = ownedSymbolIds.map((to, index) => ({
    id: createEdgeId(`effects-owns-${index}`),
    kind: "owns",
    from: componentId,
    to: to as SemanticRelation["to"],
    authority: "declared",
    provenance: snapshot.declarations.project.provenance,
  }));
  return {
    ...snapshot,
    declarations: {
      ...snapshot.declarations,
      components: [component],
      effectPolicies: policies as unknown as RepositorySemanticSnapshot["declarations"]["effectPolicies"],
    },
    graph: { relations: [...snapshot.graph.relations, ...ownership] },
  };
}

test("taxonomy is namespaced and extensible without replacing the #84 vocabulary", () => {
  assert.equal(CORE_EFFECT_TAXONOMY.isKnown(createEffectId("filesystem.read")), true);
  const extended = createEffectTaxonomy([
    {
      id: createEffectId("custom.queue.publish"),
      domain: "queue",
      operation: "write",
      description: "Publish a queue message.",
    },
  ]);
  assert.equal(extended.isKnown(createEffectId("custom.queue.publish")), true);
  assert.ok(extended.definitions.some((definition) => definition.id === "filesystem.read"));
});

test("direct primitive rules use resolved Node/external identity and cover the initial domains", () => {
  const snapshot = extract();
  const analysis = analyze(snapshot);
  const primitive = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "primitiveEffects").id);
  assert.ok(primitive);
  assert.deepEqual([...effects(primitive)].sort(), [
    "clock.read",
    "console.write",
    "database.read",
    "database.write",
    "environment.read",
    "environment.write",
    "filesystem.read",
    "filesystem.write",
    "git.read",
    "git.write",
    "network.read",
    "network.write",
    "process.spawn",
    "process.state",
    "randomness.read",
  ]);
  assert.equal(primitive.directCompleteness, "complete");
});

test("same-name project APIs are not classified from text and direct/transitive effects stay distinct", () => {
  const snapshot = extract();
  const analysis = analyze(snapshot);
  const local = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "sameNameLocalApi").id);
  assert.ok(local);
  assert.equal(local.direct.length, 0);
  assert.equal(local.transitive.length, 0);
  assert.equal(local.unknowns.length, 0);

  const helper = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "readThroughHelper").id);
  const entry = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "transitiveEntry").id);
  assert.ok(helper);
  assert.ok(entry);
  assert.deepEqual([...new Set(helper.direct.map((item) => item.effect))], ["filesystem.read"]);
  assert.equal(entry.direct.length, 0);
  assert.deepEqual([...new Set(entry.transitive.map((item) => item.effect))], ["filesystem.read"]);
  const propagated = entry.transitive.find((item) => item.effect === "filesystem.read");
  assert.ok(propagated);
  assert.ok(propagated.path.some((item) => item === helper.symbolId));
  assert.ok(propagated.path.some((item) => item.includes("node:fs.readFileSync")));

  const localRequire = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "sameNameRequire").id);
  assert.ok(localRequire);
  assert.equal(
    localRequire.direct.some((item) => item.effect === "filesystem.read"),
    false,
  );
  assert.equal(
    localRequire.transitive.some((item) => item.effect === "filesystem.read"),
    false,
  );
});

test("relative imports retain project identity even when the local export has an effectful name", () => {
  const snapshot = extract();
  const analysis = analyze(snapshot);
  const localAlias = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "localAlias").id);
  assert.ok(localAlias);
  assert.equal(localAlias.direct.length, 0);
  assert.equal(localAlias.transitive.length, 0);
  assert.equal(localAlias.transitiveCompleteness, "complete");
  assert.equal(localAlias.unknowns.length, 0);
});

test("recursive call graphs terminate deterministically and retain an SCC evidence path", () => {
  const first = analyze();
  const second = analyze();
  const firstResult = first.symbols.find((result) => result.symbolId.includes("#recursiveA~"));
  const secondResult = second.symbols.find((result) => result.symbolId.includes("#recursiveA~"));
  assert.ok(firstResult);
  assert.ok(secondResult);
  assert.deepEqual([...new Set(firstResult.transitive.map((item) => item.effect))], ["filesystem.read"]);
  assert.deepEqual(firstResult.transitive, secondResult.transitive);
});

test("dynamic and opaque calls reduce completeness without inventing concrete effects", () => {
  const snapshot = extract();
  const analysis = analyze(snapshot);
  const dynamic = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "dynamicCall").id);
  const imported = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "dynamicImport").id);
  const opaque = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "opaqueExternal").id);
  assert.ok(dynamic);
  assert.ok(imported);
  assert.ok(opaque);
  assert.equal(dynamic.transitiveCompleteness, "partial");
  assert.equal(imported.transitiveCompleteness, "partial");
  assert.equal(opaque.transitiveCompleteness, "partial");
  assert.equal(dynamic.transitive.length, 0);
  assert.equal(imported.transitive.length, 0);
  assert.equal(opaque.transitive.length, 0);
  assert.ok(analysis.unknowns.some((unknown) => unknown.code === "dynamic-call"));
  assert.ok(analysis.unknowns.some((unknown) => unknown.code === "dynamic-import"));
  assert.ok(analysis.unknowns.some((unknown) => unknown.code === "opaque-external-call"));
});

test("component aggregation and inherited/specialized policies preserve proven violations", () => {
  const snapshot = extract();
  const primitive = symbol(snapshot, "primitiveEffects");
  const componentId = createComponentId("effects");
  const componentPolicy = {
    id: createLogicalId("policy", "effects-component"),
    subject: componentId,
    allow: [],
    deny: [createEffectId("filesystem.write")],
    rationaleIds: [],
  };
  const symbolPolicy = {
    id: createLogicalId("policy", "effects-symbol"),
    subject: primitive.id,
    allow: [],
    deny: [],
    rationaleIds: [],
    inheritance: "inherit",
  };
  const decorated = withPolicy(snapshot, [componentPolicy, symbolPolicy], [primitive.id]);
  const analysis = analyze(decorated);
  const component = analysis.components.find((result) => result.componentId === componentId);
  const conformance = analysis.conformance.find((result) => result.subjectId === primitive.id);
  assert.ok(component);
  assert.ok(conformance);
  assert.ok(component.transitive.some((item) => item.effect === "filesystem.write"));
  assert.equal(conformance.status, "violation");
  assert.ok(
    conformance.violations.some(
      (violation) => violation.code === "forbidden-effect" && violation.effect === "filesystem.write",
    ),
  );
  assert.ok(conformance.policy?.inheritedFrom.includes(componentId));
  assert.deepEqual(conformance.policy?.policyIds, [componentPolicy.id, symbolPolicy.id]);

  const purePolicy = {
    id: createLogicalId("policy", "effects-pure"),
    subject: primitive.id,
    allow: [],
    deny: [],
    rationaleIds: [],
    purity: "pure",
    inheritance: "replace",
  };
  const pureAnalysis = analyze(withPolicy(snapshot, [purePolicy], [primitive.id]));
  const pureConformance = pureAnalysis.conformance.find((result) => result.subjectId === primitive.id);
  assert.ok(pureConformance);
  assert.equal(pureConformance.status, "violation");
  assert.ok(pureConformance.violations.some((violation) => violation.code === "declared-pure-violation"));
});

test("incomplete analysis is unknown, never a proven policy violation, and is consumable by #53/#54 surfaces", () => {
  const snapshot = extract();
  const dynamic = symbol(snapshot, "dynamicCall");
  const policy = {
    id: createLogicalId("policy", "dynamic-pure"),
    subject: dynamic.id,
    allow: [],
    deny: [],
    rationaleIds: [],
    purity: "pure",
    inheritance: "replace",
  };
  const analysis = analyze(withPolicy(snapshot, [policy], [dynamic.id]));
  const result = analysis.conformance.find((item) => item.subjectId === dynamic.id);
  assert.ok(result);
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.violations, []);

  const projection = projectEffectsToQuery(analysis);
  assert.ok(projection.factsFor(dynamic.id).some((fact) => fact.name === "effect.conformance"));
  assert.ok(projection.factsFor(dynamic.id).some((fact) => fact.name === "effect.unknowns"));

  const primitive = symbol(snapshot, "primitiveEffects");
  const componentId = createComponentId("effects");
  const deltaPolicy = {
    id: createLogicalId("policy", "delta-forbidden-write"),
    subject: componentId,
    allow: [],
    deny: [createEffectId("filesystem.write")],
    rationaleIds: [],
  };
  const policyAnalysis = analyze(withPolicy(snapshot, [deltaPolicy], [primitive.id]));
  const delta = computeEffectAnalysisDelta(analyze(snapshot), policyAnalysis);
  assert.ok(delta.changes.some((change) => change.subjectId === primitive.id && change.conformanceChanged === true));
  assert.ok(delta.violations.some((violation) => violation.effect === "filesystem.write"));
});
