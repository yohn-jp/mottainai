import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../config.js";
import type { ArtifactStore } from "../retrieve.js";
import { applyResponseBudget, DEFAULT_RESPONSE_BUDGET, projectedBytes, projectedTokens } from "./budget.js";
import { applyBurstReduction, isBlockingProjection } from "./burst-budget.js";
import type { BurstBudgetController } from "./burst-budget.js";
import { hasStructuredEnvelope, markOmissionsRetrievable, projectResult, serializeProjectedResult } from "./project.js";
import type { ProjectedResult, ProjectionStats } from "./types.js";

export interface FinalizedToolResult {
  result: CallToolResult;
  stats: ProjectionStats;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rawArtifactText(result: CallToolResult): string {
  return JSON.stringify(result);
}

function shouldRetainEvidence(resultId: string, truncated: boolean, omissions: number): boolean {
  return resultId.length === 0 && (truncated || omissions > 0);
}

function boundedText(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "… use mottainai_result_get for full evidence …";
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = marker.slice(0, 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${marker}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function finalizeUnstructuredResult(result: CallToolResult, hardBytes: number): CallToolResult {
  const textBlock = (result.content ?? []).find(
    (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
  );
  const fixed: CallToolResult = { ...result, content: [] };
  delete fixed._meta;
  if (textBlock === undefined) return fixed;
  const textBytes = Buffer.byteLength(textBlock.text, "utf8");
  let low = 0;
  let high = textBytes;
  let best: CallToolResult | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: CallToolResult = {
      ...fixed,
      content: [{ type: "text", text: boundedText(textBlock.text, middle) }],
    };
    if (serializedBytes(candidate) <= hardBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? fixed;
}

function toCallToolResult(
  result: CallToolResult,
  serialized: ReturnType<typeof serializeProjectedResult>,
): CallToolResult {
  const next: CallToolResult = {
    ...result,
    content: serialized.content as CallToolResult["content"],
    structuredContent: serialized.structuredContent,
  };
  if (serialized.isError === undefined) delete next.isError;
  else next.isError = serialized.isError;
  if (serialized.meta === undefined) delete next._meta;
  else next._meta = serialized.meta as CallToolResult["_meta"];
  return next;
}

/**
 * burst budget の可否を一度だけ判定する。reservation は呼び出しにつき 1 回だけ
 * reserve/release する — 同一呼び出しを二重に in-flight 登録すると優先度計算・rolling
 * window の消費量が二重加算され、admission の決定性が壊れる。
 */
function decideBurstAdmission(
  projected: ProjectedResult,
  burst: BurstBudgetController | undefined,
): boolean {
  if (burst === undefined) return true;
  const reservation = burst.reserveEnvelope(isBlockingProjection(projected));
  try {
    return burst.admitOptional(reservation, projectedTokens(projected), projectedBytes(projected)).admitted;
  } finally {
    burst.release(reservation);
  }
}

export function finalizeToolResult(
  result: CallToolResult,
  config: ResolvedGatewayConfig,
  store: ArtifactStore,
  burst: BurstBudgetController | undefined = undefined,
): FinalizedToolResult {
  const rawBytes = serializedBytes(result);
  const structuredContent = result.structuredContent;
  if (!hasStructuredEnvelope(structuredContent)) {
    const budget = config.responseBudget ?? DEFAULT_RESPONSE_BUDGET;
    const hardBytes = Math.min(budget.hardBytes, budget.hardTokens * 4);
    const finalized = rawBytes <= hardBytes ? result : finalizeUnstructuredResult(result, hardBytes);
    const returnedBytes = serializedBytes(finalized);
    return {
      result: finalized,
      stats: {
        rawBytes,
        storedBytes: 0,
        returnedBytes,
        omittedBytes: Math.max(0, rawBytes - returnedBytes),
        estimatedProjectedTokens: Math.ceil(returnedBytes / 4),
      },
    };
  }

  const budget = config.responseBudget ?? DEFAULT_RESPONSE_BUDGET;
  const projected = projectResult({
    structuredContent,
    content: result.content ?? [],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result._meta === undefined ? {} : { meta: result._meta }),
  });
  let budgeted = applyResponseBudget(projected, budget);
  let storedBytes = budgeted.resultId.length > 0 ? rawBytes : 0;
  const burstAdmitted = decideBurstAdmission(budgeted, burst);

  if (
    shouldRetainEvidence(budgeted.resultId, budgeted.truncated, budgeted.omissions.length)
    || (!burstAdmitted && budgeted.resultId.length === 0)
  ) {
    const evidence = rawArtifactText(result);
    const resultId = store.putArtifact({
      text: evidence,
      metadata: { operation: "context_runtime", summary: projected.summary },
    });
    storedBytes = Buffer.byteLength(evidence, "utf8");
    budgeted = applyResponseBudget(markOmissionsRetrievable({ ...projected, resultId }), budget);
  }

  const bursted = burstAdmitted ? budgeted : applyBurstReduction(budgeted);
  const finalized = toCallToolResult(result, serializeProjectedResult(bursted));
  const returnedBytes = serializedBytes(finalized);
  return {
    result: finalized,
    stats: {
      rawBytes,
      storedBytes,
      returnedBytes,
      omittedBytes: Math.max(0, rawBytes - returnedBytes),
      estimatedProjectedTokens: projectedTokens(bursted),
    },
  };
}
