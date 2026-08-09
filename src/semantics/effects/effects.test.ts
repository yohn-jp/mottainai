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
  DEFAULT_EFFECT_PRIMITIVE_ADAPTER,
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
  assert.equal(extended.definitions.filter((definition) => definition.id === "filesystem.read").length, 1);
});

test("primitive taxonomy separates process clock and Git branch identities and handles database constructors", () => {
  const resolvePrimitive = (module: string, exportPath: string[], operation: "call" | "construct" | "read" | "write") =>
    DEFAULT_EFFECT_PRIMITIVE_ADAPTER.resolve({
      operation,
      identity: {
        kind: module.startsWith("node:") ? "builtin" : "external",
        module,
        exportPath,
        declarationName: exportPath.at(-1) ?? module,
      },
      location: { path: "fixture.ts" },
    });

  assert.deepEqual(resolvePrimitive("node:process", ["hrtime"], "call"), ["clock.read"]);
  assert.deepEqual(resolvePrimitive("node:process", ["uptime"], "call"), ["clock.read"]);
  assert.deepEqual(resolvePrimitive("simple-git", ["branch"], "call"), ["git.read"]);
  assert.deepEqual(resolvePrimitive("node:sqlite", ["DatabaseSync"], "construct"), ["database.write"]);
  assert.deepEqual(resolvePrimitive("better-sqlite3", ["Database"], "construct"), ["database.write"]);
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

test("database instance methods retain TypeChecker-resolved module identity", () => {
  const snapshot = extract();
  const analysis = analyze(snapshot);
  const database = analysis.symbols.find((result) => result.symbolId === symbol(snapshot, "databaseEffects").id);
  assert.ok(database);
  assert.ok(database.direct.some((item) => item.effect === "database.read"));
  assert.ok(database.direct.some((item) => item.effect === "database.write"));
  assert.ok(database.direct.every((item) => item.origin.identity.kind !== "project"));
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

test("policy specialization preserves parent constraints and replace is the only reset", () => {
  const snapshot = extract();
  const primitive = symbol(snapshot, "primitiveEffects");
  const componentId = createComponentId("effects");
  const projectPolicy = {
    id: createLogicalId("policy", "effects-project"),
    subject: snapshot.declarations.project.id,
    allow: [createEffectId("filesystem.read"), createEffectId("network.read")],
    deny: [createEffectId("git.write")],
    rationaleIds: [],
    purity: "readonly",
  };
  const componentPolicy = {
    id: createLogicalId("policy", "effects-component-specialized"),
    subject: componentId,
    allow: [createEffectId("filesystem.read"), createEffectId("filesystem.write")],
    deny: [createEffectId("database.write")],
    rationaleIds: [],
    purity: "pure",
  };
  const inheritedSymbolPolicy = {
    id: createLogicalId("policy", "effects-symbol-inherited"),
    subject: primitive.id,
    allow: [createEffectId("console.write")],
    deny: [createEffectId("filesystem.read")],
    rationaleIds: [],
    purity: "effectful",
    inheritance: "inherit",
  };
  const decorated = withPolicy(snapshot, [inheritedSymbolPolicy, componentPolicy, projectPolicy], [primitive.id]);
  const analysis = analyze(decorated);
  const conformance = analysis.conformance.find((result) => result.subjectId === primitive.id);
  assert.ok(conformance?.policy);
  assert.deepEqual(conformance.policy.allow, ["filesystem.read", "filesystem.write", "network.read"]);
  assert.deepEqual(conformance.policy.deny, ["database.write", "git.write"]);
  assert.equal(conformance.policy.purity, "pure");
  assert.deepEqual(
    [...conformance.policy.inheritedFrom].sort(),
    [snapshot.declarations.project.id, componentId].sort(),
  );

  const replaced = analyze(
    withPolicy(
      snapshot,
      [
        projectPolicy,
        componentPolicy,
        {
          ...inheritedSymbolPolicy,
          inheritance: "replace",
          allow: [],
          deny: [],
          purity: undefined,
        },
      ],
      [primitive.id],
    ),
  ).conformance.find((result) => result.subjectId === primitive.id);
  assert.ok(replaced?.policy);
  assert.deepEqual(replaced.policy.allow, []);
  assert.deepEqual(replaced.policy.deny, []);
  assert.equal(replaced.policy.purity, undefined);
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

test("explicitly narrowed TypeScript roots are partial and cannot produce a proven violation", () => {
  const snapshot = extract();
  const primitive = symbol(snapshot, "primitiveEffects");
  const policy = {
    id: createLogicalId("policy", "effects-partial-project"),
    subject: primitive.id,
    allow: [],
    deny: [createEffectId("filesystem.write")],
    rationaleIds: [],
  };
  const analysis = analyzeTypeScriptEffects({
    rootDir: fixtureRoot,
    tsconfigPath: resolve(fixtureRoot, "tsconfig.json"),
    snapshot: withPolicy(snapshot, [policy], [primitive.id]),
    rootNames: ["src/effects.ts"],
  });
  const result = analysis.conformance.find((item) => item.subjectId === primitive.id);
  assert.ok(result);
  assert.ok(analysis.unknowns.some((unknown) => unknown.code === "project-incomplete"));
  assert.notEqual(result.completeness, "complete");
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.violations, []);
});
