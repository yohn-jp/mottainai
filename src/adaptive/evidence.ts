import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionStatus } from "./trace.js";

/**
 * 実行結果から trace 用の metadata だけを取り出す。原文は保存しない。
 *
 * 「成功したか」ではなく「証拠が返ったか」を数えたいので、エラーでなくても中身が
 * 空なら `empty` として区別する。空振りの provider は統計で見えなければ直せない。
 *
 * ここで判定できるのは呼び出しが完了した場合だけ（tool 自体が `isError` を返した、
 * または中身が空だった）。dispatch 自体が例外を投げた provider/接続の失敗
 * （`provider_error`）は呼び出し側（`proxy.ts`）が別途判定する。
 */

export interface ExecutionEvidence {
  status: Extract<ExecutionStatus, "success" | "empty" | "tool_error">;
  result_count: number;
  output_size: number;
}

function textOf(result: CallToolResult): string[] {
  return (result.content ?? []).flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []));
}

/**
 * 返った証拠の件数。
 *
 * 1. structured output の `metrics.result_count`
 * 2. structured output の `facts` 配列長
 * 3. 単一 text が JSON 配列ならその要素数
 * 4. それ以外は content 要素数
 */
export function evidenceCount(result: CallToolResult): number {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const metrics = structured?.metrics;
  if (typeof metrics === "object" && metrics !== null) {
    const count = (metrics as Record<string, unknown>).result_count;
    if (typeof count === "number" && Number.isFinite(count)) return count;
  }
  if (Array.isArray(structured?.facts) && structured.facts.length > 0) return structured.facts.length;
  const texts = textOf(result);
  if (texts.length === 1) {
    try {
      const parsed: unknown = JSON.parse(texts[0]);
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      // JSON でないテキストは 1 件の証拠として数える
    }
  }
  return (result.content ?? []).length;
}

export function summarizeExecution(result: CallToolResult): ExecutionEvidence {
  const outputSize = Buffer.byteLength(JSON.stringify(result.content ?? []), "utf8");
  const texts = textOf(result);
  const empty = (result.content ?? []).length === 0 || (texts.length === (result.content ?? []).length && texts.every((text) => text.trim().length === 0));
  const structuredStatus = (result.structuredContent as Record<string, unknown> | undefined)?.status;
  const status = result.isError === true || structuredStatus === "failed"
    ? "tool_error"
    : empty
      ? "empty"
      : "success";
  return { status, result_count: empty ? 0 : evidenceCount(result), output_size: outputSize };
}
