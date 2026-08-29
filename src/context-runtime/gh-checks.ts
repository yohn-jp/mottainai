import type { AwaitPolicy } from "./poll-policy.js";
import { nextPollDelayMs } from "./poll-policy.js";

export interface CheckSnapshot {
  name: string;
  state: string;
}

export interface CheckDelta {
  name: string;
  /** `null` means that the check was absent from that snapshot. */
  from: string | null;
  to: string | null;
}

export interface WaitUntilResult {
  changed: CheckDelta[];
  terminal: boolean;
  checks: CheckSnapshot[];
  pollCount: number;
  elapsedMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

/** `statusCheckRollup` の 1 件から比較用の状態文字列を作る。`conclusion` があればそれを、無ければ `status` を使う。 */
function checkState(check: { status?: string; conclusion?: string | null }): string {
  return (check.conclusion ?? check.status ?? "unknown").toLowerCase();
}

export interface RawCheck {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

export type StatusCheckRollupParseResult = { ok: true; checks: RawCheck[] } | { ok: false; reason: string };

/** `gh pr view --json statusCheckRollup` の provider output を検証・解釈する。 */
export function parseStatusCheckRollup(stdout: string): StatusCheckRollupParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { ok: false, reason: "unparsable JSON output" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "expected JSON object with statusCheckRollup" };
  }
  const payload = parsed as Record<string, unknown>;
  if (!Object.hasOwn(payload, "statusCheckRollup")) {
    return { ok: false, reason: "missing statusCheckRollup field" };
  }
  if (!Array.isArray(payload.statusCheckRollup)) {
    return { ok: false, reason: "statusCheckRollup must be an array" };
  }

  const checks: RawCheck[] = [];
  for (const [index, item] of payload.statusCheckRollup.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `statusCheckRollup[${index}] must be an object` };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      return { ok: false, reason: `statusCheckRollup[${index}].name must be a non-empty string` };
    }
    if (Object.hasOwn(record, "status") && typeof record.status !== "string") {
      return { ok: false, reason: `statusCheckRollup[${index}].status must be a string` };
    }
    if (Object.hasOwn(record, "conclusion") && record.conclusion !== null && typeof record.conclusion !== "string") {
      return { ok: false, reason: `statusCheckRollup[${index}].conclusion must be a string or null` };
    }

    const check: RawCheck = { name: record.name };
    if (Object.hasOwn(record, "status")) check.status = record.status as string;
    if (Object.hasOwn(record, "conclusion")) check.conclusion = record.conclusion as string | null;
    checks.push(check);
  }

  return { ok: true, checks };
}

export class StatusCheckRollupParseError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StatusCheckRollupParseError";
  }
}

export function normalizeChecks(raw: RawCheck[]): CheckSnapshot[] {
  return raw
    .filter((check): check is RawCheck & { name: string } => typeof check.name === "string" && check.name.length > 0)
    .map((check) => ({ name: check.name, state: checkState(check) }));
}

const TERMINAL_STATUSES = new Set(["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale"]);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATUSES.has(state);
}

function compareCheckNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** snapshot 間の membership/state 差分を、check 名順の bounded な delta として返す。 */
function diffChecks(previous: CheckSnapshot[], current: CheckSnapshot[]): CheckDelta[] {
  const previousByName = new Map(previous.map((check) => [check.name, check.state]));
  const currentByName = new Map(current.map((check) => [check.name, check.state]));
  const names = [...new Set([...previousByName.keys(), ...currentByName.keys()])].sort(compareCheckNames);

  return names.flatMap((name) => {
    const from = previousByName.get(name) ?? null;
    const to = currentByName.get(name) ?? null;
    return from === to ? [] : [{ name, from, to }];
  });
}

function allTerminal(checks: CheckSnapshot[]): boolean {
  return checks.length > 0 && checks.every((check) => isTerminalState(check.state));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted === true) finish();
  });
}

function cancelledResult(
  startedAt: number,
  now: () => number,
  checks: CheckSnapshot[],
  pollCount: number,
): WaitUntilResult {
  return {
    changed: [],
    terminal: false,
    checks,
    pollCount,
    elapsedMs: now() - startedAt,
    cancelled: true,
  };
}

export interface WaitUntilDeps {
  fetchChecks: (signal?: AbortSignal) => Promise<CheckSnapshot[]>;
  policy: AwaitPolicy;
  timeoutMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * provider/status の await primitive（Issue #74）。runtime が interval/backoff/jitter を集中管理し、
 * agent には interval 指定を許さない。terminal state・意味のある変化・timeout のいずれかで一度だけ戻る。
 * 変化の無い中間 snapshot は呼び出し元へ返さない（`changed` が空のまま poll を続ける）。
 */
export async function waitUntilChanged(deps: WaitUntilDeps): Promise<WaitUntilResult> {
  const sleep = deps.sleep ?? sleepFor;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let previous: CheckSnapshot[] | undefined;
  let pollCount = 0;

  for (;;) {
    if (isAborted(deps.signal)) return cancelledResult(startedAt, now, previous ?? [], pollCount);
    pollCount += 1;

    let current: CheckSnapshot[];
    try {
      current = await deps.fetchChecks(deps.signal);
    } catch (error) {
      if (isAborted(deps.signal)) return cancelledResult(startedAt, now, previous ?? [], pollCount);
      throw error;
    }
    if (isAborted(deps.signal)) return cancelledResult(startedAt, now, current, pollCount);

    const changed = previous === undefined ? [] : diffChecks(previous, current);
    const terminal = allTerminal(current);
    const elapsedMs = now() - startedAt;

    if (terminal || changed.length > 0) {
      return { changed, terminal, checks: current, pollCount, elapsedMs };
    }

    previous = current;
    const remaining = deps.timeoutMs - elapsedMs;
    if (remaining <= 0) {
      return { changed: [], terminal: false, checks: current, pollCount, elapsedMs, timedOut: true };
    }

    if (isAborted(deps.signal)) return cancelledResult(startedAt, now, current, pollCount);
    const delay = Math.min(nextPollDelayMs(pollCount - 1, deps.policy, deps.random), remaining);
    try {
      await sleep(delay, deps.signal);
    } catch (error) {
      if (isAborted(deps.signal)) return cancelledResult(startedAt, now, current, pollCount);
      throw error;
    }
    if (isAborted(deps.signal)) return cancelledResult(startedAt, now, current, pollCount);
  }
}
