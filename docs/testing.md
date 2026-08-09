# テストアーキテクチャ

テスト層は責務、実行コスト、環境境界で分離する。既存のcolocated testは移動・改名しない。分類の正本は`src/test-support/`のfixtureやコメントではなく、[`scripts/test-suites.mjs`](../scripts/test-suites.mjs)の機械可読ルール。

## CI検証トポロジー

PR CIはnative Windowsを含めず、Linux上のNode matrixだけを採用する。LinuxはTier 1 / canonical、WSL2はLinux runtimeとしてsupported、macOSはbest effort / Tier 2、native Windowsはunsupported。WindowsユーザーはWSL2を利用する。Issue #78のWindows smoke前提はIssue #88でsupersedeされた。

| 責務 | 環境 | CIで担う検証 |
| --- | --- | --- |
| Canonical full validation | Ubuntu + Node 22 | `standards`、typecheck、fast unit/contract、integration/process、build、built-dist full E2E、coverage、package/consumer smoke。repositoryの完全な必須検証の正本 |
| Node compatibility smoke | Ubuntu + Node 24 | install、build、packed consumer path、最小MCP handshake/list/call/EOF。Node 22のfull suiteを再実行しない |

Ubuntu + Node 22はexhaustive correctnessの正本。Node 24はruntime/package差異だけ確認する。full E2Eのlifecycle・fault・POSIX SIGINT/SIGTERM検証はcanonical環境に残す。

完全直積を避ける理由は、Node runtime差異の確認にLinuxのNode matrixで足りるため。CIはsupported runtimeのcorrectnessとNode compatibilityへ集中する。

CI check名も検証責務に合わせる。Node 24のcheckは`Node compatibility smoke (Ubuntu, Node 24)`で、`pnpm run test:package`によるinstall、build、packed consumer/MCP smokeだけを実行する。main rulesetのrequired checksは`validate-pr`、`install / typecheck / test / build (Node 22)`、`coverage (Node 22)`。Windows job削除に対応するrequired checkは現行rulesetにないため、branch protectionの手動変更は不要。設定変更は実施しない。

## 層とコマンド

| 層                    | 保証対象                                                                | ファイル規則                                                                                                                                                                    | コマンド                       | 実行目安       |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------- |
| Fast                  | pure logic、unit、contract、MCP envelope/config schema、決定論的境界    | `src/**/*.test.ts`からintegrationルール対象を除外                                                                                                                               | `pnpm test`                    | 15秒以内を目標 |
| Integration / process | 複数component、filesystem、git、SQLite、CLI・子process                  | `src/commands/**/*.test.ts`、`src/init.test.ts`、`src/local-tools.test.ts`、`src/logging.test.ts`、`src/mcp-cli.test.ts`、`src/state/**/*.test.ts`、`src/workflow/**/*.test.ts` | `pnpm run test:integration`    | 30秒以内を目標 |
| E2E / black-box       | built `dist` gatewayを外部MCP clientからstdio接続                       | `src/e2e/**/*.spec.ts`                                                                                                                                                          | `pnpm run test:e2e`（build後） | 30秒以内を目標 |
| Package               | packed artifactのprotocol subset、install、bin、init、missing-config    | `scripts/mcp-stdio-package.test.mjs`、`scripts/smoke-test.mjs`                                                                                                                  | `pnpm run test:package`        | 90秒以内を目標 |
| Standards             | format、lint、architecture、governance、suite/coverage policy self-test | `scripts/**/*.test.mjs`                                                                                                                                                         | `pnpm run test:standards`      | 30秒以内を目標 |
| Full verification     | 上記全層、typecheck、build、package smoke                               | `FULL_VERIFICATION_SUITES`全項目                                                                                                                                                | `pnpm run verify`              | CI/release前   |

`pnpm test`はTDD用のdefault loop。E2E、package smoke、coverageは含めない。`pnpm run test:all`はfast、integration/process、E2Eを順に実行する開発用aliasで、standards・build・package smokeを含むrelease判定ではない。

既存コマンドの責務:

- `pnpm run smoke-test`: `dist/`をbuild済みとしてpacked packageだけ検証。単独実行時はbuildしない。
- `pnpm run test:package`: `build`後に同一tarballをpackし、package protocol subsetと`smoke-test`を実行。package層の入口。
- `pnpm run verify:standards`: format、lint、architecture、governance、分類validator、coverage policy self-test。
- `pnpm run test:coverage`: fast+integrationを一度ずつ実行し、coverage artifactとgate結果を生成。fast loopへinstrumentationを入れない。
- `pnpm run verify`: `verify:standards`、typecheck、fast、integration/process、built-dist E2E、coverage、packageを決定的な順序で実行。

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
- 外部stdio MCP protocol: `src/e2e/<name>.e2e.spec.ts`。built `dist`を起動し、production internalsをimportしない。
- packed package: `scripts/mcp-stdio-package.test.mjs`と`scripts/smoke-test.mjs`をpackage層へ割り当てる。package smokeを`pnpm test`へ追加しない。

`scripts/**/*.test.mjs`は原則standards層。ただし`test-suites.mjs`の明示分類により、共通harness self-testはintegration、package protocol testはpackageへ所属する。

## Governance evidence classes

PRの`Validation evidence`は、下表のevidence classを既存test tierへ写像する。
classのpath triggerとrequired fieldsの正本は
[`scripts/governance-rules.json`](../scripts/governance-rules.json)であり、この表は層の意味だけを示す。

| Evidence class        | 主なtest tier               | 保証対象                                                      |
| --------------------- | --------------------------- | ------------------------------------------------------------- |
| `unit/contract`       | Fast                        | pure logic、schema、envelope、決定論的contract                |
| `process/integration` | Integration / process       | CLI、子process、filesystem、複数componentの境界               |
| `package smoke`       | Package / E2E / smoke       | packed artifact、install、bin、consumer protocol              |
| `fault injection`     | Integration / process       | timeout、spawn/upstream failure、rollback、migration failure  |
| `lint/architecture`   | Standards                   | format、lint、architecture、governance、suite policy          |
| `release`             | Package / Full verification | warning-free package metadata、pack/publish dry-run、artifact |
| `security/negative`   | Integration / process       | security-sensitive pathの拒否・negative scenario              |

各classは`pass`または`not-applicable`を1件ずつ記録する。`not-applicable`はchanged pathがclassをtriggerしない場合だけ許可し、具体的な理由を要する。package pathではpacked artifact、package smoke、`warnings: none`のrelease evidenceを省略しない。`pnpm test`の完了だけで全classをpass扱いしない。

## Integration、process、fault test

integration/process層は実component間の契約と失敗境界を検証する。実filesystem、一時git repository、in-memory/temporary SQLite、CLI subprocessは許可するが、developerのHOME、global git config、global package installation、networkへ依存しない。

fault-injection testはintegration/process層に置く。timeout、spawn failure、missing config、upstream failure、rollback、migration failureなど、制御可能なfaultを注入し、diagnostic、cleanup、exit status、protocol stdoutを検証する。fault testをfastへ混ぜる場合はpure deterministic failureだけに限定する。

共有fixtureは[`src/test-support/`](../src/test-support/)に置く。fixtureは`t.after()`でcleanupし、`isolatedGitEnvironment`、`withEnv`、`isolatedHomeDir`、`withDeterministicEnv`でhost stateを隔離する。`src/test-support/`と`src/e2e/`は`testInfrastructure` layerであり、productionから逆依存しない。`tsconfig.build.json`でpublished `dist/`から除外する。

## E2Eとpackageの境界

`test:e2e`は`pnpm run build`後の`dist/index.js`をchild processとして起動し、MCP `initialize`、`initialized`、`tools/list`、`tools/call`、protocol fault、lifecycle、upstream faultをstdio境界で検証する。sourceをtsx起動するだけのsuiteではない。

`test:package`はbuild済みartifactを`npm pack --ignore-scripts`で1回生成し、同一tarballのprotocol subsetと既存`smoke-test`へ渡す。smokeはisolated consumerの実installとlauncher/initを担当し、package subsetはartifactのbin、handshake/list/call、stdout purity、EOFを担当する。展開subsetの依存symlinkはprotocol確認用で、install correctnessの代替ではない。

共通process harnessは`scripts/lib/mcp-blackbox-client.mjs`だけを使う。harness self-testはintegration tierでstdout fragment、blank line、partial response、timeout diagnostics、process-exit、stderr tail、forced cleanupを検証する。

## Coverage policy

`pnpm run test:coverage`はcanonical Ubuntu + Node 22で組み込みtest coverageを専用processで実行する。`coverage/lcov.info`（machine-readable LCOV）と`coverage/summary.json`（machine-readable gate summary）を生成し、同じCI stepでline、function、branchのhuman-readable summaryをstdoutへ出す。coverage jobは通常のfast commandと分離し、CIでのみ必須gateとして実行する。Node 24ではcoverageを再測定しない。

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

| 指標     | covered / total | baseline |
| -------- | --------------: | -------: |
| Line     |   13056 / 13436 |   97.17% |
| Function |       909 / 955 |   95.18% |
| Branch   |     3037 / 3512 |   86.47% |

Baselineは品質targetそのものではない。repository-wide regression floorは`scripts/coverage-policy.json`の`baseline.thresholds`に保守的に設定し、現在値を大きく下回る意味のある回帰をCIで失敗させる。

現行repository-wide floor:

| Line | Function | Branch |
| ---: | -------: | -----: |
|  80% |      80% |    65% |

Critical moduleはaggregate率で隠れやすい境界なので、個別targetを設定する。

| Module                               | Line | Function | Branch | 高いtargetの理由                               |
| ------------------------------------ | ---: | -------: | -----: | ---------------------------------------------- |
| `src/config.ts`                      |  95% |      95% |    80% | 起動とupstream接続全体の設定解決               |
| `src/init.ts`                        |  82% |      82% |    68% | CLI/init、設定生成、client登録、credential除去 |
| `src/proxy.ts`                       |  95% |      90% |    75% | MCP tool list/call公開境界                     |
| `src/auth.ts`                        |  92% |      95% |    70% | credential headerとOAuth brokerのsecret境界    |
| `src/retrieve.ts`                    |  92% |      90% |    85% | 圧縮前artifact retentionのTTL/取得保証         |
| `src/state/migrations.ts`            |  95% |      95% |    95% | 永続schema migrationと互換性                   |
| `src/state/sqlite-store.ts`          |  95% |      95% |    85% | session/read evidenceの永続化                  |
| `src/workflow/state/sqlite-store.ts` |  95% |      95% |    82% | workflow lifecycle stateと競合制御             |
| `src/workflow/domain/lifecycle.ts`   |  95% |      95% |    88% | lifecycle遷移の不変条件                        |

gateはrepository floorとcritical targetの両方を評価し、moduleがartifactから消えた場合も失敗させる。100%や単一aggregate率を品質指標にしない。

### Baseline/threshold更新

1. main相当のproduction sourceを専用worktreeで固定し、`pnpm install --frozen-lockfile`。
2. `pnpm run test:coverage -- --measure-only`を実行し、`coverage/summary.json`と`coverage/lcov.info`を保存。
3. 測定値、source revision、測定日を`scripts/coverage-policy.json`へ反映。thresholdは測定値から機械的に推測せず、regression floorまたはcritical targetの意図をreviewで明記する。
4. `docs/testing.md`のbaseline/table、self-test、CI artifact名を同じPRで更新。
5. `pnpm run test:coverage`、`pnpm run test:coverage:policy`、`pnpm run verify`を実行。policy JSONのthreshold変更は品質policy変更としてReview focusへ記載。

## 変更種別ごとの検証

| 変更                                                | 最低コマンド                                      |
| --------------------------------------------------- | ------------------------------------------------- |
| pure logic、schema、envelope、contract              | `pnpm test`                                       |
| filesystem、git、SQLite、CLI、timeout、spawn、fault | `pnpm run test:integration`                       |
| stdio MCP server/proxy                              | `pnpm run test:e2e`（必要ならfast/integrationも） |
| package files、bin、init、publish準備               | `pnpm run test:package`                           |
| scripts、architecture、governance、test policy      | `pnpm run test:standards`                         |
| production変更をPR/release判定                      | `pnpm run verify` と`pnpm run test:coverage`      |

非Draft PRのValidationには、実行した`format:check`、`lint`、`typecheck`、`pnpm test`、integration/process、E2E、build、package smoke、architecture/governance、coverageを明記する。未実行をpassとして記載しない。

Governanceの`Validation` checklistは実行済みlayerの記録であり、evidence classの結果本文ではない。PRではchecklistを維持したうえで、classごとにcommand、target、result、必要ならartifact・scenario・warningsを記録する。未実行、pending、hung、環境境界はpassに変換しない。

## Mutation / property effectiveness

Issue #24のeffectiveness layerは、広い入力空間と意味のある分岐を持つ手書きproduction logicだけを対象にする。初期scopeは次の通り。

| Scope                                                                     | Risk                                           | Properties / mutation scenarios                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/config.ts`                                                           | 起動設定、transport validation、正規化の互換性 | nullish path default、HTTP(S) validation、version normalization、normalization idempotence |
| `src/local-tools.ts`                                                      | workspace外へのread/exec、検索結果の再現性     | lexical/realpath containment、symlink escape rejection、first-seen result ordering         |
| `src/compress/budget.ts`, `src/compress/json.ts`, `src/compress/lines.ts` | UTF-8情報損失、予算超過、境界off-by-one        | byte bound、head/tail preservation、depth/line/byte exact boundary                         |
| `src/envelope.ts`, `src/execution.ts`                                     | MCP schema、error flag、result budget          | required fields、reserved-field isolation、JSON byte boundary、token-to-byte conversion    |
| `src/retrieve.ts`                                                         | 圧縮前データの漏洩・無制限保持                 | UTF-8 bound、TTL exact boundary、LRU entry cap                                             |
| `src/init.ts`                                                             | credential/URLの誤 import                      | plain HTTP(S) only、userinfo/query/fragment rejection、any-secret argument rejection       |

固定seed `240824`、既定48ケース/property、最大200ケース/property、mutationごとの15秒timeoutで実行する。generatorはseedからのみ値を生成し、失敗時は`seed`、case番号、縮小済み`counterexample`をstderrへ出す。reportにはruntime inputやsecretを含めず、scope、mutation id、status、seed、件数だけを保存する。

Targeted local commands:

- `pnpm run test:property -- --seed 240824 --runs 48 --report test-artifacts/property-report.json`
- `pnpm run test:mutation -- --seed 240824 --runs 48 --timeout-ms 15000 --report test-artifacts/mutation-report.json`
- `pnpm run test:effectiveness`（上記2層の連続実行）

これらは`pnpm test`、`test:all`、`verify`へ含めない。mutation runnerはrepository全体をmutationせず、`scripts/mutation-catalog.mjs`に列挙したscopeを一時sandboxへコピーしてproperty suiteだけを実行する。CIでは`.github/workflows/test-effectiveness.yml`のmanual dispatchまたは週次scheduleだけで実行し、JSON reportをartifactとして保存する。

Mutation policy:

- non-equivalent survivorまたはtimeoutは失敗。scoreは`killed / (selected - equivalent)`で計算し、runnerがcanonicalな[`mutation-baseline.json`](mutation-baseline.json)を読み、catalogとのID・scope・operator・期待値の一致とbaseline以上のscoreを機械検証する。baseline更新は`--update-baseline`を明示した変更とreview可能な差分で行う。
- equivalent mutantは自動的に隠さず、descriptorの`equivalence.status: equivalent`と非空の`rationale`を必須にしてreportへ記録する。generated code、dependency、`dist/`、test helperはcatalog外であり、scope外である理由をこの文書とreportへ残す。
- 初期baselineは23 non-equivalent mutantsを23件kill、survivor 0、score 1.0。baseline JSONは[`mutation-baseline.json`](mutation-baseline.json)。non-equivalent survivorが見つかった場合は、property/regression assertionを強化するか、理由・owner・IssueをPRのReview focusとreportへ記録する。意図的なscore低下・scope除外も同じ証跡なしには認めない。

新しいcritical logicを追加・変更するPRでは、少なくとも1つのbounded property（不変条件、境界、順序、拒否条件のいずれか）と、比較演算子・上限・正規化・保持期限・security/protocol分岐のうち該当するmutation scenarioをcatalogへ追加する。pure logicの境界はunit/contract、filesystem/CLI/security実行はprocess/integrationまたはsecurity/negativeとしてValidation evidenceへ記録する。property/mutationが変更されないPRは、対象外の理由をReview focusへ明記する。
