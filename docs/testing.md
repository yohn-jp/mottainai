# テストアーキテクチャ

Mottainai のテスト層は責務・実行コスト・環境境界で分離する。分類の機械的な正本は [`scripts/test-suites.mjs`](../scripts/test-suites.mjs) であり、この文書はその意味と運用を説明する。

## Assurance chain

```text
canonical rule / contract
  -> named test layer / command
  -> compiled Inari PR contract + executable CI results
  -> packed artifact proof when distribution paths change
  -> runtime/build identity for the verified artifact
```

PR body の shape は compiled Inari contract が単独 authority である。現在の default PR は `Summary / Linked issue / Changes / Validation / Review focus` の5フィールド。`Test contract`、`Regression proof`、`Validation evidence`、`Release impact` などを test tier から逆算して別の必須 body schema にしない。

詳細な実行証跡は各 CI job / artifact が正本である。`Validation` の Typecheck / Tests / Build と条件付き Package check は、実際にその検証が完了した場合だけチェックする。

## テスト層

| 層 | 保証対象 | 主な入口 |
| --- | --- | --- |
| Fast | pure logic、schema、envelope、決定論的 contract | `pnpm test` |
| Integration / process | filesystem、Git、SQLite、CLI、subprocess、複数 component | `pnpm run test:integration` |
| E2E / black-box | built `dist` を外部 MCP client として stdio 接続 | `pnpm run test:e2e` |
| Package | packed artifact、install、bin、consumer protocol | `pnpm run test:package` |
| Standards | format、lint、architecture、governance、suite/coverage policy | `pnpm run test:standards`, `pnpm run verify:standards` |
| Coverage | fast + integration の coverage policy | `pnpm run test:coverage` |
| Full verification | standards、typecheck、fast、integration、build、E2E、coverage、package | `pnpm run verify` |

`pnpm test` は TDD 用の短い default loop であり、E2E・package・coverage を含めない。`pnpm run test:all` は fast / integration / E2E の開発用 aggregate で、release 判定そのものではない。

## 機械的分類

`scripts/test-suites.mjs` が repository を列挙して test file を各 suite に割り当てる。

- `src/**/*.test.ts`: fast または明示された integration/process rule。
- `src/e2e/**/*.spec.ts`: E2E。
- `scripts/**/*.test.mjs`: 原則 standards。ただし classifier が integration/package harness として明示分類するものを除く。
- `scripts/mcp-stdio-package.test.mjs`, `scripts/smoke-test.mjs`: package path。

classifier は suite 未所属、複数 suite 所属、fast への process/E2E/package 混入を失敗させる。test file をコメントだけで分類から隠す経路は作らない。

新規テストの配置は次を基本とする。

- pure logic / schema / envelope: 対象 module の隣の `<name>.test.ts`。
- filesystem / Git / SQLite / CLI / subprocess: integration/process rule。
- 外部 stdio MCP protocol: `src/e2e/<name>.e2e.spec.ts`。
- packed consumer / install / bin: package suite。

既存 colocated test は分類だけのために移動しない。

## CI topology

Linux / Node 24 を canonical correctness 環境とする。native Windows は supported runtime ではなく、Windows 利用者は WSL2 を使う。macOS は best-effort / Tier 2。

Canonical Node 24 path は変更内容に応じて次を実行する。

- standards / static integrity;
- typecheck;
- fast unit/contract;
- integration/process;
- build;
- built-dist E2E;
- coverage;
- packed consumer/package contract。

GitHub Ruleset の required check は GitHub 側の設定が正本であり、この文書から推測しない。CI に表示される非-required job も、該当層の executable evidence として有効である。

## Governanceとの境界

Repository PR governance は test layer の一覧から追加 body section を生成しない。

現在の分担は次の通り。

- Inari: PR body shape と rendering/semantic validation。
- `scripts/governance-rules.json`: title、branch、minimum body length、Validation completion、conditional Package check、compression/CLI changed-file rules。
- `scripts/governance-lib.mjs`: repository-local independent checks と Inari heading synchronization。
- CI: 実際に test/build/package を実行したという証拠。

旧 `Validation evidence` class や PR-body `Regression proof` は現在の default PR schema authority ではない。historical quality-evidence research は analyzer 選定の記録として残るが、PR に undeclared field を要求してはならない。

## Commands

```bash
pnpm test
pnpm run test:integration
pnpm run build
pnpm run test:e2e
pnpm run test:package
pnpm run test:coverage
pnpm run test:standards
pnpm run verify:standards
pnpm run verify
```

- `smoke-test`: build 済み `dist` から packed package を検証する。
- `test:package`: build 後、同一 tarball の package protocol / consumer smoke を実行する。
- `test:coverage`: fast + integration を instrumentation 付きで実行し、coverage artifact と policy result を生成する。
- `verify`: full verification を決定的な順序で実行する。

## Process / fault boundaries

Persistent state、external process、Git mutation、migration、cleanup、retry semantics を変更する場合は、その boundary に対応する deterministic failure case を追加する。sleep、random failure、実 process の timing race を再現手段にしない。詳細は [`fault-injection.md`](fault-injection.md)。

故障テストは最低限、次を固定する。

1. failure operation;
2. pre-state;
3. post-state;
4. cleanup/retention;
5. retry/recovery semantics。

## E2Eとpackageの境界

`test:e2e` は build 済み `dist/index.js` を child process として起動し、MCP initialize、tools/list、tools/call、protocol/lifecycle/upstream failure を stdio 境界で検証する。production internals を import して成功しただけでは E2E proof にならない。

`test:package` は build した artifact を pack し、同じ tarball を consumer path で検証する。package/bin/publish path の correctness は source import だけでは証明できない。

release workflow は pack と publish の間で artifact を作り直さず、検証した tarball と publish 対象を一致させる。

## Coverage

Coverage policy の数値と critical module は [`scripts/coverage-policy.json`](../scripts/coverage-policy.json) が正本。coverage threshold を満たすことと product behavior が正しいことは別の保証なので、coverage を integration/E2E/package proof の代用にしない。

## Effectiveness tests

Property/mutation testing は test suite 自体の有効性を評価する補助層で、通常の fast loop や必須 PR body field ではない。

```bash
pnpm run test:property
pnpm run test:mutation
pnpm run test:effectiveness
```

その結果は analyzer/test-harness 改善の材料として扱い、通常の CI pass を置き換えない。

## Golden Path

Golden Path の最終 acceptance は個別 unit test だけではなく、実際の lifecycle を跨ぐ product proof を必要とする。

```text
Issue
  -> task start/run
  -> Nawabari worktree/session/claim
  -> validation
  -> managed commit
  -> managed push
  -> gh-inari PR
  -> Governance + CI
  -> merge
  -> task finish
  -> Nawabari ownership release
  -> next task start
```

途中の retry/reconciliation fix は focused integration test で固定し、最後に lifecycle 全体で再検証する。raw Git/GitHub repair が必要なら Golden Path は未完成として扱う。
