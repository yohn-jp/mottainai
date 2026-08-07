/**
 * Issue-bound task の versioned lifecycle state machine（Issue #28 Child 4）。
 * 遷移の合法性判定のみを持つ純粋関数群 — 検出（orphaned への遷移が必要かどうか）・
 * 実行（cleaned への実際の削除処理）は Child Issue 7/8 の責務であり、ここでは
 * 「その遷移が状態機械上許可されるか」だけを扱う。
 */

export const LIFECYCLE_STATES = [
  "planned",
  "active",
  "committed",
  "pushed",
  "pull-request-open",
  "merged",
  "abandoned",
  "orphaned",
  "cleaned",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_SCHEMA_VERSION = 1;

export interface TransitionBlockedInfo {
  currentState: LifecycleState;
  requestedTransition: LifecycleState;
  blockingRule: string;
  allowedNextTransitions: LifecycleState[];
}

export type TransitionValidation =
  | { allowed: true; from: LifecycleState; to: LifecycleState }
  | { allowed: false; blocked: TransitionBlockedInfo };

/**
 * 遷移表。`orphaned`→`active`は、Child Issue 7/8のreconciliationが検出済みの
 * orphaned taskを再アダプションできるようにするための遷移で、この Child では
 * 到達するcaller自体は無い（状態機械としての定義のみが受入基準の対象）。
 */
const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  planned: ["active", "abandoned"],
  active: ["committed", "abandoned", "orphaned"],
  committed: ["pushed", "abandoned", "orphaned"],
  pushed: ["pull-request-open", "abandoned", "orphaned"],
  "pull-request-open": ["merged", "abandoned", "orphaned"],
  merged: ["cleaned"],
  abandoned: ["cleaned"],
  orphaned: ["cleaned", "active"],
  cleaned: [],
};

export function allowedNextTransitions(state: LifecycleState): LifecycleState[] {
  return [...TRANSITIONS[state]];
}

function blockingRuleFor(from: LifecycleState, to: LifecycleState): string {
  if (TRANSITIONS[from].length === 0) return `${from} is a terminal state; no further transitions are allowed`;
  if (from === to) return `${from} is already the current state; re-entrant transitions are not modeled`;
  return `no direct transition from ${from} to ${to}; allowed: ${TRANSITIONS[from].join(", ") || "(none)"}`;
}

export function validateTransition(from: LifecycleState, to: LifecycleState): TransitionValidation {
  if (TRANSITIONS[from].includes(to)) {
    return { allowed: true, from, to };
  }
  return {
    allowed: false,
    blocked: {
      currentState: from,
      requestedTransition: to,
      blockingRule: blockingRuleFor(from, to),
      allowedNextTransitions: allowedNextTransitions(from),
    },
  };
}
