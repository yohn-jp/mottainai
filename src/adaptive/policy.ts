import fs from "node:fs";
import path from "node:path";
import { normalizeCapability, normalizeTaskCategory } from "./taxonomy.js";

/**
 * capability 指向の決定論的 routing policy。
 *
 * policy は「タスク分類 → 必要な証拠 capability」だけを持つ。どの provider が satisfy
 * するかは `CapabilityIndex` が実行時に決めるため、provider を差し替えても policy は
 * 生き残る。候補 policy は提案されてもそのままでは効かない。人間が承認したものだけが
 * active になる。
 */

export interface PolicyRule {
  task_category: string;
  capabilities: string[];
  /** 呼び出し側が明示していない限り追加しない capability。noise 報告から導く。 */
  avoid_capabilities?: string[];
  /** 生成根拠となった review 済み trace 数。 */
  support?: number;
  /** 根拠 trace のうち、この規則が説明できた比率。 */
  confidence?: number;
}

export interface PolicyDocument {
  policy_version: string;
  status: "candidate" | "approved";
  source: "builtin" | "proposed";
  generated_at: string;
  rules: PolicyRule[];
  notes?: string;
  approved_at?: string;
  approved_by?: string;
}

/** 分類に一致する規則が無いときの既定規則。 */
export const DEFAULT_RULE_CATEGORY = "*";

/**
 * 同梱の baseline policy。issue #40 の探索パターンをそのまま capability で表現したもの。
 *
 * コードとして PR レビューを経ているため `approved`。統計から生成した候補 policy は
 * これを上書きせず、人間の承認を経て初めて active になる。
 */
export const BUILTIN_POLICY: PolicyDocument = {
  policy_version: "builtin-1",
  status: "approved",
  source: "builtin",
  generated_at: "2026-07-31T00:00:00.000Z",
  rules: [
    { task_category: "symbol_lookup", capabilities: ["definitions", "references", "callers"] },
    { task_category: "bug_investigation", capabilities: ["definitions", "callers", "tests", "recent_changes", "runtime_state"] },
    { task_category: "ui_investigation", capabilities: ["dom", "styles", "screenshots", "file_content"] },
    { task_category: "ownership_history", capabilities: ["recent_changes", "ownership", "issues_and_prs"] },
    { task_category: "test_failure", capabilities: ["tests", "diagnostics", "runtime_state", "recent_changes"] },
    { task_category: "refactor", capabilities: ["definitions", "references", "callers", "tests"] },
    { task_category: "feature_implementation", capabilities: ["definitions", "file_content", "tests", "docs"] },
    { task_category: "dependency_audit", capabilities: ["dependencies", "recent_changes", "docs"] },
    { task_category: "performance_investigation", capabilities: ["runtime_state", "tests", "recent_changes"] },
    { task_category: "config_investigation", capabilities: ["file_content", "text_matches", "recent_changes"] },
    { task_category: "security_review", capabilities: ["text_matches", "dependencies", "recent_changes", "ownership"] },
    { task_category: "documentation", capabilities: ["docs", "file_content", "symbols"] },
    { task_category: DEFAULT_RULE_CATEGORY, capabilities: ["text_matches", "file_content"] },
  ],
};

export interface ResolvedPlan {
  policy_version: string;
  task_category: string;
  /** 呼び出し側の指定と policy を統合した capability 列。呼び出し側の指定順を先に置く。 */
  capabilities: string[];
  /** policy が足した capability。 */
  added_by_policy: string[];
  /** policy の avoid 指定で外した capability。 */
  suppressed: string[];
  /** 一致した規則が既定規則だったか。 */
  matched_default_rule: boolean;
}

export function resolvePlan(
  policy: PolicyDocument,
  taskCategory: string,
  requestedCapabilities: string[],
): ResolvedPlan {
  const rule = policy.rules.find((candidate) => candidate.task_category === taskCategory);
  const fallback = policy.rules.find((candidate) => candidate.task_category === DEFAULT_RULE_CATEGORY);
  const effective = rule ?? fallback;
  const requested = [...new Set(requestedCapabilities)];
  const avoid = new Set(effective?.avoid_capabilities ?? []);
  const added: string[] = [];
  const suppressed: string[] = [];
  for (const capability of effective?.capabilities ?? []) {
    if (requested.includes(capability) || added.includes(capability)) continue;
    // 呼び出し側が明示した capability は avoid でも落とさない。意図の方が統計より強い。
    if (avoid.has(capability)) {
      suppressed.push(capability);
      continue;
    }
    added.push(capability);
  }
  return {
    policy_version: policy.policy_version,
    task_category: taskCategory,
    capabilities: [...requested, ...added],
    added_by_policy: added,
    suppressed,
    matched_default_rule: rule === undefined,
  };
}

export function isPolicyLoadingEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.MOTTAINAI_POLICY;
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

export function resolvePolicyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOTTAINAI_POLICY_DIR ?? path.join(process.cwd(), ".mottainai", "policy");
}

export function policyFileName(policyVersion: string): string {
  return `policy-${policyVersion}.json`;
}

/** 提案 policy の version。ファイル名の辞書順が生成時刻順になる形にする。 */
export function newPolicyVersion(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function normalizePolicyDocument(value: unknown, source: string): PolicyDocument {
  if (typeof value !== "object" || value === null) throw new Error(`invalid policy document: ${source}`);
  const document = value as Record<string, unknown>;
  if (typeof document.policy_version !== "string" || document.policy_version.length === 0) {
    throw new Error(`invalid policy_version: ${source}`);
  }
  if (document.status !== "candidate" && document.status !== "approved") {
    throw new Error(`invalid policy status: ${source}`);
  }
  if (!Array.isArray(document.rules)) throw new Error(`invalid policy rules: ${source}`);
  return {
    policy_version: document.policy_version,
    status: document.status,
    source: document.source === "builtin" ? "builtin" : "proposed",
    generated_at: typeof document.generated_at === "string" ? document.generated_at : new Date(0).toISOString(),
    rules: document.rules.map((rule) => normalizeRule(rule, source)),
    notes: typeof document.notes === "string" ? document.notes : undefined,
    approved_at: typeof document.approved_at === "string" ? document.approved_at : undefined,
    approved_by: typeof document.approved_by === "string" ? document.approved_by : undefined,
  };
}

function normalizeRule(value: unknown, source: string): PolicyRule {
  if (typeof value !== "object" || value === null) throw new Error(`invalid policy rule: ${source}`);
  const rule = value as Record<string, unknown>;
  if (typeof rule.task_category !== "string" || rule.task_category.length === 0) {
    throw new Error(`invalid policy rule task_category: ${source}`);
  }
  if (!Array.isArray(rule.capabilities)) throw new Error(`invalid policy rule capabilities: ${source}`);
  const taskCategory = rule.task_category === DEFAULT_RULE_CATEGORY
    ? DEFAULT_RULE_CATEGORY
    : normalizeTaskCategory(rule.task_category, `${source}.task_category`).id;
  return {
    task_category: taskCategory,
    capabilities: rule.capabilities.map((capability) => normalizeCapability(capability, `${source}.capabilities`).id),
    avoid_capabilities: Array.isArray(rule.avoid_capabilities)
      ? rule.avoid_capabilities.map((capability) => normalizeCapability(capability, `${source}.avoid_capabilities`).id)
      : undefined,
    support: typeof rule.support === "number" ? rule.support : undefined,
    confidence: typeof rule.confidence === "number" ? rule.confidence : undefined,
  };
}

export interface StoredPolicy {
  document: PolicyDocument;
  filePath: string;
}

export function loadPolicies(directory: string): StoredPolicy[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const policies: StoredPolicy[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      policies.push({ document: normalizePolicyDocument(JSON.parse(fs.readFileSync(filePath, "utf8")), name), filePath });
    } catch {
      // 壊れた policy ファイルは無視する。routing を止めるより baseline へ落ちる方が安全。
      continue;
    }
  }
  return policies;
}

export function savePolicy(directory: string, document: PolicyDocument): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, policyFileName(document.policy_version));
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

/**
 * active policy を決める。承認済みのうち最も新しいものを採り、無ければ同梱 baseline。
 * `MOTTAINAI_POLICY=0` のときはファイルを読まず baseline に固定する。
 */
export function loadActivePolicy(env: NodeJS.ProcessEnv = process.env): PolicyDocument {
  if (!isPolicyLoadingEnabled(env)) return BUILTIN_POLICY;
  const approved = loadPolicies(resolvePolicyDir(env))
    .map((stored) => stored.document)
    .filter((document) => document.status === "approved");
  if (approved.length === 0) return BUILTIN_POLICY;
  return approved.sort((left, right) =>
    right.generated_at.localeCompare(left.generated_at) || right.policy_version.localeCompare(left.policy_version),
  )[0];
}

/** 候補 policy を承認済みへ変える。MCP ツールからは呼ばない（人間の明示操作のみ）。 */
export function approvePolicy(directory: string, policyVersion: string, approvedBy: string): StoredPolicy {
  const stored = loadPolicies(directory).find((candidate) => candidate.document.policy_version === policyVersion);
  if (stored === undefined) throw new Error(`unknown policy version: ${policyVersion}`);
  const approved: PolicyDocument = {
    ...stored.document,
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: approvedBy,
  };
  const filePath = savePolicy(directory, approved);
  // stored.filePath は任意の *.json 名でありうる（policyFileName(version) と一致する保証はない）。
  // 名前が違えば古い candidate ファイルが残り、同じ policy_version の重複を生む。
  if (filePath !== stored.filePath) {
    fs.rmSync(stored.filePath, { force: true });
  }
  return { document: approved, filePath };
}
