import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface LogRecord {
  /** ログ全体で一意なID。将来「圧縮前オリジナルを取得する」機能の参照キーとして使える。 */
  id: string;
  timestamp: string;
  upstreamName: string;
  toolName: string;
  arguments: unknown;
  /** upstreamから返った圧縮前の生のCallToolResult。 */
  rawResult: unknown;
}

export interface Logger {
  log(record: Omit<LogRecord, "id" | "timestamp">): Promise<void>;
}

const NOOP_LOGGER: Logger = {
  async log() {
    // no-op
  },
};

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

// key名ベースのredaction。値の中身までは見ない（誤検知よりも見逃しを避ける方向はredact()側の再帰で担保）。
const REDACT_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authoriz|cookie|credential|access[-_]?key|private[-_]?key|session)/i;
const REDACTED = "[REDACTED]";

function isLoggingEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.MOTTAINAI_LOG;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

function isRedactionEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.MOTTAINAI_LOG_REDACT;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

function resolveLogDir(env: NodeJS.ProcessEnv): string {
  return env.MOTTAINAI_LOG_DIR ?? path.join(process.cwd(), ".mottainai", "log");
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRetentionMs(env: NodeJS.ProcessEnv): number {
  return positiveNumber(env.MOTTAINAI_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
}

function resolveMaxFileBytes(env: NodeJS.ProcessEnv): number {
  return positiveNumber(env.MOTTAINAI_LOG_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
}

function boundedLogLine(record: LogRecord, maxBytes: number): string {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  const rawResultText = JSON.stringify(record.rawResult);
  const compact: LogRecord = {
    ...record,
    arguments: "[mottainai log record truncated]",
    rawResult: {
      truncated: true,
      original_bytes: Buffer.byteLength(rawResultText, "utf8"),
      sha256: createHash("sha256").update(rawResultText).digest("hex"),
    },
  };
  return `${JSON.stringify(compact)}\n`;
}

function resolveExcludedTools(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.MOTTAINAI_LOG_EXCLUDE_TOOLS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

// 同一ミリ秒内にロールオーバーするとtimestampだけでは名前が衝突し、
// 上限超過後も同じファイルへ追記され続けるため連番で区別する。
let logFileSequence = 0;

function logFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_pid${process.pid}_${logFileSequence++}.jsonl`;
}

/** key名が機微情報パターンに一致する値を再帰的に[REDACTED]へ置換する。 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

/** 起動時に保存期間を超えたjsonlを削除する。掃除の失敗はロギング続行を妨げない。 */
function sweepExpiredLogs(logDir: string, maxAgeMs: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(logDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      // 掃除中の消失・権限エラーはロギング続行を妨げない
    }
  }
}

/**
 * 環境変数から設定を解決し、Loggerを構築する。MOTTAINAI_LOG=0 なら no-op logger を返す。
 *
 * 環境変数:
 * - MOTTAINAI_LOG=0 — ロギング無効化（既定は有効）
 * - MOTTAINAI_LOG_DIR — 出力先ディレクトリ（既定 `.mottainai/log/`）
 * - MOTTAINAI_LOG_REDACT=0 — secret/token/cookie等のredactionを無効化（既定は有効。デバッグ用の逃げ道）
 * - MOTTAINAI_LOG_EXCLUDE_TOOLS — カンマ区切りのtool名。`toolName`単体または`<upstream>__<tool>`でマッチしたら記録しない
 * - MOTTAINAI_LOG_RETENTION_DAYS — 保存日数（既定14日）。起動時に期限切れjsonlを削除
 * - MOTTAINAI_LOG_MAX_FILE_BYTES — 1ファイルの上限バイト数（既定10MiB）。超過したら新規ファイルへロールオーバー
 */
export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  if (!isLoggingEnabled(env)) return NOOP_LOGGER;

  const logDir = resolveLogDir(env);
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  sweepExpiredLogs(logDir, resolveRetentionMs(env));

  const redactEnabled = isRedactionEnabled(env);
  const excludedTools = resolveExcludedTools(env);
  const maxFileBytes = resolveMaxFileBytes(env);
  // 最小 envelope 未満の設定でも JSONL を壊さない。通常値では設定値をそのまま使う。
  const maxRecordBytes = Math.max(maxFileBytes, 256);

  let filePath = path.join(logDir, logFileName());
  let currentFileBytes = 0;

  // 単一プロセス内での書き込み順序を保証するための直列化チェーン。
  // ロールオーバー判定もこのチェーン内で行い、並行呼び出し時のサイズ計算競合を避ける。
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    async log(record) {
      if (
        excludedTools.has(record.toolName) ||
        excludedTools.has(`${record.upstreamName}__${record.toolName}`)
      ) {
        return;
      }

      const full: LogRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        upstreamName: record.upstreamName,
        toolName: record.toolName,
        arguments: redactEnabled ? redact(record.arguments) : record.arguments,
        rawResult: redactEnabled ? redact(record.rawResult) : record.rawResult,
      };
      const line = boundedLogLine(full, maxRecordBytes);

      writeQueue = writeQueue
        .then(async () => {
          const lineBytes = Buffer.byteLength(line, "utf8");
          if (currentFileBytes > 0 && currentFileBytes + lineBytes > maxFileBytes) {
            filePath = path.join(logDir, logFileName());
            currentFileBytes = 0;
          }
          currentFileBytes += lineBytes;
          await fs.promises.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
        })
        .catch((err) => {
          console.error("mottainai: failed to write log record", err);
        });
      await writeQueue;
    },
  };
}
