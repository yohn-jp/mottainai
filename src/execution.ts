import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRisk } from "./catalog.js";
import { summarizeExecution } from "./adaptive/evidence.js";
import type { ExecutionStatus } from "./adaptive/trace.js";
import { compactToBudget } from "./compress/budget.js";
import { resolveTokenBudget } from "./compress/config.js";
import type { ResolvedGatewayConfig } from "./config.js";
import type { ArtifactStore } from "./retrieve.js";

/** 新 execution path はこの集合へ追加し、conformance matrix の追加を型検査で強制する。 */
export const EXECUTION_PATHS = ["prefixed", "brokered", "logical", "local", "provider_fallback"] as const;
export type ExecutionPath = typeof EXECUTION_PATHS[number];

/** 実行中に試した provider/tool。失敗理由は routing metadata と trace の共通入力にする。 */
export interface ExecutionAttempt {
  provider: string;
  tool: string;
  backend?: string;
  error: string;
}

export type OutcomeStatus = Extract<ExecutionStatus, "success" | "empty" | "tool_error" | "provider_error" | "unavailable">;

/** 全 execution path が trace・telemetry・routing metadata へ渡す正規化済み結果。 */
export interface ExecutionOutcome {
  result: CallToolResult;
  selectedProvider: string;
  selectedTool: string;
  selectedBackend?: string;
  capability: string;
  risk: ToolRisk;
  attempts: ExecutionAttempt[];
  status: OutcomeStatus;
  resultCount: number;
  outputSize: number;
}

export interface ExecutionOutcomeInput {
  result: CallToolResult;
  selectedProvider: string;
  selectedTool: string;
  selectedBackend?: string;
  capability: string;
  risk: ToolRisk;
  attempts?: ExecutionAttempt[];
  status?: OutcomeStatus;
}

export interface BudgetedExecution {
  outcome: ExecutionOutcome;
  decision: { target_tokens: number; source: "tool" | "capability" | "profile" | "gateway"; truncated: boolean } | undefined;
}

/** MCP 結果の形を各 dispatch 実装で再判定せず、共通 status へ変換する。 */
export function normalizeExecutionOutcome(input: ExecutionOutcomeInput): ExecutionOutcome {
  const evidence = summarizeExecution(input.result);
  return {
    ...input,
    attempts: input.attempts ?? [],
    status: input.status ?? evidence.status,
    resultCount: evidence.result_count,
    outputSize: evidence.output_size,
  };
}

/** provider/接続例外を trace へ残す。MCP へ返す結果ではないため空結果を保持する。 */
export function providerErrorOutcome(input: Omit<ExecutionOutcomeInput, "result"> & { error: string }): ExecutionOutcome {
  return {
    result: { content: [], isError: true },
    selectedProvider: input.selectedProvider,
    selectedTool: input.selectedTool,
    selectedBackend: input.selectedBackend,
    capability: input.capability,
    risk: input.risk,
    attempts: [...(input.attempts ?? []), {
      provider: input.selectedProvider,
      tool: input.selectedTool,
      ...(input.selectedBackend === undefined ? {} : { backend: input.selectedBackend }),
      error: input.error,
    }],
    status: "provider_error",
    resultCount: 0,
    outputSize: 0,
  };
}

/** text/structuredContent を含む MCP 結果全体を budget 判定し、超過分を artifact へ退避する。 */
export function applyExecutionBudget(
  outcome: ExecutionOutcome,
  toolName: string,
  capability: string | undefined,
  config: ResolvedGatewayConfig,
  artifactStore: ArtifactStore,
): BudgetedExecution {
  const budget = resolveTokenBudget({
    toolName,
    capability,
    config,
    isError: outcome.status === "tool_error" || outcome.result.isError === true,
  });
  if (budget === undefined) return { outcome, decision: undefined };

  const applied = budgetResult(outcome.result, budget.targetTokens, artifactStore);
  const normalized = normalizeExecutionOutcome({
    ...outcome,
    result: applied.result,
    attempts: outcome.attempts,
  });
  return {
    outcome: normalized,
    decision: { target_tokens: budget.targetTokens, source: budget.source, truncated: applied.truncated },
  };
}

function budgetResult(
  result: CallToolResult,
  targetTokens: number,
  artifactStore: ArtifactStore,
): { result: CallToolResult; truncated: boolean } {
  const originalText = JSON.stringify(result);
  const targetBytes = targetTokens * 4;
  if (Buffer.byteLength(originalText) <= targetBytes) return { result, truncated: false };

  const fixed = { ...result, content: [] };
  const fixedBytes = Buffer.byteLength(JSON.stringify(fixed));
  const contentBudget = Math.max(256, targetTokens - Math.ceil(fixedBytes / 4));
  const content = (result.content ?? []).map((block) => {
    if (block.type !== "text") return block;
    const text = compactToBudget(block.text, contentBudget, Buffer.byteLength(block.text));
    return text === block.text ? block : { ...block, text };
  });
  const compacted = { ...result, content };
  if (Buffer.byteLength(JSON.stringify(compacted)) <= targetBytes) {
    const contentChanged = JSON.stringify(compacted.content) !== JSON.stringify(result.content);
    if (!contentChanged) return { result: compacted, truncated: true };
    const artifactId = artifactStore.put(result);
    return {
      result: {
        ...compacted,
        content: [
          ...(compacted.content ?? []),
          { type: "text" as const, text: `[mottainai compression: original_id=${artifactId}; retrieve=mottainai_retrieve]` },
        ],
      },
      truncated: true,
    };
  }

  const artifactId = artifactStore.putArtifact({
    text: originalText,
    metadata: { operation: "result_budget", summary: `result exceeded ${targetTokens} tokens` },
  });
  const marker = `[mottainai budget: original_id=${artifactId}; retrieve=mottainai_result_get]`;
  const structured = result.structuredContent;
  const compactStructured = typeof structured === "object" && structured !== null
    ? {
      operation: typeof (structured as Record<string, unknown>).operation === "string" ? (structured as Record<string, unknown>).operation : "execution",
      status: typeof (structured as Record<string, unknown>).status === "string" ? (structured as Record<string, unknown>).status : "partial",
      summary: typeof (structured as Record<string, unknown>).summary === "string" ? (structured as Record<string, unknown>).summary : "result exceeded configured budget",
      facts: [],
      diagnostics: [{ severity: "warning", message: `full result stored as ${artifactId}` }],
      metrics: { budget_target_tokens: targetTokens },
      result_id: artifactId,
      truncated: true,
    }
    : undefined;
  const compactResult = {
    ...result,
    content: [{ type: "text" as const, text: marker }],
    ...(compactStructured === undefined ? { structuredContent: undefined } : { structuredContent: compactStructured }),
  };
  const compactWithoutMetadata = { ...compactResult, _meta: undefined };
  /*
   * _meta is part of the budgeted CallToolResult. Keep it when the compact
   * result fits; otherwise the artifact already contains the complete value.
   */
  if (Buffer.byteLength(JSON.stringify(compactResult)) <= targetBytes) {
    return { result: compactResult, truncated: true };
  }
  return {
    result: compactWithoutMetadata,
    truncated: true,
  };
}
