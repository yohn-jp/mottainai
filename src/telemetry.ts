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
  read_governor: ReadGovernorCounts;
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

export interface ReadGovernorCounts {
  allow: number;
  observe: number;
  warn: number;
  deny: number;
  raw_lines_returned: number;
  raw_bytes_returned: number;
  by_mode: Record<string, number>;
  by_rule: Record<string, number>;
  by_reason_category: Record<string, number>;
}

export interface RecordReadGovernorInput {
  action: "allow" | "observe" | "warn" | "deny";
  requestedMode: string;
  rawLinesReturned: number;
  rawBytesReturned: number;
  policyRule: string;
  reasonCategory: string;
}

export interface RecordProjectionInput {
  rawBytes: number;
  storedBytes: number;
  returnedBytes: number;
  omittedBytes: number;
  projectedTokens: number;
}

export interface TelemetrySink {
  readonly enabled: boolean;
  readonly filePath?: string;
  recordToolCall(input: RecordToolCallInput): void;
  recordProjection(input: RecordProjectionInput): void;
  recordReadGovernor(input: RecordReadGovernorInput): void;
  recordRetrieval(): void;
  snapshot(): TelemetrySnapshot;
}

interface TelemetryState {
  totals: TelemetryCounts & { retrievals: number };
  by_provider: Record<string, TelemetryCounts>;
  by_capability: Record<string, TelemetryCounts>;
  projection: ProjectionCounts;
  read_governor: ReadGovernorCounts;
}

function emptyCounts(): TelemetryCounts {
  return { calls: 0, errors: 0, original_bytes: 0, compressed_bytes: 0 };
}

function emptyState(): TelemetryState {
  return {
    totals: { ...emptyCounts(), retrievals: 0 }, by_provider: {}, by_capability: {},
    projection: emptyProjection(), read_governor: emptyReadGovernor(),
  };
}

function emptyProjection(): ProjectionCounts {
  return { raw_bytes: 0, stored_bytes: 0, returned_bytes: 0, omitted_bytes: 0, projected_tokens: 0 };
}

function emptyReadGovernor(): ReadGovernorCounts {
  return {
    allow: 0,
    observe: 0,
    warn: 0,
    deny: 0,
    raw_lines_returned: 0,
    raw_bytes_returned: 0,
    by_mode: {},
    by_rule: {},
    by_reason_category: {},
  };
}

function cloneCounts(counts: TelemetryCounts): TelemetryCounts {
  return { ...counts };
}

function snapshotState(state: TelemetryState): Pick<TelemetrySnapshot, "totals" | "by_provider" | "by_capability" | "projection" | "read_governor"> {
  return {
    totals: { ...state.totals },
    by_provider: Object.fromEntries(
      Object.entries(state.by_provider).map(([key, counts]) => [key, cloneCounts(counts)]),
    ),
    by_capability: Object.fromEntries(
      Object.entries(state.by_capability).map(([key, counts]) => [key, cloneCounts(counts)]),
    ),
    projection: { ...state.projection },
    read_governor: {
      ...state.read_governor,
      by_mode: { ...state.read_governor.by_mode },
      by_rule: { ...state.read_governor.by_rule },
      by_reason_category: { ...state.read_governor.by_reason_category },
    },
  };
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
      .map(([key, entry]) => [key, entry as number]),
  );
}

function readGovernorState(value: unknown): ReadGovernorCounts {
  const empty = emptyReadGovernor();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  const counts = { ...empty };
  for (const key of ["allow", "observe", "warn", "deny"] as const) {
    const entry = record[key];
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) counts[key] = entry;
  }
  const rawLinesReturned = record.raw_lines_returned ?? record.raw_lines;
  const rawBytesReturned = record.raw_bytes_returned ?? record.raw_bytes;
  if (typeof rawLinesReturned === "number" && Number.isFinite(rawLinesReturned) && rawLinesReturned >= 0) {
    counts.raw_lines_returned = rawLinesReturned;
  }
  if (typeof rawBytesReturned === "number" && Number.isFinite(rawBytesReturned) && rawBytesReturned >= 0) {
    counts.raw_bytes_returned = rawBytesReturned;
  }
  counts.by_mode = numberRecord(record.by_mode ?? record.requested_modes);
  counts.by_rule = numberRecord(record.by_rule ?? record.policy_rules);
  counts.by_reason_category = numberRecord(record.by_reason_category);
  return counts;
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
      read_governor: readGovernorState(parsed.read_governor),
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
  recordProjection() { /* telemetry disabled */ },
  recordReadGovernor() { /* telemetry disabled */ },
  recordRetrieval() { /* telemetry disabled */ },
  snapshot() {
    return {
      enabled: false, generated_at: new Date().toISOString(), totals: { ...emptyCounts(), retrievals: 0 },
      by_provider: {}, by_capability: {}, projection: emptyProjection(), read_governor: emptyReadGovernor(),
    };
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
    recordReadGovernor(input) {
      state.read_governor[input.action] += 1;
      state.read_governor.raw_lines_returned += Math.max(0, input.rawLinesReturned);
      state.read_governor.raw_bytes_returned += Math.max(0, input.rawBytesReturned);
      state.read_governor.by_mode[input.requestedMode] =
        (state.read_governor.by_mode[input.requestedMode] ?? 0) + 1;
      state.read_governor.by_rule[input.policyRule] =
        (state.read_governor.by_rule[input.policyRule] ?? 0) + 1;
      state.read_governor.by_reason_category[input.reasonCategory] =
        (state.read_governor.by_reason_category[input.reasonCategory] ?? 0) + 1;
      persist();
    },
    recordRetrieval() {
      state.totals.retrievals += 1;
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
