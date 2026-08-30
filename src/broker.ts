import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { attachDecisionMetadata, errorMessage } from "./adaptive/decision-metadata.js";
import type { DecisionMetadata, ExecutionRouting, FallbackAttempt } from "./adaptive/decision-metadata.js";
import { CATALOG_DEFAULT_LIMIT, CATALOG_MAX_LIMIT, minimalInputSchema, profileAllows } from "./catalog.js";
import type { CatalogTool, ToolCatalog, ToolRisk } from "./catalog.js";
import type { ProfileConfig, ResolvedGatewayConfig } from "./config.js";
import { OUTPUT_SCHEMA, output } from "./envelope.js";
import type { ExecutionOutcome } from "./execution.js";
import { assertValidToolArguments } from "./mcp-tool-validation.js";
import { callUpstreamTool } from "./upstream-call.js";
import type { UpstreamCallContext } from "./upstream-call.js";

/**
 * Brokered Mode の MCP 面。
 *
 * 全 upstream tool を初期 `listTools` に並べる代わりに、search → describe → call の
 * 三段で辿らせる。**既定** では profile が公開面を絞っていても、この三つは常に使える
 * （絞り込みは「LLM に見せる既定の面」を減らすための設定で、到達手段を奪うためではない）。
 *
 * `activeProfile.rawToolAccess === "restricted"`（#26）を明示したときだけ、raw tool
 * escape hatch そのものにも `includeCapabilities` / `denyRisk` を適用する。search は
 * 該当 tool を返さず、describe / call は拒否する。高度な用途で provider 固有 tool を
 * 使わせつつ、運用者が明示的に許可した範囲だけへ絞りたい場合の opt-in。
 */

const RISK_VALUES: ToolRisk[] = ["read_only", "mutating", "destructive", "unknown"];

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const brokerTools: Tool[] = [
  {
    name: "mottainai_tool_search",
    description: "Find upstream tools by capability, tag, name or description. Complete tool/provider identities are matched case-insensitively before fuzzy tokenization; one-character queries match only exact identities. Returns tool ids for describe and call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Free text matched against tool/provider identities, tags and summary; one-character queries are exact-only." },
        capability: { type: "string", minLength: 1, description: "Evidence capability such as definitions or text_matches." },
        risk: { type: "string", enum: RISK_VALUES },
        provider: { type: "string", minLength: 1, description: "Restrict to one upstream." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum hits; default 10." },
      },
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_tool_describe",
    description: "Get the full unmodified input schema and execution metadata of one catalog tool.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, description: "Tool id from mottainai_tool_search." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_tool_call",
    description: "Run a catalog tool by id. Applies the same compression and raw-result retention as prefixed calls.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Tool id from mottainai_tool_search." },
        arguments: {
          type: "object",
          description: "Arguments matching the schema from mottainai_tool_describe.",
          additionalProperties: true,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const brokerToolNames = new Set(brokerTools.map((tool) => tool.name));

export function isBrokerTool(name: string): boolean {
  return brokerToolNames.has(name);
}

export interface BrokerContext extends UpstreamCallContext {
  /** ready な upstream から目録を組み立てる。呼び出しごとに最新の状態を見る。 */
  catalog: () => Promise<ToolCatalog>;
  /** `gateway.activeProfile` が指す profile。未設定なら絞り込みなし。 */
  activeProfile?: ProfileConfig;
  /** token budget 解決に使う。budget 未設定なら `mottainai_tool_call` の圧縮量は変わらない。 */
  gatewayConfig: ResolvedGatewayConfig;
}

type Args = Record<string, unknown> | undefined;

function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = args?.[key];
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${key} must be a non-empty string`);
  return candidate;
}

function summarizeTool(tool: CatalogTool): Record<string, unknown> {
  return {
    id: tool.id,
    provider: tool.provider,
    tool: tool.tool,
    summary: tool.summary,
    capabilities: tool.capabilities,
    risk: tool.risk,
    input_schema: minimalInputSchema(tool.definition.inputSchema),
  };
}

export interface BrokerDispatchOutcome {
  result: CallToolResult;
  /** `mottainai_tool_call` が結果を返したときだけ設定する。search/describe には無い。 */
  routing?: ExecutionRouting;
  /** 実行済み upstream の正規化結果。proxy の trace はこれを直接消費する。 */
  outcome?: ExecutionOutcome;
}

/** proxy.ts の trace 記録が実際に選ばれた provider/tool を読めるようにする経路。 */
export async function dispatchBrokerTool(name: string, args: Args, context: BrokerContext): Promise<BrokerDispatchOutcome> {
  const tool = brokerTools.find((candidate) => candidate.name === name);
  if (tool !== undefined) assertValidToolArguments(tool, args);
  switch (name) {
    case "mottainai_tool_search": return { result: await searchTool(args, context) };
    case "mottainai_tool_describe": return { result: await describeTool(args, context) };
    case "mottainai_tool_call": return callTool(args, context);
    default: throw new Error(`Unknown broker tool: ${name}`);
  }
}

export async function callBrokerTool(name: string, args: Args, context: BrokerContext): Promise<CallToolResult> {
  return (await dispatchBrokerTool(name, args, context)).result;
}

async function searchTool(args: Args, context: BrokerContext): Promise<CallToolResult> {
  const risk = stringArg(args, "risk");
  if (risk !== undefined && !RISK_VALUES.includes(risk as ToolRisk)) {
    throw new Error(`risk must be one of: ${RISK_VALUES.join(", ")}`);
  }
  const requestedLimit = args?.limit;
  if (requestedLimit !== undefined && (typeof requestedLimit !== "number"
    || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > CATALOG_MAX_LIMIT)) {
    throw new Error(`limit must be an integer between 1 and ${CATALOG_MAX_LIMIT}`);
  }
  const limit = typeof requestedLimit === "number" ? requestedLimit : CATALOG_DEFAULT_LIMIT;
  const catalog = await context.catalog();
  // まず query/provider/risk/capability による全マッチを確定し、profile の許可判定後に
  // result window を切る。先に limit を適用すると hidden tool が visible slot を消費し、
  // matched total と truncated が caller-visible な集合からずれる。
  const accessibleMatches = catalog.searchAll({
    query: stringArg(args, "query"),
    capability: stringArg(args, "capability"),
    risk: risk as ToolRisk | undefined,
    provider: stringArg(args, "provider"),
  }).filter((hit) => rawToolAllowed(hit.tool, context.activeProfile));
  const matchedTotal = accessibleMatches.length;
  const hits = accessibleMatches.slice(0, limit);
  return output("tool_search", "success", `${hits.length} of ${matchedTotal} catalog tools matched`, "", {
    facts: hits.map((hit) => ({ ...summarizeTool(hit.tool), score: hit.score, matched: hit.matched })),
    metrics: { hits: hits.length, matched_total: matchedTotal },
    truncated: hits.length < matchedTotal,
  });
}

async function describeTool(args: Args, context: BrokerContext): Promise<CallToolResult> {
  const id = stringArg(args, "id", true)!;
  const catalog = await context.catalog();
  const tool = catalog.get(id);
  if (tool === undefined) throw new Error(`unknown catalog tool: ${id}`);
  if (!rawToolAllowed(tool, context.activeProfile)) throw new Error(`tool denied by active profile rawToolAccess: ${id}`);
  return output("tool_describe", "success", `${tool.provider} ${tool.tool} (${tool.risk})`, "", {
    facts: [{
      id: tool.id,
      provider: tool.provider,
      tool: tool.tool,
      capabilities: tool.capabilities,
      tags: tool.tags,
      risk: tool.risk,
      visible_in_active_profile: profileAllows(tool, context.activeProfile),
    }],
    // 元の schema と description をそのまま返す。圧縮も要約も通さない。
    description: tool.definition.description,
    input_schema: tool.definition.inputSchema,
    annotations: tool.definition.annotations,
  });
}

/**
 * primary と同じ capability を宣言する catalog tool を、primary を除いて決定論的な順序で返す。
 * capability を 1 つも宣言していない primary には候補が無い（何と同等なのか判定できない）。
 * profile が拒否している候補は外す — fallback で暗黙に profile 制約を迂回させないため。
 */
function fallbackCandidates(primary: CatalogTool, catalog: ToolCatalog, activeProfile: ProfileConfig | undefined): CatalogTool[] {
  const capability = primary.capabilities[0];
  if (capability === undefined) return [];
  if (primary.contract === undefined) return [];
  return catalog.search({ capability, limit: 50 })
    .map((hit) => hit.tool)
    .filter((candidate) => candidate.id !== primary.id
      && candidate.contract === primary.contract
      && profileAllows(candidate, activeProfile));
}

/**
 * raw tool escape hatch（#26）の許可判定。`rawToolAccess` が明示的に `"restricted"` の
 * ときだけ `profileAllows`（`includeCapabilities` / `denyRisk`）を search/describe/call
 * へ適用する。既定（未設定 = `"open"`）は今までどおり常に許可する。
 */
function rawToolAllowed(tool: Pick<CatalogTool, "capabilities" | "risk">, activeProfile: ProfileConfig | undefined): boolean {
  if (activeProfile?.rawToolAccess !== "restricted") return true;
  return profileAllows(tool, activeProfile);
}

async function callTool(args: Args, context: BrokerContext): Promise<BrokerDispatchOutcome> {
  const id = stringArg(args, "id", true)!;
  const catalog = await context.catalog();
  const primary = catalog.get(id);
  if (primary === undefined) throw new Error(`unknown catalog tool: ${id}`);
  if (!rawToolAllowed(primary, context.activeProfile)) throw new Error(`tool denied by active profile rawToolAccess: ${id}`);
  const forwarded = args?.arguments;
  if (forwarded !== undefined && (typeof forwarded !== "object" || forwarded === null || Array.isArray(forwarded))) {
    throw new Error("arguments must be an object");
  }
  const forwardedArgs = forwarded as Record<string, unknown> | undefined;
  const capability = primary.capabilities[0];

  const candidates = [primary, ...fallbackCandidates(primary, catalog, context.activeProfile)];
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    let outcome: Awaited<ReturnType<typeof callUpstreamTool>>;
    try {
      outcome = await callUpstreamTool(context, candidate.provider, candidate.tool, forwardedArgs, {
        config: context.gatewayConfig,
        capability,
      });
    } catch (error) {
      // provider 障害（起動失敗・接続断）。tool 自体のエラー（isError）とは区別し、次候補へ進む。
      attempts.push({ provider: candidate.provider, tool: candidate.tool, error: errorMessage(error) });
      lastError = error;
      continue;
    }
    // tool 自体が isError を返した場合は fallback しない。provider を変えても直らない失敗のため。
    const decision: DecisionMetadata = {
      ...outcome.decision,
      ...(attempts.length > 0 ? {
        selected_provider: candidate.provider,
        selected_tool: candidate.tool,
        fallback_history: attempts,
      } : {}),
    };
    const result = attachDecisionMetadata(outcome.result, decision);
    return {
      result,
      routing: { provider: candidate.provider, tool: candidate.tool },
      outcome: {
        ...outcome.outcome,
        result,
        attempts: attempts.map((attempt) => ({ provider: attempt.provider, tool: attempt.tool, error: attempt.error })),
      },
    };
  }

  throw lastError;
}
