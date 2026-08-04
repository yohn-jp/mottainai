import { buildCapabilityIndex, LOCAL_PROVIDER } from "../adaptive/capabilities.js";
import type { CapabilityIndex, RankedProvider } from "../adaptive/capabilities.js";
import { classifyFile } from "./classify.js";
import type { FileClass } from "./classify.js";

/** issue #62 "Policy decisions" の contract。observe stage では action は常に "allow"。 */
export type ReadDecisionAction = "allow" | "rewrite" | "deny";

/** provider 名を持たない探索 capability。provider 解決は呼び出し側の `CapabilityIndex` が行う。 */
export type ReadCapability = "code.symbol" | "document.heading" | "structured.query" | "log.search" | "deny";

/** 探索 capability の推奨が無いときの sentinel。`policyCode` の `"NONE"` と対になる。 */
export const NO_CAPABILITY = "none";

export interface ReadDecision {
  action: ReadDecisionAction;
  fileClass: FileClass;
  /** provider-neutral な推奨探索 capability。`NO_CAPABILITY` は推奨無しを表す。 */
  capability: string;
  policyCode: string;
  reason: string;
  suggestedTools: string[];
  stage: RolloutStage;
}

/**
 * issue #62/#82 の段階導入。observe/warn だけが実装済み。`enforce`/`tighten` は将来の値として
 * 予約されているが挙動が無いので、型にもconfiguration検証にも含めない — 実装されるまでは
 * 明示的に拒否し、`action: "allow"` へ黙って fall through させない（#87）。
 */
export type RolloutStage = "observe" | "warn";

/** 将来 `enforce`/`tighten` を実装する際は、ここへ追加してから `RolloutStage` を拡張する。 */
export const SUPPORTED_ROLLOUT_STAGES: readonly RolloutStage[] = ["observe", "warn"];

/** 未実装の rollout stage（`enforce`/`tighten` を含む、将来の任意の文字列）を拒否する。 */
export function assertSupportedRolloutStage(stage: string): asserts stage is RolloutStage {
  if (!(SUPPORTED_ROLLOUT_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `unsupported read governor rollout stage: ${JSON.stringify(stage)} `
      + `(implemented stages: ${SUPPORTED_ROLLOUT_STAGES.join(", ")}; `
      + `"enforce"/"tighten" are reserved but not yet implemented)`,
    );
  }
}

export interface ReadGovernorPolicy {
  stage: RolloutStage;
  smallFileMaxLines: number;
  /** warn stage only: a bounded (already-localized) range read past this many lines still gets rewritten. */
  warnMaxRangeLines: number;
}

export const DEFAULT_POLICY: ReadGovernorPolicy = {
  stage: "observe",
  smallFileMaxLines: 120,
  warnMaxRangeLines: 400,
};

export interface ReadRequest {
  path: string;
  /** 呼び出し側が推定した"ファイル全体"の行数。small-file 判定にのみ使う（分からなければ省略可）。 */
  estimatedLines?: number;
  /** true ならすでに構造探索エビデンスに基づく範囲READ。observe stage では未使用。 */
  bounded?: boolean;
  /**
   * `bounded: true` のときの、実際にREADする範囲の行数。oversized-range 判定（`warnMaxRangeLines`）は
   * これを使う — `estimatedLines`（ファイル全体のサイズ）を範囲サイズとして再利用しない（#88）。
   * 900行のファイルから10行だけ読む bounded read を、900行の oversized range と誤認しないため。
   */
  rangeLines?: number;
}

/**
 * fileClass ごとの推奨 capability（issue "Integrate Read Governor with provider routing"）。
 * `code.symbol` が codegraph/LSP/ast-grep のどれに解決されるかはここでは決めない —
 * `suggestedToolsFor` が `CapabilityIndex` へ問い合わせて決める。
 */
const CAPABILITY_FOR_CLASS: Record<FileClass, ReadCapability | undefined> = {
  source: "code.symbol",
  document: "document.heading",
  "structured-config": "structured.query",
  log: "log.search",
  lockfile: "deny",
  generated: "deny",
  unknown: undefined,
};

const POLICY_CODE: Record<FileClass, string> = {
  source: "FULL_READ_REQUIRES_LOCALIZATION",
  document: "DOCUMENT_SEARCH_PROVIDER_REQUIRED",
  "structured-config": "STRUCTURED_QUERY_REQUIRED",
  log: "STRUCTURED_QUERY_REQUIRED",
  lockfile: "GENERATED_FILE_DENIED",
  generated: "GENERATED_FILE_DENIED",
  unknown: "NONE",
};

/** 常に最後尾へ足す gateway 自前の text 検索。capability が未登録でも探索手段を切らさない。 */
const LOCAL_FALLBACK_TOOL = "mottainai_search";

function toolLabel(provider: RankedProvider): string {
  if (provider.provider === LOCAL_PROVIDER) return provider.tool ?? LOCAL_PROVIDER;
  return provider.tool !== undefined ? `${provider.provider}__${provider.tool}` : provider.provider;
}

/**
 * capability → provider の解決は `CapabilityIndex.rankProviders` にそのまま委譲する
 * （`docs/code-search.md` の `planCodeSearch` / `planCodeSymbol` と同じ形）。ここでは
 * provider 名を一切書かない。
 */
function suggestedToolsFor(capability: ReadCapability | undefined, capabilityIndex: CapabilityIndex): string[] {
  if (capability === undefined || capability === "deny") return [];
  const tools = capabilityIndex.rankProviders(capability).map(toolLabel);
  return tools.includes(LOCAL_FALLBACK_TOOL) ? tools : [...tools, LOCAL_FALLBACK_TOOL];
}

const DEFAULT_CAPABILITY_INDEX: CapabilityIndex = buildCapabilityIndex([]);

/**
 * warn stage でのみ rewrite の対象になるクラス。GENERATED_FILE_DENIED 系（generated/lockfile）は
 * 「代わりの読み方」が存在しない全面拒否なので、rewrite ではなく enforce/tighten 待ちのまま allow で報告する。
 */
const WARN_REWRITE_CLASSES = new Set<FileClass>(["source", "document", "structured-config", "log"]);

/**
 * observe/warn 共通の評価。将来の enforce/tighten はこの関数のシグネチャを保ったまま
 * action の決め方だけを変える想定（呼び出し側 CLI・hook はここを触らずに済む）。
 * observe: 常に allow。warn: deny はしないが、rewrite を返しうる。
 *
 * `capabilityIndex` 省略時は upstream 無しの索引（gateway 自前ツールのみ）を使う。
 * provider 込みの推奨が欲しい呼び出し側は、実際の設定から作った索引を渡す。
 */
export function evaluateRead(
  request: ReadRequest,
  policy: ReadGovernorPolicy = DEFAULT_POLICY,
  capabilityIndex: CapabilityIndex = DEFAULT_CAPABILITY_INDEX,
): ReadDecision {
  // policy.stage は型では "observe" | "warn" に絞られているが、外部configから来る値は実行時に
  // 未実装stageでありうる。enforce/tighten を黙って allow へ fall through させない（#87）。
  assertSupportedRolloutStage(policy.stage);
  const fileClass = classifyFile(request.path);
  // generated/lockfile are denied regardless of size (issue #62 file-type routing);
  // the small-file exemption only applies to classes where size is the deciding factor.
  const exemptFromSmallFile = fileClass === "generated" || fileClass === "lockfile";
  const isSmall = !exemptFromSmallFile && request.estimatedLines !== undefined && request.estimatedLines <= policy.smallFileMaxLines;

  if (fileClass === "unknown" || isSmall) {
    return {
      action: "allow",
      fileClass,
      capability: NO_CAPABILITY,
      policyCode: "NONE",
      reason: isSmall ? "file is within the small-file exemption threshold" : "unrecognized file class; no policy applies",
      suggestedTools: [],
      stage: policy.stage,
    };
  }

  const wouldBePolicyCode = POLICY_CODE[fileClass];
  const wouldConcern = wouldBePolicyCode !== "NONE";
  const isUnbounded = request.bounded !== true;
  // oversized-range は「READする範囲」の大きさで判定する。ファイル全体のサイズ（estimatedLines）を
  // 範囲サイズとして誤用しない — 900行のファイルから10行だけ読む bounded read を、900行の
  // oversized range と誤認してはいけない（#88）。
  const isOversizedRange = !isUnbounded && request.rangeLines !== undefined && request.rangeLines > policy.warnMaxRangeLines;
  const capability = CAPABILITY_FOR_CLASS[fileClass];
  // deny-only class（generated/lockfile）は「代わりの読み方」が存在しない全面拒否。bounded で
  // 範囲を絞っても、later stage が拒否するという懸念自体は消えない（#89）。
  const isDenyOnly = capability === "deny";

  switch (policy.stage) {
    case "warn": {
      if (wouldConcern && WARN_REWRITE_CLASSES.has(fileClass) && (isUnbounded || isOversizedRange)) {
        return {
          action: "rewrite",
          fileClass,
          capability: capability ?? NO_CAPABILITY,
          policyCode: wouldBePolicyCode,
          reason: isUnbounded
            ? `warn: whole ${fileClass} read should be localized`
            : `warn: bounded ${fileClass} read exceeds the oversized-range threshold (${policy.warnMaxRangeLines} lines)`,
          suggestedTools: suggestedToolsFor(capability, capabilityIndex),
          stage: policy.stage,
        };
      }
      break;
    }
    case "observe":
      // observe stage never rewrites or denies; falls through to the shared allow / would-deny
      // reporting below, same as warn stage's non-rewrite path.
      break;
    default: {
      // unreachable: assertSupportedRolloutStage already rejected anything outside
      // "observe" | "warn", and this switch is exhaustive over the narrowed RolloutStage type.
      const exhaustive: never = policy.stage;
      throw new Error(`unhandled read governor rollout stage: ${String(exhaustive)}`);
    }
  }

  // observe stage never denies; warn stage never denies either (deny-only classes and
  // in-range bounded reads fall through here). Both report what a later stage would decide.
  const wouldDeny = wouldConcern && (isDenyOnly || isUnbounded);

  return {
    action: "allow",
    fileClass,
    capability: wouldDeny ? (capability ?? NO_CAPABILITY) : NO_CAPABILITY,
    policyCode: wouldDeny ? wouldBePolicyCode : "NONE",
    reason: wouldDeny
      ? (isDenyOnly
        ? `${policy.stage}: ${fileClass} reads are deny-only; a later stage would deny this read`
        : `${policy.stage}: a later stage would deny this unbounded ${fileClass} read`)
      : "no policy concern for this request",
    suggestedTools: wouldDeny ? suggestedToolsFor(capability, capabilityIndex) : [],
    stage: policy.stage,
  };
}
