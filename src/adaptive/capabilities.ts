import type { UpstreamConfig } from "../config.js";
import { normalizeCapability, normalizeTaskCategory } from "./taxonomy.js";

/**
 * capability から provider への索引。policy は capability だけを扱い、どの provider が
 * それを満たすかはこの索引が実行時に決める。provider を差し替えても policy が生き残る。
 */

export interface ProviderRef {
  /** upstream 名。gateway 自前のツールは `local`。 */
  provider: string;
  /** gateway 上のツール名。upstream 単位の宣言だけの場合は未指定。 */
  tool?: string;
  priority: number;
  source: "config" | "capability_map" | "builtin";
}

export interface CallCapabilityInput {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 呼び出し側が明示した capability。推定より優先する。 */
  declared?: string;
}

/** capability を特定できない実行を記録するときの値。統計上「不明」を欠損と区別する。 */
export const UNSPECIFIED_CAPABILITY = "unspecified";

export const LOCAL_PROVIDER = "local";

/** gateway 自前ツールの capability。実挙動に対応させる。 */
const LOCAL_TOOL_CAPABILITIES: Record<string, string[]> = {
  mottainai_search: ["text_matches"],
  mottainai_read: ["file_content", "symbols"],
  mottainai_list: ["directory_structure"],
  mottainai_exec: ["runtime_state", "tests", "diagnostics", "recent_changes", "ownership"],
  mottainai_runtime_status: ["runtime_state"],
};

/** `mottainai_exec` のコマンド本文から capability を決める規則。上から順に最初の一致を採る。 */
const EXEC_COMMAND_CAPABILITIES: Array<{ pattern: RegExp; capability: string }> = [
  { pattern: /\bgit\s+(?:-[^\s]+\s+)*blame\b/, capability: "ownership" },
  { pattern: /\bgit\s+(?:-[^\s]+\s+)*(?:log|show|diff|whatchanged)\b/, capability: "recent_changes" },
  { pattern: /\b(?:pytest|jest|vitest|cargo\s+test|go\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|node\s+--test)\b/, capability: "tests" },
  { pattern: /\b(?:tsc|eslint|biome|clippy|ruff|mypy|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck))\b/, capability: "diagnostics" },
];

/** ranking 規則の適用順。上に来るものほど強い根拠。 */
export interface RankReason {
  rule: "preferredFor" | "priority" | "source" | "provider" | "fallbackFor";
  value: string | number;
}

export interface RankedProvider extends ProviderRef {
  /** 1 始まりの順位。 */
  rank: number;
  /** 順位を決めた根拠を、評価順に並べたもの。 */
  reasons: RankReason[];
  /** `fallbackFor` により末尾へ回された provider。fallback 実行時の優先候補の目印。 */
  eligible_for_fallback: boolean;
}

export interface CapabilityIndex {
  /** capability を満たせる provider を優先度降順で返す。 */
  providersFor(capability: string): ProviderRef[];
  /**
   * capability を満たせる provider を、`preferredFor` / `fallbackFor` / priority / `source` /
   * provider 名の順で決定論的に順位付けする。`taskCategory` 省略時は `preferredFor` /
   * `fallbackFor` を評価しない（タスク文脈が無いので判定できない）。
   */
  rankProviders(capability: string, options?: { taskCategory?: string }): RankedProvider[];
  /** 索引が知っている capability の一覧。 */
  capabilities(): string[];
  /** 1 回の tool 呼び出しがどの capability を満たしたかを決める。 */
  capabilityForCall(input: CallCapabilityInput): string;
  /** tool 名から provider 名を得る。 */
  providerForTool(toolName: string): string;
}

/** `source` の強さ。細かい写像（capability_map）ほど実挙動を反映しているとみなす。 */
const SOURCE_RANK: Record<ProviderRef["source"], number> = { capability_map: 0, config: 1, builtin: 2 };

function capabilityMapEntries(
  capabilityMap: Record<string, string[]> | undefined,
): Array<{ key: string; capabilities: string[] }> {
  return Object.entries(capabilityMap ?? {}).map(([key, values]) => ({
    key,
    capabilities: values.map((value) => normalizeCapability(value, `capabilityMap.${key}`).id),
  }));
}

function splitToolName(toolName: string): { provider: string; tool: string } {
  const index = toolName.indexOf("__");
  if (index === -1) return { provider: LOCAL_PROVIDER, tool: toolName };
  return { provider: toolName.slice(0, index), tool: toolName.slice(index + 2) };
}

export function buildCapabilityIndex(
  upstreams: UpstreamConfig[],
  capabilityMap?: Record<string, string[]>,
): CapabilityIndex {
  const byCapability = new Map<string, ProviderRef[]>();
  const mapEntries = capabilityMapEntries(capabilityMap);

  function add(capability: string, ref: ProviderRef): void {
    const existing = byCapability.get(capability) ?? [];
    // 同じ provider/tool の重複登録を避ける。config と capabilityMap の両方に書かれうる。
    if (existing.some((entry) => entry.provider === ref.provider && entry.tool === ref.tool)) return;
    existing.push(ref);
    byCapability.set(capability, existing);
  }

  for (const [toolName, capabilities] of Object.entries(LOCAL_TOOL_CAPABILITIES)) {
    for (const capability of capabilities) {
      add(capability, { provider: LOCAL_PROVIDER, tool: toolName, priority: 0, source: "builtin" });
    }
  }

  for (const upstream of upstreams) {
    if (upstream.enabled === false) continue;
    for (const declared of upstream.capabilities ?? []) {
      add(normalizeCapability(declared, `${upstream.name}.capabilities`).id, {
        provider: upstream.name,
        priority: upstream.priority ?? 0,
        source: "config",
      });
    }
  }

  for (const entry of mapEntries) {
    const mappedUpstream = upstreams.find((candidate) => candidate.name === entry.key);
    const provider = mappedUpstream?.name ?? splitToolName(entry.key).provider;
    // provider 名そのものと一致するエントリは provider 単位の宣言。それ以外は tool 単位の
    // 宣言で、gateway 上のツール名（entry.key 全体）を tool として記録する。
    const tool = mappedUpstream === undefined && entry.key !== provider ? entry.key : undefined;
    const upstream = mappedUpstream ?? upstreams.find((candidate) => candidate.name === provider);
    if (upstream?.enabled === false) continue;
    for (const capability of entry.capabilities) {
      add(capability, {
        provider,
        tool,
        priority: upstream?.priority ?? 0,
        source: "capability_map",
      });
    }
  }

  for (const refs of byCapability.values()) {
    refs.sort((left, right) => right.priority - left.priority || left.provider.localeCompare(right.provider));
  }

  const mapByKey = new Map(mapEntries.map((entry) => [entry.key, entry.capabilities]));

  // provider 名 → ranking 用のタスク分類集合。upstream にしか持たせない（local / capability_map 由来の provider には無い）。
  const taskMeta = new Map(upstreams.map((upstream) => [upstream.name, {
    preferredFor: new Set((upstream.preferredFor ?? []).map((value) => normalizeTaskCategory(value, `${upstream.name}.preferredFor`).id)),
    fallbackFor: new Set((upstream.fallbackFor ?? []).map((value) => normalizeTaskCategory(value, `${upstream.name}.fallbackFor`).id)),
  }]));

  return {
    providersFor(capability) {
      return [...(byCapability.get(normalizeCapability(capability).id) ?? [])];
    },
    rankProviders(capability, options) {
      const refs = byCapability.get(normalizeCapability(capability).id) ?? [];
      const taskCategory = options?.taskCategory === undefined
        ? undefined
        : normalizeTaskCategory(options.taskCategory, "taskCategory").id;

      const scored = refs.map((ref) => {
        const meta = taskMeta.get(ref.provider);
        const preferred = taskCategory !== undefined && (meta?.preferredFor.has(taskCategory) ?? false);
        const fallbackOnly = taskCategory !== undefined && !preferred && (meta?.fallbackFor.has(taskCategory) ?? false);
        const reasons: RankReason[] = [];
        if (preferred) reasons.push({ rule: "preferredFor", value: taskCategory! });
        if (fallbackOnly) reasons.push({ rule: "fallbackFor", value: taskCategory! });
        reasons.push({ rule: "priority", value: ref.priority });
        reasons.push({ rule: "source", value: ref.source });
        reasons.push({ rule: "provider", value: ref.provider });
        return { ref, preferred, fallbackOnly, reasons };
      });

      scored.sort((left, right) => {
        if (left.preferred !== right.preferred) return left.preferred ? -1 : 1;
        if (left.fallbackOnly !== right.fallbackOnly) return left.fallbackOnly ? 1 : -1;
        if (right.ref.priority !== left.ref.priority) return right.ref.priority - left.ref.priority;
        const sourceDiff = SOURCE_RANK[left.ref.source] - SOURCE_RANK[right.ref.source];
        if (sourceDiff !== 0) return sourceDiff;
        return left.ref.provider.localeCompare(right.ref.provider);
      });

      return scored.map((entry, index) => ({
        ...entry.ref,
        rank: index + 1,
        reasons: entry.reasons,
        eligible_for_fallback: entry.fallbackOnly,
      }));
    },
    capabilities() {
      return [...byCapability.keys()].sort();
    },
    providerForTool(toolName) {
      return splitToolName(toolName).provider;
    },
    capabilityForCall(input) {
      if (input.declared !== undefined) return normalizeCapability(input.declared, "capability").id;
      const mapped = mapByKey.get(input.toolName);
      if (mapped?.[0] !== undefined) return mapped[0];
      if (input.toolName === "mottainai_exec") return execCapability(input.arguments);
      if (input.toolName === "mottainai_read") return readCapability(input.arguments);
      const builtin = LOCAL_TOOL_CAPABILITIES[input.toolName];
      if (builtin?.[0] !== undefined) return builtin[0];
      const { provider } = splitToolName(input.toolName);
      const providerMapped = mapByKey.get(provider);
      if (providerMapped !== undefined && providerMapped.length === 1) return providerMapped[0];
      const upstreamDeclared = declaredCapabilitiesOf(upstreams, provider);
      // 複数宣言している upstream は、どの capability を満たしたか呼び出しからは決められない。
      return upstreamDeclared.length === 1 ? upstreamDeclared[0] : UNSPECIFIED_CAPABILITY;
    },
  };
}

function declaredCapabilitiesOf(upstreams: UpstreamConfig[], provider: string): string[] {
  const upstream = upstreams.find((candidate) => candidate.name === provider);
  return (upstream?.capabilities ?? []).map((capability) => normalizeCapability(capability, "capabilities").id);
}

function execCapability(args: Record<string, unknown> | undefined): string {
  const command = typeof args?.command === "string" ? args.command : "";
  for (const rule of EXEC_COMMAND_CAPABILITIES) {
    if (rule.pattern.test(command)) return rule.capability;
  }
  return "runtime_state";
}

function readCapability(args: Record<string, unknown> | undefined): string {
  const mode = typeof args?.mode === "string" ? args.mode : "raw";
  return mode === "outline" || mode === "symbols" ? "symbols" : "file_content";
}
