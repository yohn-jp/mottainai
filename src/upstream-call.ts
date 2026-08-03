import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DecisionMetadata } from "./adaptive/decision-metadata.js";
import { compressCallToolResult } from "./compress/index.js";
import { isCodeCompressionEnabled, isCompressionEnabled } from "./compress/config.js";
import { detectCodeLanguage } from "./compress/code.js";
import type { ResolvedGatewayConfig } from "./config.js";
import type { Logger } from "./logging.js";
import type { ArtifactStore } from "./retrieve.js";
import { normalizeExecutionOutcome } from "./execution.js";
import type { ExecutionOutcome } from "./execution.js";
import type { TelemetrySink } from "./telemetry.js";
import type { UpstreamRegistry } from "./upstream.js";

/**
 * upstream tool の実行経路。
 *
 * 名前プレフィックス経由（`<upstream>__<tool>`）と catalog 経由（`mottainai_tool_call`）で
 * 同じ経路を通す。圧縮とロギングと artifact 保存が片方だけ抜ける事故を防ぐため、
 * 呼び出し口ごとに書かずここへ集約する。
 *
 * decision metadata は text へ直接付けず `decision` として返す。
 * `mottainai_tool_call` の fallback（#21）は複数回この関数を呼びうるので、
 * 実行のたびに routing 行を足すのではなく、最終的な決着が付いた 1 回だけ呼び出し側が
 * `attachDecisionMetadata()` で fallback 履歴などとマージして付ける。
 */

export const RETRIEVE_TOOL_NAME = "mottainai_retrieve";

export interface UpstreamCallContext {
  upstreams: UpstreamRegistry;
  logger: Logger;
  artifactStore: ArtifactStore;
  /** 既定は未設定（telemetry 記録なし）。#27 の opt-in 集計に使う。 */
  telemetry?: TelemetrySink;
}

/** 圧縮予算の解決に要る情報。省略すると budget 解決自体を行わない（opt-in の呼び出し側スイッチ）。 */
export interface TokenBudgetOptions {
  config: ResolvedGatewayConfig;
  capability?: string;
}

export function commandFromArguments(arguments_: unknown): string | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null) return undefined;
  const values = arguments_ as Record<string, unknown>;
  return typeof values.command === "string"
    ? values.command
    : typeof values.cmd === "string"
      ? values.cmd
      : undefined;
}

export interface UpstreamCallResult {
  result: CallToolResult;
  decision: DecisionMetadata;
  outcome: ExecutionOutcome;
}

/** text content block の合計バイト数。telemetry の圧縮率計測にだけ使う概算。 */
function contentBytes(result: CallToolResult): number {
  if (!Array.isArray(result.content)) return 0;
  return result.content.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
}

export async function callUpstreamTool(
  context: UpstreamCallContext,
  upstreamName: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  budgetOptions?: TokenBudgetOptions,
): Promise<UpstreamCallResult> {
  const handle = await context.upstreams.start(upstreamName);

  let result: CallToolResult;
  try {
    result = (await handle.client.callTool({ name: toolName, arguments: args })) as CallToolResult;
  } catch (error) {
    await context.upstreams.invalidate(upstreamName, error);
    throw error;
  }

  await context.logger.log({ upstreamName, toolName, arguments: args, rawResult: result });

  if (!isCompressionEnabled()) {
    context.telemetry?.recordToolCall({
      provider: upstreamName, capability: budgetOptions?.capability,
      originalBytes: contentBytes(result), compressedBytes: contentBytes(result), isError: result.isError === true,
    });
    return {
      result,
      decision: {},
      outcome: normalizeExecutionOutcome({
        result,
        selectedProvider: upstreamName,
        selectedTool: toolName,
        capability: budgetOptions?.capability ?? "unknown",
        risk: "unknown",
      }),
    };
  }

  const compressed = compressCallToolResult(result, {
    cli: { command: commandFromArguments(args) },
    code: isCodeCompressionEnabled() ? { language: detectCodeLanguage(args) } : false,
  });

  const withCompressionMetadata = JSON.stringify(compressed) === JSON.stringify(result) ? compressed : {
    ...compressed,
    content: [
      ...(compressed.content ?? []),
      {
        type: "text" as const,
        text: `[mottainai compression: original_id=${context.artifactStore.put(result)}; retrieve=${RETRIEVE_TOOL_NAME}]`,
      },
    ],
  };

  const decision: DecisionMetadata = {};
  // token budget は proxy の共通 execution pipeline で structuredContent を含めて適用する。
  context.telemetry?.recordToolCall({
    provider: upstreamName, capability: budgetOptions?.capability,
    originalBytes: contentBytes(result), compressedBytes: contentBytes(compressed), isError: result.isError === true,
  });
  return {
    result: withCompressionMetadata,
    decision,
    outcome: normalizeExecutionOutcome({
      result: withCompressionMetadata,
      selectedProvider: upstreamName,
      selectedTool: toolName,
      capability: budgetOptions?.capability ?? "unknown",
      risk: "unknown",
    }),
  };
}
