import { runProgram } from "../../subprocess.js";

/**
 * pre-commit/pre-push hook script 生成（Issue #28 Child 3）。生成された
 * hook は defense-in-depth に過ぎない — `--no-verify` や hook 未対応の
 * GUI/CI 環境からは迂回できる。実効的な enforcement は Mottainai 管理下の
 * write/edit tool が実行前に policy decision API を通ることに依存する
 * （Child Issue 9a-2）。ここでは `src/workflow/policy/protected-branch.ts`
 * と同じ判定ロジック（protectedBranches の glob マッチ + rule mode）を
 * shell へ再実装する（hook は Node 起動コストを避け、`git` 標準ツールだけで
 * 動くことを優先するため、TypeScript 実装をそのまま呼び出さない）。
 */

export type HookKind = "pre-commit" | "pre-push";

export interface GenerateHookScriptOptions {
  /** workflow.json の場所（repository root からの相対パス）。既定 `.mottainai/workflow.json`。 */
  policyRelativePath?: string;
}

const DEFAULT_POLICY_RELATIVE_PATH = ".mottainai/workflow.json";

const HOOK_MARKER = "# mottainai-workflow-hook";

/**
 * glob パターン（`*` のみワイルドカード）を protectedBranches から読み出し、
 * 現在の branch がいずれかにマッチするかを判定する shell 関数群。
 * `protected-branch.ts` の `patternToRegExp` と同じ escape 規則（`*` 以外の
 * ERE 特殊文字はリテラル化）を維持する。
 */
const PATTERN_MATCH_FUNCTIONS = [
  "pattern_to_ere() {",
  "  # $1 = glob パターン（*のみワイルドカード）。ERE のリテラルとして安全な",
  "  # 形に escape してから * を .* に展開する。",
  "  printf '%s' \"$1\" | sed -e 's/[.[\\*^$()+?{|]/\\\\&/g' -e 's/\\\\\\*/.*/g'",
  "}",
  "branch_is_protected() {",
  "  branch=\"$1\"",
  "  while IFS= read -r pattern; do",
  "    [ -z \"$pattern\" ] && continue",
  "    ere=\"^$(pattern_to_ere \"$pattern\")$\"",
  "    if printf '%s' \"$branch\" | grep -Eq \"$ere\"; then",
  "      return 0",
  "    fi",
  "  done <<EOF",
  "$(read_protected_branches)",
  "EOF",
  "  return 1",
  "}",
  "read_protected_branches() {",
  "  node -e \"" +
    "const fs=require('node:fs');" +
    "try{const doc=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));" +
    "for(const p of (doc.protectedBranches||[]))console.log(p);}catch{}" +
    "\" \"$POLICY_PATH\"",
  "}",
].join("\n");

function ruleModeLookupFunction(functionName: string, fieldName: string): string {
  return [
    `${functionName}() {`,
    "  node -e \"" +
      "const fs=require('node:fs');" +
      "try{const doc=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));" +
      `process.stdout.write(String(doc.protectedBranchRule&&doc.protectedBranchRule.${fieldName}||'off'));` +
      "}catch{process.stdout.write('off');}" +
      "\" \"$POLICY_PATH\"",
    "}",
  ].join("\n");
}

function header(kind: HookKind, policyRelativePath: string): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    `# kind=${kind}`,
    "# このファイルは src/workflow/git/hooks.ts が生成した。手動編集は再生成で失われる。",
    "# defense-in-depth のみ: --no-verify や hook 未対応環境からは迂回できる。",
    "set -eu",
    "REPO_ROOT=$(git rev-parse --show-toplevel)",
    `POLICY_PATH="$REPO_ROOT/${policyRelativePath}"`,
    'if [ ! -f "$POLICY_PATH" ]; then exit 0; fi',
    "",
  ].join("\n");
}

/**
 * pre-commit hook: 現在の branch が protected かつ `protectedBranchRule.commit`
 * が enforce/confirm なら commit を拒否する。
 */
export function generatePreCommitHookScript(options: GenerateHookScriptOptions = {}): string {
  const policyRelativePath = options.policyRelativePath ?? DEFAULT_POLICY_RELATIVE_PATH;
  return [
    header("pre-commit", policyRelativePath),
    PATTERN_MATCH_FUNCTIONS,
    ruleModeLookupFunction("rule_mode_for_commit", "commit"),
    "",
    'CURRENT_BRANCH=$(git symbolic-ref -q --short HEAD || true)',
    'if [ -z "$CURRENT_BRANCH" ]; then exit 0; fi',
    'if branch_is_protected "$CURRENT_BRANCH"; then',
    '  MODE=$(rule_mode_for_commit)',
    '  if [ "$MODE" = "enforce" ] || [ "$MODE" = "confirm" ]; then',
    "    echo \"mottainai: commit blocked on protected branch '$CURRENT_BRANCH' (protectedBranchRule.commit=$MODE)\" >&2",
    "    exit 1",
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * pre-push hook: push される各 ref のうち、宛先が protected branch なら
 * `protectedBranchRule.directPush`/`forcePush` を判定する。force push 判定は
 * remote 側の現在 SHA が local の ancestor かどうか（非 fast-forward）で行う。
 */
export function generatePrePushHookScript(options: GenerateHookScriptOptions = {}): string {
  const policyRelativePath = options.policyRelativePath ?? DEFAULT_POLICY_RELATIVE_PATH;
  return [
    header("pre-push", policyRelativePath),
    PATTERN_MATCH_FUNCTIONS,
    ruleModeLookupFunction("rule_mode_for_direct_push", "directPush"),
    ruleModeLookupFunction("rule_mode_for_force_push", "forcePush"),
    "",
    "while read -r local_ref local_sha remote_ref remote_sha; do",
    '  [ -z "$remote_ref" ] && continue',
    '  remote_branch=$(printf "%s" "$remote_ref" | sed -e "s#^refs/heads/##")',
    '  if ! branch_is_protected "$remote_branch"; then continue; fi',
    "  is_force=0",
    '  if [ "$remote_sha" != "0000000000000000000000000000000000000000" ]; then',
    '    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then',
    "      is_force=1",
    "    fi",
    "  fi",
    '  if [ "$is_force" = "1" ]; then',
    "    MODE=$(rule_mode_for_force_push)",
    '    LABEL="forcePush"',
    "  else",
    "    MODE=$(rule_mode_for_direct_push)",
    '    LABEL="directPush"',
    "  fi",
    '  if [ "$MODE" = "enforce" ] || [ "$MODE" = "confirm" ]; then',
    "    echo \"mottainai: push blocked to protected branch '$remote_branch' (protectedBranchRule.$LABEL=$MODE)\" >&2",
    "    exit 1",
    "  fi",
    "done",
    "exit 0",
    "",
  ].join("\n");
}

export function generateHookScript(kind: HookKind, options: GenerateHookScriptOptions = {}): string {
  return kind === "pre-commit" ? generatePreCommitHookScript(options) : generatePrePushHookScript(options);
}

/** 既存 hook ファイルが Mottainai 生成物かどうかを判定する（上書き前の安全確認用）。 */
export function isMottainaiGeneratedHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export type HookDivergenceReason = "no-checkpoint" | "checkpoint-not-ancestor" | "clean";

export interface HookDivergenceResult {
  diverged: boolean;
  reason: HookDivergenceReason;
  checkpointCommit: string | undefined;
  currentCommit: string;
}

/**
 * hook bypass（`--no-verify`）や hook 未対応クライアントからの直接書き込みを
 * 検知する。記録済み checkpoint（最後に hook を通過した commit）が現在の
 * branch tip の ancestor でなければ divergence とみなす。checkpoint が
 * そもそも無い場合は「hook が一度も通過していない」ことを意味し、それ自体は
 * 異常ではない（新規 branch 等）ため `diverged: false` を返す —
 * "no-checkpoint" は detection の入力不足を表す reason であり、報告や
 * 自動 repair は行わない（Child Issue 8 の範囲）。
 */
export async function detectHookBypass(
  cwd: string,
  branch: string,
  checkpointCommit: string | undefined,
): Promise<HookDivergenceResult> {
  const head = await runProgram("git", ["rev-parse", "HEAD"], cwd, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT_BYTES);
  const currentCommit = head.stdout.trim();

  if (checkpointCommit === undefined) {
    return { diverged: false, reason: "no-checkpoint", checkpointCommit: undefined, currentCommit };
  }
  if (checkpointCommit === currentCommit) {
    return { diverged: false, reason: "clean", checkpointCommit, currentCommit };
  }

  const isAncestor = await runProgram(
    "git",
    ["merge-base", "--is-ancestor", checkpointCommit, currentCommit],
    cwd,
    GIT_TIMEOUT_MS,
    GIT_MAX_OUTPUT_BYTES,
  );
  if (isAncestor.exitCode === 0) {
    return { diverged: false, reason: "clean", checkpointCommit, currentCommit };
  }
  return { diverged: true, reason: "checkpoint-not-ancestor", checkpointCommit, currentCommit };
}
