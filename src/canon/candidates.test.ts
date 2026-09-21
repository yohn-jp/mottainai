import assert from "node:assert/strict";
import test from "node:test";
import { pureFunctionFixture } from "../semantics/fixtures/snapshots.js";
import { createEdgeId } from "../semantics/ir/ids.js";
import type { RepositorySemanticSnapshot, SymbolEntity } from "../semantics/ir/types.js";
import { selectCanonC3Candidates, type CanonC3SelectorInput } from "./candidates.js";
import type { CanonContentEntry } from "./identity.js";

const provenance = pureFunctionFixture.graph.relations[0]!.provenance;
const baseSymbol = pureFunctionFixture.derived.symbols[0]!;
const baseTest = pureFunctionFixture.observed.tests[0]!;

function c2(value: CanonContentEntry["value"]): CanonContentEntry {
  return {
    contentId: "c2.scope",
    value,
    provenance: { source: "test", reference: "c2.scope", supplied: false },
  };
}

function targetSnapshot(): RepositorySemanticSnapshot {
  const snapshot = structuredClone(pureFunctionFixture);
  snapshot.derived.files = [
    {
      ...snapshot.derived.files[0]!,
      id: "file:src-target" as RepositorySemanticSnapshot["derived"]["files"][number]["id"],
      name: "src/target.ts",
      path: "src/target.ts",
    },
  ];
  snapshot.derived.symbols[0]!.locator.file = "src/target.ts";
  const interfaceSymbol: SymbolEntity = {
    ...structuredClone(baseSymbol),
    id: "symbol:target-interface" as SymbolEntity["id"],
    name: "TargetPort",
    locator: { ...baseSymbol.locator, file: "src/target.ts", symbol: "TargetPort", signature: undefined },
  };
  snapshot.derived.symbols.push(interfaceSymbol);
  snapshot.integrity.trackedFiles = [
    {
      path: "src/target.ts",
      physicalFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
      semanticFingerprint: { algorithm: "sha256", value: "b".repeat(64) },
    },
  ];
  snapshot.graph.relations.push(
    {
      id: createEdgeId("tests-target"),
      kind: "tests",
      from: baseTest.id,
      to: baseSymbol.id,
      authority: "observed",
      provenance,
    },
    {
      id: createEdgeId("implements-target"),
      kind: "implements",
      from: baseSymbol.id,
      to: interfaceSymbol.id,
      authority: "derived",
      provenance,
    },
  );
  return snapshot;
}

function directSelectors(...selectors: CanonC3SelectorInput[]) {
  return selectCanonC3Candidates({ selectors, semantic: targetSnapshot() });
}

test("explicit path, symbol, and component selectors produce bounded candidates and semantic associations", () => {
  const snapshot = targetSnapshot();
  const result = selectCanonC3Candidates({
    c2: [
      c2({
        fields: {
          scope: {
            paths: ["src/target.ts"],
            symbols: [{ type: "symbol", value: { symbol: "normalizeInput", file: "src/target.ts" } }],
            components: ["component:semantic-core"],
          },
        },
      }),
    ],
    semantic: snapshot,
  });

  assert.equal(result.completeness, "complete");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.selector.type),
    ["component", "path", "interface", "symbol", "test"],
  );
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.every((candidate) => candidate.source.identity.startsWith("repo:")));
  assert.ok(result.candidates.every((candidate) => candidate.semanticProvenance.source === "repository-semantics"));
});

test("equal C2 and semantic state replay the same ordered candidates", () => {
  const selectors: CanonC3SelectorInput[] = [
    { type: "component", value: "component:semantic-core" },
    { type: "symbol", value: "normalizeInput" },
    { type: "path", value: "./src/target.ts" },
  ];
  const first = directSelectors(...selectors);
  const second = directSelectors(...[...selectors].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.candidates.map((candidate) => candidate.candidateId),
    [...first.candidates.map((candidate) => candidate.candidateId)].sort((left, right) => left.localeCompare(right)),
  );
});

test("relevant source or relation changes invalidate only the affected selection", () => {
  const base = targetSnapshot();
  const selected = selectCanonC3Candidates({ selectors: [{ type: "path", value: "src/target.ts" }], semantic: base });
  const sourceChanged = structuredClone(base);
  sourceChanged.integrity.trackedFiles[0]!.semanticFingerprint = { algorithm: "sha256", value: "c".repeat(64) };
  const changed = selectCanonC3Candidates({
    selectors: [{ type: "path", value: "src/target.ts" }],
    semantic: sourceChanged,
  });
  assert.notEqual(selected.candidates[0]!.source.generation, changed.candidates[0]!.source.generation);

  const unrelatedChanged = structuredClone(base);
  unrelatedChanged.integrity.trackedFiles.push({
    path: "src/unrelated.ts",
    physicalFingerprint: { algorithm: "sha256", value: "d".repeat(64) },
    semanticFingerprint: { algorithm: "sha256", value: "e".repeat(64) },
  });
  const unaffected = selectCanonC3Candidates({
    selectors: [{ type: "path", value: "src/target.ts" }],
    semantic: unrelatedChanged,
  });
  assert.equal(selected.candidates[0]!.source.generation, unaffected.candidates[0]!.source.generation);

  const relationChanged = structuredClone(base);
  relationChanged.graph.relations = relationChanged.graph.relations.map((relation) =>
    relation.id === "edge:tests-target" ? { ...relation, id: createEdgeId("tests-target-v2") } : relation,
  );
  const relationResult = selectCanonC3Candidates({
    selectors: [{ type: "symbol", value: "normalizeInput" }],
    semantic: relationChanged,
  });
  const originalSymbol = selectCanonC3Candidates({
    selectors: [{ type: "symbol", value: "normalizeInput" }],
    semantic: base,
  });
  assert.notEqual(
    originalSymbol.candidates.find((candidate) => candidate.selector.type === "symbol")!.source.generation,
    relationResult.candidates.find((candidate) => candidate.selector.type === "symbol")!.source.generation,
  );
});

test("unknown and ambiguous selectors remain explicitly incomplete without broad enumeration", () => {
  const snapshot = targetSnapshot();
  const ambiguous = structuredClone(baseSymbol);
  ambiguous.id = "symbol:duplicate-normalize" as SymbolEntity["id"];
  ambiguous.locator = { ...ambiguous.locator, file: "src/other.ts" };
  snapshot.derived.symbols.push(ambiguous);
  const result = selectCanonC3Candidates({
    selectors: [
      { type: "path", value: "src/missing.ts" },
      { type: "symbol", value: "normalizeInput" },
      { type: "component", value: "component:missing" },
    ],
    semantic: snapshot,
  });
  assert.equal(result.completeness, "incomplete");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    "ambiguous-selector",
    "unknown-selector",
    "unknown-selector",
  ]);
  assert.equal(result.candidates.length, 0);
});
