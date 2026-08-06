import type { RuleMode, WorkflowPolicyDocument } from "./schema.js";

/**
 * resolution order の各段階。数値が大きいほど優先度が高い（後から強い authority が
 * 上書きできる）。ただし「弱体化」は authority の高さだけでは許可しない（下記 resolveRule 参照）。
 */
export type PolicyAuthority = "built-in" | "preset" | "user-profile" | "repository" | "invocation";

const AUTHORITY_ORDER: readonly PolicyAuthority[] = ["built-in", "preset", "user-profile", "repository", "invocation"];

function authorityRank(authority: PolicyAuthority): number {
  return AUTHORITY_ORDER.indexOf(authority);
}

/** rule mode の強さ。enforce が最も強く、off が最も弱い。confirm は enforce と同格の強さを持つ。 */
const MODE_STRENGTH: Record<RuleMode, number> = { off: 0, advisory: 1, confirm: 2, enforce: 2 };

export type WeakeningPermission = "allowed" | "human-only" | "denied";

/**
 * 確認の主体・証跡。agent が「確認された」と自称するだけでは満たせない構造。
 */
export interface ConfirmationRecord {
  confirmedBy: string;
  confirmedAt: string;
  evidence?: string;
}

/**
 * 解決済み単一 rule。値と authority を分離して持つ（後勝ちマージにしない）。
 */
export interface ResolvedRule<Value> {
  value: Value;
  mode: RuleMode;
  authority: PolicyAuthority;
  /** この値からさらに弱体化させる余地があるか。enforce は既定 human-only。 */
  weakening: WeakeningPermission;
  confirmation?: ConfirmationRecord;
}

export interface PolicySource<Value> {
  authority: PolicyAuthority;
  value: Value;
  mode: RuleMode;
  /** human approval token 等、弱体化を明示的に許可する根拠。無ければ弱体化不可。 */
  humanApproval?: ConfirmationRecord;
}

/**
 * 複数 authority の値から単一 rule を解決する。
 *
 * - 強化（advisory→enforce 等）はどの authority からでも常に上書き可能。
 * - 弱体化（enforce→advisory/off 等）は "invocation"（MCP tool の呼び出し引数）からは
 *   決して許可しない。LLM が通常の tool 引数だけで repository の enforce を外せてはならない。
 * - 弱体化を許可する authority（repository/user-profile 等）であっても、対象 rule 自体が
 *   直前まで enforce だった場合は human approval token（humanApproval）が無ければ拒否する。
 */
export function resolveRule<Value>(sources: PolicySource<Value>[]): ResolvedRule<Value> {
  if (sources.length === 0) throw new Error("resolveRule requires at least one source");
  const ordered = [...sources].sort((left, right) => authorityRank(left.authority) - authorityRank(right.authority));

  let current: ResolvedRule<Value> = {
    value: ordered[0].value,
    mode: ordered[0].mode,
    authority: ordered[0].authority,
    weakening: ordered[0].mode === "enforce" ? "human-only" : "allowed",
    confirmation: ordered[0].humanApproval,
  };

  for (const source of ordered.slice(1)) {
    const isWeakening = MODE_STRENGTH[source.mode] < MODE_STRENGTH[current.mode];
    if (!isWeakening) {
      current = {
        value: source.value,
        mode: source.mode,
        authority: source.authority,
        weakening: source.mode === "enforce" ? "human-only" : "allowed",
        confirmation: source.humanApproval,
      };
      continue;
    }

    // 弱体化: invocation からは常に拒否する。
    if (source.authority === "invocation") continue;
    // 弱体化: 現在値が human-only を要求しているなら、human approval が無い限り拒否する。
    if (current.weakening === "human-only" && source.humanApproval === undefined) continue;
    if (current.weakening === "denied") continue;

    current = {
      value: source.value,
      mode: source.mode,
      authority: source.authority,
      weakening: source.mode === "enforce" ? "human-only" : "allowed",
      confirmation: source.humanApproval,
    };
  }

  return current;
}

/**
 * 全 rule を含む解決済み policy。`policy explain` はこの構造をそのまま返す
 * （value/mode/authority/weakening の全フィールド）。
 */
export type ResolvedPolicy = {
  [K in keyof WorkflowPolicyDocument]: WorkflowPolicyDocument[K] extends object
    ? { [F in keyof WorkflowPolicyDocument[K]]: ResolvedRule<WorkflowPolicyDocument[K][F]> }
    : ResolvedRule<WorkflowPolicyDocument[K]>;
};
