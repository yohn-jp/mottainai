import type { ToolRisk } from "../catalog.js";

/**
 * tool の実行属性。routing がコスト・レイテンシ・出力量・到達範囲を根拠にできるよう、
 * capability / risk（既存の `CatalogTool`）へ足す任意フィールド群。
 *
 * unknown は必ず安全側（重い・危険な側）に倒す。現状の informational 値は自動選択せず、
 * 目録と診断で軽く見せないための既定値にする。
 */

export type ToolCost = "low" | "medium" | "high";
export type ToolLatency = "fast" | "moderate" | "slow";
export type ToolOutputSize = "small" | "medium" | "large";

export interface ToolMetadata {
  /** fallback を許可する論理契約。未指定 tool は互換性不明として fallback 対象外。 */
  contract?: string;
  capabilities: string[];
  tags: string[];
  risk: ToolRisk;
  cost?: ToolCost;
  latency?: ToolLatency;
  outputSize?: ToolOutputSize;
  /** workspace 内だけを触るか。不明なら workspace 外へも到達しうるとみなし false。 */
  workspace?: boolean;
  /** 外部ネットワークへ出るか。不明なら出るとみなし true。 */
  network?: boolean;
}

export const COST_VALUES: ToolCost[] = ["low", "medium", "high"];
export const LATENCY_VALUES: ToolLatency[] = ["fast", "moderate", "slow"];
export const OUTPUT_SIZE_VALUES: ToolOutputSize[] = ["small", "medium", "large"];

/** 未指定時に採用する最も重い値。「わからなければ高コスト・低速・大出力」に倒す。 */
export const UNKNOWN_COST: ToolCost = "high";
export const UNKNOWN_LATENCY: ToolLatency = "slow";
export const UNKNOWN_OUTPUT_SIZE: ToolOutputSize = "large";
export const UNKNOWN_WORKSPACE = false;
export const UNKNOWN_NETWORK = true;

/** config で上書き可能な部分集合。`capabilities` と `tags` は既存の解決経路を持つため対象外。 */
export type ToolMetadataOverride = Partial<Omit<ToolMetadata, "capabilities" | "tags">>;

export interface ResolvedToolAttributes {
  cost: ToolCost;
  latency: ToolLatency;
  outputSize: ToolOutputSize;
  workspace: boolean;
  network: boolean;
}

/**
 * tool 単位 > upstream 単位 > 既定（unknown 側）の順で解決する。
 * `risk` は呼び出し側が annotations 由来の値を別途決めて渡すため、ここでは扱わない。
 */
export function resolveToolAttributes(
  toolOverride: ToolMetadataOverride | undefined,
  upstreamOverride: ToolMetadataOverride | undefined,
): ResolvedToolAttributes {
  return {
    cost: toolOverride?.cost ?? upstreamOverride?.cost ?? UNKNOWN_COST,
    latency: toolOverride?.latency ?? upstreamOverride?.latency ?? UNKNOWN_LATENCY,
    outputSize: toolOverride?.outputSize ?? upstreamOverride?.outputSize ?? UNKNOWN_OUTPUT_SIZE,
    workspace: toolOverride?.workspace ?? upstreamOverride?.workspace ?? UNKNOWN_WORKSPACE,
    network: toolOverride?.network ?? upstreamOverride?.network ?? UNKNOWN_NETWORK,
  };
}

/** tool 単位の risk 上書きが無ければ upstream 単位、それも無ければ annotations 由来の値を使う。 */
export function resolveRisk(
  fromAnnotations: ToolRisk,
  toolOverride: ToolMetadataOverride | undefined,
  upstreamOverride: ToolMetadataOverride | undefined,
): ToolRisk {
  return toolOverride?.risk ?? upstreamOverride?.risk ?? fromAnnotations;
}

export function resolveContract(
  toolOverride: ToolMetadataOverride | undefined,
  upstreamOverride: ToolMetadataOverride | undefined,
): string | undefined {
  return toolOverride?.contract ?? upstreamOverride?.contract;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid tool metadata: ${field}`);
  }
  return value as T;
}

function validateBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`invalid tool metadata: ${field}`);
  return value;
}

function validateContract(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid tool metadata: ${field}`);
  return value;
}

const RISK_VALUES: ToolRisk[] = ["read_only", "mutating", "destructive", "unknown"];

/** config の生 JSON から `ToolMetadataOverride` を検証しながら取り出す。 */
export function normalizeToolMetadataOverride(value: unknown, field: string): ToolMetadataOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid tool metadata: ${field}`);
  }
  const source = value as Record<string, unknown>;
  return {
    contract: validateContract(source.contract, `${field}.contract`),
    risk: validateEnum(source.risk, RISK_VALUES, `${field}.risk`),
    cost: validateEnum(source.cost, COST_VALUES, `${field}.cost`),
    latency: validateEnum(source.latency, LATENCY_VALUES, `${field}.latency`),
    outputSize: validateEnum(source.outputSize, OUTPUT_SIZE_VALUES, `${field}.outputSize`),
    workspace: validateBoolean(source.workspace, `${field}.workspace`),
    network: validateBoolean(source.network, `${field}.network`),
  };
}
