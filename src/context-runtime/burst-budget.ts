import { applyResponseBudget, MIN_RESPONSE_BUDGET } from "./budget.js";
import { addOmission } from "./project.js";
import type { ProjectedResult } from "./types.js";

/**
 * #71 は「1レスポンスの投影」を境界にする。#73 はその上に、同一 MCP connection/session
 * が短時間に返す agent-visible projection の合計を境界づける。tool 実行・full result 保存
 * (ArtifactStore) は一切変更しない — ここで縮めるのは #71 が既に作った投影結果だけ。
 *
 * reservation/priority semantics（完了順に依存しない決定性）:
 *
 *  1. 各呼び出しは tool 実行を dispatch する **前** に `reserveEnvelope` で最小 envelope 分
 *     （固定コスト）を即時 reserve する。envelope は拒否しない — full result は必ず維持する。
 *     ここで reserve しておかないと、Promise.all で同時に投げられた複数呼び出しの実行区間が
 *     in-flight 集合に反映されず、後段の優先度判定が実質的に無意味になる（呼び出しは
 *     dispatch → #71 投影 → admitOptional という順で進むため、reserve が投影確定後では
 *     真に並行している他呼び出しを見つけられない）。
 *  2. dispatch 結果が判明した時点で `updatePriority` により isBlocking を確定する
 *     （dispatch 前は結果が分からないため）。
 *  3. #71 が投影を作った後、`admitOptional` で「最小 envelope を超える分」の可否を問う。
 *     可否は「今どの呼び出しが同時に in-flight か」という静的集合と、各呼び出しの優先度
 *     （blocking diagnostic を含むかどうか、次に登録順）だけで決まる。どちらが先に
 *     Promise を resolve したかには依存しない。
 *  4. `release` でレスポンス確定後に in-flight 集合から外す。rolling window の消費実績は
 *     時刻ベースで別途減衰する。
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
  recordReduced(input: {
    mode: BurstBudgetMode;
    reason: string;
    projectedTokens: number;
    projectedBytes: number;
    /** enforce で実際に応答が縮小された場合のみ true。observe/warn は縮小せず記録するだけ。 */
    reduced: boolean;
  }): void;
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
  // Node は単一スレッドなので、ある呼び出しの admitOptional は同期的に完了まで走り、
  // release も直後に呼ばれる。そのため「今 open な集合」だけでランキングすると、
  // 評価される呼び出しは常に「自分より前に登録された、まだ未決定の」呼び出しがゼロの状態
  // （＝実質ランク0）になりがちで、maxConcurrentProjectedTokens が同時バーストに対して
  // 事実上働かなくなる（決定順に budget を消費する「naive な完了順消費」に事実上退化する）。
  //
  // そこで rank の算出には `generation` — この burst 世代（open count が 0 から増え、また
  // 0 に戻るまでの一続き）に登録された全 reservation の静的集合 — を使う。generation は
  // release されても縮まない（open count が 0 に戻ったときだけ丸ごとリセットする）。
  // rank は登録時に決まる (isBlocking, sequence) だけに依存し、どの呼び出しがいつ
  // admitOptional を呼んだか（＝どの Promise が先に解決したか）には一切依存しない —
  // これで同時バーストに対しても budget が機能しつつ、決定性を保つ。
  private generation = new Map<number, InFlightEntry>();
  private readonly openCallIds = new Set<number>();
  private rollingWindow: RollingEntry[] = [];
  private nextCallId = 1;
  private disposed = false;

  constructor(policy: BurstBudgetPolicy, telemetry?: BurstBudgetTelemetry, now: () => number = Date.now) {
    this.policy = policy;
    this.telemetry = telemetry;
    this.now = now;
  }

  /**
   * tool 実行を dispatch する前に呼ぶ。envelope 分は必ず reserve できる（拒否しない）。
   * isBlocking は dispatch 結果が出るまで不明なので既定 false — 結果判明後に
   * `updatePriority` で確定させること。
   */
  reserveEnvelope(): BurstReservation {
    if (this.disposed) throw new Error("burst budget controller disposed");
    const callId = this.nextCallId++;
    this.generation.set(callId, { callId, isBlocking: false, sequence: callId });
    this.openCallIds.add(callId);
    return { callId };
  }

  /** dispatch 結果が判明した時点で優先度を確定する。admitOptional より前に呼ぶこと。 */
  updatePriority(reservation: BurstReservation, isBlocking: boolean): void {
    const entry = this.generation.get(reservation.callId);
    if (entry === undefined) return;
    entry.isBlocking = isBlocking;
  }

  /**
   * #71 投影確定後、envelope を超える optional 分の可否を問う。決定は「この burst 世代に
   * 登録された呼び出し集合」（release されても縮まない）と各呼び出しの静的優先度
   * （blocking diagnostic を含むか、登録順）だけで決まる — どちらの Promise が先に
   * resolve したかには依存しない。
   */
  admitOptional(reservation: BurstReservation, projectedTokens: number, projectedBytes: number): BurstAdmission {
    if (this.policy.mode === "off") return { admitted: true, pressure: 0 };

    this.decayRollingWindow();

    const entry = this.generation.get(reservation.callId);
    if (entry === undefined) throw new Error("unknown burst reservation");

    // 静的優先度: blocking diagnostic を持つ呼び出しは、非 blocking な呼び出しより常に優先。
    // 同順位は登録順（sequence）で安定タイブレークする。この generation は release されても
    // 縮まないので、rank は評価順に関係なく一意に決まる。
    const cohort = [...this.generation.values()].sort((a, b) => {
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
        reduced: !effectiveAdmitted,
      });
    }
    // enforce で縮小した応答も最小 envelope 分は agent に届く。ここを 0 計上にすると、
    // 圧迫が続く間 rolling window が実態より早く空いてしまう。
    const chargedTokens = effectiveAdmitted ? projectedTokens : Math.min(projectedTokens, MIN_ENVELOPE_TOKENS);
    const chargedBytes = effectiveAdmitted ? projectedBytes : Math.min(projectedBytes, MIN_ENVELOPE_TOKENS * 4);
    this.rollingWindow.push({ atMs: this.now(), tokens: chargedTokens, bytes: chargedBytes });
    return { admitted: effectiveAdmitted, reason, pressure };
  }

  /** 呼び出し終了。connection が生きている限り呼ぶこと。 */
  release(reservation: BurstReservation): void {
    this.openCallIds.delete(reservation.callId);
    // burst 世代がここで完全に drain した。次の同時バーストのために roster をリセットする
    // （rolling window は時刻ベースで別途減衰するので、ここでは触らない）。
    if (this.openCallIds.size === 0) this.generation = new Map();
  }

  /** connection teardown。以後の呼び出しは reserveEnvelope から例外になる。 */
  dispose(): void {
    this.disposed = true;
    this.generation = new Map();
    this.openCallIds.clear();
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
  const reduced = applyResponseBudget(result, MIN_RESPONSE_BUDGET);
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
