import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extractTypeScriptFacts } from "./extractors/typescript/index.js";
import { allSemanticFixtures, pureFunctionFixture } from "./fixtures/snapshots.js";
import { createSnapshotSymbolBindingResolver, createSemanticMutationService } from "./mutations/index.js";
import type { SemanticMutationRequest } from "./mutations/index.js";
import {
  loadSemanticSource,
  parseSemanticSource,
  persistSemanticMutation,
  serializeSemanticSource,
} from "./source/index.js";
import { serializeSemanticTransaction } from "./ir/serialize.js";
import { createComponentId, createLogicalId } from "./ir/ids.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function request(
  mutations: SemanticMutationRequest["mutations"],
  authorizedDeltaKinds: SemanticMutationRequest["authorizedDeltaKinds"],
): SemanticMutationRequest {
  return {
    mutations,
    intent: "semantic-change",
    reason: "Make the declared semantic boundary explicit for deterministic review.",
    authorizedDeltaKinds,
    provenance: { actor: "test", issue: "49", task: "semantic-mutation-api", ref: "test-fixture" },
  };
}

test("one mutation service owns declarations, binds Symbols explicitly, and emits deterministic source writes", () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const symbol = base.derived.symbols[0]!;
  const { authority: _componentAuthority, provenance: _componentProvenance, ...componentInput } = component;
  const service = createSemanticMutationService(base);
  const plan = service.plan(
    request(
      [
        {
          kind: "component",
          component: { ...componentInput, responsibility: "Own explicitly declared semantic responsibility." },
        },
        {
          kind: "symbol-ownership",
          symbol: { symbolId: symbol.id },
          ownership: { classification: "managed", componentId: component.id },
        },
      ],
      ["responsibility"],
    ),
  );
  assert.deepEqual(plan.diagnostics, []);
  assert.ok(plan.candidateSnapshot);
  assert.equal(plan.candidateSnapshot?.derived.symbols[0]?.classification, symbol.classification);
  assert.equal(plan.candidateSnapshot?.declarations.symbolOwnership?.[0]?.componentId, component.id);
  assert.ok(
    plan.candidateSnapshot?.graph.relations.some((relation) => relation.kind === "owns" && relation.to === symbol.id),
  );
  assert.ok(plan.expectedWrites.some((write) => write.path.includes("declarations/symbol-ownership")));
  assert.equal(
    plan.expectedWrites.some((write) => write.path.endsWith("repository.json")),
    false,
  );
  assert.ok(plan.expectedWrites.some((write) => write.path.includes("semantics/transactions/")));

  const result = service.apply(plan);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.transaction.reason, "Make the declared semantic boundary explicit for deterministic review.");
  assert.deepEqual(result.transaction.authorizedDeltaKinds, ["responsibility"]);
  assert.deepEqual(result.transaction.protectedChanges, [component.id]);
  assert.deepEqual(
    result.transaction.delta.entries.map((entry) => entry.subject),
    [component.id, symbol.id],
  );
  assert.deepEqual(
    result.transaction.delta.entries.map((entry) => entry.reviewLevel),
    ["L3", "L3"],
  );
  assert.equal(plan.bindingRequirements[0]?.resolution.status, "resolved");
  assert.deepEqual(result.transaction.transactionProvenance, {
    actor: "test",
    issue: "49",
    task: "semantic-mutation-api",
    ref: "test-fixture",
  });
  assert.equal(serializeSemanticTransaction(result.transaction).endsWith("\n"), true);

  const roundTrip = parseSemanticSource(serializeSemanticSource(result.snapshot));
  assert.equal(roundTrip.ok, true);
  if (roundTrip.ok)
    assert.deepEqual(serializeSemanticSource(roundTrip.snapshot), serializeSemanticSource(result.snapshot));
});

test("canonical prose validation reaches formal-English keys nested in arrays", () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  component.metadata = { description: ["日本語の説明"] };
  base.integrity.status = "stale";
  base.integrity.statusReason = "test added invalid metadata without recomputing fixture digests";
  const { authority: _authority, provenance: _provenance, ...input } = component;
  const plan = createSemanticMutationService(base).plan(
    request([{ kind: "component", component: input }], ["responsibility"]),
  );
  assert.equal(plan.diagnostics[0]?.code, "canonical_prose_not_formal_english");
  assert.match(plan.diagnostics[0]?.message ?? "", /declarations\.components\.0\.metadata\.description\.0/);
});

test("all declared semantic categories are mutation operations and derived facts stay untouched", () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const {
    authority: _capabilityAuthority,
    provenance: _capabilityProvenance,
    ...capability
  } = base.declarations.capabilities[0]!;
  const {
    authority: _contractAuthority,
    provenance: _contractProvenance,
    ...contract
  } = base.declarations.contracts[0]!;
  const {
    authority: _invariantAuthority,
    provenance: _invariantProvenance,
    ...invariant
  } = base.declarations.invariants[0]!;
  const {
    authority: _rationaleAuthority,
    provenance: _rationaleProvenance,
    ...rationale
  } = base.declarations.rationales[0]!;
  const {
    authority: _constraintAuthority,
    provenance: _constraintProvenance,
    ...constraint
  } = base.declarations.constraints[0]!;
  const {
    authority: _decisionAuthority,
    provenance: _decisionProvenance,
    ...decision
  } = base.declarations.decisions[0]!;
  const plan = createSemanticMutationService(base).plan(
    request(
      [
        { kind: "capability", capability },
        { kind: "contract", contract },
        { kind: "invariant", invariant },
        { kind: "rationale", rationale },
        { kind: "constraint", constraint },
        { kind: "decision", decision },
        { kind: "decision-link", link: base.declarations.decisionLinks[0]! },
        { kind: "effect-policy", policy: base.declarations.effectPolicies[0]! },
        { kind: "dependency-policy", policy: base.declarations.dependencyPolicies[0]! },
        { kind: "review-guidance", guidance: base.declarations.reviewGuidance[0]! },
        { kind: "stability", declaration: base.declarations.stability[0]! },
        { kind: "terminology", link: base.declarations.terminology[0]! },
        {
          kind: "semantic-debt",
          debt: {
            id: createLogicalId("debt", "explicit-binding"),
            subject: component.id,
            statement: "Resolve the remaining semantic binding debt.",
            status: "open",
            priority: "medium",
          },
        },
      ],
      ["capability", "contract", "invariant", "public-surface", "effect", "dependency-policy"],
    ),
  );
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.candidateSnapshot?.derived, base.derived);
  assert.deepEqual(plan.candidateSnapshot?.observed, base.observed);
});

test("apply rejects a tampered public plan before it can bypass the mutation boundary", () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const { authority: _authority, provenance: _provenance, ...input } = component;
  const service = createSemanticMutationService(base);
  const plan = service.plan(
    request(
      [{ kind: "component", component: { ...input, responsibility: "A validated responsibility change." } }],
      ["responsibility"],
    ),
  );
  assert.ok(plan.candidateSnapshot);
  if (plan.candidateSnapshot === undefined) return;
  plan.candidateSnapshot.derived.symbols[0]!.name = "forged-derived-change";
  const result = service.apply(plan);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "mutation_plan_invalid");
  assert.equal(service.getSnapshot().derived.symbols[0]?.name, base.derived.symbols[0]?.name);
});

test("source persistence rejects central or non-declared writes", async () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const { authority: _authority, provenance: _provenance, ...input } = component;
  const plan = createSemanticMutationService(base).plan(
    request(
      [{ kind: "component", component: { ...input, responsibility: "Persist only a declared responsibility." } }],
      ["responsibility"],
    ),
  );
  const result = createSemanticMutationService(base).apply(plan);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const root = await mkdtemp(resolve(tmpdir(), "mottainai-issue-49-boundary-"));
  try {
    await assert.rejects(
      persistSemanticMutation(root, {
        ...result,
        writes: [{ path: ".mottainai/semantics/repository.json", operation: "write", content: "{}\n" }],
      }),
      /declared mutation boundary/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful mutation persistence round-trips declarations and transaction history", async () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const { authority: _authority, provenance: _provenance, ...input } = component;
  const service = createSemanticMutationService(base);
  const plan = service.plan(
    request(
      [
        {
          kind: "component",
          component: { ...input, responsibility: "Persist a deterministic declared responsibility." },
        },
      ],
      ["responsibility"],
    ),
  );
  const result = service.apply(plan);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const root = await mkdtemp(resolve(tmpdir(), "mottainai-issue-49-"));
  try {
    for (const write of serializeSemanticSource(base)) {
      if (write.operation !== "write" || write.content === undefined) continue;
      const target = resolve(root, write.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, write.content, "utf8");
    }
    await persistSemanticMutation(root, result);
    const loaded = await loadSemanticSource(root);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(serializeSemanticSource(loaded.snapshot), serializeSemanticSource(result.snapshot));
    assert.ok(result.writes.some((write) => write.path.includes("semantics/transactions/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous, missing, and stale bindings fail closed without ownership guessing", () => {
  const base = clone(pureFunctionFixture);
  const symbol = base.derived.symbols[0]!;
  const ambiguous = createSemanticMutationService(base, {
    resolve: (locator) => ({
      status: "ambiguous" as const,
      locator,
      candidates: [symbol.id, createLogicalId("symbol", "other")],
    }),
  });
  const ambiguousPlan = ambiguous.plan(
    request(
      [
        {
          kind: "symbol-ownership",
          symbol: { locator: symbol.locator },
          ownership: { classification: "managed", componentId: base.declarations.components[0]!.id },
        },
      ],
      ["responsibility"],
    ),
  );
  assert.equal(ambiguousPlan.candidateSnapshot, undefined);
  assert.equal(ambiguousPlan.diagnostics[0]?.code, "symbol_binding_ambiguous");

  const missingPlan = createSemanticMutationService(base).plan(
    request(
      [
        {
          kind: "symbol-ownership",
          symbol: { symbolId: createLogicalId("symbol", "missing") },
          ownership: { classification: "shared" },
        },
      ],
      ["responsibility"],
    ),
  );
  assert.equal(missingPlan.diagnostics[0]?.code, "symbol_binding_missing");

  const stalePlan = createSemanticMutationService(base, {
    resolve: (locator) => ({ status: "stale" as const, locator, symbolId: symbol.id }),
  }).plan(
    request(
      [
        {
          kind: "symbol-ownership",
          symbol: { locator: symbol.locator, expectedRevision: "old" },
          ownership: { classification: "shared" },
        },
      ],
      ["responsibility"],
    ),
  );
  assert.equal(stalePlan.diagnostics[0]?.code, "symbol_binding_stale");
});

test("formal-English reason is required for meaning-changing mutations", () => {
  const base = clone(pureFunctionFixture);
  const component = base.declarations.components[0]!;
  const { authority: _authority, provenance: _provenance, ...input } = component;
  const invalid = request([{ kind: "component", component: input }], ["responsibility"]);
  invalid.reason = "責任を更新する";
  const plan = createSemanticMutationService(base).plan(invalid);
  assert.equal(plan.diagnostics[0]?.code, "missing_semantic_change_reason");
});

test("repeated semantic applications receive distinct transaction events", () => {
  const base = clone(pureFunctionFixture);
  const service = createSemanticMutationService(base);

  const planForCurrentStability = () => {
    const declaration = service.getSnapshot().declarations.stability[0]!;
    return service.plan(request([{ kind: "stability", declaration }], ["public-surface"]));
  };

  const plan = planForCurrentStability();
  const first = service.apply(plan);
  const second = service.apply(plan);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(typeof first.transaction.sequence, "number");
  assert.equal(typeof second.transaction.sequence, "number");
  assert.notEqual(first.transaction.sequence, second.transaction.sequence);
  const firstEvent = first.writes.find((write) => write.path.includes("semantics/transactions/"));
  const secondEvent = second.writes.find((write) => write.path.includes("semantics/transactions/"));
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.notEqual(firstEvent?.path, secondEvent?.path);
});

test("independent entity plans rebase, while concurrent protected edits conflict deterministically", () => {
  const base = clone(pureFunctionFixture);
  const first = base.declarations.components[0]!;
  const second = { ...first, id: createComponentId("second"), name: "Second Component" };
  base.declarations.components.push(second);
  base.integrity.status = "stale";
  base.integrity.statusReason = "test added an independent Component without extractor refresh";
  const { authority: _firstAuthority, provenance: _firstProvenance, ...firstInput } = first;
  const { authority: _secondAuthority, provenance: _secondProvenance, ...secondInput } = second;
  const service = createSemanticMutationService(base);
  const firstPlan = service.plan(
    request(
      [{ kind: "component", component: { ...firstInput, responsibility: "First explicit responsibility." } }],
      ["responsibility"],
    ),
  );
  const secondPlan = service.plan(
    request(
      [{ kind: "component", component: { ...secondInput, responsibility: "Second explicit responsibility." } }],
      ["responsibility"],
    ),
  );
  assert.equal(service.apply(firstPlan).ok, true);
  assert.equal(service.apply(secondPlan).ok, true);

  const protectedBase = clone(base);
  protectedBase.declarations.components[0]!.stability = "protected";
  protectedBase.declarations.components[0]!.reviewLevel = "L3";
  const protectedService = createSemanticMutationService(protectedBase);
  const protectedInput = (() => {
    const { authority, provenance, ...value } = protectedBase.declarations.components[0]!;
    return value;
  })();
  const a = protectedService.plan(
    request(
      [{ kind: "component", component: { ...protectedInput, responsibility: "Protected responsibility one." } }],
      ["responsibility"],
    ),
  );
  const b = protectedService.plan(
    request(
      [{ kind: "component", component: { ...protectedInput, responsibility: "Protected responsibility two." } }],
      ["responsibility"],
    ),
  );
  assert.equal(protectedService.apply(a).ok, true);
  const conflict = protectedService.apply(b);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.diagnostics[0]?.code, "mutation_conflict");
});

test("fixture resolver and the merged TypeScript fact provider resolve the same binding contract", () => {
  const fixtureSymbol = pureFunctionFixture.derived.symbols[0]!;
  assert.equal(
    createSnapshotSymbolBindingResolver(pureFunctionFixture).resolve(fixtureSymbol.locator).status,
    "resolved",
  );
  const rootDir = resolve("src/semantics/fixtures/typescript");
  const extracted = extractTypeScriptFacts({ rootDir, tsconfigPath: resolve(rootDir, "tsconfig.json") });
  const extractedSymbol = extracted.snapshot.derived.symbols[0];
  assert.ok(extractedSymbol);
  if (extractedSymbol) {
    assert.equal(
      createSnapshotSymbolBindingResolver(extracted.snapshot).resolve(extractedSymbol.locator).status,
      "resolved",
    );
  }
});

test("source serialization round-trips every merged schema fixture", () => {
  for (const [name, fixture] of Object.entries(allSemanticFixtures)) {
    const parsed = parseSemanticSource(serializeSemanticSource(fixture));
    assert.equal(parsed.ok, true, name);
    if (parsed.ok) assert.deepEqual(serializeSemanticSource(parsed.snapshot), serializeSemanticSource(fixture), name);
  }
});
