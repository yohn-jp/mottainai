import assert from "node:assert/strict";
import test from "node:test";
import {
  allSemanticFixtures,
  callsAndPackageFixture,
  effectfulFunctionFixture,
  inferredClaimFixture,
  logicalComponentFixture,
  sharedOwnershipFixture,
  pureFunctionFixture,
} from "../fixtures/snapshots.js";
import { createComponentId, createEdgeId, createSymbolId } from "./ids.js";
import { validateSemanticTransaction, validateSnapshot } from "./schema.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRejected(input: unknown, code: string): void {
  const result = validateSnapshot(input);
  if (result.ok) assert.fail(`expected rejection: ${code}`);
  assert.ok(
    result.diagnostics.some((item) => item.code === code || item.path?.includes(code)),
    JSON.stringify(result.diagnostics),
  );
}

test("symbol-first v1 separates declared, derived, observed, analysis and integrity state", () => {
  const result = validateSnapshot(pureFunctionFixture);
  assert.equal(result.ok, true);
  assert.deepEqual(
    Object.keys(pureFunctionFixture).sort(),
    [
      "analysis",
      "declarations",
      "derived",
      "graph",
      "integrity",
      "modelVersion",
      "repositoryIdentity",
      "revisionIdentity",
      "schemaVersion",
      "observed",
    ].sort(),
  );
  assert.equal(pureFunctionFixture.declarations.commentPolicy.canonicalForm, "formal-english");
  assert.equal(pureFunctionFixture.derived.symbols[0]?.classification, "managed");
  assert.equal(pureFunctionFixture.observed.evidences[0]?.kind, "evidence");
  assert.equal(pureFunctionFixture.analysis.semanticDelta.version, 1);
  assert.equal(pureFunctionFixture.integrity.status, "fresh");
});

test("all canonical entities and universal graph edges validate", () => {
  for (const [name, fixture] of Object.entries(allSemanticFixtures)) {
    const result = validateSnapshot(fixture);
    assert.equal(result.ok, true, `${name}: ${result.ok ? "" : JSON.stringify(result.diagnostics)}`);
  }
  assert.ok(callsAndPackageFixture.graph.relations.some((relation) => relation.kind === "calls"));
  assert.ok(callsAndPackageFixture.graph.relations.some((relation) => relation.kind === "uses_package"));
  assert.ok(callsAndPackageFixture.graph.relations.some((relation) => relation.kind === "imports_api"));
  assert.ok(callsAndPackageFixture.graph.relations.some((relation) => relation.kind === "evidence_for"));
});

test("managed Symbol has exactly one Component owner and Shared is explicit", () => {
  assert.equal(validateSnapshot(logicalComponentFixture).ok, true);
  assert.equal(validateSnapshot(sharedOwnershipFixture).ok, true);

  const invalid = clone(logicalComponentFixture);
  const managedSymbol = invalid.derived.symbols[0]!;
  invalid.declarations.components.push({
    ...invalid.declarations.components[0]!,
    id: createComponentId("second-owner"),
    name: "Second Owner",
  });
  invalid.graph.relations.push({
    ...invalid.graph.relations.find((relation) => relation.kind === "owns" && relation.to === managedSymbol.id)!,
    id: createEdgeId("second-owner"),
    from: createComponentId("second-owner"),
  });
  assertRejected(invalid, "invalid_symbol_ownership");
});

test("contract, evidence and observed test remain graph-linked", () => {
  const evidenceForContract = pureFunctionFixture.graph.relations.find((relation) => relation.kind === "evidence_for");
  assert.equal(evidenceForContract?.from, pureFunctionFixture.observed.evidences[0]?.id);
  assert.equal(evidenceForContract?.to, pureFunctionFixture.declarations.contracts[0]?.id);
  assert.equal(pureFunctionFixture.observed.tests[0]?.evidenceIds[0], pureFunctionFixture.observed.evidences[0]?.id);
  assert.equal(effectfulFunctionFixture.declarations.contracts[0]?.definition.outputs.effects.length, 0);
});

test("integrity represents fresh, stale and invalid without mtime authority", () => {
  for (const status of ["fresh", "stale", "invalid"] as const) {
    const fixture = clone(pureFunctionFixture);
    fixture.integrity.status = status;
    if (status !== "fresh") fixture.integrity.statusReason = `${status} fixture state`;
    assert.equal(validateSnapshot(fixture).ok, true, status);
  }

  const withMtime = clone(pureFunctionFixture) as unknown as { integrity: Record<string, unknown> };
  withMtime.integrity.mtime = 123;
  assertRejected(withMtime, "schema_validation_failed");
});

test("inferred claims have no default enforcement authority", () => {
  assert.equal(validateSnapshot(inferredClaimFixture).ok, true);
  const invalid = clone(inferredClaimFixture);
  invalid.analysis.claims[0]!.enforcement = "authoritative";
  assertRejected(invalid, "inferred_claim_not_authoritative");
});

test("prior #48 schema is explicitly rejected and never coerced", () => {
  const prior = { ...pureFunctionFixture, schemaVersion: 1 };
  assertRejected(prior, "unsupported_schema_version");

  const missingModel = clone(pureFunctionFixture) as unknown as Record<string, unknown>;
  delete missingModel.modelVersion;
  assertRejected(missingModel, "schema_validation_failed");
});

test("semantic transaction vocabulary is versioned and serializable", () => {
  const transaction = {
    version: 1 as const,
    intent: "semantic-neutral" as const,
    delta: {
      version: 1 as const,
      intent: "semantic-neutral" as const,
      entries: [
        {
          id: "delta:unexpected" as (typeof pureFunctionFixture.analysis.semanticDelta.entries)[number]["id"],
          subject: createSymbolId(pureFunctionFixture.derived.symbols[0]!.locator),
          kind: "contract" as const,
          summary: "A neutral transaction produced a contract delta.",
          reviewLevel: "L2" as const,
        },
      ],
      unauthorized: true,
    },
    provenance: pureFunctionFixture.derived.symbols[0]!.provenance,
  };
  assert.equal(validateSemanticTransaction(transaction).ok, true);

  const incompatible = { ...transaction, version: 2 };
  const result = validateSemanticTransaction(incompatible);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "unsupported_semantic_vocabulary_version");
});
