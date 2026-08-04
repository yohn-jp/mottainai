import type { CapabilityIndex } from "./capabilities.js";

/**
 * code.search / code.symbol 論理capability契約（#24）。
 *
 * 呼び出し側は pattern / symbol / kind / scope だけを渡し、どの backend
 * （codegraph, fff, ast-grep, git grep, rg）が答えるかは意識しない。ここは
 * 自前検索エンジンを実装しない — `CapabilityIndex` が既に持つ capability→provider
 * の優先順位をそのまま使い、pattern 種別・scope から候補 backend の並びを決定論的に
 * 決めるだけ。実行（プロセス起動・upstream 呼び出し・fallback）は `../code-search.ts` が担う。
 */

export type CodeSearchKind = "text" | "ast" | "auto";
export type CodeSymbolRelation = "definitions" | "references" | "callers";

export interface CodeSearchRequest {
  pattern: string;
  kind?: CodeSearchKind;
  /** tracked: git 管理下のファイルだけを対象にする（git grep を優先）。既定は workspace 全体。 */
  scope?: "tracked" | "workspace";
  path?: string;
  limit?: number;
}

export interface CodeSymbolRequest {
  symbol: string;
  relation?: CodeSymbolRelation;
  path?: string;
  limit?: number;
}

export interface CodeSearchMatch {
  path: string;
  line?: number;
  text?: string;
}

/**
 * 選ばれうる backend の候補。`tool` が未指定の場合は catalog から capability 宣言済みの
 * tool を実行時に探す（config の書き方が provider 単位・tool 単位のどちらでも動く）。
 */
export interface CodeSearchCandidate {
  /** ローカル固有 backend（`ast_grep` / `git_grep`）または provider 名。 */
  backend: string;
  provider: string;
  tool?: string;
  /** 候補同士を fallback 可能とする明示的な論理契約。 */
  contract?: string;
  /** この候補を選んだ理由。結果へそのまま記録する（#25 の「routing 理由を結果へ記録」）。 */
  reason: string;
}

export const AST_GREP_BACKEND = "ast_grep";
export const GIT_GREP_BACKEND = "git_grep";
export const RG_BACKEND = "rg";
export const RG_PROVIDER = "local";
export const RG_TOOL = "mottainai_search";
/** 実行可能な候補が無いことを示す backend。`tool` は常に未指定。 */
export const UNSUPPORTED_BACKEND = "unsupported";

const AST_METAVARIABLE_PATTERN = /\$\$\$|\$[A-Z_][A-Z0-9_]*/;

/** kind 未指定・auto のとき、ast-grep のメタ変数記法（`$VAR` / `$$$`）があれば ast と推定する。 */
export function resolveCodeSearchKind(request: Pick<CodeSearchRequest, "pattern" | "kind">): "text" | "ast" {
  if (request.kind === "text" || request.kind === "ast") return request.kind;
  return AST_METAVARIABLE_PATTERN.test(request.pattern) ? "ast" : "text";
}

/**
 * text/ast pattern の候補 backend を優先順に並べる。
 *
 * - AST pattern → ast-grep のみを候補にする。ast-grep が使えない場合の rg fallback は
 *   意図的に持たない — `$FN($$$)` のような AST メタ変数記法を text query へ変換する
 *   決定論的な contract がこのリポジトリに無いので、あいまいな変換をでっち上げるより
 *   「実行できる候補が無い」ことを明示する（#31）。
 * - literal text → `text_matches` capability を持つ provider を `rankProviders` の順で並べる。
 *   builtin の rg は source rank が最弱なので、他に何も設定されていなければ自然に唯一の
 *   候補、他に設定があれば自然に最後尾のfallbackになる。
 * - tracked scope → git 管理下ファイルへの制限を証明できる backend（git grep）だけを返す。
 *   `text_matches` provider（builtin rg を含む）は tracked 制限を保証できないので、
 *   scope: "tracked" では一切候補に含めない。AST pattern + tracked scope も同様に
 *   ast-grep が tracked 制限を保証できないため、実行不能（`UNSUPPORTED_BACKEND`）を返す。
 */
export function planCodeSearch(request: CodeSearchRequest, capabilityIndex: CapabilityIndex): CodeSearchCandidate[] {
  const contract = "code.search.v1";
  const tracked = request.scope === "tracked";

  if (resolveCodeSearchKind(request) === "ast") {
    if (tracked) {
      return [
        { backend: UNSUPPORTED_BACKEND, provider: "local", contract, reason: "ast_tracked_scope_unsupported" },
      ];
    }
    return [
      { backend: AST_GREP_BACKEND, provider: "local", tool: "ast-grep", contract, reason: "ast_pattern" },
    ];
  }

  if (tracked) {
    return [
      { backend: GIT_GREP_BACKEND, provider: "local", tool: "git", contract, reason: "scope_tracked" },
    ];
  }

  const candidates: CodeSearchCandidate[] = [];
  for (const provider of capabilityIndex.rankProviders("text_matches")) {
    candidates.push({
      backend: backendNameFor(provider.provider, provider.tool),
      provider: provider.provider,
      tool: provider.tool,
      contract,
      reason: `text_matches_rank_${provider.rank}`,
    });
  }
  return candidates;
}

/** builtin の rg 登録（provider `local` / tool `mottainai_search`）だけ `rg` という読みやすい backend 名にする。 */
function backendNameFor(provider: string, tool: string | undefined): string {
  return provider === RG_PROVIDER && tool === RG_TOOL ? RG_BACKEND : provider;
}

/**
 * symbol 関係（definitions/references/callers）の候補 backend を優先順に並べる。
 * どの provider も capability を宣言していなければ、symbol 名を literal text として
 * rg に投げる（最後の手段。symbol 情報としては劣化するため理由を明記する）。
 */
export function planCodeSymbol(request: CodeSymbolRequest, capabilityIndex: CapabilityIndex): CodeSearchCandidate[] {
  const relation = request.relation ?? "definitions";
  const contract = `code.symbol.${relation}.v1`;
  const candidates: CodeSearchCandidate[] = capabilityIndex.rankProviders(relation).map((provider) => ({
    backend: backendNameFor(provider.provider, provider.tool),
    provider: provider.provider,
    tool: provider.tool,
    contract,
    reason: `${relation}_rank_${provider.rank}`,
  }));
  candidates.push({
    backend: RG_BACKEND,
    provider: RG_PROVIDER,
    tool: RG_TOOL,
    contract,
    reason: "symbol_backend_unavailable_fallback_to_text_search",
  });
  return candidates;
}

/** capability_map の値（`<provider>__<tool>` 形式もありうる）から upstream が期待する裸の tool 名を得る。 */
export function bareToolName(provider: string, tool: string | undefined): string | undefined {
  if (tool === undefined) return undefined;
  const prefix = `${provider}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}
