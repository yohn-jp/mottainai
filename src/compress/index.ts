import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stripAnsi } from "./ansi.js";
import { compressJsonText, tryParseJson } from "./json.js";
import type { JsonCompressOptions } from "./json.js";
import { filterLines } from "./lines.js";
import type { LineFilterOptions } from "./lines.js";
import { compressKnownCliOutput } from "./cli.js";
import type { CliCompressOptions } from "./cli.js";
import { compressCodeText } from "./code.js";
import type { CodeSkeletonOptions } from "./code.js";

export interface CompressOptions {
  ansi?: boolean;
  json?: JsonCompressOptions | false;
  lines?: LineFilterOptions | false;
  cli?: CliCompressOptions | false;
  code?: CodeSkeletonOptions | false;
}

export const DEFAULT_COMPRESS_OPTIONS: Required<CompressOptions> = {
  ansi: true,
  json: {},
  lines: {},
  cli: {},
  code: false,
};

/**
 * ANSI除去 → JSON検出/圧縮 → (非JSON時のみ)行フィルタ、の順で適用する。
 * JSONとして解釈できたテキストへ行フィルタをかけると再シリアライズ後の
 * 改行位置で意味が壊れるため、JSON圧縮が効いた場合は行フィルタを併用しない。
 */
export function compressText(input: string, options?: CompressOptions): string {
  const opts = { ...DEFAULT_COMPRESS_OPTIONS, ...options };

  let text = opts.ansi ? stripAnsi(input) : input;

  if (opts.cli !== false) {
    text = compressKnownCliOutput(text, opts.cli);
  }

  if (opts.json !== false && tryParseJson(text) !== undefined) {
    return compressJsonText(text, opts.json);
  }

  if (opts.code !== false) {
    text = compressCodeText(text, opts.code);
  }

  if (opts.lines !== false) {
    text = filterLines(text, opts.lines);
  }

  return text;
}

/**
 * CallToolResult.content の各要素のうち type === "text" のものだけ text を圧縮する。
 * image / audio / resource_link / resource はそのまま素通しする。
 */
export function compressCallToolResult(
  result: CallToolResult,
  options?: CompressOptions,
): CallToolResult {
  if (!Array.isArray(result.content)) return result;

  const content = result.content.map((block) => {
    if (block.type === "text") {
      return { ...block, text: compressText(block.text, options) };
    }
    return block;
  });

  return { ...result, content };
}
