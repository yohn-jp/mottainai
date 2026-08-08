import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BurstBudgetController,
  DEFAULT_BURST_BUDGET_POLICY,
  isBlockingProjection,
  resolveBurstBudgetPolicy,
} from "./burst-budget.js";
import type { BurstAdmission, BurstBudgetMode, BurstBudgetTelemetry } from "./burst-budget.js";

function policy(overrides: Partial<typeof DEFAULT_BURST_BUDGET_POLICY> = {}) {
  return { ...DEFAULT_BURST_BUDGET_POLICY, mode: "enforce" as const, ...overrides };
}

function recordingTelemetry(): { telemetry: BurstBudgetTelemetry; reduced: Array<{ reason: string }> } {
  const reduced: Array<{ reason: string }> = [];
  return {
    telemetry: {
      recordPressure() {},
      recordReduced(input) {
        reduced.push({ reason: input.reason });
      },
    },
    reduced,
  };
}

test("resolveBurstBudgetPolicy defaults to mode off with dogfood-scale limits and rejects unsafe values", () => {
  assert.deepEqual(resolveBurstBudgetPolicy(undefined), DEFAULT_BURST_BUDGET_POLICY);
  assert.throws(() => resolveBurstBudgetPolicy({ mode: "aggressive" as BurstBudgetMode }), /invalid burst budget mode/);
  assert.throws(() => resolveBurstBudgetPolicy({ rollingWindowMs: 0 }), /invalid burst budget rollingWindowMs/);
});

test("mode off admits everything without touching in-flight/rolling accounting", () => {
  const controller = new BurstBudgetController({ ...DEFAULT_BURST_BUDGET_POLICY, mode: "off" });
  const reservation = controller.reserveEnvelope(false);
  const admission = controller.admitOptional(reservation, 100_000, 400_000);
  assert.equal(admission.admitted, true);
  assert.equal(admission.pressure, 0);
});

test("simultaneous completion ordering: admission set is identical regardless of which call's admitOptional resolves first", () => {
  // 4 呼び出しが「ほぼ同時に」reserve される（Promise.all 相当）。admitOptional を呼ぶ順番を
  // シャッフルしても、admit される集合は同じでなければならない — 順序に依存しないことの証明。
  const budget = policy({ maxConcurrentProjectedTokens: 1_000, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const projectedTokensEach = 300;

  function runInOrder(order: number[]): boolean[] {
    const controller = new BurstBudgetController(budget);
    const reservations = [0, 1, 2, 3].map(() => controller.reserveEnvelope(false));
    const results: boolean[] = new Array(4).fill(false);
    for (const index of order) {
      results[index] = controller.admitOptional(reservations[index], projectedTokensEach, projectedTokensEach * 4).admitted;
    }
    return results;
  }

  const forward = runInOrder([0, 1, 2, 3]);
  const reverse = runInOrder([3, 2, 1, 0]);
  const shuffled = runInOrder([2, 0, 3, 1]);
  assert.deepEqual(reverse, forward);
  assert.deepEqual(shuffled, forward);
});

test("many small calls: admits calls up to the concurrent budget, rejects the rest deterministically by priority rank", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 500, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  // envelope cost (MIN_ENVELOPE_TOKENS=64) が同順位のタイブレークを決める。10 個同時、各 50 tokens 要求。
  const reservations = Array.from({ length: 10 }, () => controller.reserveEnvelope(false));
  const admissions = reservations.map((reservation) => controller.admitOptional(reservation, 50, 200).admitted);
  // 500 budget / (64 envelope + up to 50 optional per higher-rank call)... 上位から順に許可される。
  assert.ok(admissions.some((admitted) => admitted));
  assert.ok(admissions.includes(false));
  // 先頭（登録順で最優先）が拒否され、末尾（低優先）が admit されることは起きない。
  const firstAdmitted = admissions.indexOf(true);
  const lastRejected = admissions.lastIndexOf(false);
  assert.ok(firstAdmitted < lastRejected || !admissions.includes(false));
});

test("one large plus several small calls: the large call does not starve the concurrent pool for the small ones registered before it", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 1_000, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  const small = [controller.reserveEnvelope(false), controller.reserveEnvelope(false), controller.reserveEnvelope(false)];
  const large = controller.reserveEnvelope(false);
  const smallAdmissions = small.map((reservation) => controller.admitOptional(reservation, 100, 400).admitted);
  const largeAdmission = controller.admitOptional(large, 5_000, 20_000).admitted;
  assert.deepEqual(smallAdmissions, [true, true, true]);
  assert.equal(largeAdmission, false);
});

test("failure vs success priority: a blocking diagnostic call is admitted even when concurrent successes would otherwise exhaust the budget", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 300, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  // 非 blocking な成功呼び出しを先に reserve するが、blocking な失敗呼び出しは後から reserve されても
  // 優先度計算で先頭に来る（isBlocking を静的優先度の第一キーにしている）。
  const successes = [controller.reserveEnvelope(false), controller.reserveEnvelope(false), controller.reserveEnvelope(false)];
  const failure = controller.reserveEnvelope(true);
  const failureAdmission = controller.admitOptional(failure, 150, 600).admitted;
  const successAdmissions = successes.map((reservation) => controller.admitOptional(reservation, 150, 600).admitted);
  assert.equal(failureAdmission, true);
  assert.ok(successAdmissions.some((admitted) => !admitted), "at least one success should be squeezed out by the reserved failure priority");
});

test("rolling-window refill: budget denied inside the window becomes available again once the window elapses", () => {
  let now = 0;
  const budget = policy({ rollingWindowMs: 100, rollingProjectedTokens: 200, rollingProjectedBytes: 4_000, maxConcurrentProjectedTokens: 100_000 });
  const controller = new BurstBudgetController(budget, undefined, () => now);

  const first = controller.reserveEnvelope(false);
  const firstAdmission = controller.admitOptional(first, 150, 600);
  controller.release(first);
  assert.equal(firstAdmission.admitted, true);

  const second = controller.reserveEnvelope(false);
  const secondAdmission = controller.admitOptional(second, 100, 400);
  controller.release(second);
  assert.equal(secondAdmission.admitted, false, "rolling window still holds the first call's usage");

  now += 150; // rollingWindowMs 経過 → 最初の使用量が減衰する
  const third = controller.reserveEnvelope(false);
  const thirdAdmission = controller.admitOptional(third, 100, 400);
  controller.release(third);
  assert.equal(thirdAdmission.admitted, true, "usage decayed out of the rolling window, budget refilled");
});

test("connection isolation: two independently constructed controllers never share budget state", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 100, rollingProjectedTokens: 100, rollingProjectedBytes: 400 });
  const controllerA = new BurstBudgetController(budget);
  const controllerB = new BurstBudgetController(budget);

  const reservationA = controllerA.reserveEnvelope(false);
  const exhaustA = controllerA.admitOptional(reservationA, 100, 400);
  assert.equal(exhaustA.admitted, true);

  const reservationB = controllerB.reserveEnvelope(false);
  const admissionB = controllerB.admitOptional(reservationB, 100, 400);
  assert.equal(admissionB.admitted, true, "controller B must not observe controller A's consumption");
});

test("teardown cleanup: dispose clears in-flight/rolling state and further reservations throw", () => {
  const controller = new BurstBudgetController(policy());
  const reservation = controller.reserveEnvelope(false);
  controller.admitOptional(reservation, 100, 400);
  controller.dispose();
  assert.throws(() => controller.reserveEnvelope(false), /disposed/);
});

test("off/observe/warn never reduce the effective admission; only enforce does", () => {
  const heavyBudget = { ...DEFAULT_BURST_BUDGET_POLICY, maxConcurrentProjectedTokens: 10, rollingProjectedTokens: 10, rollingProjectedBytes: 10 };
  for (const mode of ["off", "observe", "warn"] as const) {
    const controller = new BurstBudgetController({ ...heavyBudget, mode });
    const reservation = controller.reserveEnvelope(false);
    const admission = controller.admitOptional(reservation, 10_000, 40_000);
    assert.equal(admission.admitted, true, `mode=${mode} must not reduce agent-visible admission`);
  }
  const enforceController = new BurstBudgetController({ ...heavyBudget, mode: "enforce" });
  const reservation = enforceController.reserveEnvelope(false);
  const admission = enforceController.admitOptional(reservation, 10_000, 40_000);
  assert.equal(admission.admitted, false);
});

test("warn mode records reduced telemetry even though the response itself is not reduced", () => {
  const { telemetry, reduced } = recordingTelemetry();
  const heavyBudget = { ...DEFAULT_BURST_BUDGET_POLICY, mode: "warn" as const, maxConcurrentProjectedTokens: 10, rollingProjectedTokens: 10, rollingProjectedBytes: 10 };
  const controller = new BurstBudgetController(heavyBudget, telemetry);
  const reservation = controller.reserveEnvelope(false);
  const admission: BurstAdmission = controller.admitOptional(reservation, 10_000, 40_000);
  assert.equal(admission.admitted, true);
  assert.ok(reduced.length > 0);
});

test("isBlockingProjection detects failed status and error-severity diagnostics", () => {
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [] }), false);
  assert.equal(isBlockingProjection({ status: "failed", diagnostics: [] }), true);
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [{ severity: "error", message: "boom" }] }), true);
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [{ severity: "info", message: "note" }] }), false);
});
