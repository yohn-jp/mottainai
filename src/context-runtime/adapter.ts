import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedGatewayConfig } from "../config.js";
import type { ArtifactStore } from "../retrieve.js";
import { applyResponseBudget, DEFAULT_RESPONSE_BUDGET, projectedBytes, projectedTokens } from "./budget.js";
import { applyBurstReduction, isBlockingProjection } from "./burst-budget.js";
import type { BurstBudgetController, BurstReservation } from "./burst-budget.js";
import { dedupeProjectedResult } from "./dedupe.js";
import type { DedupeContext } from "./dedupe.js";
import { hasStructuredEnvelope, markOmissionsRetrievable, projectResult, serializeProjectedResult } from "./project.js";
import type { ProjectedResult, ProjectionStats } from "./types.js";
import type { TelemetrySink } from "../telemetry.js";

/** dispatch 前に取得済みの burst reservation。finalize 後の解放は呼び出し側（proxy.ts）が行う。 */
export interface BurstContext {
  controller: BurstBudgetController;
  reservation: BurstReservation;
}

export interface FinalizedToolResult {
  result: CallToolResult;
  stats: ProjectionStats;
}

export interface IdentityDedupeContext extends DedupeContext {
  telemetry?: Pick<TelemetrySink, "recordDedupe">;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rawArtifactText(result: CallToolResult): string {
  return JSON.stringify(result);
}

/**
 * Projection telemetry measures the artifact currently retained for this
 * result, not the candidate payload supplied to the store. An unavailable or
 * invalid observation is conservatively reported as no retained bytes.
 */
function retainedArtifactBytes(store: ArtifactStore, resultId: string): number | undefined {
  if (resultId.length === 0) return undefined;
  try {
    const bytes = store.getStoredArtifactBytes(resultId);
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    // A failed observation cannot establish that any candidate bytes remain retained.
    return undefined;
  }
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
 * burst budget の可否を判定する。reservation は呼び出し側が dispatch 前に既に
 * reserveEnvelope 済みのものを渡す — ここでは isBlocking の確定と admitOptional のみ行う。
 * release はここでは呼ばない: 呼び出し側がレスポンス確定後に 1 回だけ呼ぶ。
 */
function decideBurstAdmission(
  projected: ProjectedResult,
  burst: BurstContext | undefined,
): boolean {
  if (burst === undefined) return true;
  burst.controller.updatePriority(burst.reservation, isBlockingProjection(projected));
  return burst.controller.admitOptional(burst.reservation, projectedTokens(projected), projectedBytes(projected)).admitted;
}

export function finalizeToolResult(
  result: CallToolResult,
  config: ResolvedGatewayConfig,
  store: ArtifactStore,
  burst: BurstContext | undefined = undefined,
  dedupe: IdentityDedupeContext | undefined = undefined,
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
        estimatedOmittedTokens: Math.max(0, Math.ceil(rawBytes / 4) - Math.ceil(returnedBytes / 4)),
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
  // `storedBytes` is an event-level count for the artifact backing this
  // projection. It is not aggregate store occupancy and does not include
  // artifacts evicted while this one was inserted.
  let storedBytes = retainedArtifactBytes(store, budgeted.resultId) ?? 0;
  const burstAdmitted = decideBurstAdmission(budgeted, burst);

  if (
    shouldRetainEvidence(budgeted.resultId, budgeted.truncated, budgeted.omissions.length)
    || (!burstAdmitted && budgeted.resultId.length === 0)
  ) {
    const evidence = rawArtifactText(result);
    try {
      const resultId = store.putArtifact({
        text: evidence,
        metadata: { operation: "context_runtime", summary: projected.summary },
      });
      const retainedBytes = retainedArtifactBytes(store, resultId);
      if (retainedBytes !== undefined && resultId.length > 0) {
        storedBytes = retainedBytes;
        budgeted = applyResponseBudget(markOmissionsRetrievable({ ...projected, resultId }), budget);
      } else {
        // A returned ID without a currently retained artifact is not a valid
        // retrieval claim, so leave the projection without that ID.
        storedBytes = 0;
      }
    } catch {
      // Evidence retention is optional; a failed store operation must not turn
      // the unretained candidate into a positive telemetry measurement.
      storedBytes = 0;
    }
  }

  const bursted = burstAdmitted ? budgeted : applyBurstReduction(budgeted);
  const beforeDedupe = toCallToolResult(result, serializeProjectedResult(bursted));
  const deduplicated = dedupe === undefined
    ? { result: bursted, eligible: false, hit: false, collision: false }
    : dedupeProjectedResult(bursted, budget, store, dedupe);
  const finalProjected = deduplicated.result;
  const finalized = toCallToolResult(result, serializeProjectedResult(finalProjected));
  const returnedBytes = serializedBytes(finalized);
  if (dedupe !== undefined && deduplicated.eligible) {
    const beforeBytes = serializedBytes(beforeDedupe);
    const avoidedBytes = deduplicated.hit ? Math.max(0, beforeBytes - returnedBytes) : 0;
    dedupe.telemetry?.recordDedupe?.({
      hit: deduplicated.hit,
      bytesAvoided: avoidedBytes,
      estimatedTokensAvoided: deduplicated.hit
        ? Math.max(0, Math.ceil(beforeBytes / 4) - Math.ceil(returnedBytes / 4))
        : 0,
    });
  }
  return {
    result: finalized,
    stats: {
      rawBytes,
      storedBytes,
      returnedBytes,
      omittedBytes: Math.max(0, rawBytes - returnedBytes),
      estimatedProjectedTokens: projectedTokens(finalProjected),
      estimatedOmittedTokens: Math.max(0, Math.ceil(rawBytes / 4) - projectedTokens(finalProjected)),
    },
  };
}
