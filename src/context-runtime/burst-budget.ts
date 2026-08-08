import { applyResponseBudget } from "./budget.js";
import { addOmission } from "./project.js";
import type { ProjectedResult } from "./types.js";

/**
 * #71 は「1レスポンスの投影」を境界にする。#73 はその上に、同一 MCP connection/session
 * が短時間に返す agent-visible projection の合計を境界づける。tool 実行・full result 保存
 * (ArtifactStore) は一切変更しない — ここで縮めるのは #71 が既に作った投影結果だけ。
 *
 * reservation/priority semantics（完了順に依存しない決定性）:
 *
 *  1. 各呼び出しは finalize 直前に `reserveEnvelope` で最小 envelope 分（固定コスト）を
 *     即時 reserve する。envelope は拒否しない — full result は必ず維持する。
 *  2. #71 が投影を作った後、`admitOptional` で「最小 envelope を超える分」の可否を問う。
 *     可否は「今どの呼び出しが同時に in-flight か」という静的集合と、各呼び出しの優先度
 *     （blocking diagnostic を含むかどうか、次に登録順）だけで決まる。どちらが先に
 *     Promise を resolve したかには依存しない。
 *  3. `release` で in-flight 集合から外す。rolling window の消費実績は時刻ベースで別途減衰。
 */

export type BurstBudgetMode = "off" | "observe" | "warn" | "enforce";

export interface BurstBudgetPolicyConfig {
  mode?: BurstBudgetMode;
  maxConcurrentProjectedTokens?: number;
  rollingWindowMs?: number;
  rollingProjectedTokens?: number;
  rollingProjectedBytes?: number;
}

export interface BurstBudgetPolicy {
  mode: BurstBudgetMode;
  maxConcurrentProjectedTokens: number;
  rollingWindowMs: number;
  rollingProjectedTokens: number;
  rollingProjectedBytes: number;
}

export const DEFAULT_BURST_BUDGET_POLICY: BurstBudgetPolicy = {
  mode: "off",
  maxConcurrentProjectedTokens: 6_000,
  rollingWindowMs: 1_500,
  rollingProjectedTokens: 8_000,
  rollingProjectedBytes: 32_000,
};

const MIN_BURST_BUDGET = {
  maxConcurrentProjectedTokens: 256,
  rollingWindowMs: 50,
  rollingProjectedTokens: 512,
  rollingProjectedBytes: 2_048,
} as const;

const MODES: readonly BurstBudgetMode[] = ["off", "observe", "warn", "enforce"];

function positiveInteger(value: number | undefined, fallback: number, field: string, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) throw new Error(`invalid burst budget ${field}`);
  return resolved;
}

export function resolveBurstBudgetPolicy(config?: BurstBudgetPolicyConfig): BurstBudgetPolicy {
  const mode = config?.mode ?? DEFAULT_BURST_BUDGET_POLICY.mode;
  if (!MODES.includes(mode)) throw new Error(`invalid burst budget mode: ${String(mode)}`);
  return {
    mode,
    maxConcurrentProjectedTokens: positiveInteger(
      config?.maxConcurrentProjectedTokens,
      DEFAULT_BURST_BUDGET_POLICY.maxConcurrentProjectedTokens,
      "maxConcurrentProjectedTokens",
      MIN_BURST_BUDGET.maxConcurrentProjectedTokens,
    ),
    rollingWindowMs: positiveInteger(
      config?.rollingWindowMs,
      DEFAULT_BURST_BUDGET_POLICY.rollingWindowMs,
      "rollingWindowMs",
      MIN_BURST_BUDGET.rollingWindowMs,
    ),
    rollingProjectedTokens: positiveInteger(
      config?.rollingProjectedTokens,
      DEFAULT_BURST_BUDGET_POLICY.rollingProjectedTokens,
      "rollingProjectedTokens",
      MIN_BURST_BUDGET.rollingProjectedTokens,
    ),
    rollingProjectedBytes: positiveInteger(
      config?.rollingProjectedBytes,
      DEFAULT_BURST_BUDGET_POLICY.rollingProjectedBytes,
      "rollingProjectedBytes",
      MIN_BURST_BUDGET.rollingProjectedBytes,
    ),
  };
}

/** #71 の envelope 最小コスト見積り。operation/status/summary/result_id/truncated/omissions の下限。 */
export const MIN_ENVELOPE_TOKENS = 64;

export interface BurstReservation {
  readonly callId: number;
  readonly isBlocking: boolean;
}

export interface BurstAdmission {
  /** true なら optional projection をそのまま返してよい。false なら burst budget で縮める。 */
  admitted: boolean;
  reason?: "concurrent_budget" | "rolling_tokens" | "rolling_bytes";
  pressure: number;
}

export interface BurstBudgetTelemetry {
  recordPressure(input: {
    mode: BurstBudgetMode;
    pressure: number;
    projectedTokens: number;
    projectedBytes: number;
  }): void;
  recordReduced(input: { mode: BurstBudgetMode; reason: string; projectedTokens: number; projectedBytes: number }): void;
}

interface InFlightEntry {
  callId: number;
  isBlocking: boolean;
  sequence: number;
}

interface RollingEntry {
  atMs: number;
  tokens: number;
  bytes: number;
}

/**
 * connection/session 単位で生成する。呼び出し側 (`proxy.ts`) が `registerProxyHandlers` の
 * closure スコープで 1 個だけ作り、teardown 時に `dispose` を呼ぶ。static/global state は
 * 持たない — 無関係な client 間で予算を共有しない。
 */
export class BurstBudgetController {
  private readonly policy: BurstBudgetPolicy;
  private readonly telemetry: BurstBudgetTelemetry | undefined;
  private readonly now: () => number;
  private readonly inFlight = new Map<number, InFlightEntry>();
  private rollingWindow: RollingEntry[] = [];
  private nextCallId = 1;
  private disposed = false;

  constructor(policy: BurstBudgetPolicy, telemetry?: BurstBudgetTelemetry, now: () => number = Date.now) {
    this.policy = policy;
    this.telemetry = telemetry;
    this.now = now;
  }

  /** 実行完了直後・投影確定前に呼ぶ。envelope 分は必ず reserve できる（拒否しない）。 */
  reserveEnvelope(isBlocking: boolean): BurstReservation {
    if (this.disposed) throw new Error("burst budget controller disposed");
    const callId = this.nextCallId++;
    this.inFlight.set(callId, { callId, isBlocking, sequence: callId });
    return { callId, isBlocking };
  }

  /**
   * #71 投影確定後、envelope を超える optional 分の可否を問う。決定は「現在 in-flight な
   * 呼び出し集合」と各呼び出しの静的優先度（blocking diagnostic を含むか、登録順）だけで
   * 決まる — どちらの Promise が先に resolve したかには依存しない。
   */
  admitOptional(reservation: BurstReservation, projectedTokens: number, projectedBytes: number): BurstAdmission {
    if (this.policy.mode === "off") return { admitted: true, pressure: 0 };

    this.decayRollingWindow();

    const entry = this.inFlight.get(reservation.callId);
    if (entry === undefined) throw new Error("unknown burst reservation");

    // 静的優先度: blocking diagnostic を持つ呼び出しは、非 blocking な呼び出しより常に優先。
    // 同順位は登録順（sequence）で安定タイブレークする。順序は in-flight 集合が固定されて
    // いれば resolve タイミングに関係なく一意に決まる。
    const cohort = [...this.inFlight.values()].sort((a, b) => {
      if (a.isBlocking !== b.isBlocking) return a.isBlocking ? -1 : 1;
      return a.sequence - b.sequence;
    });
    const rankIndex = cohort.findIndex((candidate) => candidate.callId === entry.callId);
    const higherPriorityTokens = cohort
      .slice(0, rankIndex)
      .reduce((sum) => sum + MIN_ENVELOPE_TOKENS, 0);

    const concurrentBudget = this.policy.maxConcurrentProjectedTokens;
    const concurrentRemaining = concurrentBudget - higherPriorityTokens;
    const rollingTokensUsed = this.rollingWindow.reduce((sum, item) => sum + item.tokens, 0);
    const rollingBytesUsed = this.rollingWindow.reduce((sum, item) => sum + item.bytes, 0);
    const rollingTokensRemaining = this.policy.rollingProjectedTokens - rollingTokensUsed;
    const rollingBytesRemaining = this.policy.rollingProjectedBytes - rollingBytesUsed;

    const pressure = Math.max(
      concurrentBudget > 0 ? (concurrentBudget - concurrentRemaining + projectedTokens) / concurrentBudget : 1,
      this.policy.rollingProjectedTokens > 0
        ? (rollingTokensUsed + projectedTokens) / this.policy.rollingProjectedTokens
        : 1,
      this.policy.rollingProjectedBytes > 0
        ? (rollingBytesUsed + projectedBytes) / this.policy.rollingProjectedBytes
        : 1,
    );
    this.telemetry?.recordPressure({ mode: this.policy.mode, pressure, projectedTokens, projectedBytes });

    let admitted = true;
    let reason: BurstAdmission["reason"];
    if (projectedTokens > Math.max(0, concurrentRemaining)) {
      admitted = false;
      reason = "concurrent_budget";
    } else if (projectedTokens > Math.max(0, rollingTokensRemaining)) {
      admitted = false;
      reason = "rolling_tokens";
    } else if (projectedBytes > Math.max(0, rollingBytesRemaining)) {
      admitted = false;
      reason = "rolling_bytes";
    }

    // observe/warn は telemetry のみ。enforce だけが実際に縮小させる。
    const effectiveAdmitted = this.policy.mode === "enforce" ? admitted : true;
    if (!admitted) {
      this.telemetry?.recordReduced({
        mode: this.policy.mode,
        reason: reason ?? "concurrent_budget",
        projectedTokens,
        projectedBytes,
      });
    }
    if (effectiveAdmitted || this.policy.mode !== "enforce") {
      this.rollingWindow.push({ atMs: this.now(), tokens: projectedTokens, bytes: projectedBytes });
    }
    return { admitted: effectiveAdmitted, reason, pressure };
  }

  /** 呼び出し終了。connection が生きている限り呼ぶこと — in-flight 集合から外れないと以後の
   * 優先度計算が古い呼び出しを永久に高優先扱いし続ける。 */
  release(reservation: BurstReservation): void {
    this.inFlight.delete(reservation.callId);
  }

  /** connection teardown。以後の呼び出しは reserveEnvelope から例外になる。 */
  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.rollingWindow = [];
  }

  private decayRollingWindow(): void {
    const cutoff = this.now() - this.policy.rollingWindowMs;
    this.rollingWindow = this.rollingWindow.filter((entry) => entry.atMs >= cutoff);
  }
}

/**
 * optional projection が admit されなかった場合の縮小を #71 の budget primitives へ委譲する。
 * `MIN_RESPONSE_BUDGET` 相当のごく小さい hard 予算で `applyResponseBudget` を呼ぶと #71 の
 * `minimalResult` 経路がそのまま働く — burst 用の圧縮ロジックを別途複製しない。
 */
export function applyBurstReduction(result: ProjectedResult): ProjectedResult {
  const minimalBudget = { softTokens: 128, hardTokens: 256, hardBytes: 1_024 };
  const reduced = applyResponseBudget(result, minimalBudget);
  return addOmission(reduced, {
    field: "optional_result_data",
    reason: "burst_budget",
    retrievalAvailable: reduced.resultId.length > 0,
  });
}

export function isBlockingProjection(result: Pick<ProjectedResult, "diagnostics" | "status">): boolean {
  if (result.status === "failed" || result.status === "error") return true;
  return result.diagnostics.some((diagnostic) => {
    if (typeof diagnostic !== "object" || diagnostic === null) return false;
    const record = diagnostic as Record<string, unknown>;
    const severity = typeof record.severity === "string" ? record.severity.toLowerCase() : "";
    return severity === "error" || severity === "fatal" || severity === "blocking";
  });
}
