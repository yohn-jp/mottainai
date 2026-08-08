import assert from "node:assert/strict";
import { test } from "node:test";
import { boundAwaitTimeout, DEFAULT_AWAIT_POLICY, nextPollDelayMs } from "./poll-policy.js";
import type { AwaitPolicy } from "./poll-policy.js";

test("boundAwaitTimeout clamps a requested timeout to the policy maximum", () => {
  const policy: AwaitPolicy = { minPollIntervalMs: 100, maxPollIntervalMs: 1_000, maxAwaitMs: 5_000, jitterRatio: 0 };
  assert.equal(boundAwaitTimeout(20_000, policy), 5_000);
  assert.equal(boundAwaitTimeout(1_000, policy), 1_000);
});

test("boundAwaitTimeout falls back to the policy maximum for missing or non-positive requests", () => {
  const policy: AwaitPolicy = { minPollIntervalMs: 100, maxPollIntervalMs: 1_000, maxAwaitMs: 5_000, jitterRatio: 0 };
  assert.equal(boundAwaitTimeout(undefined, policy), 5_000);
  assert.equal(boundAwaitTimeout(0, policy), 5_000);
  assert.equal(boundAwaitTimeout(-10, policy), 5_000);
  assert.equal(boundAwaitTimeout(Number.NaN, policy), 5_000);
});

test("nextPollDelayMs never goes below minPollIntervalMs or above maxPollIntervalMs across many attempts", () => {
  const policy: AwaitPolicy = { minPollIntervalMs: 250, maxPollIntervalMs: 4_000, maxAwaitMs: 60_000, jitterRatio: 0.3 };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = nextPollDelayMs(attempt, policy, () => random);
      assert.ok(delay >= policy.minPollIntervalMs, `delay ${delay} below min at attempt ${attempt}`);
      assert.ok(delay <= policy.maxPollIntervalMs, `delay ${delay} above max at attempt ${attempt}`);
    }
  }
});

test("nextPollDelayMs grows with attempt count before hitting the cap (bounded backoff)", () => {
  const policy: AwaitPolicy = { minPollIntervalMs: 100, maxPollIntervalMs: 10_000, maxAwaitMs: 60_000, jitterRatio: 0 };
  const first = nextPollDelayMs(0, policy, () => 0.5);
  const second = nextPollDelayMs(1, policy, () => 0.5);
  const third = nextPollDelayMs(2, policy, () => 0.5);
  assert.ok(second >= first);
  assert.ok(third >= second);
});

test("nextPollDelayMs applies jitter so repeated calls at the same attempt are not identical", () => {
  const policy = DEFAULT_AWAIT_POLICY;
  const values = new Set<number>();
  let seed = 0;
  const random = (): number => { seed = (seed + 0.137) % 1; return seed; };
  for (let i = 0; i < 5; i += 1) values.add(nextPollDelayMs(3, policy, random));
  assert.ok(values.size > 1, "jitter should vary the delay across calls");
});
