import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BurstBudgetController,
  DEFAULT_BURST_BUDGET_POLICY,
  isBlockingProjection,
  resolveBurstBudgetPolicy,
} from "./burst-budget.js";
import type { BurstAdmission, BurstBudgetMode, BurstBudgetTelemetry, BurstReservation } from "./burst-budget.js";

function policy(overrides: Partial<typeof DEFAULT_BURST_BUDGET_POLICY> = {}) {
  return { ...DEFAULT_BURST_BUDGET_POLICY, mode: "enforce" as const, ...overrides };
}

/** dispatch 前に reserve → 結果判明後に updatePriority、という本番の流れを再現するヘルパー。 */
function reserve(controller: BurstBudgetController, isBlocking = false): BurstReservation {
  const reservation = controller.reserveEnvelope();
  controller.updatePriority(reservation, isBlocking);
  return reservation;
}

function recordingTelemetry(): { telemetry: BurstBudgetTelemetry; reduced: Array<{ reason: string; reduced: boolean }> } {
  const reduced: Array<{ reason: string; reduced: boolean }> = [];
  return {
    telemetry: {
      recordPressure() {},
      recordReduced(input) {
        reduced.push({ reason: input.reason, reduced: input.reduced });
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
  const reservation = reserve(controller);
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
    const reservations = [0, 1, 2, 3].map(() => reserve(controller));
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

test("many small calls: admissions form a strict priority-rank prefix (once rejected, every lower-priority call is also rejected)", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 500, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  // envelope cost (MIN_ENVELOPE_TOKENS=64) が同順位のタイブレークを決める。10 個同時、各 50 tokens 要求。
  const reservations = Array.from({ length: 10 }, () => reserve(controller));
  const admissions = reservations.map((reservation) => controller.admitOptional(reservation, 50, 200).admitted);
  assert.ok(admissions.some((admitted) => admitted));
  assert.ok(admissions.includes(false));
  // admit された集合は優先順位（登録順）の prefix でなければならない: 一度 false になったら
  // それ以降（＝より低優先）は全部 false。
  const firstRejected = admissions.indexOf(false);
  assert.deepEqual(admissions.slice(firstRejected), new Array(admissions.length - firstRejected).fill(false));
});

test("one large plus several small calls: the large call does not starve the concurrent pool for the small ones registered before it", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 1_000, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  const small = [reserve(controller), reserve(controller), reserve(controller)];
  const large = reserve(controller);
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
  const successes = [reserve(controller, false), reserve(controller, false), reserve(controller, false)];
  const failure = reserve(controller, true);
  const failureAdmission = controller.admitOptional(failure, 150, 600).admitted;
  const successAdmissions = successes.map((reservation) => controller.admitOptional(reservation, 150, 600).admitted);
  assert.equal(failureAdmission, true);
  assert.ok(successAdmissions.some((admitted) => !admitted), "at least one success should be squeezed out by the reserved failure priority");
});

test("updatePriority applied after reservation still influences admission ranking (dispatch result determines isBlocking later)", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 300, rollingProjectedTokens: 100_000, rollingProjectedBytes: 400_000 });
  const controller = new BurstBudgetController(budget);
  // 本番同様、reserve は dispatch 前（isBlocking 不明）に行い、dispatch 結果が出てから
  // updatePriority で確定する。
  const successReservations = [controller.reserveEnvelope(), controller.reserveEnvelope(), controller.reserveEnvelope()];
  const failureReservation = controller.reserveEnvelope();
  for (const reservation of successReservations) controller.updatePriority(reservation, false);
  controller.updatePriority(failureReservation, true);

  const failureAdmission = controller.admitOptional(failureReservation, 150, 600).admitted;
  const successAdmissions = successReservations.map((reservation) => controller.admitOptional(reservation, 150, 600).admitted);
  assert.equal(failureAdmission, true);
  assert.ok(successAdmissions.some((admitted) => !admitted));
});

test("rolling-window refill: budget denied inside the window becomes available again once the window elapses", () => {
  let now = 0;
  const budget = policy({ rollingWindowMs: 100, rollingProjectedTokens: 200, rollingProjectedBytes: 4_000, maxConcurrentProjectedTokens: 100_000 });
  const controller = new BurstBudgetController(budget, undefined, () => now);

  const first = reserve(controller);
  const firstAdmission = controller.admitOptional(first, 150, 600);
  controller.release(first);
  assert.equal(firstAdmission.admitted, true);

  const second = reserve(controller);
  const secondAdmission = controller.admitOptional(second, 100, 400);
  controller.release(second);
  assert.equal(secondAdmission.admitted, false, "rolling window still holds the first call's usage");

  now += 150; // rollingWindowMs 経過 → 最初の使用量が減衰する
  const third = reserve(controller);
  const thirdAdmission = controller.admitOptional(third, 100, 400);
  controller.release(third);
  assert.equal(thirdAdmission.admitted, true, "usage decayed out of the rolling window, budget refilled");
});

test("connection isolation: two independently constructed controllers never share budget state", () => {
  const budget = policy({ maxConcurrentProjectedTokens: 100, rollingProjectedTokens: 100, rollingProjectedBytes: 400 });
  const controllerA = new BurstBudgetController(budget);
  const controllerB = new BurstBudgetController(budget);

  const reservationA = reserve(controllerA);
  const exhaustA = controllerA.admitOptional(reservationA, 100, 400);
  assert.equal(exhaustA.admitted, true);

  const reservationB = reserve(controllerB);
  const admissionB = controllerB.admitOptional(reservationB, 100, 400);
  assert.equal(admissionB.admitted, true, "controller B must not observe controller A's consumption");
});

test("teardown cleanup: dispose clears in-flight/rolling state and further reservations throw", () => {
  const controller = new BurstBudgetController(policy());
  const reservation = reserve(controller);
  controller.admitOptional(reservation, 100, 400);
  controller.dispose();
  assert.throws(() => controller.reserveEnvelope(), /disposed/);
});

test("off/observe/warn never reduce the effective admission; only enforce does", () => {
  const heavyBudget = { ...DEFAULT_BURST_BUDGET_POLICY, maxConcurrentProjectedTokens: 10, rollingProjectedTokens: 10, rollingProjectedBytes: 10 };
  for (const mode of ["off", "observe", "warn"] as const) {
    const controller = new BurstBudgetController({ ...heavyBudget, mode });
    const reservation = reserve(controller);
    const admission = controller.admitOptional(reservation, 10_000, 40_000);
    assert.equal(admission.admitted, true, `mode=${mode} must not reduce agent-visible admission`);
  }
  const enforceController = new BurstBudgetController({ ...heavyBudget, mode: "enforce" });
  const reservation = reserve(enforceController);
  const admission = enforceController.admitOptional(reservation, 10_000, 40_000);
  assert.equal(admission.admitted, false);
});

test("warn mode records a would-be reduction (reduced: false) while enforce records an actual one (reduced: true)", () => {
  const heavyBudget = { ...DEFAULT_BURST_BUDGET_POLICY, maxConcurrentProjectedTokens: 10, rollingProjectedTokens: 10, rollingProjectedBytes: 10 };

  const warn = recordingTelemetry();
  const warnController = new BurstBudgetController({ ...heavyBudget, mode: "warn" }, warn.telemetry);
  const warnAdmission: BurstAdmission = warnController.admitOptional(reserve(warnController), 10_000, 40_000);
  assert.equal(warnAdmission.admitted, true);
  assert.ok(warn.reduced.length > 0);
  assert.ok(warn.reduced.every((entry) => entry.reduced === false), "warn mode must not report an actual reduction");

  const enforce = recordingTelemetry();
  const enforceController = new BurstBudgetController({ ...heavyBudget, mode: "enforce" }, enforce.telemetry);
  const enforceAdmission = enforceController.admitOptional(reserve(enforceController), 10_000, 40_000);
  assert.equal(enforceAdmission.admitted, false);
  assert.ok(enforce.reduced.length > 0);
  assert.ok(enforce.reduced.every((entry) => entry.reduced === true), "enforce mode must report an actual reduction");
});

test("enforce mode charges the reduced response's minimal-envelope cost to the rolling window, not zero", () => {
  let now = 0;
  const budget = policy({ rollingWindowMs: 1_000, rollingProjectedTokens: 1_000, rollingProjectedBytes: 4_000, maxConcurrentProjectedTokens: 100_000 });
  const controller = new BurstBudgetController(budget, undefined, () => now);
  const rejected = reserve(controller);
  const admission = controller.admitOptional(rejected, 2_000, 8_000);
  assert.equal(admission.admitted, false);
  controller.release(rejected);

  // 直後にもう 1 回、rolling budget いっぱいの要求を送る。0 計上なら通ってしまうが、
  // 縮小後の最小 envelope 分（MIN_ENVELOPE_TOKENS=64）は計上されているはずなので、
  // budget いっぱいの要求はわずかに超過して拒否される。
  const next = reserve(controller);
  const nextAdmission = controller.admitOptional(next, 1_000, 4_000);
  assert.equal(nextAdmission.admitted, false, "the reduced response's minimal-envelope cost must still occupy rolling budget");
});

test("isBlockingProjection detects failed status and error-severity diagnostics", () => {
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [] }), false);
  assert.equal(isBlockingProjection({ status: "failed", diagnostics: [] }), true);
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [{ severity: "error", message: "boom" }] }), true);
  assert.equal(isBlockingProjection({ status: "success", diagnostics: [{ severity: "info", message: "note" }] }), false);
});
