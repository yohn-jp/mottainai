import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * caller-supervised routing の trace 永続化。
 *
 * 追記専用の JSON Lines で `request` / `execution` / `review` / `execution_review` を別レコードとして書き、
 * 読み出し時に `request_id` で畳み込む。review は探索の後に届くため、既存レコードを
 * 書き換えない構造にしている（同時書き込みでの破損と、部分書きの取りこぼしを避ける）。
 *
 * 既定では metadata だけを保存する。呼び出し側の自由記述 `context` は sha256 の断片と
 * 長さだけを残し、原文は `MOTTAINAI_TRACE_RAW=1` のときにだけ保存する。
 */

/**
 * execution の結果分類。issue #47: 「証拠が無い」を単一の `skipped` に潰すと、
 * provider 未導入（`unavailable`）と呼び出し側が避けるべき capability（将来の avoid 由来）を
 * 統計上区別できなくなる。技術的失敗も tool 自体の失敗（`tool_error`）と provider/接続の
 * 失敗（`provider_error`）を分け、原因ごとに集計できるようにする。
 */
export type ExecutionStatus =
  | "success"
  | "empty"
  | "tool_error"
  | "provider_error"
  | "unavailable"
  | "policy_suppressed"
  | "not_executed";

/**
 * trace レコード形式の版。旧形式（版無し = {@link LEGACY_SCHEMA_VERSION}）は読み出し時に
 * best-effort で現行形式へ写像する（`normalizeRequestRecord` / `normalizeExecutionRecord`）。
 * 破壊的にレコード形状を変えるときはここを上げ、移行方針をこのコメントに書き足す。
 */
export const TRACE_SCHEMA_VERSION = 1;
const LEGACY_SCHEMA_VERSION = 0;

export interface TraceRequestRecord {
  type: "request";
  schema_version: number;
  request_id: string;
  timestamp: string;
  task_category: string;
  task_intent?: string;
  task_confidence?: number;
  /** 呼び出し側が明示した capability。policy の追加・抑制を経ない、そのままの値。 */
  caller_requested_capabilities: string[];
  /** 呼び出し側の指定と policy を統合した、実際に使われた capability 列。 */
  planned_capabilities: string[];
  /** policy が足した capability。 */
  added_by_policy: string[];
  /** policy の avoid 指定で外した capability。 */
  suppressed_by_policy: string[];
  policy_version: string;
  /** 既知語彙に無かったラベル。taxonomy を広げる判断材料として残す。 */
  unknown_labels?: string[];
  context_digest?: string;
  context_length?: number;
  context?: string;
}

export interface TraceExecutionRecord {
  type: "execution";
  schema_version: number;
  /** 同一 request 内でも execution 単位に安定した ID。将来の execution 単位 review が使う。 */
  execution_id: string;
  request_id: string;
  timestamp: string;
  provider: string;
  tool: string;
  capability: string;
  duration_ms: number;
  result_count: number;
  output_size: number;
  status: ExecutionStatus;
  /** fallback で試した provider/tool。通常呼び出しでは空または未設定。 */
  attempts?: TraceExecutionAttempt[];
}

export interface TraceExecutionAttempt {
  provider: string;
  tool: string;
  backend?: string;
  error: string;
}

export interface TraceReviewRecord {
  type: "review";
  schema_version: number;
  request_id: string;
  timestamp: string;
  expected_found: boolean;
  sufficient: boolean;
  usefulness?: number;
  missing_capabilities: string[];
  unexpected_noise: string[];
  follow_up_requested: boolean;
  next_capabilities: string[];
}

export interface TraceExecutionReviewRecord {
  type: "execution_review";
  schema_version: number;
  request_id: string;
  execution_id: string;
  timestamp: string;
  expected_found?: boolean;
  useful?: boolean;
  sufficient_for_capability?: boolean;
  missing_capabilities: string[];
  unexpected_noise: string[];
}

export type TraceRecord = TraceRequestRecord | TraceExecutionRecord | TraceReviewRecord | TraceExecutionReviewRecord;

export interface Trace {
  request: TraceRequestRecord;
  executions: TraceExecutionRecord[];
  review?: TraceReviewRecord;
  execution_reviews?: TraceExecutionReviewRecord[];
}

export interface BeginRequestInput {
  task_category: string;
  task_intent?: string;
  task_confidence?: number;
  /** 呼び出し側が明示した capability。policy 適用前のそのままの値。 */
  caller_requested_capabilities: string[];
  /** 呼び出し側の指定と policy を統合した、実際に使う capability 列。 */
  planned_capabilities: string[];
  added_by_policy?: string[];
  suppressed_by_policy?: string[];
  policy_version: string;
  unknown_labels?: string[];
  context?: string;
}

export type ExecutionInput = Omit<TraceExecutionRecord, "type" | "timestamp" | "schema_version" | "execution_id">;
export type ReviewInput = Omit<TraceReviewRecord, "type" | "timestamp" | "schema_version">;
export type ExecutionReviewInput = Omit<TraceExecutionReviewRecord, "type" | "timestamp" | "schema_version">;

export interface TraceFilter {
  requestId?: string;
  taskCategory?: string;
  /** この時刻以降に開始した request だけを返す（epoch ミリ秒）。 */
  since?: number;
  reviewedOnly?: boolean;
}

export interface TraceStore {
  /** 永続化が有効か。無効でも request_id の発行と session 内の追跡は続く。 */
  readonly enabled: boolean;
  readonly directory: string;
  readonly retainRawEvidence: boolean;
  beginRequest(input: BeginRequestInput): Promise<TraceRequestRecord>;
  recordExecution(input: ExecutionInput): Promise<void>;
  recordReview(input: ReviewInput): Promise<"recorded" | "unknown_request">;
  recordExecutionReview(input: ExecutionReviewInput): Promise<"recorded" | "unknown_request" | "unknown_execution">;
  knowsRequest(requestId: string): boolean;
  load(filter?: TraceFilter): Trace[];
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 2_000;

export function isTraceEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.MOTTAINAI_TRACE;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

export function resolveTraceDir(env: NodeJS.ProcessEnv): string {
  return env.MOTTAINAI_TRACE_DIR ?? path.join(process.cwd(), ".mottainai", "trace");
}

function retainRawEvidence(env: NodeJS.ProcessEnv): boolean {
  const value = env.MOTTAINAI_TRACE_RAW;
  return value !== undefined && value !== "0" && value.toLowerCase() !== "false";
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function newRequestId(): string {
  return `rq_${randomBytes(8).toString("hex")}`;
}

export function newExecutionId(): string {
  return `ex_${randomBytes(8).toString("hex")}`;
}

/** 同一ミリ秒でロールオーバーしても名前が衝突しないよう連番を足す。 */
let traceFileSequence = 0;

function traceFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_pid${process.pid}_${traceFileSequence++}.jsonl`;
}

function sweepExpiredTraces(directory: string, maxAgeMs: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(directory, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      // 掃除の失敗は trace 記録を止めない
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isTraceRecord(value: unknown): value is TraceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    (record.type === "request" || record.type === "execution" || record.type === "review" || record.type === "execution_review")
  );
}

/** 旧 execution status → 新語彙への best-effort 写像。読み出し専用、書き込みは常に新語彙を使う。 */
const LEGACY_EXECUTION_STATUS: Record<string, ExecutionStatus> = {
  success: "success",
  empty: "empty",
  // 旧 "error" は tool 自体の失敗と provider/接続の失敗を区別していなかった。
  // 過去分はどちらか一方に倒す必要があり、より頻度の高かった tool 起因側へ寄せる。
  error: "tool_error",
  // 旧 "skipped" は「この capability を満たす provider が無い」の意味だった。
  skipped: "unavailable",
};

/**
 * 旧形式（schema_version 無し）の request レコードを現行形式へ写像する。
 *
 * 旧 `requested_capabilities` は呼び出し側の意図と policy の寄与を区別せず、
 * 解決済みプランだけを保存していた。過去分から呼び出し側の原意図は復元できないため、
 * best-effort で `planned_capabilities` 側へ寄せ、`caller_requested_capabilities` も
 * 同じ値にする（policy の寄与を 0 とみなす、既知の近似）。
 */
function normalizeRequestRecord(record: Record<string, unknown>): TraceRequestRecord {
  const schemaVersion = typeof record.schema_version === "number" ? record.schema_version : LEGACY_SCHEMA_VERSION;
  if (schemaVersion >= TRACE_SCHEMA_VERSION && Array.isArray(record.caller_requested_capabilities)) {
    return record as unknown as TraceRequestRecord;
  }
  const planned = Array.isArray(record.requested_capabilities) ? (record.requested_capabilities as string[]) : [];
  return {
    ...(record as unknown as TraceRequestRecord),
    schema_version: LEGACY_SCHEMA_VERSION,
    caller_requested_capabilities: planned,
    planned_capabilities: planned,
    added_by_policy: [],
    suppressed_by_policy: [],
  };
}

function normalizeExecutionRecord(record: Record<string, unknown>): TraceExecutionRecord {
  const schemaVersion = typeof record.schema_version === "number" ? record.schema_version : LEGACY_SCHEMA_VERSION;
  if (schemaVersion >= TRACE_SCHEMA_VERSION && typeof record.execution_id === "string") {
    return record as unknown as TraceExecutionRecord;
  }
  const legacyStatus = typeof record.status === "string" ? record.status : "success";
  // 同じレコードを読み直しても同じ ID になるよう、内容から合成する（乱数は使わない）。
  const executionId = `ex_legacy_${digest(`${record.request_id}:${record.timestamp}:${record.provider}:${record.tool}:${record.capability}`)}`;
  return {
    ...(record as unknown as TraceExecutionRecord),
    schema_version: LEGACY_SCHEMA_VERSION,
    execution_id: executionId,
    status: LEGACY_EXECUTION_STATUS[legacyStatus] ?? "not_executed",
  };
}

function normalizeReviewRecord(record: Record<string, unknown>): TraceReviewRecord {
  if (typeof record.schema_version === "number") return record as unknown as TraceReviewRecord;
  return { ...(record as unknown as TraceReviewRecord), schema_version: LEGACY_SCHEMA_VERSION };
}

function normalizeExecutionReviewRecord(record: Record<string, unknown>): TraceExecutionReviewRecord {
  if (typeof record.schema_version === "number") return record as unknown as TraceExecutionReviewRecord;
  return { ...(record as unknown as TraceExecutionReviewRecord), schema_version: LEGACY_SCHEMA_VERSION };
}

function normalizeRecord(record: TraceRecord): TraceRecord {
  const raw = record as unknown as Record<string, unknown>;
  if (record.type === "request") return normalizeRequestRecord(raw);
  if (record.type === "execution") return normalizeExecutionRecord(raw);
  if (record.type === "execution_review") return normalizeExecutionReviewRecord(raw);
  return normalizeReviewRecord(raw);
}

function readRecords(directory: string): TraceRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const records: TraceRecord[] = [];
  for (const name of names) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(directory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        // 途中で切れた行や別形式の行は捨てる。1 行の破損で trace 全体を失わないため。
        if (isTraceRecord(parsed)) records.push(normalizeRecord(parsed));
      } catch {
        continue;
      }
    }
  }
  return records;
}

/** レコード列を request_id ごとに畳み込む。request レコードの無い孤児は捨てる。 */
export function foldRecords(records: TraceRecord[]): Trace[] {
  const traces = new Map<string, Trace>();
  for (const record of records) {
    if (record.type !== "request") continue;
    traces.set(record.request_id, { request: record, executions: [], execution_reviews: [] });
  }
  for (const record of records) {
    const trace = traces.get(record.request_id);
    if (trace === undefined) continue;
    if (record.type === "execution") trace.executions.push(record);
    if (record.type === "execution_review") trace.execution_reviews?.push(record);
    // 同じ request に複数 review が届いたら最後を採る。呼び出し側の訂正を有効にする。
    if (record.type === "review") trace.review = record;
  }
  return [...traces.values()];
}

function matchesFilter(trace: Trace, filter: TraceFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.requestId !== undefined && trace.request.request_id !== filter.requestId) return false;
  if (filter.taskCategory !== undefined && trace.request.task_category !== filter.taskCategory) return false;
  if (filter.reviewedOnly === true && trace.review === undefined) return false;
  if (filter.since !== undefined && Date.parse(trace.request.timestamp) < filter.since) return false;
  return true;
}

/**
 * 環境変数から trace store を構築する。
 *
 * - `MOTTAINAI_TRACE=0` — 永続化を無効化（既定は有効）
 * - `MOTTAINAI_TRACE_DIR` — 出力先（既定 `.mottainai/trace/`）
 * - `MOTTAINAI_TRACE_RAW=1` — 呼び出し側 `context` の原文保存を有効化（既定は digest のみ）
 * - `MOTTAINAI_TRACE_RETENTION_DAYS` — 保存日数（既定 30 日）。起動時に期限切れを削除
 * - `MOTTAINAI_TRACE_MAX_FILE_BYTES` — 1 ファイル上限（既定 5MiB）。超過で新規ファイルへ
 */
export function createTraceStore(env: NodeJS.ProcessEnv = process.env): TraceStore {
  const enabled = isTraceEnabled(env);
  const directory = resolveTraceDir(env);
  const raw = retainRawEvidence(env);
  const maxFileBytes = positiveNumber(env.MOTTAINAI_TRACE_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
  const retentionMs = positiveNumber(env.MOTTAINAI_TRACE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const sessionRequests = new Set<string>();
  const sessionExecutionIds = new Map<string, Set<string>>();

  let filePath = "";
  let currentFileBytes = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let prepared = false;

  // ディレクトリ作成と期限切れ掃除は最初の書き込みまで遅らせる。metadata を一度も
  // 受け取らない起動で `.mottainai/trace/` を作らないため。
  function prepareDirectory(): void {
    if (prepared) return;
    prepared = true;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    sweepExpiredTraces(directory, retentionMs);
    filePath = path.join(directory, traceFileName());
  }

  async function append(record: TraceRecord): Promise<void> {
    if (!enabled) return;
    const line = `${JSON.stringify(record)}\n`;
    writeQueue = writeQueue
      .then(async () => {
        prepareDirectory();
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (currentFileBytes > 0 && currentFileBytes + lineBytes > maxFileBytes) {
          sweepExpiredTraces(directory, retentionMs);
          filePath = path.join(directory, traceFileName());
          currentFileBytes = 0;
        }
        currentFileBytes += lineBytes;
        await fs.promises.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((err) => {
        console.error("mottainai: failed to write trace record", err);
      });
    await writeQueue;
  }

  function loadTraces(filter?: TraceFilter): Trace[] {
    if (!enabled) return [];
    return foldRecords(readRecords(directory)).filter((trace) => matchesFilter(trace, filter));
  }

  return {
    enabled,
    directory,
    retainRawEvidence: raw,
    async beginRequest(input) {
      const record: TraceRequestRecord = {
        type: "request",
        schema_version: TRACE_SCHEMA_VERSION,
        request_id: newRequestId(),
        timestamp: new Date().toISOString(),
        task_category: input.task_category,
        task_intent: input.task_intent,
        task_confidence: input.task_confidence,
        caller_requested_capabilities: input.caller_requested_capabilities,
        planned_capabilities: input.planned_capabilities,
        added_by_policy: input.added_by_policy ?? [],
        suppressed_by_policy: input.suppressed_by_policy ?? [],
        policy_version: input.policy_version,
        unknown_labels: input.unknown_labels?.length ? input.unknown_labels : undefined,
        context_digest: input.context === undefined ? undefined : digest(input.context),
        context_length: input.context?.length,
        context: raw ? input.context?.slice(0, MAX_CONTEXT_CHARS) : undefined,
      };
      sessionRequests.add(record.request_id);
      await append(record);
      return record;
    },
    async recordExecution(input) {
      const record: TraceExecutionRecord = {
        type: "execution",
        schema_version: TRACE_SCHEMA_VERSION,
        execution_id: newExecutionId(),
        timestamp: new Date().toISOString(),
        ...input,
      };
      await append(record);
      const executionIds = sessionExecutionIds.get(record.request_id) ?? new Set<string>();
      executionIds.add(record.execution_id);
      sessionExecutionIds.set(record.request_id, executionIds);
    },
    async recordReview(input) {
      if (!sessionRequests.has(input.request_id) && loadTraces({ requestId: input.request_id }).length === 0) {
        return "unknown_request";
      }
      await append({ type: "review", schema_version: TRACE_SCHEMA_VERSION, timestamp: new Date().toISOString(), ...input });
      return "recorded";
    },
    async recordExecutionReview(input) {
      const knownExecutionIds = sessionExecutionIds.get(input.request_id);
      if (!sessionRequests.has(input.request_id) || knownExecutionIds === undefined || !knownExecutionIds.has(input.execution_id)) {
        const trace = loadTraces({ requestId: input.request_id })[0];
        if (trace === undefined) return "unknown_request";
        if (!trace.executions.some((execution) => execution.execution_id === input.execution_id)) return "unknown_execution";
      }
      await append({ type: "execution_review", schema_version: TRACE_SCHEMA_VERSION, timestamp: new Date().toISOString(), ...input });
      return "recorded";
    },
    knowsRequest(requestId) {
      return sessionRequests.has(requestId) || loadTraces({ requestId }).length > 0;
    },
    load: loadTraces,
  };
}
