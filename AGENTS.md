# AGENTS.md — mottainai

エージェント（Codex / Claude Code / その他）共通の運用指示。**このファイルがプロジェクト規約の正本**。`CLAUDE.md` は応答スタイルとこのファイルへの参照のみを持つ。

---

## 0. 応答スタイル（原始人モード）

日本語で簡潔に返す。詳細は `CLAUDE.md`。

- 削除: 敬語・丁寧語（です/ます）、クッション（これから/基本的に）、前置き（ご質問ありがとう）、ぼかし（〜かもしれません）、謝罪・進捗実況（〜を確認します/以降注意します）
- 体言止め・用言止めOK。短い同義語。技術用語は正確維持。コードブロック無変更
- パターン: `[対象] [状態/動作] [理由]。[次の手順]。`
- 思考内容をテキスト出力で再度なぞらない。出力は結果・要約のみ
- 不可: 「ご質問ありがとうございます、お答えします」
- 可: 「圧縮パイプラインにバグ。修正:」

**自動解除**（通常日本語に戻す）: 破壊的操作の確認、セキュリティ警告、ユーザー混乱時。該当部分が終わったらすぐ復帰。

**境界**: コード、コミットメッセージ、PR 本文は通常記述。

**テキスト形式ファイル生成時**（`.md` / `.txt` / `.json` 等）: 原始人口調を自動適用しない。初回のみ「原始人口調で書くか？」確認。いいえ/無回答なら通常日本語。

---

## 1. リポジトリの実態

複数の upstream MCP サーバーを 1 エンドポイントに集約し、**LLM に届く前にツール定義と実行結果を圧縮する**プロキシゲートウェイ。全体像は `README.md`。

```
LLM ⇄ mottainai ⇄ [codegraph, fff-mcp, ...]
```

### レイヤ

| 層 | ファイル | 役割 |
|---|---|---|
| 起動 | `src/index.ts` | config 読み込み → upstream 接続 → stdio server |
| 中継 | `src/proxy.ts` | `listTools` / `callTool` のルーティング、名前プレフィックス `<upstream>__<tool>` |
| upstream | `src/upstream.ts` | 子プロセス起動（`StdioClientTransport` 前提） |
| 設定 | `src/config.ts` | `mottainai.config.json` の `mcpServers` と `gateway` |
| 圧縮 | `src/compress/*` | ANSI 除去 / JSON サンプリング / 行フィルタ / 既知 CLI / コード骨格 / tool description |
| upstream 実行 | `src/upstream-call.ts` | 起動 → 実行 → ロギング → 圧縮 → 原文保持。prefix 経由と brokered 経由で共有 |
| tool 目録 | `src/catalog.ts` / `src/broker.ts` | CatalogTool 構築、決定論的検索、profile による公開面の絞り込み |
| routing | `src/adaptive/*` | タスク分類の受け取り、capability→provider 索引、trace、統計、policy 候補生成 |
| 原文保持 | `src/retrieve.ts` | TTL 付きインメモリ artifact store（既定 15分 / 200件） |
| ローカルツール | `src/local-tools.ts` | `mottainai_exec` 等、gateway 自前のツール |
| ロギング | `src/logging.ts` | 圧縮前の生データを `.mottainai/log/` に JSON Lines |
| 永続 state | `src/state/*` | `StateStore` 抽象、SQLite backend（`node:sqlite`）、session / read evidence / read decision、schema migration。現状は基盤のみで未配線（呼び出し元なし） |

### パッケージマネージャ: pnpm

lockfile は `pnpm-lock.yaml`。他のパッケージマネージャの lockfile を混在させない。

| 用途 | コマンド |
|---|---|
| 依存インストール | `pnpm install`（lockfile 変更時は `pnpm install --frozen-lockfile`） |
| ビルド | `pnpm run build` |
| テスト | `pnpm test`（`node --import tsx --test "src/**/*.test.ts"`） |
| typecheck | `pnpm run typecheck` |
| upstream 管理 | `pnpm run mcp <list\|inspect\|add\|remove\|enable\|disable\|profile\|doctor>` |
| policy 操作 | `pnpm run policy <list\|show\|approve\|traces\|stats>` |

`tree-sitter` 系はネイティブビルドが必要（`pnpm approve-builds`）。初回 `pnpm install` 時に `ERR_PNPM_IGNORED_BUILDS` が出たら実行する。

CI は `.github/workflows/ci.yml`（install → typecheck → test → build、Node 22/24）。デプロイ系ワークフローは追加提案しない。

---

## 2. 探索（最重要・トークン規律）

このリポジトリは codegraph でインデックス済み（`.codegraph/`、TS 29ファイル）。**圧縮ゲートウェイを名乗る以上、自分の探索も無駄を出さない。**

### 順序

1. **`codegraph_explore` を 1 回**。シンボル定義・呼び出し関係・「X はどう動くか」はここが最短（呼び出し元・影響範囲まで 1 回で返る）
2. 足りなければ**名前を絞った** codegraph 追加（最大あと 1〜2）
3. Grep / Read は次だけ:
   - 非インデックス対象 — `README.md` / `docs/*.md` / `package.json` / `tsconfig.json` / `mottainai.config.json*` / `.mottainai/log/*`
   - staleness バナーが出た対象
   - **編集直前の該当ファイル 1 本**

### 禁止（硬）

- codegraph がソースを返したあと、同じ記号・同じファイルを Grep/Read で「確認」する
- ユーザーが原因・ファイル・修正方針を既に書いたとき → **探索 0**。差分・修正のみ
- explore サブエージェント複数 / 指示があるのにリポジトリ再地図化

探索は既定 **1 往復**。Todo・リポジトリ地図化はソロ実装ではやらない。

`src/` は 2,500 行程度と小さい。全体を読み直すより codegraph の 1 クエリのほうが安い。

---

## 3. 自己ドッグフーディング（このプロジェクト固有）

このゲートウェイ自身が提供する `mottainai_*` ツールを、開発中も優先して使う。**自分が使わない圧縮は品質が落ちる。**

| したいこと | 使うツール | 代わりに使わない |
|---|---|---|
| コマンド実行（test / build / typecheck） | `mottainai_exec` | 素の Bash（長い出力をそのまま食う） |
| ファイル読み | `mottainai_read`（`mode: outline` / `symbols`） | 大きいファイルの Read 全文 |
| 文字列検索 | `mottainai_search` | 素の `rg` / `grep` |
| ディレクトリ一覧 | `mottainai_list` | `ls -R` |
| 圧縮で落ちた原文 | `mottainai_result_get`（`query` / `startLine` / `maxLines`） | 同じコマンド再実行 |
| 過去結果の探索 | `mottainai_result_search` | 再実行 |
| upstream の状態確認 | `mottainai_runtime_status` | ログの手読み |

`mottainai_exec` は既定 `targetTokens=1000` に収まるよう圧縮し、省略時は
`⋯ mottainai omitted=N lines sha256=… ⋯` を挟む。**省略部分が必要なら再実行ではなく `mottainai_result_get`**（`result_id` を使う）。

### 圧縮の不具合を見つけたときの扱い

自分のツール経由で「圧縮しすぎて必要な行が消えた」「壊れた JSON が返った」を踏んだら、それは**このプロジェクトのバグ報告**。回避して先に進むだけで終わらせず、最小再現（入力テキスト + 期待出力）をユーザーに報告する。

デバッグ時に圧縮を切る:

```bash
MOTTAINAI_COMPRESS=0                      # Step2/Step3まとめて停止
MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS=0    # Step3 description圧縮のみ停止
MOTTAINAI_COMPRESS_CODE=0                 # コード骨格化のみ停止
MOTTAINAI_LOG=0                           # 生データロギング停止
```

`mottainai_exec` は引数 `compression: false` で単発の圧縮を切れる。

### ローカルツールを触るときの不変条件

- **`workspaceRoot` の外に出さない**。`resolveInside()`（`src/local-tools.ts`）が realpath 解決後にも境界を再検証する。シンボリックリンク経由の脱出を塞ぐ検査なので、片方だけの検査に簡略化しない
- 全ローカルツールの返却は `OUTPUT_SCHEMA` 準拠（`operation` / `status` / `summary` / `facts` / `diagnostics` / `metrics` / `result_id` / `truncated`）。フィールドを削らない
- `annotations`（`readOnlyHint` / `destructiveHint`）は実挙動と一致させる。読み取り専用ツールに副作用を足さない

### `mottainai_exec` の trust mode と OS sandbox

- `workspaceRoot` は OS sandbox ではない。`mottainai_exec` の初期 cwd と `cwd` 引数、read/search/list の path 解決だけを制約する
- `mottainai_exec` は `shell: true` で任意コマンドを実行する。コマンド本文は `workspaceRoot` 外の絶対パス・`cd`・子プロセス経由の到達を防がない
- 実行ユーザー権限で許される network、ファイル変更・削除、プロセス起動を防がない。timeout・出力上限は資源制御でありアクセス制御ではない
- 現在の trust mode は運用上の信頼境界のみ。信頼済み利用者・信頼済みワークスペースにだけ `mottainai_exec` を公開する。非信頼入力には公開しない
- OS sandbox 未実装。外部 sandbox なしで arbitrary exec の OS 隔離を提供しない。bubblewrap、sandbox-exec、コンテナ、trust mode 強制実装、OS sandbox テストは次段階
- `mottainai_exec` の annotations は `readOnlyHint: false`、`destructiveHint: true`、`idempotentHint: false`、`openWorldHint: true` を維持。実挙動と一致

### 呼び出し側監督型 routing を触るときの不変条件

`src/adaptive/*`（trace / policy / capability 索引）は次を壊さない。

- **候補 policy を MCP ツールから active にしない**。承認は `pnpm run policy approve` だけ。呼び出し側エージェントが自分の統計で自分の routing を書き換える経路を作らない
- **trace に証拠本文を入れない**。既定は metadata のみ。呼び出し側の `context` は digest だけ保存し、原文は `MOTTAINAI_TRACE_RAW=1` のときに限る
- **`_mottainai` は upstream へ転送しない**。`additionalProperties: false` の upstream schema を壊す
- **capability 語彙を閉じた enum にしない**。未知ラベルは正規化して受け入れ、`known: false` として記録する。弾くとフィードバックそのものが失われる
- **policy に provider 名を書かない**。規則は capability だけを扱い、provider 解決は `CapabilityIndex` が実行時に行う
- 統計と候補生成は決定論的規則のみ。LLM を実行経路に入れない

---

## 4. 圧縮ロジックを変更するときの規約

**圧縮は「短くする」ことより「壊さない」ことが優先。** 判断に迷ったら圧縮しない側に倒す。

### 無変形を守る対象（全レイヤ共通）

- コードフェンス内 / inline code / URL / 引用文字列（シングル・ダブル）
- 日本語を含む行（英語向け規則を適用しない）
- JSON Schema の非 `description` フィールド（`type` / `enum` / `default` / `required` / `examples` 等）
- `image` / `resource` タイプの content 要素
- `git diff` 出力（パッチの根拠が消えるため）

### 変更手順

1. 規則は該当モジュールに閉じて足す（`src/compress/<layer>.ts`）。`proxy.ts` に個別ケースを直書きしない
2. **テストは「短縮する例」と「短縮してはならない例」を必ず両方**追加する。片方だけの追加は不可
3. 環境変数で切れるべき新レイヤは `src/compress/config.ts` に判定関数を足し、既定は有効
4. `README.md` の圧縮規則一覧を、挙動が変わったら同じコミットで更新する

### 追加してはいけない変更

- 意味を変える言い換え・要約（機械的規則のみ。LLM 抽出器はロードマップ上 opt-in で別途）
- tool 識別子の変更（プレフィックス付与以外）
- upstream の元定義の破壊的書き換え（`listTools` は upstream 由来を保持したうえで写しを圧縮する）
- 原文 artifact を保持せずに情報を落とす経路（落とすなら必ず `result_id` で辿れること）

---

## 5. Git 運用

- **コード変更・ファイル操作の着手前に作業ブランチを作成**。`main` 直接作業をしない
- **変更完了ごとに即コミット**。まとめ置き禁止
- コミットメッセージは Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）。既存履歴に合わせる
- push・PR 作成・ブランチ削除はユーザー明示時のみ
- `mottainai.config.json` と `.mottainai/` は `.gitignore` 対象。**ログには upstream の生の実行結果が入りうるのでコミットしない**

---

## 6. 検証

- 既定: **変更に対応するテスト 1 本**（`pnpm test` は全体でも数秒なので通してよい）
- 型が疑わしい変更（`src/compress/index.ts` のオプション型、`CallToolResult` 周り）では `pnpm run typecheck`
- `pnpm run build` は `dist/` を使う疎通確認をするときだけ
- 新しい upstream の疎通確認は `Client` + `StdioClientTransport` の使い捨てスクリプトで `listTools()` を叩く

### MCP サーバーの起動

`node dist/index.js` は stdio を掴んで常駐する。**ユーザー許可なくフォアグラウンドで起動しない**（ハングに見える）。疎通確認は `Client` + `StdioClientTransport` の使い捨てスクリプトで `listTools()` を叩く。

Claude Code 側へ反映するときは `/mcp reconnect mottainai`、またはセッション再起動。

---

## 7. コード規約

`src/` の既存スタイルに合わせる。lint / formatter は未導入なので、**周囲のコードを模倣する**のが基準。

- TypeScript strict / ESM（`module: NodeNext`）。相対 import は `.js` 拡張子付き（`./config.js`）
- 命名は完全語。略語を作らない（`config` は既存だが `cfg` / `impl` / `res` を新規に増やさない）
- コメントは日本語。**why のみ**書く（マジックナンバー、非自明な境界、回避策の理由）。what は書かない
  - 例: `// 共通envelope分を約256 token確保。行境界を維持して先頭・末尾を残す。`
- テストは `node:test` + `node:assert/strict`。対象ファイルと同階層に `<name>.test.ts`
- 例外は `throw new Error("<lowercase message>")` で引数検証エラーを返す既存パターンに合わせる

---

## 8. トークン規律

- サブエージェントの並列起動はユーザー明示時のみ。このリポジトリの規模ではソロ実装が既定
- 完了報告は変更パスと結果のみ。差分全文・ログ全文の再掲をしない
- デバッグ: 計測 → 1 仮説 → 最小差分。効かなければ打ち切って報告。「直して様子見」の連鎖をしない
- 生ログを見るときは `.mottainai/log/*.jsonl` を `jq` で絞る。全文を読み込まない

---

## 9. 参照索引

| 内容 | パス |
|---|---|
| プロジェクト概要・圧縮規則一覧 | `README.md` |
| 応答スタイル | `CLAUDE.md` |
| 探索 hook | `.claude/hooks/warn-grep.sh` |
| Issue・PR契約 | `docs/governance.md` |

機能別の詳細ドキュメント（`docs/*.md`）は整理中で、このリポジトリにはまだ含まれていない。当面は本ファイルと `README.md` が正本。

**最短手順**: codegraph 1 回 → 該当ファイル 1 本 Read → 修正 → テスト 1 本 → 即コミット。

---

## 10. Issue・PR契約

- Issueにない機能を追加しない
- Acceptance criteriaを実装中に変更しない
- Scope外の問題は別Issueとして提案する
- PR本文は実装後の差分と検証結果から再構成する
- 実施していない検証へチェックを入れない
- `Closes`対象は1件を原則とする
- Review focusを具体化する
- TODO・follow-upをPR本文だけに残さずIssue化する
- 形式・差分連動規則は`docs/governance.md`と`scripts/governance-rules.json`を正本とする
