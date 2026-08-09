import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { computeIntegrityDigestsFromValidated } from "../ir/canonical.js";
import { createEdgeId, createNodeId } from "../ir/ids.js";
import { validateSnapshot } from "../ir/schema.js";
import type { RepositorySemanticSnapshot, SemanticRelation } from "../ir/types.js";
import { extractTypeScriptFacts } from "../extractors/typescript/index.js";
import { compileRepositoryModel } from "./compiler.js";

const fixtureRoot = join(process.cwd(), "src/semantics/fixtures/typescript");

function explicitFixtureSnapshot(): RepositorySemanticSnapshot {
  const extracted = extractTypeScriptFacts({ rootDir: fixtureRoot }).snapshot;
  const snapshot = structuredClone(extracted);
  const dependency = snapshot.graph.relations.find(
    (relation) =>
      (relation.kind === "uses_package" || relation.kind === "imports_api") &&
      snapshot.derived.symbols.some((symbol) => symbol.id === relation.from),
  );
  const selectedSymbol =
    snapshot.derived.symbols.find((symbol) => symbol.id === dependency?.from) ?? snapshot.derived.symbols[0];
  if (selectedSymbol !== undefined) selectedSymbol.classification = "managed";
  const symbolId = selectedSymbol?.id;
  assert.ok(symbolId, "fixture must contain at least one Symbol");
  const componentId = createNodeId("component", "explicit-fixture");
  const evidenceId = createNodeId("evidence", "fixture-test");
  const componentProvenance = { ...snapshot.declarations.project.provenance, kind: "declared" as const };
  const observedProvenance = { ...snapshot.declarations.project.provenance, kind: "observed" as const };
  snapshot.declarations.components.push({
    id: componentId,
    name: "Explicit Fixture Component",
    description: "A test-only explicitly declared ownership boundary",
    authority: "declared",
    provenance: componentProvenance,
    kind: "component",
    responsibility: "Own the selected fixture Symbol explicitly",
    stability: "stable",
    reviewLevel: "L1",
  });
  snapshot.observed.evidences.push({
    id: evidenceId,
    name: "fixture test evidence",
    authority: "observed",
    provenance: observedProvenance,
    kind: "evidence",
    evidenceKind: "test",
    reference: "query.test.ts",
    summary: "Evidence attached to the selected live-derived Symbol",
  });
  const owns: SemanticRelation = {
    id: createEdgeId("explicit-fixture-owns"),
    kind: "owns",
    from: componentId,
    to: symbolId,
    authority: "declared",
    provenance: componentProvenance,
  };
  const evidenceFor: SemanticRelation = {
    id: createEdgeId("fixture-evidence-for"),
    kind: "evidence_for",
    from: evidenceId,
    to: symbolId,
    authority: "observed",
    provenance: observedProvenance,
  };
  snapshot.graph.relations.push(owns, evidenceFor);
  snapshot.integrity = { ...snapshot.integrity, status: "stale", statusReason: "test fixture was extended explicitly" };
  const validated = validateSnapshot(snapshot);
  assert.equal(validated.ok, true, JSON.stringify(validated));
  if (!validated.ok) throw new Error("fixture snapshot validation failed");
  const digestInput: RepositorySemanticSnapshot = {
    ...validated.snapshot,
    integrity: {
      ...validated.snapshot.integrity,
      status: "fresh",
      statusReason: undefined,
    },
  };
  return {
    ...digestInput,
    integrity: { ...digestInput.integrity, ...computeIntegrityDigestsFromValidated(digestInput) },
  };
}

test("live model preserves explicit ownership and joins Symbol dependencies/evidence without source bodies", () => {
  const snapshot = explicitFixtureSnapshot();
  const result = compileRepositoryModel({ snapshot });
  assert.equal(result.integrityStatus, "fresh", JSON.stringify(result.diagnostics));
  const component = result.query.listComponents()[0];
  assert.ok(component);
  assert.equal(component.ownedSymbolIds.length, 1);
  const symbolId = component.ownedSymbolIds[0]!;
  const symbol = result.query.getEntity(symbolId);
  assert.ok(symbol);
  assert.equal(symbol.componentId, component.id);
  assert.ok(symbol.relations.some((relation) => relation.kind === "evidence-for"));
  assert.deepEqual(component.evidenceIds, ["evidence:fixture-test"]);
  assert.ok(result.query.getDependencies({ componentId: component.id }).items.length >= 1);
  assert.ok(result.query.getProject().counts.symbol >= 1);
  assert.ok(result.query.getBenchmark().compileMs >= 0);
  assert.ok(
    symbol.facts.every(
      (fact) =>
        !/(?:body|source[_-]?text|raw[_-]?source)/i.test(fact.name) &&
        !JSON.stringify(fact.value).includes("source body"),
    ),
  );
  const implementsRelation = snapshot.graph.relations.find((relation) => relation.kind === "implements");
  assert.ok(implementsRelation);
  assert.ok(result.query.getEntity(implementsRelation.from)?.relations.some((relation) => relation.kind === "implements"));
});

test("missing declarations remain model gaps and do not create Components", () => {
  const snapshot = extractTypeScriptFacts({ rootDir: fixtureRoot }).snapshot;
  const result = compileRepositoryModel({ snapshot });
  assert.deepEqual(result.query.listComponents(), []);
  assert.ok(result.query.getProject().health.modelGaps > 0);
  const symbolId = snapshot.derived.symbols[0]!.id;
  const symbol = result.query.getEntity(symbolId);
  assert.ok(symbol);
  assert.equal(symbol.componentId, undefined);
  assert.ok(symbol.tags.includes("model-gap"));
  assert.ok(symbol.facts.some((fact) => fact.name === "model-gap"));
});

test("stale and invalid integrity states stay explicit in bounded query results", () => {
  const snapshot = explicitFixtureSnapshot();
  snapshot.integrity.status = "stale";
  snapshot.integrity.statusReason = "source changed after compilation";
  const stale = compileRepositoryModel({ snapshot });
  assert.equal(stale.integrityStatus, "stale");
  assert.equal(stale.query.getProject().health.status, "stale");
  assert.match(stale.query.getProject().provenance.note, /integrity=stale/);

  snapshot.integrity.status = "invalid";
  snapshot.integrity.statusReason = "digest cannot be verified";
  const invalid = compileRepositoryModel({ snapshot });
  assert.equal(invalid.integrityStatus, "invalid");
  assert.equal(invalid.query.getProject().provenance.status, "unavailable");
  assert.match(invalid.query.getProject().provenance.note, /integrity=invalid/);
});

test("a fresh snapshot with a changed digest fails closed before live serving", () => {
  const snapshot = explicitFixtureSnapshot();
  snapshot.declarations.project.description = "changed after the recorded integrity digest";
  const result = compileRepositoryModel({ snapshot });
  assert.equal(result.integrityStatus, "invalid");
  assert.equal(result.snapshot, undefined);
  assert.equal(result.query.getProject().project.id, "project:unavailable");
  assert.equal(result.query.getProject().health.status, "unknown");
  assert.match(result.query.getProject().provenance.note, /integrity=invalid/);
});

test("graph traversal honors direction, depth, node and edge budgets deterministically", () => {
  const result = compileRepositoryModel({ snapshot: explicitFixtureSnapshot() });
  const projectId = result.query.getProject().project.id;
  const first = result.query.getGraph({
    entityId: projectId,
    direction: "outgoing",
    depth: 1,
    nodeLimit: 3,
    edgeLimit: 1,
  });
  const second = result.query.getGraph({
    entityId: projectId,
    direction: "outgoing",
    depth: 1,
    nodeLimit: 3,
    edgeLimit: 1,
  });
  assert.ok(first.nodes.length <= 3);
  assert.ok(first.relations.length <= 1);
  assert.deepEqual(first, second);
});

test("component dependencies aggregate internal Symbol relations only across explicit owners", () => {
  const snapshot = explicitFixtureSnapshot();
  const firstComponent = snapshot.declarations.components[0]!;
  const firstOwnedId = snapshot.graph.relations.find(
    (relation) => relation.kind === "owns" && relation.from === firstComponent.id,
  )!.to;
  const firstSymbol = snapshot.derived.symbols.find((symbol) => symbol.id === firstOwnedId)!;
  const secondSymbol = snapshot.derived.symbols.find((symbol) => symbol.id !== firstSymbol.id)!;
  const secondComponentId = createNodeId("component", "second-explicit-fixture");
  const provenance = { ...firstComponent.provenance, kind: "declared" as const };
  snapshot.declarations.components.push({
    id: secondComponentId,
    name: "Second Explicit Fixture Component",
    description: "A second explicitly declared ownership boundary",
    authority: "declared",
    provenance,
    kind: "component",
    responsibility: "Own another fixture Symbol explicitly",
    stability: "stable",
    reviewLevel: "L1",
  });
  secondSymbol.classification = "managed";
  snapshot.graph.relations.push(
    {
      id: createEdgeId("second-explicit-fixture-owns"),
      kind: "owns",
      from: secondComponentId,
      to: secondSymbol.id,
      authority: "declared",
      provenance,
    },
    {
      id: createEdgeId("second-explicit-fixture-calls"),
      kind: "calls",
      from: firstSymbol.id,
      to: secondSymbol.id,
      authority: "derived",
      provenance: firstSymbol.provenance,
    },
  );
  snapshot.integrity = { ...snapshot.integrity, status: "stale", statusReason: "test fixture was extended explicitly" };

  const result = compileRepositoryModel({ snapshot });
  const dependencies = result.query.getDependencies({ componentId: firstComponent.id });
  assert.ok(
    dependencies.items.some(
      (item) => item.relation.kind === "depends-on" && item.to.id === secondComponentId,
    ),
  );
});
