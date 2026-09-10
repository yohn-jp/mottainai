import assert from "node:assert/strict";
import { test } from "node:test";
import { createFactId, createSymbolId } from "../ir/ids.js";
import type { EffectAnalysisDelta, EffectViolation } from "../effects/types.js";
import type { RepositorySemanticSnapshot, SemanticFact, SemanticTransaction, SymbolEntity } from "../ir/types.js";
import { callsAndPackageFixture, pureFunctionFixture } from "../fixtures/snapshots.js";
import { compileRepositoryModel } from "../model/compiler.js";
import { createSemanticMutationService } from "../mutations/service.js";
import { compareSemanticSnapshots, parseSemanticChangeSet, serializeSemanticChangeSet } from "./index.js";

function cloneSnapshot(snapshot: RepositorySemanticSnapshot): RepositorySemanticSnapshot {
  return structuredClone(snapshot);
}

function replaceFact(snapshot: RepositorySemanticSnapshot, subject: string, predicate: string, value: unknown): void {
  const fact = snapshot.derived.facts.find((item) => item.subject === subject && item.predicate === predicate);
  if (fact !== undefined) {
    fact.value = value as never;
    return;
  }
  snapshot.derived.facts.push({
    id: createFactId(`${subject}-${predicate.replace(/[^a-z0-9]+/giu, "-")}`),
    subject: subject as never,
    predicate,
    value: value as never,
    authority: "derived",
    provenance: snapshot.declarations.project.provenance,
  });
}

function replaceSymbol(snapshot: RepositorySemanticSnapshot, before: SymbolEntity, after: SymbolEntity): void {
  snapshot.derived.symbols = snapshot.derived.symbols.map((item) => (item.id === before.id ? after : item));
  snapshot.derived.facts = snapshot.derived.facts.map((item) =>
    item.subject === before.id ? { ...item, subject: after.id } : item,
  );
  snapshot.graph.relations = snapshot.graph.relations.map((item) => ({
    ...item,
    ...(item.from === before.id ? { from: after.id } : {}),
    ...(item.to === before.id ? { to: after.id } : {}),
  }));
}

function transaction(intent: SemanticTransaction["intent"]): SemanticTransaction {
  return {
    version: 1,
    intent,
    delta: { version: 1, intent, entries: [], unauthorized: false },
    provenance: pureFunctionFixture.declarations.project.provenance,
    transactionProvenance: { actor: "fixture", issue: "54" },
    authorizedDeltaKinds: [],
  };
}

test("unchanged snapshots and pure line movement are deterministic L0", () => {
  const unchanged = compareSemanticSnapshots(pureFunctionFixture, pureFunctionFixture);
  assert.equal(unchanged.reviewLevel, "L0");
  assert.deepEqual(unchanged.semanticDeltas, []);

  const moved = cloneSnapshot(pureFunctionFixture);
  const symbol = moved.derived.symbols[0]!;
  symbol.locator = { ...symbol.locator, range: { start: { line: 40, column: 1 }, end: { line: 44, column: 2 } } };
  const first = compareSemanticSnapshots(pureFunctionFixture, moved);
  const second = compareSemanticSnapshots(pureFunctionFixture, moved);
  assert.equal(first.reviewLevel, "L0");
  assert.equal(first.semanticDeltas.length, 0);
  assert.deepEqual(first, second);
  assert.ok(first.symbolChanges.some((item) => item.identityStatus === "moved"));
});

test("public optional input changes are L1 while required changes are L3", () => {
  const before = pureFunctionFixture.derived.symbols[0]!;
  const optional = cloneSnapshot(pureFunctionFixture);
  const optionalSymbol = {
    ...before,
    id: createSymbolId({ ...before.locator, signature: "(value: string, suffix?: string): string" }),
    locator: { ...before.locator, signature: "(value: string, suffix?: string): string" },
  };
  replaceSymbol(optional, before, optionalSymbol);
  replaceFact(optional, optionalSymbol.id, "symbol.signature", "(value: string, suffix?: string): string");
  const optionalResult = compareSemanticSnapshots(pureFunctionFixture, optional);
  assert.equal(optionalResult.reviewLevel, "L1");
  assert.ok(
    optionalResult.semanticDeltas.some((item) => item.kind === "contract" && item.compatibility === "compatible"),
  );

  const breaking = cloneSnapshot(pureFunctionFixture);
  const breakingSymbol = {
    ...before,
    id: createSymbolId({ ...before.locator, signature: "(value: string, suffix: string): string" }),
    locator: { ...before.locator, signature: "(value: string, suffix: string): string" },
  };
  replaceSymbol(breaking, before, breakingSymbol);
  replaceFact(breaking, breakingSymbol.id, "symbol.signature", "(value: string, suffix: string): string");
  const breakingResult = compareSemanticSnapshots(pureFunctionFixture, breaking);
  assert.equal(breakingResult.reviewLevel, "L3");
  assert.ok(breakingResult.semanticDeltas.some((item) => item.compatibility === "breaking"));
});

test("semantic-neutral actual meaning change is an unauthorized L3 stop event", () => {
  const head = cloneSnapshot(pureFunctionFixture);
  head.declarations.components[0]!.responsibility = "A changed Component responsibility boundary";
  const result = compareSemanticSnapshots(pureFunctionFixture, head, { transaction: transaction("semantic-neutral") });
  assert.equal(result.authorizedVsActual.status, "unauthorized");
  assert.equal(result.authorizedVsActual.unauthorized, true);
  assert.equal(result.authorizedVsActual.stopEvent?.level, "L3");
  assert.equal(result.reviewLevel, "L3");
});

test("dependency reachability alone stops at an unchanged Component boundary", () => {
  const head = cloneSnapshot(callsAndPackageFixture);
  const symbol = head.derived.symbols[0]!;
  replaceFact(head, symbol.id, "symbol.type", "changed internal implementation type");
  const result = compareSemanticSnapshots(callsAndPackageFixture, head);
  assert.equal(result.reviewLevel, "L0");
  assert.ok(
    result.propagationStopPoints.some((item) => item.reason.includes("preserved conforming Component boundary")),
  );
  const consumer = head.derived.symbols[1]!;
  assert.equal(result.affectedEntities.includes(consumer.id), false);
});

test("materially incomplete analysis cannot produce L0 and protected declarations stay review events", () => {
  const incomplete = cloneSnapshot(pureFunctionFixture);
  incomplete.analysis.health.status = "partial";
  incomplete.analysis.unknowns = [
    { code: "dynamic", message: "dynamic region", subjects: [incomplete.derived.symbols[0]!.id] },
  ];
  replaceFact(incomplete, incomplete.derived.symbols[0]!.id, "symbol.type", "changed");
  const incompleteResult = compareSemanticSnapshots(pureFunctionFixture, incomplete);
  assert.notEqual(incompleteResult.reviewLevel, "L0");
  assert.ok(incompleteResult.unknownRegions.length > 0);

  const protectedHead = cloneSnapshot(pureFunctionFixture);
  protectedHead.declarations.components[0]!.description = "changed protected declaration description";
  const protectedResult = compareSemanticSnapshots(pureFunctionFixture, protectedHead);
  assert.equal(protectedResult.reviewLevel, "L3");
  assert.ok(protectedResult.semanticDeltas.some((item) => item.protected));
});

test("#51 effect violations are consumed as L3 without effect recomputation", () => {
  const subject = pureFunctionFixture.derived.symbols[0]!.id;
  const violation = {
    subjectId: subject,
    policyId: "policy:effects",
    code: "forbidden-effect",
    effect: "filesystem.write",
    evidence: {},
    proven: true,
  } as unknown as EffectViolation;
  const effectDelta: EffectAnalysisDelta = {
    changes: [{ subjectId: subject, added: [], removed: [], conformanceChanged: true, violations: [violation] }],
    violations: [violation],
  };
  const result = compareSemanticSnapshots(pureFunctionFixture, pureFunctionFixture, { effectDelta });
  assert.equal(result.reviewLevel, "L3");
  assert.equal(result.effectViolations.length, 1);
  assert.ok(result.effectChanges.some((item) => item.subject === subject));
});

test("the versioned result is serializable and round-trips deterministically", () => {
  const result = compareSemanticSnapshots(pureFunctionFixture, pureFunctionFixture);
  const serialized = serializeSemanticChangeSet(result);
  const parsed = parseSemanticChangeSet(serialized);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(serializeSemanticChangeSet(parsed.changeSet), serialized);
});

test("the existing Change Impact query surface renders the canonical result", () => {
  const component = pureFunctionFixture.declarations.components[0]!;
  const service = createSemanticMutationService(pureFunctionFixture);
  const plan = service.plan({
    mutations: [
      { kind: "component", component: { ...component, responsibility: "A changed responsibility boundary" } },
    ],
    intent: "semantic-change",
    reason: "Change the component responsibility to document the new semantic boundary.",
    authorizedDeltaKinds: ["responsibility"],
    provenance: { actor: "fixture", issue: "54" },
  });
  const applied = service.apply(plan);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const query = compileRepositoryModel({
    snapshot: applied.snapshot,
    baseSnapshot: pureFunctionFixture,
    transaction: applied.transaction,
  }).query;
  const changeSet = query.getChangeSet();
  assert.equal(changeSet.version, 1);
  assert.equal(changeSet.reviewLevel, "L3");
  assert.ok(changeSet.semanticDeltas?.some((item) => item.kind === "responsibility"));
});

// #871: the per-symbol comparison loop must reuse the hoisted fact indexes instead of
// rebuilding factsBySubject() on every symbol iteration (which made the loop O(symbols * facts)).

function syntheticSymbol(index: number): SymbolEntity {
  const locator: SymbolEntity["locator"] = {
    kind: "symbol",
    language: "typescript",
    package: "mottainai",
    file: `src/semantics/fixtures/synthetic-${index}.ts`,
    symbol: `syntheticSymbol${index}`,
    signature: "(): void",
    range: { start: { line: 1, column: 1 }, end: { line: 2, column: 2 } },
  };
  return {
    kind: "symbol",
    id: createSymbolId(locator),
    name: `syntheticSymbol${index}`,
    authority: "derived",
    provenance: pureFunctionFixture.derived.symbols[0]!.provenance,
    locator,
    classification: "shared",
  };
}

function syntheticFacts(subject: SymbolEntity["id"], factsPerSymbol: number): SemanticFact[] {
  return Array.from({ length: factsPerSymbol }, (_, index) => ({
    id: createFactId(`${subject}-synthetic-${index}`),
    subject,
    predicate: `synthetic.fact.${index}`,
    value: `value-${index}`,
    authority: "derived" as const,
    provenance: pureFunctionFixture.derived.facts[0]!.provenance,
  }));
}

/** Builds a snapshot with `symbolCount` extra symbols carrying `factsPerSymbol` facts each. */
function buildScaledSnapshot(symbolCount: number, factsPerSymbol: number): RepositorySemanticSnapshot {
  const base = cloneSnapshot(pureFunctionFixture);
  const symbols: SymbolEntity[] = [];
  const facts: SemanticFact[] = [];
  for (let index = 0; index < symbolCount; index += 1) {
    const symbolEntity = syntheticSymbol(index);
    symbols.push(symbolEntity);
    facts.push(...syntheticFacts(symbolEntity.id, factsPerSymbol));
  }
  base.derived.symbols = [...base.derived.symbols, ...symbols];
  base.derived.facts = [...base.derived.facts, ...facts];
  return base;
}

interface FactIndexWork {
  indexBuilds: number;
  factEntriesVisited: number;
}

interface InstrumentedSnapshot {
  snapshot: RepositorySemanticSnapshot;
  work: FactIndexWork;
}

/**
 * Counts the deterministic work performed while factsBySubject() consumes a snapshot.
 * A Proxy keeps the production API unchanged while making an accidental full-fact scan
 * observable in this regression test.
 */
function instrumentFactIndex(snapshot: RepositorySemanticSnapshot): InstrumentedSnapshot {
  const work: FactIndexWork = { indexBuilds: 0, factEntriesVisited: 0 };
  const facts = snapshot.derived.facts;
  const countedFacts = new Proxy(facts, {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
      return function* (): IterableIterator<SemanticFact> {
        work.indexBuilds += 1;
        for (const fact of target) {
          work.factEntriesVisited += 1;
          yield fact;
        }
      };
    },
  });
  snapshot.derived = { ...snapshot.derived, facts: countedFacts };
  return { snapshot, work };
}

test("#871 per-symbol fact lookups reuse the hoisted index instead of rebuilding it per symbol", () => {
  // Hold facts-per-symbol constant so doubling the symbol count also doubles the total fact
  // count F (S and F grow together) while keeping the workload shape identical.
  const factsPerSymbol = 30;
  const smallBase = instrumentFactIndex(buildScaledSnapshot(300, factsPerSymbol));
  const smallHead = instrumentFactIndex(buildScaledSnapshot(300, factsPerSymbol));
  const largeBase = instrumentFactIndex(buildScaledSnapshot(600, factsPerSymbol));
  const largeHead = instrumentFactIndex(buildScaledSnapshot(600, factsPerSymbol));

  const smallResult = compareSemanticSnapshots(smallBase.snapshot, smallHead.snapshot);
  const largeResult = compareSemanticSnapshots(largeBase.snapshot, largeHead.snapshot);

  // One index is required for each side of a diff. Rebuilding either full index from inside
  // the symbol loop would increase this count by S and fail independently of machine speed.
  assert.equal(smallBase.work.indexBuilds, 1);
  assert.equal(smallHead.work.indexBuilds, 1);
  assert.equal(largeBase.work.indexBuilds, 1);
  assert.equal(largeHead.work.indexBuilds, 1);

  const smallFactCount = smallBase.snapshot.derived.facts.length + smallHead.snapshot.derived.facts.length;
  const largeFactCount = largeBase.snapshot.derived.facts.length + largeHead.snapshot.derived.facts.length;
  const smallWork = smallBase.work.factEntriesVisited + smallHead.work.factEntriesVisited;
  const largeWork = largeBase.work.factEntriesVisited + largeHead.work.factEntriesVisited;
  assert.equal(smallWork, smallFactCount);
  assert.equal(largeWork, largeFactCount);

  // Doubling both symbol count and fact count should at most roughly double indexed work. The
  // pre-fix O(S*F) behavior grows roughly 4x and is rejected without scheduler/timing noise.
  const growth = largeWork / smallWork;
  assert.ok(
    growth < 3,
    `expected near-linear fact-index work when doubling symbols/facts together, got ${growth.toFixed(2)}x ` +
      `(small=${smallWork}, large=${largeWork})`,
  );

  // Correctness remains authoritative: identical snapshots produce a stable L0 result with no
  // semantic deltas, independent of the complexity observation above.
  assert.equal(smallResult.reviewLevel, "L0");
  assert.equal(smallResult.semanticDeltas.length, 0);
  assert.equal(largeResult.reviewLevel, "L0");
  assert.equal(largeResult.semanticDeltas.length, 0);
  const small = buildScaledSnapshot(300, factsPerSymbol);
  const first = compareSemanticSnapshots(small, small);
  const second = compareSemanticSnapshots(small, small);
  assert.deepEqual(first, second);
  assert.equal(first.reviewLevel, "L0");
  assert.equal(first.semanticDeltas.length, 0);
});

test("#871 hoisted fact lookups still detect per-symbol fact changes correctly", () => {
  const base = buildScaledSnapshot(40, 10);
  const head = cloneSnapshot(base);
  // Change one fact on a subset of the synthetic symbols to exercise the added/removed/modified
  // branches that read from the hoisted baseFacts/headFacts maps.
  const changedIndexes = [0, 5, 10, 15, 20, 25, 30, 35];
  for (const index of changedIndexes) {
    const subject = syntheticSymbol(index).id;
    replaceFact(head, subject, "synthetic.fact.0", "changed-value");
  }
  const result = compareSemanticSnapshots(base, head);
  const factChangeSubjects = new Set(
    result.derivedChanges.filter((item) => item.path === "facts.synthetic.fact.0").map((item) => item.entityId),
  );
  assert.equal(factChangeSubjects.size, changedIndexes.length);
  for (const index of changedIndexes) assert.ok(factChangeSubjects.has(syntheticSymbol(index).id));
  assert.equal(result.changedSymbols.length, changedIndexes.length);
});
