# AGENTS.md — Mottainai agent execution contract

このファイルは、Mottainaiで作業するagentの **canonical agent execution contract**。
全リポジトリ規則の正本でも、プロジェクト百科事典でもない。作業の境界、証拠の扱い、context lifecycle、安全境界を定義し、詳細な規則は既存のstructured / executable authorityへ委譲する。

同じ規則にmachine-readableまたはexecutableなauthorityがある場合、重複したMarkdown proseよりそちらを優先する。矛盾は隠さず、影響範囲とauthorityを報告する。

## 1. Mission and authority

Mottainaiの目的は、agentとupstreamの間でtool定義・実行結果・作業証拠を、意味と追跡可能性を保ったままbounded projectionとして扱うこと。agentの作業も同じ原則に従う。

- ユーザー依頼とaccepted Issueが、作業scope・acceptance criteria・non-goalsを定める。
- machine-readable設定、validator、workflow、test runner、CIが、exact behaviorと判定のauthority。
- domain documentは意図と入口を説明し、exact ruleを重複定義しない。
- 会話は補助的な作業入力。`Conversation history is not durable project state.`

## 2. Task entry protocol

1. Issue identity、目的、acceptance criteria、non-goals、許可されたpathを確定する。
2. 専用worktreeとIssue branchを確認する。`main`、detached HEAD、他taskの変更を作業対象にしない。
3. repository root、symbolic HEAD、branch ownership、既存変更、今回のmutation scopeを確認する。
4. 必要なevidence capabilityとauthorityを選び、bounded taskに分割する。repository全探索を開始条件にしない。
5. 既に正確なfile・原因・修正scopeが提示されている場合、探索を追加せず差分・validationへ進む。

長期taskでは、次のstateをauthoritative sourceから再構築できる状態で維持する。

- task / Issue identity
- current phase
- permitted / modified scope
- accepted decisions not canonical elsewhere
- unresolved blockers
- validation / evidence references
- next action

## 3. Context lifecycle / context economy

context lifecycleは次の順序で実行する。

```text
Prevent → Deduplicate → Externalize → Compact
```

### Prevent

不要なREAD、広い検索、full log、同じcommandの再実行を開始前に抑える。必要なcapability、path、range、出力budgetを先に決める。

### Deduplicate

現在のprojection、artifact、result、reference、git stateを再利用する。既に結果が存在する情報を再READ・再実行しない。省略部分が必要なら保存されたresult referenceからbounded retrievalする。

### Externalize

会話にしかないtask stateやaccepted decisionを、利用可能なIssue、workflow state、branch/worktree state、validation artifact、result referenceなどのdurable sourceへ移す。将来機能や未配線のstate基盤を、現在利用可能な保存先として扱わない。

### Compact

context exhaustionまで待たない。clientがcompactionまたはcontext reset capabilityを持つ場合、reasoning qualityが劣化する前の安全なcheckpointで使う。特定clientの`/compact`コマンドを普遍的な手順にしない。

compaction前に上記7項目と証拠referenceを外部化し、compaction後に同じauthoritative sourceからtask stateを再構築する。compaction後のrepository全探索、既読artifactの再READ、同一入力の再実行を禁止する。再検証が必要なのは入力・authority・環境が変わった場合だけ。

### Projection integrity

projectionやcompressionは、短縮を理由に意味・証拠・構文を壊さない。

- code fence、inline code、URL、single / double quoted string、日本語を含む行を変形しない。
- JSON Schemaの`description`以外のfield、`image` / `resource` content、`git diff`を変形しない。
- projectionで落とす情報は、元結果を`result_id`等のreferenceから取得可能にする。
- raw / full-file / full-log retrievalは通常経路にしない。必要時もrangeと目的を限定する。

## 4. Repository understanding and progressive disclosure

source explorationはprogressive disclosureで行う。

```text
fresh authoritative semantic/task projection
→ structural/index query
→ exact symbol/range evidence
→ broad raw source only as last resort
```

- freshでvalidなsemantic/task projectionが存在する場合、作業入口に使う。staleまたはinvalidなprojectionをcurrent truthとして使わない。
- declared intent / responsibility / invariantと、実際のexecutable behaviorを同じauthorityとして扱わない。後者は実装、test、実行結果などで検証する。
- 現在のtransitionとして、worktree-localでfreshnessを確認できる場合に限り`codegraph_explore`などのstructural/index queryと、Mottainaiのbounded read/search/list/result retrievalを使う。`codegraph first`を永久規則にしない。
- exact symbol・range・artifactを優先し、broad raw sourceは最後の手段。全ファイル・全ログ・`src/**`の無目的なREADは禁止。
- artifact/referenceが既にある場合、再実行ではなくreferenceから必要部分だけ取得する。

Repository Semantics、永続task state、lifecycle enforcementなど将来または未実装の機能は、current capabilityとして記述・利用しない。実装され、freshnessとauthorityが明示された場合だけこのcontractのprojection入口に昇格する。

## 5. Mutation protocol

- `main`へ直接変更しない。ユーザーまたはrepository workflowが要求するIssue worktree・branchを先に確保する。
- 許可されたscopeだけ変更し、既存の無関係な変更を上書きしない。acceptance criteria変更、Issue外機能、無関係なrefactor、新しいMarkdown正本を追加しない。
- Git操作、branch naming、worktree lifecycle、staging、commit、cleanupは`docs/workflow-policy.md`とそのstructured authorityに従う。
- Issue / PR governance、title、body、changed-file rule、required checkは`docs/governance.md`と`scripts/governance-rules.json`に従う。
- 変更をbounded checkpointで検証し、authorityが要求する形式でcommitする。push、PR作成、merge、rebase、Issue close、review reply / resolveは明示許可なしに行わない。

破壊的操作では通常の安全確認へ切り替え、対象を明示してから進める。

## 6. Validation protocol

- 変更pathとriskに対応するvalidation layerを`docs/testing.md`、test-suite classifier、package scripts、CI workflowから選ぶ。
- executable / governance / documentation contractを変更した場合、対応するstandards・governance validationを実行する。不要な全suite実行を完了条件にしない。
- validation結果はcommand、対象scope、環境、pass / fail / unavailable、artifact referenceで記録する。未実行、pending、hung、環境境界をpassと書かない。
- 既存のvalidation artifactを、入力が変わっていないのに再生成しない。remote CIの状態はlocal passと分離する。

## 7. Safety and trust-boundary invariants

以下は短縮・projection・便利化の対象外。

- `workspaceRoot`外へ出ない。pathはrealpath解決後も境界検証し、symlink経由の脱出を許さない。
- `mottainai_exec`のworkspaceRootはOS sandboxではない。`shell: true`のarbitrary commandは、権限内のfilesystem、network、processへ到達できる。timeoutとoutput limitはaccess controlではない。
- `mottainai_exec`はtrusted user / trusted workspaceにだけ公開する。OS-level sandbox未実装を、実装済みまたは保証済みと記述しない。
- local toolの返却は`OUTPUT_SCHEMA`（`operation`、`status`、`summary`、`facts`、`diagnostics`、`metrics`、`result_id`、`truncated`）を保つ。`annotations`は実挙動と一致させ、`mottainai_exec`の`readOnlyHint: false`、`destructiveHint: true`、`idempotentHint: false`、`openWorldHint: true`を維持する。
- routing candidateをMCP toolからactiveにしない。policyの承認・activateは`pnpm run policy approve`だけ。policyにprovider名を埋め込まず、provider解決は`CapabilityIndex`へ委譲する。
- traceへevidence本文を入れない。既定はmetadataとdigestだけ、raw traceは`MOTTAINAI_TRACE_RAW=1`の明示opt-in時だけ。`_mottainai`をupstreamへ転送しない。
- capability語彙を閉じたenumにしない。未知labelは失わず`known: false`として扱う。routing統計・candidate生成は決定論的にし、LLMをexecution pathへ入れない。

## 8. Completion protocol

完了前に、acceptance criteria、変更scope、unresolved blocker、validation evidence、next actionを再確認する。`git status`とdiffで無関係な変更・漏れを確認し、必要なcommitを作る。

報告はchanged files、実装scope、validation結果、未検証の環境境界、follow-up候補、local commitとremote stateを分離して示す。diff全文・ログ全文・既読文書の再掲をしない。Issue外の問題は勝手に取り込まず、follow-up候補として分離する。

## 9. Authority index

| 責務 | authority |
|---|---|
| Issue / PR contract、changed-file、evidence rule | [`docs/governance.md`](docs/governance.md)、[`scripts/governance-rules.json`](scripts/governance-rules.json)、`.github/PULL_REQUEST_TEMPLATE.md` |
| Git workflow policy、repository state | [`docs/workflow-policy.md`](docs/workflow-policy.md)、trackedな`.mottainai/workflow.json`、対応するworkflow実装 |
| test layer、classification、coverage、CI責務 | [`docs/testing.md`](docs/testing.md)、`scripts/test-suites.mjs`、`package.json`、`.github/workflows/ci.yml` |
| executable coding standard | [`docs/coding-standards.md`](docs/coding-standards.md)、`eslint.config.mjs`、`prettier.config.mjs`、`scripts/architecture-check.mjs` |
| project behavior、compressionの説明と実装契約 | [`README.md`](README.md)、対象実装・test |
| response style | [`CLAUDE.md`](CLAUDE.md)。execution authorityではない |

このindexはauthorityの入口。exact ruleをここへ複製しない。authorityが不在・stale・矛盾する場合、作業を広げずblockerと影響範囲を報告する。
