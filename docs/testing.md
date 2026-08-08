# テストアーキテクチャ

テスト層は責務、実行コスト、環境境界で分離する。既存のcolocated testは移動・改名しない。分類の正本は`src/test-support/`のfixtureやコメントではなく、[`scripts/test-suites.mjs`](../scripts/test-suites.mjs)の機械可読ルール。

## 層とコマンド

| 層 | 保証対象 | ファイル規則 | コマンド | 実行目安 |
|---|---|---|---|---|
| Fast | pure logic、unit、contract、MCP envelope/config schema、決定論的境界 | `src/**/*.test.ts`からintegrationルール対象を除外 | `pnpm test` | 15秒以内を目標 |
| Integration / process | 複数component、filesystem、git、SQLite、CLI・子process | `src/commands/**/*.test.ts`、`src/init.test.ts`、`src/local-tools.test.ts`、`src/logging.test.ts`、`src/mcp-cli.test.ts`、`src/state/**/*.test.ts`、`src/workflow/**/*.test.ts` | `pnpm run test:integration` | 30秒以内を目標 |
| E2E / black-box | gatewayを外部MCP clientからstdioで接続 | `src/e2e/**/*.spec.ts` | `pnpm run test:e2e` | 30秒以内を目標 |
| Package smoke | build後のpacked tarball install、bin、init、missing-config動作 | `scripts/smoke-test.mjs` | `pnpm run test:package` | 90秒以内を目標 |
| Standards | format、lint、architecture、governance、suite/coverage policy self-test | `scripts/**/*.test.mjs` | `pnpm run test:standards` | 30秒以内を目標 |
| Full verification | 上記全層、typecheck、build、package smoke | `FULL_VERIFICATION_SUITES`全項目 | `pnpm run verify` | CI/release前 |

`pnpm test`はTDD用のdefault loop。E2E、package smoke、coverageは含めない。`pnpm run test:all`はfast、integration/process、E2Eを順に実行する開発用aliasで、standards・build・package smokeを含むrelease判定ではない。

既存コマンドの責務:

- `pnpm run smoke-test`: `dist/`をbuild済みとしてpacked packageだけ検証。単独実行時はbuildしない。
- `pnpm run test:package`: `build`後に`smoke-test`を実行。package層の入口。
- `pnpm run verify:standards`: format、lint、architecture、governance、分類validator、coverage policy self-test。
- `pnpm run test:coverage`: fast+integrationを一度ずつ実行し、coverage artifactとgate結果を生成。fast loopへinstrumentationを入れない。
- `pnpm run verify`: `verify:standards`、typecheck、fast、integration/process、E2E、coverage、package smokeを決定的な順序で実行。

## 機械的分類

[`scripts/test-suites.mjs`](../scripts/test-suites.mjs)がrepositoryを再帰列挙し、次を認識する。

- `*.test.ts`: fastまたは明示的なintegration/process rule。既存colocated testを維持するため、integration層はpath ruleで固定。
- `*.spec.ts`: `src/e2e/`配下だけE2E。fastには一致しない。
- `scripts/**/*.test.mjs`: standards。architecture/governance/self-testを含む。
- `scripts/smoke-test.mjs`: package smoke。Node test runnerへ渡さない。

validatorは各認識ファイルについて、suite未所属、複数suite所属、同一suite重複、E2E/process/packageのfast混入を失敗させる。`test-suites.test.mjs`は、現在の全ファイル列挙、fast除外、全suiteのfull verification被覆をself-testする。分類をコメントだけで隠す経路はない。

新しいtest fileは次の規則に従う。

- pure logic、schema、envelope、config contract: 対象moduleの隣に`<name>.test.ts`。
- filesystem、git、SQLite、CLI、子process: 既存colocated testを移動せず、integration path ruleへ追加して`test:integration`へ割り当てる。
- 外部stdio MCP protocol: `src/e2e/<name>.e2e.spec.ts`。
- packed package: `scripts/smoke-test.mjs`の検証、または同じpackage層のscript。package smokeを`pnpm test`へ追加しない。

## Integration、process、fault test

integration/process層は実component間の契約と失敗境界を検証する。実filesystem、一時git repository、in-memory/temporary SQLite、CLI subprocessは許可するが、developerのHOME、global git config、global package installation、networkへ依存しない。

fault-injection testはintegration/process層に置く。timeout、spawn failure、missing config、upstream failure、rollback、migration failureなど、制御可能なfaultを注入し、diagnostic、cleanup、exit status、protocol stdoutを検証する。fault testをfastへ混ぜる場合はpure deterministic failureだけに限定する。

共有fixtureは[`src/test-support/`](../src/test-support/)に置く。fixtureは`t.after()`でcleanupし、`isolatedGitEnvironment`、`withEnv`、`isolatedHomeDir`、`withDeterministicEnv`でhost stateを隔離する。`src/test-support/`と`src/e2e/`は`testInfrastructure` layerであり、productionから逆依存しない。`tsconfig.build.json`でpublished `dist/`から除外する。

## E2Eとpackageの境界

`test:e2e`はsource checkoutの`src/index.ts`を`tsx`経由で子process起動し、MCP `listTools`/`callTool`のstdio境界を検証する。`dist/`やpacked packageの公開内容は保証しない。

`test:package`は`pnpm build`後に`npm pack`、isolated install、installed bin、`init`、missing-config実行を検証する。公開tarball、package.jsonの`files`、launcher、依存解決の変更ではpackage層を実行する。E2Eでpackage smokeを代用しない。

## Coverage policy

`pnpm run test:coverage`はNode 22/24の組み込みtest coverageを専用processで実行する。`coverage/lcov.info`（machine-readable LCOV）と`coverage/summary.json`（machine-readable gate summary）を生成し、同じCI stepでline、function、branchのhuman-readable summaryをstdoutへ出す。coverage jobは通常のfast commandと分離し、CIでのみ必須gateとして実行する。

測定対象:

- `src/**/*.ts`、`src/**/*.mjs`のproduction source。
- fast + integration/processの全source test file。E2E子processのcoverageは親test runnerへ自動合算されないため、E2Eのpass/failは別jobで検証する。

除外対象:

- `*.test.ts`、`*.spec.ts`。
- `src/test-support/`、`src/e2e/`のtest helper。
- `src/**/fixtures/`、`src/**/test-fixtures/`。
- declaration、`dist/`、`coverage/`、generated file、dependency。

### Measured baseline

測定日`2026-08-08`、コマンド`pnpm run test:coverage -- --measure-only`、対象production source revisionは`4c40896`（PR #67をorigin/mainへrebase後の最終review-fix commit。coverageはtest-support/e2eを除外）。推測値ではなく、生成されたLCOVから取得した値。

| 指標 | covered / total | baseline |
|---|---:|---:|
| Line | 13056 / 13436 | 97.17% |
| Function | 909 / 955 | 95.18% |
| Branch | 3037 / 3512 | 86.47% |

Baselineは品質targetそのものではない。repository-wide regression floorは`scripts/coverage-policy.json`の`baseline.thresholds`に保守的に設定し、現在値を大きく下回る意味のある回帰をCIで失敗させる。

現行repository-wide floor:

| Line | Function | Branch |
|---:|---:|---:|
| 80% | 80% | 65% |

Critical moduleはaggregate率で隠れやすい境界なので、個別targetを設定する。

| Module | Line | Function | Branch | 高いtargetの理由 |
|---|---:|---:|---:|---|
| `src/config.ts` | 95% | 95% | 80% | 起動とupstream接続全体の設定解決 |
| `src/init.ts` | 82% | 82% | 68% | CLI/init、設定生成、client登録、credential除去 |
| `src/proxy.ts` | 95% | 90% | 75% | MCP tool list/call公開境界 |
| `src/auth.ts` | 92% | 95% | 70% | credential headerとOAuth brokerのsecret境界 |
| `src/retrieve.ts` | 92% | 90% | 85% | 圧縮前artifact retentionのTTL/取得保証 |
| `src/state/migrations.ts` | 95% | 95% | 95% | 永続schema migrationと互換性 |
| `src/state/sqlite-store.ts` | 95% | 95% | 85% | session/read evidenceの永続化 |
| `src/workflow/state/sqlite-store.ts` | 95% | 95% | 82% | workflow lifecycle stateと競合制御 |
| `src/workflow/domain/lifecycle.ts` | 95% | 95% | 88% | lifecycle遷移の不変条件 |

gateはrepository floorとcritical targetの両方を評価し、moduleがartifactから消えた場合も失敗させる。100%や単一aggregate率を品質指標にしない。

### Baseline/threshold更新

1. main相当のproduction sourceを専用worktreeで固定し、`pnpm install --frozen-lockfile`。
2. `pnpm run test:coverage -- --measure-only`を実行し、`coverage/summary.json`と`coverage/lcov.info`を保存。
3. 測定値、source revision、測定日を`scripts/coverage-policy.json`へ反映。thresholdは測定値から機械的に推測せず、regression floorまたはcritical targetの意図をreviewで明記する。
4. `docs/testing.md`のbaseline/table、self-test、CI artifact名を同じPRで更新。
5. `pnpm run test:coverage`、`pnpm run test:coverage:policy`、`pnpm run verify`を実行。policy JSONのthreshold変更は品質policy変更としてReview focusへ記載。

## 変更種別ごとの検証

| 変更 | 最低コマンド |
|---|---|
| pure logic、schema、envelope、contract | `pnpm test` |
| filesystem、git、SQLite、CLI、timeout、spawn、fault | `pnpm run test:integration` |
| stdio MCP server/proxy | `pnpm run test:e2e`（必要ならfast/integrationも） |
| package files、bin、init、publish準備 | `pnpm run test:package` |
| scripts、architecture、governance、test policy | `pnpm run test:standards` |
| production変更をPR/release判定 | `pnpm run verify` と`pnpm run test:coverage` |

非Draft PRのValidationには、実行した`format:check`、`lint`、`typecheck`、`pnpm test`、integration/process、E2E、build、package smoke、architecture/governance、coverageを明記する。未実行をpassとして記載しない。
