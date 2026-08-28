import assert from "node:assert/strict";
import { test } from "node:test";
import { LIFECYCLE_STATES, allowedNextTransitions, isContinuableLifecycleState, validateTransition } from "./lifecycle.js";
import type { LifecycleState } from "./lifecycle.js";

const VALID_EDGES: ReadonlyArray<[LifecycleState, LifecycleState]> = [
  ["planned", "active"],
  ["planned", "abandoned"],
  ["planned", "orphaned"],
  ["active", "committed"],
  ["active", "abandoned"],
  ["active", "orphaned"],
  ["committed", "pushed"],
  ["committed", "abandoned"],
  ["committed", "orphaned"],
  ["pushed", "pull-request-open"],
  ["pushed", "abandoned"],
  ["pushed", "orphaned"],
  ["pull-request-open", "merged"],
  ["pull-request-open", "abandoned"],
  ["pull-request-open", "orphaned"],
  ["merged", "cleaned"],
  ["abandoned", "cleaned"],
  ["orphaned", "cleaned"],
  ["orphaned", "active"],
  ["orphaned", "abandoned"],
];

function isValidEdge(from: LifecycleState, to: LifecycleState): boolean {
  return VALID_EDGES.some(([f, t]) => f === from && t === to);
}

test("every declared valid edge is allowed", () => {
  for (const [from, to] of VALID_EDGES) {
    const result = validateTransition(from, to);
    assert.equal(result.allowed, true, `expected ${from} -> ${to} to be allowed`);
  }
});

test("every non-declared (from,to) pair is rejected with structured blocker info", () => {
  for (const from of LIFECYCLE_STATES) {
    for (const to of LIFECYCLE_STATES) {
      if (isValidEdge(from, to)) continue;
      const result = validateTransition(from, to);
      assert.equal(result.allowed, false, `expected ${from} -> ${to} to be blocked`);
      if (result.allowed) continue;
      assert.equal(result.blocked.currentState, from);
      assert.equal(result.blocked.requestedTransition, to);
      assert.ok(result.blocked.blockingRule.length > 0);
      assert.deepEqual(result.blocked.allowedNextTransitions, allowedNextTransitions(from));
    }
  }
});

test("cleaned is terminal with no allowed next transitions", () => {
  assert.deepEqual(allowedNextTransitions("cleaned"), []);
});

test("cleaned is only reachable from merged, abandoned, or orphaned", () => {
  const reachableFrom = LIFECYCLE_STATES.filter((state) => validateTransition(state, "cleaned").allowed);
  assert.deepEqual(reachableFrom.sort(), ["abandoned", "merged", "orphaned"].sort());
});

test("validateTransition never throws for any state pair", () => {
  for (const from of LIFECYCLE_STATES) {
    for (const to of LIFECYCLE_STATES) {
      assert.doesNotThrow(() => validateTransition(from, to));
    }
  }
});

test("isContinuableLifecycleState is true only for planned and active", () => {
  const continuable = LIFECYCLE_STATES.filter((state) => isContinuableLifecycleState(state));
  assert.deepEqual(continuable.sort(), ["active", "planned"]);
});
