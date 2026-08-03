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
}

export interface RecordToolCallInput {
  provider: string;
  capability?: string;
  originalBytes: number;
  compressedBytes: number;
  isError: boolean;
}

export interface TelemetrySink {
  readonly enabled: boolean;
  readonly filePath?: string;
  recordToolCall(input: RecordToolCallInput): void;
  recordRetrieval(): void;
  snapshot(): TelemetrySnapshot;
}

interface TelemetryState {
  totals: TelemetryCounts & { retrievals: number };
  by_provider: Record<string, TelemetryCounts>;
  by_capability: Record<string, TelemetryCounts>;
}

function emptyCounts(): TelemetryCounts {
  return { calls: 0, errors: 0, original_bytes: 0, compressed_bytes: 0 };
}

function emptyState(): TelemetryState {
  return { totals: { ...emptyCounts(), retrievals: 0 }, by_provider: {}, by_capability: {} };
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
    return {
      totals: totals as TelemetryState["totals"],
      by_provider: byProvider as Record<string, TelemetryCounts>,
      by_capability: byCapability as Record<string, TelemetryCounts>,
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

const NOOP_SINK: TelemetrySink = {
  enabled: false,
  recordToolCall() { /* telemetry disabled */ },
  recordRetrieval() { /* telemetry disabled */ },
  snapshot() {
    return { enabled: false, generated_at: new Date().toISOString(), totals: { ...emptyCounts(), retrievals: 0 }, by_provider: {}, by_capability: {} };
  },
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

  function persist(): void {
    writeQueue = writeQueue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const snapshot: TelemetrySnapshot = { enabled: true, generated_at: new Date().toISOString(), ...state };
        await fs.promises.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      })
      .catch((err) => {
        console.error("mottainai: failed to write telemetry summary", err);
      });
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
    recordRetrieval() {
      state.totals.retrievals += 1;
      persist();
    },
    snapshot() {
      return { enabled: true, generated_at: new Date().toISOString(), ...state };
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
