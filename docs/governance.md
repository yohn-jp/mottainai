# Issue・PRガバナンス

複数LLM・人間が作るIssueとPRを、テンプレートではなく機械検証可能な契約として扱う。

## Issue契約

Blank issueは禁止。`.github/ISSUE_TEMPLATE/`のIssue Formから種類を選ぶ。

- Feature
- Bug
- Architecture
- Maintenance
- Research

全Issueで次を必須とする。

- Summary
- Problem
- Goal
- Non-goals
- Acceptance criteria（チェックリスト形式）
- Affected areas
- Risks / compatibility
- Dependencies
- Implementation notes

`issue-governance.yml`が作成・編集時に再検証する。不正Issueには`status:invalid`と`needs:specification`を付与する。修正後の再検証成功時に解除する。

## PR契約

PRタイトル形式:

```text
type(scope): summary
```

許可type: `feat`、`fix`、`docs`、`refactor`、`test`、`chore`。

許可scope: `cli`、`proxy`、`config`、`compression`、`routing`、`upstream`、`security`、`release`、`docs`、`ci`。

ブランチ名形式:

```text
type/123-short-description
```

PR本文は`.github/PULL_REQUEST_TEMPLATE.md`の全見出しを維持する。`Closes #123`は原則1件。複数Issueを閉じる変更は分割する。Epicへ直接PRを紐付けず、子Issueへ分解する。

Validationは実施結果だけチェックする。未実施項目は未チェックのまま理由を記載する。非Draft PRに`TBD`、`TODO`、`FIXME`、`WIP`を残さない。

## 差分連動規則

| 変更 | 追加契約 |
|---|---|
| `src/config.ts`、`mottainai.config*` | `Migration / compatibility`記述 |
| `src/compress/**` | 同ディレクトリのテスト変更、短縮例と無変形例の検証記述 |
| `package.json` | Package check実施済み |
| `src/index.ts`、`scripts/mcp.ts` | READMEまたはCLIテスト変更 |
| security、auth、sandbox、local-tools関連 | `Security impact`記述 |

## ローカル検証

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch chore/123-governance
pnpm run governance:issue -- --event /path/to/issues-event.json
pnpm run governance:pr -- --event /path/to/pull-request-event.json --files /path/to/changed-files.txt
```

規則の正本は`scripts/governance-rules.json`。検証実装は`scripts/governance-lib.mjs`。workflowへ検証規則を重複させない。

## GitHub Ruleset

リポジトリ内ファイルだけではRulesetを有効化できない。main対象Rulesetへ次を手動設定する。

- Pull request必須
- Approval 1件以上
- 古いapprovalの破棄
- Review conversation解決必須
- Branch最新化必須
- Force push禁止
- Branch削除禁止
- 管理者を含むbypass禁止
- `Governance / validate-pr`をrequired status checkへ追加
- CIのNode 22/24 jobをrequired status checkへ追加

Ruleset適用後、既存IssueはPRから参照する前に現行Issue契約へ移行する。

## LLM運用

- Issueにない機能を追加しない
- Acceptance criteriaを実装中に変更しない
- Scope外の問題は別Issueとして提案する
- PR本文は実装後の差分と検証結果から再構成する
- 実施していない検証へチェックを入れない
- Closes対象は1件を原則とする
- Review focusを具体化する
- TODOやfollow-upをPR本文だけに残さずIssue化する
