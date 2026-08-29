import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveContract, resolveRisk, resolveToolAttributes } from "./adaptive/metadata.js";
import type { ToolMetadataOverride } from "./adaptive/metadata.js";
import { normalizeCapability } from "./adaptive/taxonomy.js";
import type { UpstreamConfig } from "./config.js";
import type { UpstreamHandle } from "./upstream.js";

/**
 * upstream tool の検索可能な目録。
 *
 * 初期 `listTools` に全 upstream tool を並べる代わりに、ここを検索して必要な tool だけ
 * 詳細を取る導線を作る。意味検索モデルは使わず、capability / tag / tool 名 / description
 * の決定論的スコアリングだけで順位付けする。
 */

/** 実行時の危険度。annotations が無い tool は安全側に倒して `unknown` にする。 */
export type ToolRisk = "read_only" | "mutating" | "destructive" | "unknown";

export interface CatalogTool {
  /** 不透明な tool 識別子。LLM 側に upstream 名を識別子として渡さないため。 */
  id: string;
  provider: string;
  tool: string;
  summary: string;
  capabilities: string[];
  tags: string[];
  risk: ToolRisk;
  /** 明示された論理契約。同じ契約の tool だけ broker fallback 対象。 */
  contract?: string;
  /** 既定は unknown 側（"high"）に倒す。config で上書きしない限りこの値になる。 */
  cost: "low" | "medium" | "high";
  /** 既定は unknown 側（"slow"）に倒す。 */
  latency: "fast" | "moderate" | "slow";
  /** 既定は unknown 側（"large"）に倒す。 */
  outputSize: "small" | "medium" | "large";
  /** workspace 内だけを触るか。不明時は false（workspace 外へも到達しうる扱い）。 */
  workspace: boolean;
  /** 外部ネットワークへ出るか。不明時は true。 */
  network: boolean;
  /** upstream 由来の元定義。意味を変えずに保持する。 */
  definition: Tool;
}

export interface CatalogSearchQuery {
  query?: string;
  capability?: string;
  risk?: ToolRisk;
  provider?: string;
  limit?: number;
}

export interface CatalogSearchHit {
  tool: CatalogTool;
  score: number;
  matched: string[];
}

export interface ToolCatalog {
  tools(): CatalogTool[];
  get(id: string): CatalogTool | undefined;
  search(query: CatalogSearchQuery): CatalogSearchHit[];
  /** Apply matching and ranking without a result-window limit. */
  searchAll(query: Omit<CatalogSearchQuery, "limit">): CatalogSearchHit[];
}

export const CATALOG_DEFAULT_LIMIT = 10;
export const CATALOG_MAX_LIMIT = 50;
const SUMMARY_LENGTH = 200;

/** 同じ provider/tool なら再起動後も同じ ID になる。describe / call が ID を持ち回れる。 */
export function catalogToolId(provider: string, tool: string): string {
  return `tl_${createHash("sha256").update(`${provider}__${tool}`).digest("hex").slice(0, 12)}`;
}

/**
 * MCP の annotation 既定に合わせる。`readOnlyHint` が false のとき `destructiveHint` の
 * 既定は true なので、明示的に false でない限り destructive として扱う。
 */
export function riskOf(annotations: Tool["annotations"]): ToolRisk {
  if (annotations === undefined) return "unknown";
  if (annotations.readOnlyHint === true) return "read_only";
  if (annotations.destructiveHint === false) return "mutating";
  return "destructive";
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Exact identity matching is case-insensitive and trims surrounding whitespace, but preserves
 * separators. A non-empty query that produces no fuzzy tokens therefore remains exact-only.
 */
function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function summarize(description: string | undefined): string {
  const text = (description ?? "").trim().split("\n")[0] ?? "";
  return text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH - 1)}…` : text;
}

/**
 * 入力 schema のうち、候補選別に要る分だけを返す。全文は `mottainai_tool_describe` で取る。
 * description を落とすのは、検索結果に upstream の長い説明文を並べないため。
 */
export function minimalInputSchema(schema: Tool["inputSchema"]): Record<string, unknown> {
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (typeof properties !== "object" || properties === null) {
    return { type: schema.type, required };
  }
  const kept: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof definition !== "object" || definition === null) continue;
    const source = definition as Record<string, unknown>;
    kept[name] = {
      ...(source.type !== undefined ? { type: source.type } : {}),
      ...(source.enum !== undefined ? { enum: source.enum } : {}),
      ...(required.includes(name) ? { required: true } : {}),
    };
  }
  return { type: schema.type, properties: kept, required };
}

/** tool 単位の宣言を upstream 単位より優先する。細かい写像のほうが実挙動に近いため。 */
function capabilitiesFor(
  provider: string,
  tool: string,
  upstream: UpstreamConfig | undefined,
  capabilityMap: Record<string, string[]>,
): string[] {
  const declared = capabilityMap[`${provider}__${tool}`] ?? capabilityMap[provider] ?? upstream?.capabilities ?? [];
  const seen = new Set<string>();
  for (const value of declared) seen.add(normalizeCapability(value, "capabilities").id);
  return [...seen];
}

/** 検索語と突き合わせる語彙。tool 名と provider 名の分割語をそのまま tag として使う。 */
function tagsFor(provider: string, tool: string): string[] {
  return [...new Set([...tokenize(provider), ...tokenize(tool)])];
}

export function buildCatalog(
  handles: UpstreamHandle[],
  upstreams: UpstreamConfig[],
  capabilityMap: Record<string, string[]> = {},
  toolMetadata: Record<string, ToolMetadataOverride> = {},
): ToolCatalog {
  const entries: CatalogTool[] = [];
  for (const handle of handles) {
    const provider = handle.config.name;
    const upstream = upstreams.find((candidate) => candidate.name === provider);
    for (const tool of handle.tools) {
      // tool 単位の上書きは `<provider>__<tool>` キー、無ければ provider 名キーで探す。
      const toolOverride = toolMetadata[`${provider}__${tool.name}`];
      const upstreamOverride = toolMetadata[provider] ?? upstream?.metadata;
      const attributes = resolveToolAttributes(toolOverride, upstreamOverride);
      entries.push({
        id: catalogToolId(provider, tool.name),
        provider,
        tool: tool.name,
        summary: summarize(tool.description),
        capabilities: capabilitiesFor(provider, tool.name, upstream, capabilityMap),
        tags: tagsFor(provider, tool.name),
        risk: resolveRisk(riskOf(tool.annotations), toolOverride, upstreamOverride),
        contract: resolveContract(toolOverride, upstreamOverride),
        ...attributes,
        definition: tool,
      });
    }
  }
  // 同点時の順序を固定するため、索引そのものを provider/tool 名で整列させる。
  entries.sort((left, right) => left.provider.localeCompare(right.provider) || left.tool.localeCompare(right.tool));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const searchAll = (query: Omit<CatalogSearchQuery, "limit">): CatalogSearchHit[] => {
    const capability = query.capability === undefined ? undefined : normalizeCapability(query.capability).id;
    const normalizedQuery = normalizeIdentity(query.query ?? "");
    const tokens = tokenize(normalizedQuery);
    const hits: RankedCatalogSearchHit[] = [];
    for (const tool of entries) {
      if (query.provider !== undefined && tool.provider !== query.provider) continue;
      if (query.risk !== undefined && tool.risk !== query.risk) continue;
      if (capability !== undefined && !tool.capabilities.includes(capability)) continue;
      const scored = score(tool, tokens, capability, normalizedQuery);
      if (!scored.queryMatched) continue;
      hits.push({ tool, score: scored.score, matched: scored.matched, exact: scored.exact });
    }
    hits.sort((left, right) =>
      Number(right.exact) - Number(left.exact)
      || right.score - left.score
      || left.tool.provider.localeCompare(right.tool.provider)
      || left.tool.tool.localeCompare(right.tool.tool));
    return hits.map(({ exact: _exact, ...hit }) => hit);
  };

  return {
    tools: () => [...entries],
    get: (id) => byId.get(id),
    search(query) {
      const limit = Math.min(Math.max(query.limit ?? CATALOG_DEFAULT_LIMIT, 1), CATALOG_MAX_LIMIT);
      return searchAll(query).slice(0, limit);
    },
    searchAll,
  };
}

/**
 * profile による公開可否。未知は必ず落とす側に倒す。
 *
 * capability を宣言していない tool は `includeCapabilities` を満たせないとみなし、
 * risk 不明は destructive として `denyRisk` に照らす。profile は公開面を絞るための
 * 設定なので、判断できないものを通すと設定した意味が消える。
 */
export function profileAllows(
  tool: Pick<CatalogTool, "capabilities" | "risk">,
  profile: { includeCapabilities?: string[]; denyRisk?: string[] } | undefined,
): boolean {
  if (profile === undefined) return true;
  const denied = profile.denyRisk ?? [];
  const effectiveRisk = tool.risk === "unknown" ? "destructive" : tool.risk;
  if (denied.includes(effectiveRisk) || denied.includes(tool.risk)) return false;
  const included = profile.includeCapabilities;
  if (included === undefined) return true;
  const allowed = new Set(included.map((value) => normalizeCapability(value, "includeCapabilities").id));
  return tool.capabilities.some((capability) => allowed.has(capability));
}

const CAPABILITY_FILTER_SCORE = 10;
const EXACT_IDENTITY_SCORE = 100;
const NAME_EXACT_SCORE = 8;
const NAME_TOKEN_SCORE = 4;
const CAPABILITY_TOKEN_SCORE = 3;
const TAG_TOKEN_SCORE = 2;
const SUMMARY_TOKEN_SCORE = 1;

interface ScoredCatalogTool {
  score: number;
  matched: string[];
  queryMatched: boolean;
  exact: boolean;
}

interface RankedCatalogSearchHit extends CatalogSearchHit {
  exact: boolean;
}

/**
 * Compare the raw query with complete catalog identities before fuzzy token scoring. The qualified
 * `<provider>__<tool>` form is accepted in addition to either identity on its own.
 */
function exactIdentityMatch(tool: CatalogTool, query: string): string | undefined {
  if (query === "") return undefined;
  if (query === normalizeIdentity(`${tool.provider}__${tool.tool}`)) return `identity:${query}`;
  if (query === normalizeIdentity(tool.tool)) return `name:${query}`;
  if (query === normalizeIdentity(tool.provider)) return `provider:${query}`;
  return undefined;
}

function score(tool: CatalogTool, tokens: string[], capability: string | undefined, normalizedQuery: string): ScoredCatalogTool {
  const matched: string[] = [];
  let total = 0;
  if (capability !== undefined) {
    total += CAPABILITY_FILTER_SCORE;
    matched.push(`capability:${capability}`);
  }
  const exactMatch = exactIdentityMatch(tool, normalizedQuery);
  if (exactMatch !== undefined) {
    return { score: total + EXACT_IDENTITY_SCORE, matched: [...matched, exactMatch], queryMatched: true, exact: true };
  }
  if (normalizedQuery === "") return { score: total, matched, queryMatched: true, exact: false };
  if (tokens.length === 0) return { score: total, matched, queryMatched: false, exact: false };

  const name = tool.tool.toLowerCase();
  const summaryTokens = new Set(tokenize(tool.summary));
  const nameTokens = new Set(tokenize(tool.tool));
  const tagTokens = new Set(tool.tags);
  // capability id は snake_case（例: text_matches）。tokenize は `_` で分割するため、
  // 素の includes() 比較だと複数語の capability には絶対に一致しない。
  const capabilityTokens = new Set(tool.capabilities.flatMap((value) => tokenize(value)));
  let queryMatched = false;
  for (const token of tokens) {
    if (name === token) {
      total += NAME_EXACT_SCORE;
      matched.push(`name:${token}`);
      queryMatched = true;
      continue;
    }
    if (nameTokens.has(token)) {
      total += NAME_TOKEN_SCORE;
      matched.push(`name:${token}`);
      queryMatched = true;
      continue;
    }
    if (capabilityTokens.has(token)) {
      total += CAPABILITY_TOKEN_SCORE;
      matched.push(`capability:${token}`);
      queryMatched = true;
      continue;
    }
    if (tagTokens.has(token)) {
      total += TAG_TOKEN_SCORE;
      matched.push(`tag:${token}`);
      queryMatched = true;
      continue;
    }
    if (summaryTokens.has(token)) {
      total += SUMMARY_TOKEN_SCORE;
      matched.push(`summary:${token}`);
      queryMatched = true;
    }
  }
  return { score: total, matched, queryMatched, exact: false };
}
