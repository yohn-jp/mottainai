import { createHash } from "node:crypto";

/**
 * トークン予算の最終切り詰め。
 *
 * 4 レイヤ圧縮（ANSI/CLI/JSON/行フィルタ/コード骨格）が終わったあとの、最後の安全弁。
 * §4 の無変形対象（コードフェンス・URL・日本語行・git diff 等）はここでは尊重しない —
 * それらは既に圧縮パイプラインを無変形で通過済みで、ここは「それでも大きすぎる」場合の
 * 最終手段として頭と末尾を残して中間を切る。原文は必ず artifact store 経由で拾える
 * （呼び出し元が `result_id` を付ける）ことが、無変形の代わりに守るべき不変条件。
 */
export function compactToBudget(text: string, targetTokens: number, rawBytes: number): string {
  // 共通envelope分を約256 token確保。行境界を維持して先頭・末尾を残す。
  const targetBytes = (targetTokens - 256) * 4;
  // 生出力より大きいMCP payloadを返さないよう、envelope用に約1 KiB確保。
  const rawCap = rawBytes > 1024 ? rawBytes - 1024 : Number.POSITIVE_INFINITY;
  const budget = Math.max(256, Math.min(targetBytes, rawCap));
  if (Buffer.byteLength(text) <= budget) return text;
  const lines = text.split("\n");
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const markerOverhead = Buffer.byteLength(
    `⋯ mottainai omitted=${"9".repeat(String(lines.length).length)} lines sha256=${"0".repeat(16)}; use mottainai_result_get ⋯`,
    "utf8",
  ) + 2;
  const contentBudget = Math.max(0, budget - markerOverhead);
  const headBudget = Math.floor(contentBudget * 0.6);
  for (const line of lines) {
    const bytes = Buffer.byteLength(`${line}\n`);
    if (used + bytes > headBudget) break;
    head.push(line); used += bytes;
  }
  let tailUsed = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const line = lines[index];
    const bytes = Buffer.byteLength(`${line}\n`);
    if (used + tailUsed + bytes > contentBudget) break;
    tail.unshift(line); tailUsed += bytes;
  }
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return [...head, `⋯ mottainai omitted=${omitted} lines sha256=${hash}; use mottainai_result_get ⋯`, ...tail].join("\n");
}
