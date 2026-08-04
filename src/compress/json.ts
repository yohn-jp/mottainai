import { createHash } from "node:crypto";

export interface JsonCompressOptions {
  /** 配列から保持する先頭・末尾要素の合計上限。 */
  maxArrayItems?: number;
  /** 配列末尾から保持する要素数。maxArrayItems未満に制限される。 */
  tailArrayItems?: number;
  /** 文字列値をこの文字数で切り詰め。 */
  maxStringLength?: number;
  /** オブジェクト/配列のネスト深さの上限。 */
  maxDepth?: number;
  /** 出力インデント幅（0で改行なしのミニファイ）。 */
  indent?: number;
}

export const DEFAULT_JSON_COMPRESS_OPTIONS: Required<JsonCompressOptions> = {
  maxArrayItems: 20,
  tailArrayItems: 5,
  maxStringLength: 300,
  maxDepth: 6,
  indent: 0,
};

const DEPTH_TRUNCATED_MARKER = "[truncated: max depth exceeded]";

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveJsonCompressOptions(options?: JsonCompressOptions): Required<JsonCompressOptions> {
  const merged = { ...DEFAULT_JSON_COMPRESS_OPTIONS, ...options };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a finite non-negative integer`);
    }
  }
  return merged;
}

/** 入力がJSONとしてパース可能かどうかを判定する。パース不能なら undefined を返す。 */
export function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function compressValue(value: unknown, options: Required<JsonCompressOptions>, depth: number): unknown {
  if (depth > options.maxDepth) return DEPTH_TRUNCATED_MARKER;

  if (Array.isArray(value)) {
    if (value.length <= options.maxArrayItems) {
      return value.map((item) => compressValue(item, options, depth + 1));
    }

    const tailCount = Math.min(options.tailArrayItems, Math.max(0, options.maxArrayItems - 1));
    const headCount = options.maxArrayItems - tailCount;
    const head = value.slice(0, headCount).map((item) => compressValue(item, options, depth + 1));
    const omitted = value.slice(headCount, value.length - tailCount);
    const tail = value.slice(value.length - tailCount).map((item) => compressValue(item, options, depth + 1));
    return [
      ...head,
      {
        __truncated__: true,
        omittedCount: omitted.length,
        totalCount: value.length,
        omittedSha256: sha256Json(omitted),
      },
      ...tail,
    ];
  }

  if (typeof value === "string") {
    if (value.length <= options.maxStringLength) return value;
    const omitted = value.length - options.maxStringLength;
    return `${value.slice(0, options.maxStringLength)}…(+${omitted} chars)`;
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(out, key, {
        value: compressValue(v, options, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }

  // number / boolean / null はそのまま保持
  return value;
}

/** パース済みのJSON値に対して再帰的にサンプリング・切り詰めを適用する。 */
export function compressJsonValue(value: unknown, options?: JsonCompressOptions): unknown {
  const opts = resolveJsonCompressOptions(options);
  return compressValue(value, opts, 0);
}

/**
 * 入力文字列がJSONとしてパースできればサンプリング・整形して再シリアライズした文字列を返す。
 * パース不能なら入力をそのまま返す（no-op）。
 */
export function compressJsonText(input: string, options?: JsonCompressOptions): string {
  const parsed = tryParseJson(input);
  if (parsed === undefined) return input;
  const opts = resolveJsonCompressOptions(options);
  const compressed = compressValue(parsed, opts, 0);
  return opts.indent > 0 ? JSON.stringify(compressed, null, opts.indent) : JSON.stringify(compressed);
}
