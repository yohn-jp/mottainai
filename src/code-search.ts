import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityIndex } from "./adaptive/capabilities.js";
import {
  bareToolName,
  planCodeSearch,
  planCodeSymbol,
  RG_PROVIDER,
  RG_TOOL,
} from "./adaptive/code-search.js";
import type { CodeSearchCandidate, CodeSearchMatch } from "./adaptive/code-search.js";
import type { ExecutionRouting, FallbackAttempt } from "./adaptive/decision-metadata.js";
import { errorMessage } from "./adaptive/decision-metadata.js";
import { profileAllows } from "./catalog.js";
import type { ToolCatalog } from "./catalog.js";
import type { ProfileConfig, ResolvedGatewayConfig } from "./config.js";
import { OUTPUT_SCHEMA, output } from "./envelope.js";
import { normalizeExecutionOutcome } from "./execution.js";
import type { ExecutionOutcome } from "./execution.js";
import { parseRgJson, resolveInside, runProgram } from "./local-tools.js";
import { callUpstreamTool } from "./upstream-call.js";
import type { UpstreamCallContext } from "./upstream-call.js";

/**
 * code.search / code.symbol の実行層（#25）。
 *
 * `src/adaptive/code-search.ts` が決めた候補 backend の並びを順に試す。ローカル固有の
 * backend（rg/git grep/ast-grep）は既存 `mottainai_search` と同じ流儀でプロセスを直接
 * 起動する。それ以外の候補は catalog / capability 索引が指す upstream tool へ、
 * `{ query, path? }` を forward する既存の upstream 呼び出し経路（圧縮・budget 込み）
 * に委譲する — provider 固有の引数名を推測して合わせ込む自前ロジックは持たない
 * （`raw` に元の upstream 結果をそのまま残し、backend 固有の情報を隠さない）。
 *
 * fallback は provider 障害（起動失敗・接続断・プロセス起動失敗）でのみ次候補へ進む。
 * `mottainai_tool_call`（#21）と同じ理由で、tool 自体のエラーでは fallback しない。
 */

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const codeSearchTools: Tool[] = [
  {
    name: "mottainai_code_search",
    description:
      "Search code by literal text or ast-grep pattern across configured backends (codegraph, fff, ast-grep, git grep, rg) through one backend-agnostic contract.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal text, or an ast-grep pattern using $VAR / $$$ metavariables." },
        kind: { type: "string", enum: ["text", "ast", "auto"], description: "Search kind; default auto (detects ast-grep metavariables)." },
        scope: { type: "string", enum: ["tracked", "workspace"], description: "tracked restricts to git-tracked files via git grep; default workspace." },
        path: { type: "string", description: "Path relative to workspaceRoot; default workspace root." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches; default 30." },
      },
      required: ["pattern"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_code_symbol",
    description: "Look up symbol definitions, references or callers across configured backends (codegraph preferred, rg text search as last resort).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        relation: { type: "string", enum: ["definitions", "references", "callers"], description: "Default definitions." },
        path: { type: "string", description: "Path relative to workspaceRoot; default workspace root." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches; default 30." },
      },
      required: ["symbol"],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
];

const codeSearchToolNames = new Set(codeSearchTools.map((tool) => tool.name));

export function isCodeSearchTool(name: string): boolean {
  return codeSearchToolNames.has(name);
}

export interface CodeSearchContext extends UpstreamCallContext {
  catalog: () => Promise<ToolCatalog>;
  capabilityIndex: CapabilityIndex;
  gatewayConfig: ResolvedGatewayConfig;
  activeProfile?: ProfileConfig;
}

type Args = Record<string, unknown> | undefined;

function stringArg(args: Args, key: string, required = false): string | undefined {
  const candidate = args?.[key];
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${key} must be a non-empty string`);
  return candidate;
}

function numberArg(args: Args, key: string, min: number, max: number): number | undefined {
  const candidate = args?.[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

export interface CodeSearchDispatchOutcome {
  result: CallToolResult;
  /** どの backend も候補にならない、または全滅した場合は無い。 */
  routing?: ExecutionRouting;
  /** code search 固有 backend を含む正規化済み実行結果。 */
  outcome?: ExecutionOutcome;
}

/** proxy.ts の trace 記録が実際に選ばれた backend/provider を読めるようにする経路。 */
export async function dispatchCodeSearchTool(name: string, args: Args, context: CodeSearchContext): Promise<CodeSearchDispatchOutcome> {
  switch (name) {
    case "mottainai_code_search": return codeSearchTool(args, context);
    case "mottainai_code_symbol": return codeSymbolTool(args, context);
    default: throw new Error(`Unknown code search tool: ${name}`);
  }
}

export async function callCodeSearchTool(name: string, args: Args, context: CodeSearchContext): Promise<CallToolResult> {
  return (await dispatchCodeSearchTool(name, args, context)).result;
}

interface ExecutionRequest {
  query: string;
  path?: string;
  limit?: number;
}

async function codeSearchTool(args: Args, context: CodeSearchContext): Promise<CodeSearchDispatchOutcome> {
  const pattern = stringArg(args, "pattern", true)!;
  const kind = stringArg(args, "kind");
  if (kind !== undefined && kind !== "text" && kind !== "ast" && kind !== "auto") {
    throw new Error("kind must be text, ast or auto");
  }
  const scope = stringArg(args, "scope");
  if (scope !== undefined && scope !== "tracked" && scope !== "workspace") {
    throw new Error("scope must be tracked or workspace");
  }
  const limit = numberArg(args, "limit", 1, 200) ?? 30;
  const requestPath = stringArg(args, "path");
  const candidates = planCodeSearch(
    { pattern, kind: kind as "text" | "ast" | "auto" | undefined, scope: scope as "tracked" | "workspace" | undefined, path: requestPath, limit },
    context.capabilityIndex,
  );
  return executeCandidates("code_search", candidates, { query: pattern, path: requestPath, limit }, "text_matches", context);
}

async function codeSymbolTool(args: Args, context: CodeSearchContext): Promise<CodeSearchDispatchOutcome> {
  const symbol = stringArg(args, "symbol", true)!;
  const relation = stringArg(args, "relation");
  if (relation !== undefined && relation !== "definitions" && relation !== "references" && relation !== "callers") {
    throw new Error("relation must be definitions, references or callers");
  }
  const limit = numberArg(args, "limit", 1, 200) ?? 30;
  const requestPath = stringArg(args, "path");
  const resolvedRelation = (relation as "definitions" | "references" | "callers" | undefined) ?? "definitions";
  const candidates = planCodeSymbol({ symbol, relation: resolvedRelation, path: requestPath, limit }, context.capabilityIndex);
  return executeCandidates("code_symbol", candidates, { query: symbol, path: requestPath, limit }, resolvedRelation, context);
}

interface BackendOutcome {
  matches: CodeSearchMatch[];
  raw?: unknown;
  truncated: boolean;
  selectedTool?: string;
  diagnostics?: BackendDiagnostic[];
  metrics?: Record<string, unknown>;
  outputLimited?: boolean;
  truncationReason?: string;
}

interface BackendDiagnostic {
  severity: "info" | "warning" | "error";
  code?: string;
  message: string;
}

async function executeCandidates(
  operation: "code_search" | "code_symbol",
  candidates: CodeSearchCandidate[],
  request: ExecutionRequest,
  capability: string,
  context: CodeSearchContext,
): Promise<CodeSearchDispatchOutcome> {
  if (candidates.length === 0) {
    const result = output(operation, "failed", "no backend available for this request", "", {
      diagnostics: [{ severity: "error", message: "no candidate backend; configure an upstream provider or capabilityMap entry" }],
    }, true);
    return {
      result,
      outcome: normalizeExecutionOutcome({
        result,
        selectedProvider: "none",
        selectedTool: operation,
        capability,
        risk: "read_only",
        status: "unavailable",
      }),
    };
  }

  const contract = candidates[0].contract;
  const compatibleCandidates = contract === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.contract === contract);

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of compatibleCandidates) {
    let outcome: BackendOutcome;
    try {
      outcome = await runCandidate(candidate, request, capability, context);
    } catch (error) {
      attempts.push({ provider: candidate.backend, tool: candidate.tool ?? candidate.backend, error: errorMessage(error) });
      lastError = error;
      continue;
    }
    const selectedTool = outcome.selectedTool ?? candidate.tool ?? candidate.backend;
    const summary = `${operation} backend=${candidate.backend} matches=${outcome.matches.length}${attempts.length > 0 ? ` fallback_from=${attempts.length}` : ""}`;
    const result = output(operation, "success", summary, "", {
        facts: outcome.matches,
        backend: candidate.backend,
        capability,
        routing_reason: candidate.reason,
        fallback_history: attempts,
        raw: outcome.raw,
        diagnostics: outcome.diagnostics ?? [],
        metrics: {
          matches: outcome.matches.length,
          attempts: attempts.length + 1,
          ...(outcome.metrics ?? {}),
        },
        ...(outcome.outputLimited === true ? { output_limited: true } : {}),
        ...(outcome.truncationReason === undefined ? {} : { truncation_reason: outcome.truncationReason }),
        truncated: outcome.truncated,
      });
    return {
      result,
      routing: { provider: candidate.provider, tool: selectedTool, backend: candidate.backend },
      outcome: normalizeExecutionOutcome({
        result,
        selectedProvider: candidate.provider,
        selectedTool,
        selectedBackend: candidate.backend,
        capability,
        risk: "read_only",
        attempts: attempts.map((attempt) => ({ provider: attempt.provider, tool: attempt.tool, error: attempt.error })),
      }),
    };
  }

  const selected = compatibleCandidates.at(-1) ?? candidates[0];
  const result = output(operation, "failed", `all backends failed: ${errorMessage(lastError)}`, "", {
    diagnostics: [{ severity: "error", message: errorMessage(lastError) }],
    fallback_history: attempts,
  }, true);
  return {
    result,
    outcome: normalizeExecutionOutcome({
      result,
      selectedProvider: selected.provider,
      selectedTool: selected.tool ?? selected.backend,
      selectedBackend: selected.backend,
      capability,
      risk: "read_only",
      attempts: attempts.map((attempt) => ({ provider: attempt.provider, tool: attempt.tool, error: attempt.error })),
      status: "provider_error",
    }),
  };
}

async function runCandidate(
  candidate: CodeSearchCandidate,
  request: ExecutionRequest,
  capability: string,
  context: CodeSearchContext,
): Promise<BackendOutcome> {
  if (candidate.backend === "ast_grep") return runAstGrep(request, context.gatewayConfig);
  if (candidate.backend === "git_grep") return runGitGrep(request, context.gatewayConfig);
  if (candidate.provider === RG_PROVIDER && candidate.tool === RG_TOOL) return runRg(request, context.gatewayConfig);
  return runUpstreamCandidate(candidate, request, capability, context);
}

async function runUpstreamCandidate(
  candidate: CodeSearchCandidate,
  request: ExecutionRequest,
  capability: string,
  context: CodeSearchContext,
): Promise<BackendOutcome> {
  const catalog = await context.catalog();
  let toolName = bareToolName(candidate.provider, candidate.tool);
  if (toolName === undefined) {
    const hit = catalog.tools().find((tool) => tool.provider === candidate.provider && tool.capabilities.includes(capability));
    if (hit === undefined) throw new Error(`no catalog tool declares capability ${capability} for provider ${candidate.provider}`);
    toolName = hit.tool;
  }
  const catalogEntry = catalog.tools().find((tool) => tool.provider === candidate.provider && tool.tool === toolName);
  if (catalogEntry !== undefined && !profileAllows(catalogEntry, context.activeProfile)) {
    throw new Error(`${candidate.provider}__${toolName} denied by active profile`);
  }
  const outcome = await callUpstreamTool(
    context,
    candidate.provider,
    toolName,
    { query: request.query, ...(request.path !== undefined ? { path: request.path } : {}) },
    { config: context.gatewayConfig, capability },
  );
  // No upstream candidate currently exposes a versioned result-limit guarantee. Keep the raw
  // provider result, but do not claim that the requested default/explicit limit was enforced.
  return {
    matches: [],
    raw: outcome.result.content,
    truncated: true,
    diagnostics: [{
      severity: "warning",
      code: "UPSTREAM_LIMIT_UNVERIFIED",
      message: `upstream code-search result has no versioned match-limit guarantee for limit=${request.limit ?? 30}`,
    }],
    truncationReason: "upstream_limit_unverified",
    selectedTool: candidate.tool ?? `${candidate.provider}__${toolName}`,
  };
}

function firstLine(value: string): string {
  return value.split("\n").find(Boolean) ?? "";
}

async function runRg(request: ExecutionRequest, config: ResolvedGatewayConfig): Promise<BackendOutcome> {
  const searchPath = await resolveInside(config.workspaceRoot, request.path);
  const maxResults = request.limit ?? 30;
  const args = [
    // rg's --max-count is per file. The extra match is a bounded sentinel; the global slice below
    // remains the authority for the requested result window.
    "--json", "--line-number", "--no-heading", "--fixed-strings", "--max-count", String(maxResults + 1),
    "--glob", "!.git", "--glob", "!node_modules", "--glob", "!dist", request.query, searchPath,
  ];
  const run = await runProgram("rg", args, config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes);
  if (run.spawnError) throw new Error(`rg unavailable: ${run.spawnError}`);
  if (run.exitCode !== 0 && run.exitCode !== 1 && !run.outputLimit) throw new Error(`rg failed: exit=${run.exitCode} ${firstLine(run.stderr)}`);
  const parsed = parseRgJson(run.stdout, config.workspaceRoot);
  // exit 0/1 でも event stream が producer 契約通りに parse できない出力は fallback 対象の
  // provider 障害として扱う — silent 0 件成功にしない（issue #449, mottainai_search と同じ semantics）。
  if (parsed.malformedEventCount > 0 && !run.outputLimit) {
    throw new Error(`rg output failed to parse as the expected event stream: ${parsed.firstMalformedLine ?? "malformed rg event"}`);
  }
  const matches = parsed.groups.flatMap((group) => group.matches.map((match) => ({ path: group.path, line: match.line, text: match.text })));
  const observedMatchCount = matches.length;
  const limited = matches.slice(0, maxResults);
  const matchLimitTruncated = observedMatchCount > maxResults;
  let truncationReason: string | undefined;
  if (run.outputLimit) {
    if (matchLimitTruncated) {
      truncationReason = "match_limit_and_output_limit";
    } else {
      truncationReason = "output_limit";
    }
  } else if (matchLimitTruncated) {
    truncationReason = "match_limit";
  }
  return {
    matches: limited,
    truncated: matchLimitTruncated || run.outputLimit,
    ...(run.outputLimit ? {
      diagnostics: [{
        severity: "warning" as const,
        code: "RG_OUTPUT_LIMIT",
        message: "rg output exceeded the bounded capture limit; code-search results may be incomplete",
      }],
      metrics: { observed_matches: observedMatchCount, output_limited: true },
      outputLimited: true,
    } : { metrics: { observed_matches: observedMatchCount } }),
    ...(truncationReason === undefined ? {} : { truncationReason }),
  };
}

async function runGitGrep(request: ExecutionRequest, config: ResolvedGatewayConfig): Promise<BackendOutcome> {
  const searchPath = await resolveInside(config.workspaceRoot, request.path);
  const relativePath = path.relative(config.workspaceRoot, searchPath) || ".";
  const maxResults = request.limit ?? 30;
  const args = ["grep", "-n", "-I", "--fixed-strings", "-e", request.query, "--", relativePath];
  const run = await runProgram("git", args, config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes);
  if (run.spawnError) throw new Error(`git grep unavailable: ${run.spawnError}`);
  if (run.exitCode !== 0 && run.exitCode !== 1 && !run.outputLimit) throw new Error(`git grep failed: exit=${run.exitCode} ${firstLine(run.stderr)}`);
  const matches: CodeSearchMatch[] = [];
  for (const line of run.stdout.split("\n")) {
    if (line.length === 0) continue;
    const parsed = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!parsed) continue;
    matches.push({ path: parsed[1], line: Number(parsed[2]), text: parsed[3] });
  }
  const limited = matches.slice(0, maxResults);
  const matchLimitTruncated = matches.length > maxResults;
  let truncationReason: string | undefined;
  if (run.outputLimit) {
    if (matchLimitTruncated) {
      truncationReason = "match_limit_and_output_limit";
    } else {
      truncationReason = "output_limit";
    }
  } else if (matchLimitTruncated) {
    truncationReason = "match_limit";
  }
  return {
    matches: limited,
    truncated: matchLimitTruncated || run.outputLimit,
    ...(run.outputLimit ? {
      diagnostics: [{
        severity: "warning" as const,
        code: "SEARCH_OUTPUT_LIMIT",
        message: "git grep output exceeded the bounded capture limit; code-search results may be incomplete",
      }],
      outputLimited: true,
    } : {}),
    ...(truncationReason === undefined ? {} : { truncationReason }),
  };
}

interface AstGrepMatch {
  file?: string;
  text?: string;
  range?: { start?: { line?: number } };
}

async function runAstGrep(request: ExecutionRequest, config: ResolvedGatewayConfig): Promise<BackendOutcome> {
  const searchPath = await resolveInside(config.workspaceRoot, request.path);
  const relativePath = path.relative(config.workspaceRoot, searchPath) || ".";
  const maxResults = request.limit ?? 30;
  const args = ["run", "--pattern", request.query, "--json=compact", relativePath];
  const run = await runProgram("ast-grep", args, config.workspaceRoot, config.maxTimeoutMs, config.maxOutputBytes);
  if (run.spawnError) throw new Error(`ast-grep unavailable: ${run.spawnError}`);
  if (run.exitCode !== 0 && !run.outputLimit) throw new Error(`ast-grep failed: exit=${run.exitCode} ${firstLine(run.stderr)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout.length > 0 ? run.stdout : "[]");
  } catch {
    if (run.outputLimit) {
      return {
        matches: [],
        truncated: true,
        diagnostics: [{
          severity: "warning",
          code: "SEARCH_OUTPUT_LIMIT",
          message: "ast-grep output exceeded the bounded capture limit; code-search results may be incomplete",
        }],
        outputLimited: true,
        truncationReason: "output_limit",
      };
    }
    throw new Error("ast-grep returned malformed JSON");
  }
  if (!Array.isArray(parsed)) {
    if (run.outputLimit) {
      return {
        matches: [],
        truncated: true,
        diagnostics: [{
          severity: "warning",
          code: "SEARCH_OUTPUT_LIMIT",
          message: "ast-grep output exceeded the bounded capture limit; code-search results may be incomplete",
        }],
        outputLimited: true,
        truncationReason: "output_limit",
      };
    }
    throw new Error("ast-grep returned an unexpected JSON shape");
  }
  const entries = parsed as AstGrepMatch[];
  const matches: CodeSearchMatch[] = entries.slice(0, maxResults).map((entry) => ({
    path: entry.file ?? "",
    line: typeof entry.range?.start?.line === "number" ? entry.range.start.line + 1 : undefined,
    text: entry.text,
  }));
  const matchLimitTruncated = entries.length > matches.length;
  let truncationReason: string | undefined;
  if (run.outputLimit) {
    if (matchLimitTruncated) {
      truncationReason = "match_limit_and_output_limit";
    } else {
      truncationReason = "output_limit";
    }
  } else if (matchLimitTruncated) {
    truncationReason = "match_limit";
  }
  return {
    matches,
    truncated: matchLimitTruncated || run.outputLimit,
    ...(run.outputLimit ? {
      diagnostics: [{
        severity: "warning" as const,
        code: "SEARCH_OUTPUT_LIMIT",
        message: "ast-grep output exceeded the bounded capture limit; code-search results may be incomplete",
      }],
      outputLimited: true,
    } : {}),
    ...(truncationReason === undefined ? {} : { truncationReason }),
  };
}
