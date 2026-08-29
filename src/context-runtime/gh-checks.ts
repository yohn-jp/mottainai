import type { AwaitPolicy } from "./poll-policy.js";
import { nextPollDelayMs } from "./poll-policy.js";

export interface CheckSnapshot {
  name: string;
  state: string;
}

export interface CheckDelta {
  name: string;
  from: string;
  to: string;
}

export interface WaitUntilResult {
  changed: CheckDelta[];
  terminal: boolean;
  checks: CheckSnapshot[];
  pollCount: number;
  elapsedMs: number;
  timedOut?: boolean;
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

/** 既知 check 名だけを対象に差分を取る。新規 check（`from === undefined`）は baseline 確立の一部として扱い、delta として報告しない。 */
function diffChecks(previous: CheckSnapshot[], current: CheckSnapshot[]): CheckDelta[] {
  const previousByName = new Map(previous.map((check) => [check.name, check.state]));
  const deltas: CheckDelta[] = [];
  for (const check of current) {
    const from = previousByName.get(check.name);
    if (from !== undefined && from !== check.state) deltas.push({ name: check.name, from, to: check.state });
  }
  return deltas;
}

function allTerminal(checks: CheckSnapshot[]): boolean {
  return checks.length > 0 && checks.every((check) => isTerminalState(check.state));
}

export interface WaitUntilDeps {
  fetchChecks: () => Promise<CheckSnapshot[]>;
  policy: AwaitPolicy;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/**
 * provider/status の await primitive（Issue #74）。runtime が interval/backoff/jitter を集中管理し、
 * agent には interval 指定を許さない。terminal state・意味のある変化・timeout のいずれかで一度だけ戻る。
 * 変化の無い中間 snapshot は呼び出し元へ返さない（`changed` が空のまま poll を続ける）。
 */
export async function waitUntilChanged(deps: WaitUntilDeps): Promise<WaitUntilResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let previous: CheckSnapshot[] = [];
  let pollCount = 0;

  for (;;) {
    const current = await deps.fetchChecks();
    pollCount += 1;
    const changed = diffChecks(previous, current);
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

    const delay = Math.min(nextPollDelayMs(pollCount - 1, deps.policy, deps.random), remaining);
    await sleep(delay);
  }
}
