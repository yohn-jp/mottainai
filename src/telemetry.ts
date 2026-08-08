import fs from "node:fs";
import path from "node:path";

/**
 * ローカル専用の利用状況・トークン節約テレメトリ（#27）。
 *
 * 既定は無効。個々の呼び出し・引数・出力本文は保持しない — provider / capability 単位の
 * 呼び出し回数・エラー回数・圧縮前後バイト数・retrieval 回数という**集計値だけ**を単一の
 * JSON ファイルへ書き戻す。secret redaction が必要な生データを一切持たないため、
 * `src/logging.ts` のような redaction 機構はここには無い。
 */

export interface TelemetryCounts {
  calls: number;
  errors: number;
  original_bytes: number;
  compressed_bytes: number;
}

export interface TelemetrySnapshot {
  enabled: boolean;
  generated_at: string;
  totals: TelemetryCounts & { retrievals: number };
  by_provider: Record<string, TelemetryCounts>;
  by_capability: Record<string, TelemetryCounts>;
  projection: ProjectionCounts;
  await: AwaitCounts;
  burst: BurstCounts;
}

/**
 * await/watch primitive（Issue #74）の集計値。credential・raw payload・provider response 本文は
 * 一切保持しない — poll 回数・待機時間・観測した状態変化の件数・LLM へ返さずに済んだ
 * 中間応答の件数だけを記録する。
 */
export interface AwaitCounts {
  awaits: number;
  poll_count: number;
  elapsed_ms: number;
  state_changes: number;
  avoided_responses: number;
  terminal: number;
  timeouts: number;
  cancelled: number;
}

export interface RecordAwaitInput {
  pollCount: number;
  elapsedMs: number;
  stateChanges: number;
  avoidedResponses: number;
  outcome: "terminal" | "timeout" | "cancelled";
}

export interface RecordToolCallInput {
  provider: string;
  capability?: string;
  originalBytes: number;
  compressedBytes: number;
  isError: boolean;
}

export interface ProjectionCounts {
  raw_bytes: number;
  stored_bytes: number;
  returned_bytes: number;
  omitted_bytes: number;
  projected_tokens: number;
}

export interface RecordProjectionInput {
  rawBytes: number;
  storedBytes: number;
  returnedBytes: number;
  omittedBytes: number;
  projectedTokens: number;
}

/** #73: connection burst budget の集計値。content 本体は一切持たない。 */
export interface BurstCounts {
  pressure_samples: number;
  pressure_total: number;
  pressure_max: number;
  projected_tokens: number;
  projected_bytes: number;
  omitted_tokens: number;
  omitted_bytes: number;
  /** enforce で実際に応答が縮小された回数。 */
  responses_reduced: number;
  /** observe/warn で「enforce なら縮小されていたはず」の回数。応答自体は縮小されていない。 */
  responses_would_reduce: number;
}

export interface RecordBurstPressureInput {
  mode: string;
  pressure: number;
  projectedTokens: number;
  projectedBytes: number;
}

export interface RecordBurstReducedInput {
  mode: string;
  reason: string;
  projectedTokens: number;
  projectedBytes: number;
  /** enforce で実際に応答が縮小された場合のみ true。observe/warn は縮小せず記録するだけ。 */
  reduced: boolean;
}

export interface TelemetrySink {
  readonly enabled: boolean;
  readonly filePath?: string;
  recordToolCall(input: RecordToolCallInput): void;
  recordProjection(input: RecordProjectionInput): void;
  recordRetrieval(): void;
  recordAwait(input: RecordAwaitInput): void;
  recordBurstPressure(input: RecordBurstPressureInput): void;
  recordBurstReduced(input: RecordBurstReducedInput): void;
  snapshot(): TelemetrySnapshot;
}

interface TelemetryState {
  totals: TelemetryCounts & { retrievals: number };
  by_provider: Record<string, TelemetryCounts>;
  by_capability: Record<string, TelemetryCounts>;
  projection: ProjectionCounts;
  await: AwaitCounts;
  burst: BurstCounts;
}

function emptyCounts(): TelemetryCounts {
  return { calls: 0, errors: 0, original_bytes: 0, compressed_bytes: 0 };
}

function emptyState(): TelemetryState {
  return {
    totals: { ...emptyCounts(), retrievals: 0 }, by_provider: {}, by_capability: {},
    projection: emptyProjection(),
    await: emptyAwait(),
    burst: emptyBurst(),
  };
}

function emptyProjection(): ProjectionCounts {
  return { raw_bytes: 0, stored_bytes: 0, returned_bytes: 0, omitted_bytes: 0, projected_tokens: 0 };
}

function emptyAwait(): AwaitCounts {
  return { awaits: 0, poll_count: 0, elapsed_ms: 0, state_changes: 0, avoided_responses: 0, terminal: 0, timeouts: 0, cancelled: 0 };
}

function emptyBurst(): BurstCounts {
  return {
    pressure_samples: 0,
    pressure_total: 0,
    pressure_max: 0,
    projected_tokens: 0,
    projected_bytes: 0,
    omitted_tokens: 0,
    omitted_bytes: 0,
    responses_reduced: 0,
    responses_would_reduce: 0,
  };
}

function cloneCounts(counts: TelemetryCounts): TelemetryCounts {
  return { ...counts };
}

function snapshotState(state: TelemetryState): Pick<TelemetrySnapshot, "totals" | "by_provider" | "by_capability" | "projection" | "await" | "burst"> {
  return {
    totals: { ...state.totals },
    by_provider: Object.fromEntries(
      Object.entries(state.by_provider).map(([key, counts]) => [key, cloneCounts(counts)]),
    ),
    by_capability: Object.fromEntries(
      Object.entries(state.by_capability).map(([key, counts]) => [key, cloneCounts(counts)]),
    ),
    projection: { ...state.projection },
    await: { ...state.await },
    burst: { ...state.burst },
  };
}

export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MOTTAINAI_TELEMETRY;
  return value === "1" || (value?.toLowerCase() === "true");
}

export function resolveTelemetryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOTTAINAI_TELEMETRY_FILE ?? path.join(process.cwd(), ".mottainai", "telemetry", "summary.json");
}

function isCounts(value: unknown): value is TelemetryCounts {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.calls === "number" && typeof record.errors === "number"
    && typeof record.original_bytes === "number" && typeof record.compressed_bytes === "number";
}

/** 破損・旧形式のファイルは読み捨てて 0 から再開する。集計値の再構築は失うが致命的ではない。 */
function loadState(filePath: string): TelemetryState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const totals = parsed.totals;
    const retrievals = typeof totals === "object" && totals !== null ? (totals as Record<string, unknown>).retrievals : undefined;
    if (!isCounts(totals) || typeof retrievals !== "number") return undefined;
    const byProvider = parsed.by_provider;
    const byCapability = parsed.by_capability;
    if (typeof byProvider !== "object" || byProvider === null) return undefined;
    if (typeof byCapability !== "object" || byCapability === null) return undefined;
    for (const value of Object.values(byProvider as Record<string, unknown>)) if (!isCounts(value)) return undefined;
    for (const value of Object.values(byCapability as Record<string, unknown>)) if (!isCounts(value)) return undefined;
    const projection = typeof parsed.projection === "object" && parsed.projection !== null
      ? parsed.projection as Record<string, unknown>
      : {};
    const awaitRaw = typeof parsed.await === "object" && parsed.await !== null
      ? parsed.await as Record<string, unknown>
      : {};
    const burst = typeof parsed.burst === "object" && parsed.burst !== null
      ? parsed.burst as Record<string, unknown>
      : {};
    return {
      totals: totals as TelemetryState["totals"],
      by_provider: byProvider as Record<string, TelemetryCounts>,
      by_capability: byCapability as Record<string, TelemetryCounts>,
      projection: {
        raw_bytes: typeof projection.raw_bytes === "number" ? projection.raw_bytes : 0,
        stored_bytes: typeof projection.stored_bytes === "number" ? projection.stored_bytes : 0,
        returned_bytes: typeof projection.returned_bytes === "number" ? projection.returned_bytes : 0,
        omitted_bytes: typeof projection.omitted_bytes === "number" ? projection.omitted_bytes : 0,
        projected_tokens: typeof projection.projected_tokens === "number" ? projection.projected_tokens : 0,
      },
      await: {
        awaits: typeof awaitRaw.awaits === "number" ? awaitRaw.awaits : 0,
        poll_count: typeof awaitRaw.poll_count === "number" ? awaitRaw.poll_count : 0,
        elapsed_ms: typeof awaitRaw.elapsed_ms === "number" ? awaitRaw.elapsed_ms : 0,
        state_changes: typeof awaitRaw.state_changes === "number" ? awaitRaw.state_changes : 0,
        avoided_responses: typeof awaitRaw.avoided_responses === "number" ? awaitRaw.avoided_responses : 0,
        terminal: typeof awaitRaw.terminal === "number" ? awaitRaw.terminal : 0,
        timeouts: typeof awaitRaw.timeouts === "number" ? awaitRaw.timeouts : 0,
        cancelled: typeof awaitRaw.cancelled === "number" ? awaitRaw.cancelled : 0,
      },
      burst: {
        pressure_samples: typeof burst.pressure_samples === "number" ? burst.pressure_samples : 0,
        pressure_total: typeof burst.pressure_total === "number" ? burst.pressure_total : 0,
        pressure_max: typeof burst.pressure_max === "number" ? burst.pressure_max : 0,
        projected_tokens: typeof burst.projected_tokens === "number" ? burst.projected_tokens : 0,
        projected_bytes: typeof burst.projected_bytes === "number" ? burst.projected_bytes : 0,
        omitted_tokens: typeof burst.omitted_tokens === "number" ? burst.omitted_tokens : 0,
        omitted_bytes: typeof burst.omitted_bytes === "number" ? burst.omitted_bytes : 0,
        responses_reduced: typeof burst.responses_reduced === "number" ? burst.responses_reduced : 0,
        responses_would_reduce: typeof burst.responses_would_reduce === "number" ? burst.responses_would_reduce : 0,
      },
    };
  } catch {
    return undefined;
  }
}

function bump(counts: TelemetryCounts, input: RecordToolCallInput): void {
  counts.calls += 1;
  if (input.isError) counts.errors += 1;
  counts.original_bytes += input.originalBytes;
  counts.compressed_bytes += input.compressedBytes;
}

/** telemetry 無効時（または未接続時）の snapshot。呼び出し側が個別に同じ形を組み立てなくて済むよう公開する。 */
export function disabledTelemetrySnapshot(): TelemetrySnapshot {
  return {
    enabled: false, generated_at: new Date().toISOString(), totals: { ...emptyCounts(), retrievals: 0 },
    by_provider: {}, by_capability: {}, projection: emptyProjection(), await: emptyAwait(), burst: emptyBurst(),
  };
}

const NOOP_SINK: TelemetrySink = {
  enabled: false,
  recordToolCall() { /* telemetry disabled */ },
  recordProjection() { /* telemetry disabled */ },
  recordRetrieval() { /* telemetry disabled */ },
  recordAwait() { /* telemetry disabled */ },
  recordBurstPressure() { /* telemetry disabled */ },
  recordBurstReduced() { /* telemetry disabled */ },
  snapshot: disabledTelemetrySnapshot,
};

/**
 * 環境変数から telemetry sink を構築する。
 *
 * - `MOTTAINAI_TELEMETRY=1` — 有効化（既定は無効）
 * - `MOTTAINAI_TELEMETRY_FILE` — 集計値の保存先（既定 `.mottainai/telemetry/summary.json`）
 *
 * 無効時は fs へ一切触れない no-op sink を返す。有効時は既存ファイルがあれば読み込み、
 * プロセス再起動をまたいで集計を継続する。
 */
export function createTelemetrySink(env: NodeJS.ProcessEnv = process.env): TelemetrySink {
  if (!isTelemetryEnabled(env)) return NOOP_SINK;

  const filePath = resolveTelemetryPath(env);
  const state = loadState(filePath) ?? emptyState();
  let writeQueue: Promise<void> = Promise.resolve();
  let pendingUpdates = 0;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const PERSIST_BATCH_SIZE = 10;
  const PERSIST_DEBOUNCE_MS = 10;

  function persistNow(): void {
    writeQueue = writeQueue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const snapshot: TelemetrySnapshot = {
          enabled: true,
          generated_at: new Date().toISOString(),
          ...snapshotState(state),
        };
        await fs.promises.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      })
      .catch((err) => {
        console.error("mottainai: failed to write telemetry summary", err);
      });
  }

  function persist(): void {
    pendingUpdates += 1;
    if (pendingUpdates >= PERSIST_BATCH_SIZE) {
      pendingUpdates = 0;
      if (persistTimer !== undefined) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      persistNow();
      return;
    }
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      pendingUpdates = 0;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  return {
    enabled: true,
    filePath,
    recordToolCall(input) {
      bump(state.totals, input);
      const provider = state.by_provider[input.provider] ?? emptyCounts();
      bump(provider, input);
      state.by_provider[input.provider] = provider;
      if (input.capability !== undefined) {
        const capability = state.by_capability[input.capability] ?? emptyCounts();
        bump(capability, input);
        state.by_capability[input.capability] = capability;
      }
      persist();
    },
    recordProjection(input) {
      state.projection.raw_bytes += input.rawBytes;
      state.projection.stored_bytes += input.storedBytes;
      state.projection.returned_bytes += input.returnedBytes;
      state.projection.omitted_bytes += input.omittedBytes;
      state.projection.projected_tokens += input.projectedTokens;
      persist();
    },
    recordRetrieval() {
      state.totals.retrievals += 1;
      persist();
    },
    recordAwait(input) {
      state.await.awaits += 1;
      state.await.poll_count += input.pollCount;
      state.await.elapsed_ms += input.elapsedMs;
      state.await.state_changes += input.stateChanges;
      state.await.avoided_responses += input.avoidedResponses;
      if (input.outcome === "terminal") state.await.terminal += 1;
      else if (input.outcome === "timeout") state.await.timeouts += 1;
      else state.await.cancelled += 1;
      persist();
    },
    recordBurstPressure(input) {
      state.burst.pressure_samples += 1;
      state.burst.pressure_total += input.pressure;
      state.burst.pressure_max = Math.max(state.burst.pressure_max, input.pressure);
      state.burst.projected_tokens += input.projectedTokens;
      state.burst.projected_bytes += input.projectedBytes;
      persist();
    },
    recordBurstReduced(input) {
      if (input.reduced) {
        state.burst.responses_reduced += 1;
        state.burst.omitted_tokens += input.projectedTokens;
        state.burst.omitted_bytes += input.projectedBytes;
      } else {
        state.burst.responses_would_reduce += 1;
      }
      persist();
    },
    snapshot() {
      return { enabled: true, generated_at: new Date().toISOString(), ...snapshotState(state) };
    },
  };
}

/** 圧縮率（0〜1、1 は無変化）。呼び出しが無ければ `undefined`。 */
export function compressionRatio(counts: Pick<TelemetryCounts, "original_bytes" | "compressed_bytes">): number | undefined {
  return counts.original_bytes > 0 ? counts.compressed_bytes / counts.original_bytes : undefined;
}

/** artifact 再取得率（retrieval 回数 / 呼び出し回数）。呼び出しが無ければ `undefined`。 */
export function retrievalRate(totals: Pick<TelemetrySnapshot["totals"], "calls" | "retrievals">): number | undefined {
  return totals.calls > 0 ? totals.retrievals / totals.calls : undefined;
}
