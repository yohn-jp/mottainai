import type { ResolvedGatewayConfig, TokenBudgetEntry } from "../config.js";

/** 環境変数 MOTTAINAI_COMPRESS を見て、圧縮パイプラインを有効化するか判定する。既定は有効。 */
export function isCompressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MOTTAINAI_COMPRESS;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** Tool定義description圧縮の有効判定。既定有効、MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS=0で無効。 */
export function isToolDescriptionCompressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** コード骨格化の有効判定。既定有効、MOTTAINAI_COMPRESS_CODE=0で無効。 */
export function isCodeCompressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MOTTAINAI_COMPRESS_CODE;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

export interface TokenBudget {
  targetTokens: number;
  source: "tool" | "capability" | "profile" | "gateway";
}

function pickTokenValue(entry: TokenBudgetEntry | undefined, isError: boolean): number | undefined {
  if (entry === undefined) return undefined;
  return isError ? entry.failure ?? entry.success : entry.success ?? entry.failure;
}

/**
 * tool / capability / profile / gateway 既定の順で圧縮予算を解決する。**opt-in。**
 * 該当する設定が一つも無ければ `undefined` を返し、呼び出し側は既存の圧縮結果を
 * そのまま使う（トークン上限を課さない）。これが「既定は無制限」の実体で、
 * `docs/compression-benchmark.md` の baseline を動かさない根拠になる。
 */
export function resolveTokenBudget(input: {
  toolName: string;
  capability?: string;
  config: ResolvedGatewayConfig;
  isError: boolean;
}): TokenBudget | undefined {
  const budgets = input.config.tokenBudgets;

  const toolTokens = pickTokenValue(budgets.tools[input.toolName], input.isError);
  if (toolTokens !== undefined) return { targetTokens: toolTokens, source: "tool" };

  const capabilityTokens = input.capability === undefined
    ? undefined
    : pickTokenValue(budgets.capabilities[input.capability], input.isError);
  if (capabilityTokens !== undefined) return { targetTokens: capabilityTokens, source: "capability" };

  const profileTokens = input.config.activeProfile === undefined
    ? undefined
    : pickTokenValue(budgets.profiles[input.config.activeProfile], input.isError);
  if (profileTokens !== undefined) return { targetTokens: profileTokens, source: "profile" };

  const gatewayTokens = pickTokenValue(budgets.default, input.isError);
  if (gatewayTokens !== undefined) return { targetTokens: gatewayTokens, source: "gateway" };

  return undefined;
}
