import assert from "node:assert/strict";
import test from "node:test";
import { attachDecisionMetadata, hasDecision } from "./decision-metadata.js";

test("hasDecision is false when nothing triggered", () => {
  assert.equal(hasDecision({}), false);
  assert.equal(hasDecision({ budget: { target_tokens: 500, source: "tool", truncated: false } }), false);
  assert.equal(hasDecision({ fallback_history: [] }), false);
  assert.equal(hasDecision({ selection_reason: [] }), false);
});

test("hasDecision is true when budget actually truncated, fallback happened, or selection had reasons", () => {
  assert.equal(hasDecision({ budget: { target_tokens: 500, source: "tool", truncated: true } }), true);
  assert.equal(hasDecision({ fallback_history: [{ provider: "a", tool: "b", error: "unhealthy" }] }), true);
  assert.equal(hasDecision({ selection_reason: [{ rule: "priority", value: 10 }] }), true);
});

test("attachDecisionMetadata leaves the result untouched when no decision occurred", () => {
  const result = { content: [{ type: "text" as const, text: "hello" }] };
  const attached = attachDecisionMetadata(result, {});
  assert.equal(attached, result);
});

test("attachDecisionMetadata appends a single text line carrying the decision as JSON", () => {
  const result = { content: [{ type: "text" as const, text: "hello" }] };
  const attached = attachDecisionMetadata(result, {
    budget: { target_tokens: 500, source: "capability", truncated: true },
  });
  assert.equal(attached.content?.length, 2);
  const line = (attached.content?.[1] as { text: string }).text;
  assert.match(line, /^\[mottainai routing: /);
  assert.deepEqual(JSON.parse(line.slice("[mottainai routing: ".length, -1)), {
    budget: { target_tokens: 500, source: "capability", truncated: true },
  });
});
