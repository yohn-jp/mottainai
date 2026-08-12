import assert from "node:assert/strict";
import { test } from "node:test";
import { createSemanticExecutionPlan, projectNawabariDeclaration } from "./execution-plan.js";

test("semantic scope is projected to concrete claims without semantic coupling", () => {
  const plan = createSemanticExecutionPlan({
    semanticTargets: [{ kind: "symbol", id: "src/app.ts:run", paths: ["src/app.ts"] }],
    verification: { requiredChecks: ["typecheck"] },
  });
  assert.equal(plan.claimGeneration.strategy, "declared");
  assert.deepEqual(plan.claims, [{ resource: "src/app.ts", mode: "exclusive-write" }]);
  const declaration = projectNawabariDeclaration({ plan, branch: "feat/example" });
  assert.deepEqual(declaration, {
    schemaVersion: 1,
    contractId: "nawabari.standalone-execution.v1",
    branch: "feat/example",
    base: "HEAD",
    claims: [{ resource: "src/app.ts", mode: "exclusive-write" }],
  });
  assert.equal("semanticTargets" in declaration, false);
});

test("unknown semantic scope is explicit and conservative, or blocks in strict mode", () => {
  const conservative = createSemanticExecutionPlan();
  assert.equal(conservative.claimGeneration.strategy, "conservative-broad");
  assert.deepEqual(conservative.claims, [{ resource: "**", mode: "exclusive-write" }]);
  assert.match(conservative.claimGeneration.warnings[0] ?? "", /incomplete/u);

  const strict = createSemanticExecutionPlan({ strict: true });
  assert.equal(strict.claimGeneration.strategy, "blocked");
  assert.deepEqual(strict.claims, []);
  assert.throws(() => projectNawabariDeclaration({ plan: strict, branch: "feat/example" }), /blocked/u);
});

test("explicit claims cannot silently narrow declared semantic paths", () => {
  const plan = createSemanticExecutionPlan({
    semanticTargets: [{ kind: "component", id: "gateway", paths: ["src/gateway.ts"] }],
    claims: [{ resource: "src/other.ts", mode: "exclusive-write" }],
  });
  assert.deepEqual(plan.claims, [
    { resource: "src/gateway.ts", mode: "exclusive-write" },
    { resource: "src/other.ts", mode: "exclusive-write" },
  ]);
});

test("explicit read claims are not escalated when no semantic path is declared", () => {
  const plan = createSemanticExecutionPlan({ claims: [{ resource: "**", mode: "read" }] });
  assert.deepEqual(plan.claims, [{ resource: "**", mode: "read" }]);
  assert.equal(plan.claimGeneration.source, "explicit-claims");
});
