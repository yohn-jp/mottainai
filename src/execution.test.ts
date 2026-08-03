import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryArtifactStore } from "./retrieve.js";
import { resolveGatewayConfig } from "./config.js";
import { applyExecutionBudget, normalizeExecutionOutcome, providerErrorOutcome } from "./execution.js";

test("normalizeExecutionOutcome classifies successful and empty results from one evidence rule", () => {
  const success = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "hit" }] },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });
  const empty = normalizeExecutionOutcome({
    result: { content: [] },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });

  assert.equal(success.status, "success");
  assert.equal(empty.status, "empty");
  assert.deepEqual(success.attempts, []);
});

test("normalizeExecutionOutcome preserves tool errors and fallback attempts", () => {
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "bad arguments" }], isError: true },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "unknown",
    attempts: [{ provider: "broken", tool: "explore", error: "connection reset" }],
  });

  assert.equal(outcome.status, "tool_error");
  assert.deepEqual(outcome.attempts, [{ provider: "broken", tool: "explore", error: "connection reset" }]);
});

test("providerErrorOutcome keeps provider failure distinct from tool errors", () => {
  const outcome = providerErrorOutcome({
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
    error: "connection reset",
  });

  assert.equal(outcome.status, "provider_error");
  assert.equal(outcome.result.isError, true);
  assert.deepEqual(outcome.attempts, [{ provider: "codegraph", tool: "explore", error: "connection reset" }]);
});

test("result budgeting removes oversized metadata after preserving the full artifact", () => {
  const outcome = normalizeExecutionOutcome({
    result: { content: [{ type: "text", text: "small" }], _meta: { diagnostic: "x".repeat(8_000) } },
    selectedProvider: "codegraph",
    selectedTool: "explore",
    capability: "definitions",
    risk: "read_only",
  });
  const artifactStore = new InMemoryArtifactStore({ createId: () => "budgeted-metadata" });
  const budgeted = applyExecutionBudget(
    outcome,
    "codegraph__explore",
    "definitions",
    resolveGatewayConfig({ tokenBudgets: { default: 300 } }),
    artifactStore,
  );

  assert.equal(budgeted.decision?.truncated, true);
  assert.equal(budgeted.outcome.result._meta, undefined);
  assert.match(String(budgeted.outcome.result.content[0]?.type === "text" ? budgeted.outcome.result.content[0].text : ""), /budgeted-metadata/);
  assert.equal(artifactStore.retrieve("mx_budgeted-metadata")?.text.includes("diagnostic"), true);
});
