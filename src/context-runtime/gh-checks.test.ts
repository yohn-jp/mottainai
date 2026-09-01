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
    { name: "coverage/primary", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "coverage/package", status: "IN_PROGRESS", conclusion: null },
    { name: "", status: "QUEUED" },
  ]);
  assert.deepEqual(checks, [
    { name: "coverage/primary", state: "success" },
    { name: "coverage/package", state: "in_progress" },
  ]);
});

test("parseStatusCheckRollup accepts a valid empty rollup", () => {
  assert.deepEqual(parseStatusCheckRollup(JSON.stringify({ statusCheckRollup: [] })), { ok: true, checks: [] });
});

test("parseStatusCheckRollup accepts valid non-empty checks and preserves normalization inputs", () => {
  const result = parseStatusCheckRollup(
    JSON.stringify({
      statusCheckRollup: [
        { name: "coverage/primary", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "coverage/package", status: "IN_PROGRESS", conclusion: null },
      ],
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    checks: [
      { name: "coverage/primary", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "coverage/package", status: "IN_PROGRESS", conclusion: null },
    ],
  });
  if (result.ok) {
    assert.deepEqual(normalizeChecks(result.checks), [
      { name: "coverage/primary", state: "success" },
      { name: "coverage/package", state: "in_progress" },
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

test("waitUntilChanged reports one newly added check as an explicit membership delta", async () => {
  let call = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => {
      call += 1;
      return call === 1
        ? [{ name: "build", state: "in_progress" }]
        : [
            { name: "build", state: "in_progress" },
            { name: "lint", state: "queued" },
          ];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.deepEqual(result.changed, [{ name: "lint", from: null, to: "queued" }]);
});

test("waitUntilChanged reports one removed check as an explicit membership delta", async () => {
  let call = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => {
      call += 1;
      return call === 1
        ? [
            { name: "build", state: "in_progress" },
            { name: "lint", state: "queued" },
          ]
        : [{ name: "build", state: "in_progress" }];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.deepEqual(result.changed, [{ name: "lint", from: "queued", to: null }]);
});

test("waitUntilChanged returns simultaneous membership and state deltas in deterministic name order", async () => {
  let call = 0;
  const result = await waitUntilChanged({
    fetchChecks: async () => {
      call += 1;
      return call === 1
        ? [
            { name: "same", state: "in_progress" },
            { name: "gone", state: "queued" },
            { name: "build", state: "queued" },
          ]
        : [
            { name: "new", state: "queued" },
            { name: "same", state: "in_progress" },
            { name: "build", state: "in_progress" },
          ];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    sleep: noSleep,
  });
  assert.deepEqual(result.changed, [
    { name: "build", from: "queued", to: "in_progress" },
    { name: "gone", from: "queued", to: null },
    { name: "new", from: null, to: "queued" },
  ]);
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

test("waitUntilChanged does not fetch when cancellation is already observed", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCount = 0;

  const result = await waitUntilChanged({
    fetchChecks: async () => {
      fetchCount += 1;
      return [];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    signal: controller.signal,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.pollCount, 0);
  assert.equal(fetchCount, 0);
});

test("waitUntilChanged cancels an in-flight sleep without starting another poll", async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  let sleepCount = 0;
  let logicalNow = 0;
  let markSleepStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    markSleepStarted = resolve;
  });

  const waitPromise = waitUntilChanged({
    fetchChecks: async (signal) => {
      assert.equal(signal, controller.signal);
      fetchCount += 1;
      return [{ name: "build", state: "in_progress" }];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    signal: controller.signal,
    now: () => logicalNow,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        sleepCount += 1;
        markSleepStarted();
        signal?.addEventListener(
          "abort",
          () => {
            logicalNow = 25;
            resolve();
          },
          { once: true },
        );
      }),
  });

  await sleepStarted;
  controller.abort();
  const result = await waitPromise;

  assert.equal(result.cancelled, true);
  assert.equal(result.pollCount, 1);
  assert.equal(result.elapsedMs, 25);
  assert.equal(fetchCount, 1);
  assert.equal(sleepCount, 1);
});

test("waitUntilChanged propagates cancellation into an in-flight fetch", async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  let sleepCount = 0;
  let logicalNow = 0;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });

  const waitPromise = waitUntilChanged({
    fetchChecks: (signal) => {
      assert.equal(signal, controller.signal);
      fetchCount += 1;
      markFetchStarted();
      return new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            logicalNow = 40;
            resolve([{ name: "build", state: "in_progress" }]);
          },
          { once: true },
        );
      });
    },
    policy: POLICY,
    timeoutMs: 1_000,
    signal: controller.signal,
    now: () => logicalNow,
    sleep: async () => {
      sleepCount += 1;
    },
  });

  await fetchStarted;
  controller.abort();
  const result = await waitPromise;

  assert.equal(result.cancelled, true);
  assert.equal(result.pollCount, 1);
  assert.equal(result.elapsedMs, 40);
  assert.equal(fetchCount, 1);
  assert.equal(sleepCount, 0);
});

test("waitUntilChanged records cancellation after multiple polls and stops the loop", async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  let sleepCount = 0;
  let logicalNow = 0;

  const result = await waitUntilChanged({
    fetchChecks: async () => {
      fetchCount += 1;
      return [{ name: "build", state: "in_progress" }];
    },
    policy: POLICY,
    timeoutMs: 1_000,
    signal: controller.signal,
    now: () => logicalNow,
    sleep: async (_ms, signal) => {
      sleepCount += 1;
      if (sleepCount === 2) {
        logicalNow = 60;
        controller.abort();
      }
      assert.equal(signal, controller.signal);
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.pollCount, 2);
  assert.equal(result.elapsedMs, 60);
  assert.equal(fetchCount, 2);
  assert.equal(sleepCount, 2);
});
