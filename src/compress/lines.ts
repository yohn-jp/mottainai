export interface LineFilterOptions {
  /** 連続する完全一致重複行をこの件数まで残す。 */
  maxConsecutiveDuplicates?: number;
  /** 連続する空行をこの件数まで残す。 */
  maxConsecutiveBlankLines?: number;
  /** 1行あたりの最大文字数。超えた分は切り詰める。 */
  maxLineLength?: number;
  /** 全体の最大行数。超えた場合は先頭/末尾を残し中間を省略する。 */
  maxTotalLines?: number;
  /** maxTotalLines超過時、先頭に残す行数。 */
  headLines?: number;
  /** maxTotalLines超過時、末尾に残す行数。 */
  tailLines?: number;
}

const MAX_TOTAL_LINES = 2000;

export const DEFAULT_LINE_FILTER_OPTIONS: Required<LineFilterOptions> = {
  maxConsecutiveDuplicates: 1,
  maxConsecutiveBlankLines: 1,
  maxLineLength: 500,
  maxTotalLines: MAX_TOTAL_LINES,
  headLines: Math.round(MAX_TOTAL_LINES * 0.7),
  tailLines: Math.round(MAX_TOTAL_LINES * 0.3),
};

/** 連続する完全一致重複行を畳む（例: 同一行が50回続く → 1行 + 省略マーカー）。 */
export function collapseDuplicateLines(input: string, maxConsecutive: number): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i];
    let runLength = 1;
    while (i + runLength < lines.length && lines[i + runLength] === current) {
      runLength++;
    }
    const kept = Math.min(runLength, Math.max(maxConsecutive, 0));
    for (let k = 0; k < kept; k++) out.push(current);
    const omitted = runLength - kept;
    if (omitted > 0) out.push(`⋯ ${omitted} duplicate lines omitted ⋯`);
    i += runLength;
  }
  return out.join("\n");
}

/** 連続する空行を畳む。 */
export function collapseBlankLines(input: string, maxConsecutive: number): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun++;
      if (blankRun <= Math.max(maxConsecutive, 0)) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out.join("\n");
}

const OMISSION_MARKER_PATTERN = /^⋯ .+ omitted ⋯$/;

/** 1行あたりの長さを切り詰める。省略マーカー行自身は対象外とする。 */
export function truncateLongLines(input: string, maxLineLength: number): string {
  if (maxLineLength <= 0) return input;
  return input
    .split("\n")
    .map((line) => {
      if (line.length <= maxLineLength || OMISSION_MARKER_PATTERN.test(line)) return line;
      const omitted = line.length - maxLineLength;
      return `${line.slice(0, maxLineLength)}…(+${omitted} chars)`;
    })
    .join("\n");
}

/** 総行数が多すぎる場合、先頭・末尾を残し中間を省略する。 */
export function truncateExcessLines(
  input: string,
  headLines: number,
  tailLines: number,
  maxTotalLines: number,
): string {
  const lines = input.split("\n");
  if (lines.length <= maxTotalLines) return input;

  const retainedLineBudget = Math.max(maxTotalLines, 0);
  const headCount = Math.min(Math.max(headLines, 0), retainedLineBudget);
  const tailCount = Math.min(Math.max(tailLines, 0), Math.max(retainedLineBudget - headCount, 0));
  const head = lines.slice(0, headCount);
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  return [...head, `⋯ ${omitted} lines omitted ⋯`, ...tail].join("\n");
}

/**
 * 重複行畳み込み → 空行畳み込み → 行長切詰め → 総行数切詰め、の順で適用する合成関数。
 * 有効な情報を優先的に残すため、先に冗長性を畳んでから長さの制約をかける。
 */
export function filterLines(input: string, options?: LineFilterOptions): string {
  const opts = { ...DEFAULT_LINE_FILTER_OPTIONS, ...options };
  let text = input;
  text = collapseDuplicateLines(text, opts.maxConsecutiveDuplicates);
  text = collapseBlankLines(text, opts.maxConsecutiveBlankLines);
  text = truncateLongLines(text, opts.maxLineLength);
  text = truncateExcessLines(text, opts.headLines, opts.tailLines, opts.maxTotalLines);
  return text;
}
