import assert from "node:assert/strict";
import { test } from "node:test";
import { createFactId, createSymbolId } from "../ir/ids.js";
import type { EffectAnalysisDelta, EffectViolation } from "../effects/types.js";
import type { RepositorySemanticSnapshot, SemanticTransaction, SymbolEntity } from "../ir/types.js";
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
