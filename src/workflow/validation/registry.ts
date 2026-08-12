/**
 * Managed check identity/configuration (issue #184 Phase 1). This is the only place a
 * check command may be declared for governor reuse — it deliberately does not accept
 * arbitrary caller-supplied commands (issue #184 excludes "arbitrary command caching").
 * Identities intentionally reuse `src/semantics/verification/planner.ts`'s
 * `DEFAULT_VERIFICATION_CHECKS`/`DEFAULT_FULL_VERIFICATION` command strings so the
 * governor is not a second, drifting authority for what "lint"/"typecheck"/"build"/"verify"
 * mean in this repository.
 */

export interface ManagedCheckDefinition {
  id: string;
  label: string;
  command: string;
  args: readonly string[];
  /** workspaceRoot からの相対 cwd。省略時は workspaceRoot 直下。 */
  cwd?: string;
  /**
   * この check の結果に関係する変更を宣言する glob（repository-relative）。
   * 省略/空は worktree 全体を対象にする最も保守的な既定値 —
   * 「scope を確立できないなら実行する」を満たすための安全側デフォルト。
   */
  scope?: readonly string[];
  /** scope に関わらず常に内容を折り込む追加ファイル（例: package.json, tsconfig.json）。 */
  configPaths?: readonly string[];
  /** この check の結果に影響する env var 名。値そのものは呼び出し側の env から読む。 */
  relevantEnv?: readonly string[];
  /** リポジトリ policy として必須かどうか。receipt の `not-required` 判定に使う。 */
  required: boolean;
  timeoutMs?: number;
  /**
   * 設定時、PASS を `src/workflow/state/store.ts` の既存 `validation_evidence`
   * テーブル（push gate が信頼する唯一の authority）へも記録する。worktree が
   * クリーン（宣言 scope 内に未コミット変更が無い）な場合のみ書き込む — 既存の
   * push gate の信頼境界を弱めない。
   */
  evidenceName?: string;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export const DEFAULT_MANAGED_CHECKS: readonly ManagedCheckDefinition[] = [
  {
    id: "lint",
    label: "static analysis",
    command: "pnpm",
    args: ["run", "lint"],
    required: true,
    evidenceName: "lint",
    configPaths: ["eslint.config.mjs"],
  },
  {
    id: "typecheck",
    label: "typecheck",
    command: "pnpm",
    args: ["run", "typecheck"],
    required: true,
    evidenceName: "typecheck",
    configPaths: ["tsconfig.json"],
  },
  {
    id: "test",
    label: "fast tests",
    command: "pnpm",
    args: ["test"],
    required: true,
    evidenceName: "test",
  },
  {
    id: "build",
    label: "build",
    command: "pnpm",
    args: ["run", "build"],
    required: false,
    evidenceName: "build",
    configPaths: ["tsconfig.build.json", "package.json"],
  },
  {
    id: "verify",
    label: "full repository verification",
    command: "pnpm",
    args: ["run", "verify"],
    required: false,
    evidenceName: "verify",
  },
] as const;

export function findManagedCheck(
  checks: readonly ManagedCheckDefinition[],
  checkId: string,
): ManagedCheckDefinition | undefined {
  return checks.find((check) => check.id === checkId);
}
