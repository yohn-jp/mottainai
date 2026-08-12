import crypto from "node:crypto";
import os from "node:os";

/**
 * managed check の実行 identity（command/args/cwd/env）と、その実行結果に影響しうる
 * configuration/environment identity を、決定論的な digest として折り込む。
 * Repository state（fingerprint.ts）とは別の軸 — command そのものや Node/OS/env が
 * 変われば、リポジトリの内容が同じでも過去の PASS を再利用してはいけない。
 */

export interface ManagedCheckCommand {
  command: string;
  args: readonly string[];
  cwd: string;
}

/** キャンセル可能な決定論的 JSON 直列化。キー順を固定し、undefined を落とす。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
}

function digest(prefix: string, payload: unknown): string {
  const hash = crypto.createHash("sha256").update(`${prefix}\n`).update(canonicalJson(payload)).digest("hex");
  return `${prefix.split("/")[0]}_${hash}`;
}

export function computeCommandDigest(command: ManagedCheckCommand): string {
  return digest("mottainai/managed-check-command/v1", command);
}

export interface ConfigIdentityInput {
  checkId: string;
  command: ManagedCheckCommand;
  /** 現在の各ファイルの git blob hash（無ければ "absent"）。fingerprint.ts が解決する。 */
  configFileDigests: Readonly<Record<string, string>>;
  /** check 定義が明示した env var 名のみ、値を折り込む（宣言外の env は一切読まない）。 */
  relevantEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * check の「結果に影響しうるがリポジトリの変更ファイル一覧には現れない」identity を
 * まとめて digest 化する: Node/OS/arch、declared configFiles の内容、declared env。
 * State fingerprint と混ぜないのは、無効化の理由（「コードが変わった」vs
 * 「実行環境/設定が変わった」）を provenance として区別可能にするため。
 */
export function computeConfigDigest(input: ConfigIdentityInput): string {
  return digest("mottainai/managed-check-config/v1", {
    checkId: input.checkId,
    commandDigest: computeCommandDigest(input.command),
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    configFileDigests: input.configFileDigests,
    relevantEnv: input.relevantEnv,
  });
}
