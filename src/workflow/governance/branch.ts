import fs from "node:fs";
import path from "node:path";

interface BranchGovernanceAuthority {
  validateBranchName(branch: string): string[];
}

export type BranchGovernanceValidationResult =
  | { ok: true }
  | { ok: false; kind: "invalid" | "unavailable"; detail: string };

let authorityPromise: Promise<BranchGovernanceAuthority> | undefined;

/**
 * repository governance の既存 shared API を domain boundary として利用する。
 * CLI を subprocess 起動せず、同じ `governance-rules.json` を読む authority を
 * source tree と packaged dist の双方から解決する。これは Mottainai 自身の
 * dogfooding 用 fallback authority であり、対象 repository が別に
 * `governance-rules.json` を持つ場合はそちらを優先する（下記 resolveBranchPattern）。
 */
function loadBranchGovernanceAuthority(): Promise<BranchGovernanceAuthority> {
  authorityPromise ??= (async () => {
    const authorityUrl = new URL("../../../scripts/governance-lib.mjs", import.meta.url);
    return (await import(authorityUrl.href)) as BranchGovernanceAuthority;
  })();
  return authorityPromise;
}

const REPOSITORY_GOVERNANCE_RULES_RELATIVE = path.join(".mottainai", "governance-rules.json");

interface RepositoryGovernanceRulesFile {
  pullRequest?: { branchPattern?: unknown };
}

/**
 * 対象 repository が自身の branch policy を宣言している場合、そちらを
 * governance authority とする。任意の JS を実行させず JSON のみ読むことで、
 * 「npm 版 Mottainai を別 repository で使うと Mottainai 自身の branch 規則を
 * 強制してしまう」問題を、コード実行のリスクを増やさずに解決する。
 */
function resolveRepositoryBranchPatternSource(canonicalRepositoryRoot: string): string | undefined {
  const rulesPath = path.join(canonicalRepositoryRoot, REPOSITORY_GOVERNANCE_RULES_RELATIVE);
  let raw: string;
  try {
    raw = fs.readFileSync(rulesPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as RepositoryGovernanceRulesFile;
    const pattern = parsed.pullRequest?.branchPattern;
    if (typeof pattern !== "string") return undefined;
    new RegExp(pattern);
    return pattern;
  } catch {
    return undefined;
  }
}

function resolveRepositoryBranchPattern(canonicalRepositoryRoot: string): RegExp | undefined {
  const source = resolveRepositoryBranchPatternSource(canonicalRepositoryRoot);
  return source === undefined ? undefined : new RegExp(source);
}

export async function validateBranchNameAgainstGovernance(
  branch: string,
  canonicalRepositoryRoot: string,
): Promise<BranchGovernanceValidationResult> {
  const repositoryPattern = resolveRepositoryBranchPattern(canonicalRepositoryRoot);
  if (repositoryPattern !== undefined) {
    if (!repositoryPattern.test(branch)) return { ok: false, kind: "invalid", detail: "branch name format is invalid" };
    return { ok: true };
  }

  try {
    const errors = loadBranchGovernanceAuthority().then((authority) => authority.validateBranchName(branch));
    const validationErrors = await errors;
    if (validationErrors.length > 0) return { ok: false, kind: "invalid", detail: validationErrors.join("; ") };
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: `branch governance authority unavailable: ${(err as Error).message}` };
  }
}

const BUNDLED_GOVERNANCE_RULES_URL = new URL("../../../scripts/governance-rules.json", import.meta.url);

/** `^(type1|type2|...)/...` 形の branchPattern から、先頭の type alternation だけを
 * 抽出する。branchPattern 文字列そのものが唯一の正本であり、type 一覧を別途
 * 手書きで複製しない。 */
function branchTypesFromPattern(pattern: string): string[] | undefined {
  const match = /^\^\((?<types>[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)\)\//.exec(pattern);
  return match?.groups?.types.split("|");
}

let cachedBundledBranchTypes: readonly string[] | undefined;

/**
 * Mottainai 自身が同梱する `scripts/governance-rules.json`（対象 repository が
 * `.mottainai/governance-rules.json` で上書きしない場合の fallback authority）の
 * branchPattern が宣言する branch type 集合。MCP tool の input schema（`enum`）は
 * ここから導出する — schema 側に別途 type list を書かない。
 *
 * 対象 repository が独自の governance-rules.json を持つ場合、その branchPattern は
 * type-alternation 形式とは限らない（`branch.test.ts` 参照）。このため本関数は
 * bundled rules のみを対象とし、実行時の実際の許可判定は引き続き
 * `validateBranchNameAgainstGovernance`（repository 固有の override を尊重する）が
 * 単独の authority として担う。
 */
export function bundledGovernedBranchTypes(): readonly string[] {
  if (cachedBundledBranchTypes !== undefined) return cachedBundledBranchTypes;
  const raw = fs.readFileSync(BUNDLED_GOVERNANCE_RULES_URL, "utf8");
  const parsed = JSON.parse(raw) as RepositoryGovernanceRulesFile;
  const pattern = parsed.pullRequest?.branchPattern;
  const types = typeof pattern === "string" ? branchTypesFromPattern(pattern) : undefined;
  if (types === undefined || types.length === 0) {
    throw new Error("cannot determine governed branch types from bundled scripts/governance-rules.json");
  }
  cachedBundledBranchTypes = types;
  return types;
}

/**
 * Resolve the branch types that can be advertised as a schema enum for a
 * repository. A repository override with a non-enumerable regex returns
 * `undefined`; callers should then advertise only the representable string
 * constraint and leave full-branch validation to
 * `validateBranchNameAgainstGovernance`.
 */
export function governedBranchTypesForRepository(canonicalRepositoryRoot: string): readonly string[] | undefined {
  const source = resolveRepositoryBranchPatternSource(canonicalRepositoryRoot);
  if (source === undefined) return bundledGovernedBranchTypes();
  return branchTypesFromPattern(source);
}
