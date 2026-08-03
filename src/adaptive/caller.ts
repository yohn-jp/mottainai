import { normalizeCapability, normalizeCapabilityList, normalizeIntent, normalizeTaskCategory } from "./taxonomy.js";

/**
 * 呼び出し側が任意の gateway ツール呼び出しへ添えるタスク metadata。
 *
 * 予約キー `_mottainai` に押し込むのは、upstream ツールの引数名と衝突させないため。
 * このキーは upstream へ転送する前に必ず取り除く（`additionalProperties: false` の
 * schema を持つ upstream を壊さない）。
 */

export const CALLER_METADATA_KEY = "_mottainai";

export interface CallerTask {
  category: string;
  intent?: string;
  confidence?: number;
}

export interface CallerMetadata {
  request_id?: string;
  task?: CallerTask;
  requested_capabilities: string[];
  /** この呼び出しが満たす capability。未指定なら gateway が推定する。 */
  capability?: string;
  context?: string;
  /** 既知語彙に無かったラベル。 */
  unknown_labels: string[];
}

export interface ExtractedCall {
  metadata?: CallerMetadata;
  /** `_mottainai` を取り除いた、upstream / local tool へ渡す引数。 */
  forwardedArguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function normalizeCallerMetadata(value: unknown, field = CALLER_METADATA_KEY): CallerMetadata {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const unknownLabels: string[] = [];

  let task: CallerTask | undefined;
  if (value.task !== undefined) {
    if (!isRecord(value.task)) throw new Error(`${field}.task must be an object`);
    const category = normalizeTaskCategory(value.task.category, `${field}.task.category`);
    if (!category.known) unknownLabels.push(category.id);
    const confidence = value.task.confidence;
    if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`${field}.task.confidence must be a number between 0 and 1`);
    }
    task = {
      category: category.id,
      intent: value.task.intent === undefined ? undefined : normalizeIntent(value.task.intent, `${field}.task.intent`),
      confidence,
    };
  }

  const requested = normalizeCapabilityList(value.requested_capabilities, `${field}.requested_capabilities`);
  for (const capability of requested) {
    if (!capability.known) unknownLabels.push(capability.id);
  }

  const capability = value.capability === undefined
    ? undefined
    : normalizeCapability(value.capability, `${field}.capability`);
  if (capability !== undefined && !capability.known) unknownLabels.push(capability.id);

  const requestId = optionalString(value.request_id, `${field}.request_id`);
  if (requestId === undefined && task === undefined) {
    throw new Error(`${CALLER_METADATA_KEY} requires task.category or request_id`);
  }

  return {
    request_id: requestId,
    task,
    requested_capabilities: requested.map((entry) => entry.id),
    capability: capability?.id,
    context: optionalString(value.context, `${field}.context`),
    unknown_labels: [...new Set(unknownLabels)],
  };
}

export function extractCallerMetadata(args: unknown): ExtractedCall {
  if (!isRecord(args) || args[CALLER_METADATA_KEY] === undefined) {
    return { forwardedArguments: isRecord(args) ? args : undefined };
  }
  const { [CALLER_METADATA_KEY]: metadata, ...forwardedArguments } = args;
  return { metadata: normalizeCallerMetadata(metadata), forwardedArguments };
}
