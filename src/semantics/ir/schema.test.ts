import assert from "node:assert/strict";
import test from "node:test";
import {
  allSemanticFixtures,
  ambiguousDynamicCallFixture,
  inferredClaimFixture,
  logicalComponentFixture,
  pureFunctionFixture,
} from "../fixtures/snapshots.js";
import { validateSnapshot } from "./schema.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRejected(input: unknown, code: string): void {
  const result = validateSnapshot(input);
  if (result.ok) assert.fail(`expected rejection: ${code}`);
  assert.ok(result.diagnostics.some((item) => item.code === code || item.path?.includes(code)));
}

test("schema v1 fixtures validate without a storage backend", () => {
  for (const [name, fixture] of Object.entries(allSemanticFixtures)) {
    const result = validateSnapshot(fixture);
    assert.equal(result.ok, true, name);
  }
});

test("contract separates parameters from domain, preconditions, resources and effects", () => {
  const pureSymbol = pureFunctionFixture.nodes.find((node) => node.kind === "symbol");
  assert.ok(pureSymbol?.contract);
  assert.equal(pureSymbol.contract.inputs.parameters[0]?.name, "value");
  assert.equal(pureSymbol.contract.inputs.preconditions[0]?.expression, "value is finite-length text");
  assert.deepEqual(pureSymbol.contract.outputs.effects, []);

  const effectfulSymbol = allSemanticFixtures.effectfulFunction.nodes.find((node) => node.kind === "symbol");
  assert.deepEqual(effectfulSymbol?.contract?.outputs.effects, ["filesystem.read", "environment.read"]);
  assert.equal(effectfulSymbol?.contract?.inputs.externalResources[0]?.access, "read");
});

test("future relationship kinds remain representable", () => {
  const future = clone(logicalComponentFixture);
  future.edges.push({
    id: "edge:future-binding" as typeof future.edges[number]["id"],
    kind: "future:binds_runtime",
    from: future.nodes[1]!.identity.logicalId,
    to: future.nodes[0]!.identity.logicalId,
    provenance: future.nodes[0]!.provenance,
  });
  const result = validateSnapshot(future);
  assert.equal(result.ok, true);
});

test("inferred and ambiguous analysis are explicit", () => {
  const edge = ambiguousDynamicCallFixture.edges[0];
  assert.equal(edge?.provenance.kind, "inferred");
  assert.equal(edge?.provenance.ambiguity?.status, "ambiguous");
  assert.equal(ambiguousDynamicCallFixture.analysis.completeness, "partial");
  assert.equal(inferredClaimFixture.claims[0]?.provenance.kind, "inferred");
  assert.equal(inferredClaimFixture.claims[0]?.provenance.confidence, 0.35);
});

test("invalid fixtures return structured diagnostics", () => {
  const missingProvenance = clone(pureFunctionFixture) as unknown as Record<string, unknown>;
  const facts = missingProvenance.facts as Array<Record<string, unknown>>;
  delete facts[0]!.provenance;
  assertRejected(missingProvenance, "schema_validation_failed");

  const malformedId = clone(pureFunctionFixture);
  malformedId.nodes[1]!.identity.logicalId = "not-an-id" as typeof malformedId.nodes[1]["identity"]["logicalId"];
  assertRejected(malformedId, "schema_validation_failed");

  const danglingReference = clone(logicalComponentFixture);
  danglingReference.edges[0]!.to = "component:missing" as typeof danglingReference.edges[0]["to"];
  assertRejected(danglingReference, "dangling_reference");

  const invalidConfidence = clone(ambiguousDynamicCallFixture) as unknown as Record<string, unknown>;
  const edges = invalidConfidence.edges as Array<Record<string, unknown>>;
  const edgeProvenance = edges[0]!.provenance as Record<string, unknown>;
  edgeProvenance.confidence = 1.1;
  assertRejected(invalidConfidence, "schema_validation_failed");

  const unsupportedVersion = { ...pureFunctionFixture, schemaVersion: 2 };
  assertRejected(unsupportedVersion, "unsupported_schema_version");
});
