import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSymbolId } from "./ir/ids.js";
import { computeIntegrityDigestsFromValidated } from "./ir/canonical.js";
import { pureFunctionFixture } from "./fixtures/snapshots.js";
import { createSemanticMutationService } from "./mutations/index.js";
import { compileRepositoryModel } from "./model/compiler.js";
import { serializeSemanticSource } from "./source/index.js";
import {
  applySemanticTransaction,
  evaluateSemanticEnforcement,
  inspectManagedComments,
  proposeSemanticDebt,
  inspectSemanticSource,
  semanticDecision,
} from "./enforcement/index.js";
import type { SemanticMutationRequest } from "./mutations/types.js";

function writeSource(rootDir: string, snapshot = pureFunctionFixture): void {
  for (const write of serializeSemanticSource(snapshot)) {
    assert.equal(write.operation, "write");
    const target = join(rootDir, write.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, write.content ?? "", "utf8");
  }
}

function ownershipRequest(symbolId: ReturnType<typeof createSymbolId>): SemanticMutationRequest {
  return {
    mutations: [
      {
        kind: "symbol-ownership",
        symbol: { symbolId },
        ownership: { classification: "managed", componentId: pureFunctionFixture.declarations.components[0]!.id },
      },
    ],
    intent: "semantic-change",
    reason: "Declare the managed Symbol ownership boundary for the dogfood slice.",
    authorizedDeltaKinds: ["responsibility"],
    provenance: { actor: "enforcement-test", issue: "56", task: "semantic-enforcement" },
  };
}

test("enforce mode requires explicit ownership and passes the supported dogfood slice", async () => {
  const symbolId = pureFunctionFixture.derived.symbols[0]!.id;
  const service = createSemanticMutationService(pureFunctionFixture);
  const result = service.apply(service.plan(ownershipRequest(symbolId)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-dogfood-"));
  try {
    const sourcePath = "src/semantics/fixtures/pure.ts";
    mkdirSync(join(root, sourcePath, ".."), { recursive: true });
    writeFileSync(join(root, sourcePath), "export function normalizeInput(value: string): string { return value.trim(); }\n", "utf8");
    const dogfood = structuredClone(result.snapshot);
    const { git: _git, ...integrityWithoutGit } = dogfood.integrity;
    const integrity = {
      ...integrityWithoutGit,
      trackedFiles: [],
      worktree: { ...dogfood.integrity.worktree, root, dirty: false },
      status: "fresh" as const,
      statusReason: undefined,
    };
    const digests = computeIntegrityDigestsFromValidated({ ...dogfood, integrity });
    const current = { ...dogfood, integrity: { ...integrity, ...digests } };
    const report = await evaluateSemanticEnforcement({
      rootDir: root,
      snapshot: current,
      mode: "enforce",
      managedSymbolIds: [symbolId],
      commentZero: true,
    });
    assert.equal(report.integrity.status, "fresh");
    assert.deepEqual(report.ownership.missingSymbolIds, []);
    assert.deepEqual(report.ownership.invalidSymbolIds, []);
    assert.equal(report.comments.humanCommentCount, 0);
    assert.equal(report.blockers.length, 0, JSON.stringify(report.blockers));
    assert.equal(report.decision, "allow");
    assert.equal(result.snapshot.observed.tests[0]?.status, "passed");
    const query = compileRepositoryModel({ snapshot: current }).query;
    assert.equal(query.getProject().semantic?.integrity, "fresh");
    assert.equal(query.getAgentContext(symbolId).target.id, symbolId);
    assert.equal(query.getReviewProjection().apiVersion, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical semantic source detects a valid direct edit and accepts a canonical transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-source-"));
  try {
    writeSource(root);
    const initial = await inspectSemanticSource({ rootDir: root });
    assert.equal(initial.status, "fresh", JSON.stringify(initial));
    const projectPath = join(root, ".mottainai/semantics/declarations/project.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
    project.description = "A direct edit that remains schema-valid.";
    writeFileSync(projectPath, `${JSON.stringify(project)}\n`, "utf8");
    const edited = await inspectSemanticSource({ rootDir: root, baselineSnapshot: pureFunctionFixture });
    assert.notEqual(edited.status, "fresh");
    assert.ok(edited.directEdits.includes(".mottainai/semantics/declarations/project.json"));

    rmSync(join(root, ".mottainai"), { recursive: true, force: true });
    writeSource(root);
    const symbolId = pureFunctionFixture.derived.symbols[0]!.id;
    const applied = await applySemanticTransaction(root, ownershipRequest(symbolId));
    assert.equal(applied.ok, true, applied.ok ? "" : JSON.stringify(applied.diagnostics));
    const after = await inspectSemanticSource({ rootDir: root });
    assert.equal(after.status, "fresh", JSON.stringify(after));
    assert.ok(after.transactions.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment-zero rejects JSDoc and TODO while preserving narrow directives", () => {
  const root = mkdtempSync(join(tmpdir(), "mottainai-semantic-comments-"));
  try {
    const path = join(root, "managed.ts");
    writeFileSync(
      path,
      "/** human API meaning */\n// TODO: move rationale\n// eslint-disable-next-line no-console\nexport const value = 1;\n",
      "utf8",
    );
    const report = inspectManagedComments({
      rootDir: root,
      paths: ["managed.ts"],
      policy: pureFunctionFixture.declarations.commentPolicy,
    });
    assert.equal(report.jsdocCount, 1);
    assert.equal(report.todoDebtCount, 1);
    assert.equal(report.allowedCount, 1);
    const proposals = proposeSemanticDebt(report);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.readyForMutation, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout modes remain explicit and monotonic", () => {
  assert.equal(semanticDecision("off", 3, 3), "allow");
  assert.equal(semanticDecision("observe", 3, 0), "observe");
  assert.equal(semanticDecision("warn", 3, 0), "warn");
  assert.equal(semanticDecision("enforce", 3, 0), "block");
  assert.equal(semanticDecision("enforce", 0, 1), "warn");
});

test("semantic-neutral work with an actual delta is stopped until transaction amendment", async () => {
  const symbolId = pureFunctionFixture.derived.symbols[0]!.id;
  const service = createSemanticMutationService(pureFunctionFixture);
  const result = service.apply(service.plan(ownershipRequest(symbolId)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = await evaluateSemanticEnforcement({
    snapshot: result.snapshot,
    baseSnapshot: pureFunctionFixture,
    intent: "semantic-neutral",
    mode: "enforce",
    managedSymbolIds: [symbolId],
    commentZero: false,
  });
  assert.ok(report.blockers.some((item) => item.code === "missing_semantic_transaction"));
  assert.ok(report.blockers.some((item) => item.code === "unauthorized_semantic_delta"));
});
