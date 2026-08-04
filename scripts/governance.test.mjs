import test from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, validateIssue, validatePullRequest } from "./governance-lib.mjs";

const issueBody = `## Summary\n十分に具体的な要約を記述する。\n## Problem\n再現可能な問題と根拠を詳しく記述する。\n## Goal\n完了状態を具体化する。\n## Non-goals\n対象外範囲を明示する。\n## Acceptance criteria\n- [ ] 検証可能な条件を満たす\n## Affected areas\n影響範囲を記述する。\n## Risks / compatibility\n互換性とリスクを記述する。\n## Dependencies\n依存なし。その理由も記述する。\n## Implementation notes\n実装制約と方針を詳しく記述する。`;

const pullRequestBody = `## Summary\n契約検証を導入しLLM生成PRの形式を統一する。\n## Linked issue\nCloses #123\n## Scope\n契約検証。\n### Included\nIssue Formと検証スクリプト。\n### Excluded\nGitHub Rulesetの適用。\n## Implementation\n依存なしNodeスクリプトをCIとローカルで共有する。\n## Behavioral changes\n不正形式のPRはCI失敗となる。\n## Validation\n- [x] Typecheck\n- [x] Tests\n- [x] Build\n- [ ] Package check, not applicable\n## Risks\n既存Issueは移行が必要。\n## Breaking changes\nNo. 新規ガバナンスのみ。\n## Migration / compatibility\n既存Issueは必要時に追記する。\n## Security impact\n権限は最小化する。\n## Review focus\n見出し抽出と差分連動規則。`;

test("valid issue contract passes", () => {
  assert.deepEqual(validateIssue(issueBody), []);
});

test("empty issue sections fail", () => {
  assert.ok(validateIssue(issueBody.replace("影響範囲を記述する。", "なし")).includes("必須項目が空: Affected areas"));
});

test("valid pull request contract passes", () => {
  const result = validatePullRequest({ title: "chore(ci): add governance contract", body: pullRequestBody });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.closingIssues, [123]);
});

test("compression changes require tests and preservation evidence", () => {
  const result = validatePullRequest({ title: "fix(compression): preserve code fences", body: pullRequestBody, files: ["src/compress/code.ts"] });
  assert.ok(result.errors.some((error) => error.includes("テスト変更")));
  assert.ok(result.errors.some((error) => error.includes("無変形例")));
});

test("branch contract accepts one issue and rejects missing issue", () => {
  assert.deepEqual(validateBranchName("chore/123-governance-contract"), []);
  assert.equal(validateBranchName("chore/governance-contract").length, 1);
});
