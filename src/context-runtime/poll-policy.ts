/**
 * await/watch が使う集中管理された polling policy（Issue #74）。
 *
 * agent は間隔を指定しない — runtime だけが interval/backoff/jitter/timeout を決める。
 * provider rate limit を悪化させないための唯一の制御点。
 */
export interface AwaitPolicy {
  minPollIntervalMs: number;
  maxPollIntervalMs: number;
  maxAwaitMs: number;
  jitterRatio: number;
}

export const DEFAULT_AWAIT_POLICY: AwaitPolicy = {
  minPollIntervalMs: 250,
  maxPollIntervalMs: 15_000,
  maxAwaitMs: 120_000,
  jitterRatio: 0.2,
};

/** 呼び出し側が要求した timeout を policy の上限で bound する。0 以下や未指定は policy 既定値。 */
export function boundAwaitTimeout(requestedMs: number | undefined, policy: AwaitPolicy): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) return policy.maxAwaitMs;
  return Math.min(requestedMs, policy.maxAwaitMs);
}

/**
 * 指数 backoff + jitter で次回 poll までの待機時間を決める。attempt は 0 始まり。
 * `random` はテストで決定論的にするための注入点（既定 `Math.random`）。
 */
export function nextPollDelayMs(attempt: number, policy: AwaitPolicy, random: () => number = Math.random): number {
  const exponential = policy.minPollIntervalMs * 2 ** attempt;
  const bounded = Math.min(exponential, policy.maxPollIntervalMs);
  const jitter = bounded * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(policy.minPollIntervalMs, Math.min(policy.maxPollIntervalMs, Math.round(bounded + jitter)));
}
