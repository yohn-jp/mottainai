import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RankReason } from "./capabilities.js";

/**
 * routing / compression の判断メタデータ（#23）。
 *
 * 判断が起きた呼び出しにだけ付ける。「起きた」の定義は `hasDecision()` が持つ唯一の
 * 判定基準で、通常の呼び出し（fallback なし・budget 未切り詰め・provider 選択への
 * policy 関与なし）にはトークンを一切足さない。
 */

export interface FallbackAttempt {
  provider: string;
  tool: string;
  error: string;
}

/**
 * 実際に結果を返した provider/tool（backend があれば含む）。fallback の有無に関わらず、
 * 最終的に採用された候補を指す。gateway tool 名（`mottainai_tool_call` など）ではなく
 * 実際に動いた provider を trace の execution 記録が見られるようにする
 * （issue #47 Phase 2 / issue #48 `ExecutionOutcome.selectedProvider` 相当の最小部分）。
 */
export interface ExecutionRouting {
  provider: string;
  tool: string;
  backend?: string;
}

export interface DecisionMetadata {
  selected_provider?: string;
  selected_tool?: string;
  /** `rankProviders()` の `reasons`。provider 選択に ranking が関与した場合のみ設定する。 */
  selection_reason?: RankReason[];
  /** fallback を試みた履歴。primary を含め、実際に呼び出しを試みた順。 */
  fallback_history?: FallbackAttempt[];
  budget?: { target_tokens: number; source: string; truncated: boolean };
}

/** fallback 履歴の `error` に使う。`Error` 以外の throw（文字列 throw 等）も文字列化する。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** この呼び出しに実際に「判断」が起きたか。false ならメタデータを一切付けない。 */
export function hasDecision(metadata: DecisionMetadata): boolean {
  return (metadata.fallback_history?.length ?? 0) > 0
    || metadata.budget?.truncated === true
    || (metadata.selection_reason?.length ?? 0) > 0;
}

/**
 * upstream 結果へ text metadata 行として付与する。既存の
 * `[mottainai compression: ...]` / `[mottainai trace: ...]` と同じ「追記行」形式に揃える。
 * secret を含めない — provider の `env` / `args` はここに渡さない設計にする（呼び出し側の責務）。
 */
export function attachDecisionMetadata(result: CallToolResult, metadata: DecisionMetadata): CallToolResult {
  if (!hasDecision(metadata)) return result;
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: "text" as const, text: `[mottainai routing: ${JSON.stringify(metadata)}]` },
    ],
  };
}
