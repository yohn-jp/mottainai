/**
 * 呼び出し側が付けるタスク分類と、証拠 capability の語彙。
 *
 * 既知の語彙は「統計を集約できる正準形」を与えるためだけに存在する。未知のラベルも
 * 正規化して受け入れる（`known: false` で記録する）。閉じた enum にすると provider や
 * 分野が増えるたびに呼び出し側が弾かれ、フィードバックそのものが失われるため。
 */

/** 証拠 capability の正準 ID。provider 名ではなく「どの証拠が欲しいか」を表す。 */
export const KNOWN_CAPABILITIES = [
  "definitions",
  "references",
  "callers",
  "symbols",
  "text_matches",
  "file_content",
  "directory_structure",
  "recent_changes",
  "ownership",
  "tests",
  "runtime_state",
  "diagnostics",
  "dependencies",
  "docs",
  "issues_and_prs",
  "dom",
  "styles",
  "screenshots",
] as const;

/** 呼び出し側が付けるタスク分類の正準 ID。 */
export const KNOWN_TASK_CATEGORIES = [
  "symbol_lookup",
  "bug_investigation",
  "ui_investigation",
  "ownership_history",
  "feature_implementation",
  "refactor",
  "test_failure",
  "performance_investigation",
  "dependency_audit",
  "config_investigation",
  "security_review",
  "documentation",
] as const;

/** review の `unexpected_noise` でよく使うラベル。未知の値も受け入れる。 */
export const KNOWN_NOISE_LABELS = [
  "generated_files",
  "vendored_code",
  "build_artifacts",
  "lockfiles",
  "test_fixtures",
  "unrelated_matches",
  "binary_files",
  "stale_results",
] as const;

/**
 * 別名から正準 capability への写像。
 *
 * config の `capabilities`（例 `code.search`）や provider 固有の呼び名を、統計が
 * 集約できる形へ寄せる。ここに無い値は正規化だけして通す。
 */
const CAPABILITY_ALIASES: Record<string, string> = {
  "code.search": "text_matches",
  code_search: "text_matches",
  grep: "text_matches",
  search: "text_matches",
  xrefs: "references",
  refs: "references",
  usages: "references",
  callgraph: "callers",
  call_sites: "callers",
  definition: "definitions",
  declarations: "definitions",
  outline: "symbols",
  symbol: "symbols",
  history: "recent_changes",
  git_history: "recent_changes",
  commits: "recent_changes",
  blame: "ownership",
  authors: "ownership",
  test_results: "tests",
  runtime: "runtime_state",
  lint: "diagnostics",
  typecheck: "diagnostics",
  deps: "dependencies",
  dependency_graph: "dependencies",
  documentation: "docs",
  issues: "issues_and_prs",
  prs: "issues_and_prs",
  pull_requests: "issues_and_prs",
  computed_styles: "styles",
  screenshot: "screenshots",
  file: "file_content",
  files: "file_content",
  directory: "directory_structure",
  tree: "directory_structure",
};

const MAX_LABEL_LENGTH = 64;

export interface NormalizedLabel {
  id: string;
  known: boolean;
}

const capabilitySet = new Set<string>(KNOWN_CAPABILITIES);
const taskCategorySet = new Set<string>(KNOWN_TASK_CATEGORIES);
const noiseSet = new Set<string>(KNOWN_NOISE_LABELS);

/** 大小・区切り文字の揺れを吸収する。`Code.Search` と `code_search` を同じ統計へ寄せるため。 */
function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_LABEL_LENGTH);
  if (normalized.length === 0) throw new Error(`${field} must be a non-empty label`);
  return normalized;
}

export function normalizeCapability(value: unknown, field = "capability"): NormalizedLabel {
  const normalized = normalizeIdentifier(value, field);
  const canonical = CAPABILITY_ALIASES[normalized] ?? normalized;
  return { id: canonical, known: capabilitySet.has(canonical) };
}

export function normalizeTaskCategory(value: unknown, field = "task.category"): NormalizedLabel {
  const normalized = normalizeIdentifier(value, field);
  return { id: normalized, known: taskCategorySet.has(normalized) };
}

/** intent は自由語彙。既知集合を持たず、集約できる形へ正規化するだけ。 */
export function normalizeIntent(value: unknown, field = "task.intent"): string {
  return normalizeIdentifier(value, field);
}

export function normalizeNoiseLabel(value: unknown, field = "unexpected_noise"): NormalizedLabel {
  const normalized = normalizeIdentifier(value, field);
  return { id: normalized, known: noiseSet.has(normalized) };
}

/** 重複を除いた capability 配列。順序は呼び出し側の指定順を保つ（優先度の手掛かりになる）。 */
export function normalizeCapabilityList(value: unknown, field = "requested_capabilities"): NormalizedLabel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const seen = new Set<string>();
  const out: NormalizedLabel[] = [];
  for (const entry of value) {
    const normalized = normalizeCapability(entry, field);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

export function normalizeNoiseList(value: unknown, field = "unexpected_noise"): NormalizedLabel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const seen = new Set<string>();
  const out: NormalizedLabel[] = [];
  for (const entry of value) {
    const normalized = normalizeNoiseLabel(entry, field);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

export function isKnownCapability(id: string): boolean {
  return capabilitySet.has(id);
}
