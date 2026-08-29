import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTerminalState,
  normalizeChecks,
  parseStatusCheckRollup,
  StatusCheckRollupParseError,
  waitUntilChanged,
} from "./gh-checks.js";
import type { AwaitPolicy } from "./poll-policy.js";

const POLICY: AwaitPolicy = { minPollIntervalMs: 10, maxPollIntervalMs: 40, maxAwaitMs: 5_000, jitterRatio: 0 };

function noSleep(): Promise<void> {
  return Promise.resolve();
}

test("normalizeChecks maps conclusion over status and lowercases state", () => {
  const checks = normalizeChecks([
    { name: "coverage/node22", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "coverage/node24", status: "IN_PROGRESS", conclusion: null },
    { name: "", status: "QUEUED" },
  ]);
  assert.deepEqual(checks, [
    { name: "coverage/node22", state: "success" },
    { name: "coverage/node24", state: "in_progress" },
  ]);
});

test("parseStatusCheckRollup accepts a valid empty rollup", () => {
  assert.deepEqual(parseStatusCheckRollup(JSON.stringify({ statusCheckRollup: [] })), { ok: true, checks: [] });
});

test("parseStatusCheckRollup accepts valid non-empty checks and preserves normalization inputs", () => {
  const result = parseStatusCheckRollup(
    JSON.stringify({
      statusCheckRollup: [
        { name: "coverage/node22", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "coverage/node24", status: "IN_PROGRESS", conclusion: null },
      ],
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    checks: [
      { name: "coverage/node22", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "coverage/node24", status: "IN_PROGRESS", conclusion: null },
    ],
  });
  if (result.ok) {
    assert.deepEqual(normalizeChecks(result.checks), [
      { name: "coverage/node22", state: "success" },
      { name: "coverage/node24", state: "in_progress" },
    ]);
  }
});

test("parseStatusCheckRollup rejects malformed provider output with bounded reasons", () => {
  const malformed = [
    ["not-json-provider-secret", "unparsable JSON output"],
    [JSON.stringify(["wrong-container"]), "expected JSON object with statusCheckRollup"],
    [JSON.stringify({}), "missing statusCheckRollup field"],
    [JSON.stringify({ statusCheckRollup: {} }), "statusCheckRollup must be an array"],
    [JSON.stringify({ statusCheckRollup: [null] }), "statusCheckRollup[0] must be an object"],
    [JSON.stringify({ statusCheckRollup: [{ name: 42 }] }), "statusCheckRollup[0].name must be a non-empty string"],
    [
      JSON.stringify({ statusCheckRollup: [{ name: "build", status: 42 }] }),
      "statusCheckRollup[0].status must be a string",
    ],
    [
      JSON.stringify({ statusCheckRollup: [{ name: "build", conclusion: {} }] }),
      "statusCheckRollup[0].conclusion must be a string or null",
    ],
  ] as const;

  for (const [stdout, reason] of malformed) {
    const result = parseStatusCheckRollup(stdout);
    assert.deepEqual(result, { ok: false, reason });
    assert.doesNotMatch(result.reason, /provider-secret/);
  }
});

test("isTerminalState recognizes terminal conclusions and rejects in-flight ones", () => {
  assert.equal(isTerminalState("success"), true);
  assert.equal(isTerminalState("failure"), true);
  assert.equal(isTerminalState("in_progress"), false);
  assert.equal(isTerminalState("queued"), false);
});

test("waitUntilChanged returns immediately once every check reaches a terminal state", async () => {
  const result = await waitUntilChanged({
    fetchChecks: async () => [{ name: "build", state: "success" }, { name: "test", state: "failure" }],
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.equal(result.terminal, true);
  assert.equal(result.pollCount, 1);
  assert.equal(result.timedOut, undefined);
});

test("waitUntilChanged establishes a baseline on the first poll, then returns once a tracked check actually changes", async () => {
  const snapshots: Array<Array<{ name: string; state: string }>> = [
    [{ name: "build", state: "queued" }],
    [{ name: "build", state: "in_progress" }],
    [{ name: "build", state: "in_progress" }],
  ];
  let call = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => snapshots[Math.min(call++, snapshots.length - 1)],
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  // the first poll (queued) is baseline only — not reported as a delta. The second poll
  // (queued -> in_progress) is the first real change and is what gets returned.
  assert.equal(result.pollCount, 2);
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.changed[0], { name: "build", from: "queued", to: "in_progress" });
});

test("waitUntilChanged returns immediately on the first poll if it is already terminal, without requiring a baseline round-trip", async () => {
  const result = await waitUntilChanged({
    fetchChecks: async () => [{ name: "build", state: "success" }],
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.equal(result.pollCount, 1);
  assert.equal(result.terminal, true);
});

test("waitUntilChanged does not return a snapshot when nothing changed until timeout, then reports last-known state", async () => {
  let now = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => [{ name: "build", state: "in_progress" }],
    policy: POLICY,
    timeoutMs: 25,
    sleep: async () => { now += 15; },
    now: () => now,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.changed.length, 0);
  assert.equal(result.terminal, false);
  assert.ok(result.pollCount >= 1);
});

test("waitUntilChanged tolerates a transient fetch error by treating it as an empty, non-terminal snapshot and retrying", async () => {
  let call = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => {
      call += 1;
      if (call === 1) return [];
      return [{ name: "build", state: "success" }];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.equal(result.terminal, true);
  assert.equal(call, 2);
});

test("waitUntilChanged propagates a provider contract failure instead of fabricating an empty snapshot", async () => {
  await assert.rejects(
    () =>
      waitUntilChanged({
        fetchChecks: async () => {
          throw new StatusCheckRollupParseError("malformed statusCheckRollup");
        },
        policy: POLICY,
        timeoutMs: 1_000,
        sleep: noSleep,
      }),
    (error: unknown) => error instanceof StatusCheckRollupParseError && error.reason === "malformed statusCheckRollup",
  );
});

test("waitUntilChanged bounds each poll delay within the policy min/max regardless of attempt count", async () => {
  const delays: number[] = [];
  let call = 0;
  await waitUntilChanged({
    fetchChecks: async () => {
      call += 1;
      return call > 6 ? [{ name: "build", state: "success" }] : [{ name: "build", state: "in_progress" }];
    },
    policy: POLICY,
    timeoutMs: 10_000,
    sleep: async (ms) => { delays.push(ms); },
  });
  for (const delay of delays) {
    assert.ok(delay >= POLICY.minPollIntervalMs);
    assert.ok(delay <= POLICY.maxPollIntervalMs);
  }
});
