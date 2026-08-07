# テスト

このリポジトリのテストを責務別にどう整理しているか、どんな共有fixtureがあるか、新しいテストをどこへ追加すべきかを説明する。[`coding-standards.md`](coding-standards.md)（production側の依存方向ルール、`testInfrastructure`レイヤの正本）と役割分担しており、内容を重複させない。

テストは対象コードと同階層に置く（`foo.ts` / `foo.test.ts`）。実行は`tsx`経由のNode標準test runner。このドキュメントは既存テストファイルを1つも移動しない — 分類は命名規約と、そのテストがimportするfixtureによる判断であり、ディレクトリ再編ではない。新規テストは下記の規約に従う。既存テストは触ったタイミングで段階的に共有fixtureへ移行してよい。

## 層

| 層 | 保証する境界 | 置き場所 | 依存先 |
|---|---|---|---|
| **Unit** | pure logic: parser、policy解決、state transition、IR schema。process/filesystem/git/MCP transportへの依存を持たない。 | モジュール直下の`*.test.ts`。例: `src/workflow/policy/resolve.test.ts`、`src/semantics/ir/schema.test.ts`、`src/compress/*.test.ts` | 外部依存なし |
| **Integration** | 複数の実コンポーネント間の契約: config+runtime、policy+executor、state store+repository identity、git adapter+workflow logic。 | モジュール直下の`*.test.ts`。例: `src/workflow/domain/task.test.ts`、`src/workflow/git/hooks.test.ts`、`src/state/sqlite-store.test.ts` | 実git subprocess、実filesystem、実（in-memoryまたは一時ファイル）sqlite — developerの実環境には依存しない（Determinism節参照） |
| **Contract / Boundary** | Mottainaiの外部境界: MCP tool schema、structured input/output、error contract、(de)serialization、config boundary、CLI/runtime entrypoint。 | モジュール直下の`*.test.ts`。例: `src/catalog.test.ts`、`src/envelope.test.ts`、`src/local-tools.test.ts`、`src/config.test.ts`、`src/semantics/ir/serialize.test.ts` | integrationと同様。内部結果だけでなく境界を横断する値の形も検証する |
| **E2E / black-box** | gatewayプロセス自体を外部から実stdio MCPプロトコルで叩く。 | `src/e2e/*.e2e.spec.ts` | 実子プロセス（後述） |

Unit・integration・contractはすべて`.test.ts`で終わり、既定の`pnpm test`で実行される。3層の違いはツールではなく責務 — どの境界を固定しているかがテスト名・docstringから分かるようにする。既存ファイルに新しい層の観点（例: pure unitだったファイルへのboundary-shapeアサーション追加）を足すだけなら、ファイル分割は不要で短い一言コメントで足りる。

## 新しいテストをどこへ追加するか

- 既存モジュールの挙動拡張: そのモジュールの既存`*.test.ts`に追加する。
- 新規モジュール: 直下に`<module>.test.ts`を作る。これが既定でありunit・integration・contract/boundaryすべてを兼ねる。
- 新しいblack-box・実プロセス・実stdioプロトコルのカバレッジ（#22が積み上げる層）: `src/e2e/`へ、ファイル名は`.e2e.spec.ts`で終える。

### E2Eが`.test.ts`ではなく`.spec.ts`である理由

`pnpm test`は`node --import tsx --test "src/**/*.test.ts"`を実行する。`.e2e.spec.ts`で終わるファイルはこのglobに一致しないため、既定の高速suiteには含まれない — `pnpm run test:e2e`（glob `src/e2e/**/*.spec.ts`）だけが拾う。これは意図的な設計: E2Eテストは実subprocessを起動し実MCPプロトコルをstdio越しに話すため、他のテストより遅く失敗もしやすい。`pnpm test`を速く保つのが目的。`scripts/architecture-check.mjs`は`*.spec.ts`もproduction-fileルールから除外する（`testFilePattern`は`.test.`と`.spec.`の両方に一致）ので、これらのファイルは他のテストファイルと同様にテスト専用helperをimportしたりtop-levelで`test()`を呼んだりしてよい。

`.spec.ts`拡張子はこのE2E層専用に予約する — 既定の`pnpm test`からファイルを外すための仕組みなので、他の用途に流用しない。

## 共有fixture・helper（`src/test-support/`）

`src/test-support/`は独立した`testInfrastructure`レイヤ（[`coding-standards.md`](coding-standards.md#boundary-model)参照）: fixtureを組み立てるためにどのproductionレイヤからでもimportしてよいが、production側からこのレイヤへのimportは許されない。公開`dist`ビルドからも除外される（`tsconfig.build.json`）。

| export | 定義元 | 用途 |
|---|---|---|
| `createTempDir(t, prefix?)` | `tmp-dir.ts` | `os.tmpdir()`配下の隔離ディレクトリ。`realpathSync`解決済み。失敗時も含め`t.after()`で必ず削除する。 |
| `createTempGitRepo(t, options?)` | `tmp-git-repo.ts` | `createTempDir`上で`git init`。developerのglobal/system git設定から隔離。既定でコミットまで済ませる（`options.initialCommit = false`でスキップ）。 |
| `runGit(args, cwd, environment?)` | `tmp-git-repo.ts` | `createTempGitRepo`と同じ隔離environmentで`git`を実行する。初期リポジトリ構築以降のあらゆるgit呼び出し（clone、push、worktree、checkout等）に使う。 |
| `isolatedGitEnvironment(extra?)` | `tmp-git-repo.ts` | 隔離済みenvironmentオブジェクトそのもの。壊れた`PATH`など、隔離の上にさらに1つ上書きしたいテスト向け。 |
| `createWorkflowStore(t)` | `workflow-store.ts` | in-memory（`:memory:`）の`WorkflowSqliteStateStore`。`t.after()`でopen/closeを管理する。 |
| `withEnv(t, overrides)` | `env.ts` | `process.env`のキーを一時的に設定・削除し、失敗時も含め`t.after()`で元の値へ復元する。 |
| `withDeterministicEnv(t, overrides?)` | `env.ts` | `TZ=UTC`・`LANG=C`・`LC_ALL=C`をあらかじめ設定した`withEnv`。 |
| `isolatedHomeDir(t, prefix?)` | `env.ts` | テスト期間中`HOME`/`USERPROFILE`として使う一時ディレクトリ。 |
| `buildTestConfig(options?)` / `writeTestConfig(dir, options?)` | `config-fixture.ts` | network/upstreamに依存しない最小`MottainaiConfig`（空`mcpServers`、`gateway.workspaceRoot: "."`）。`writeTestConfig`はディスクへも書き出す。 |
| `assertOk(result)` / `assertError(result)` | `assertions.ts` | このリポジトリ全体で使われる`{ ok: true, ... } \| { ok: false, ... }`判別共用体向けのnarrowingアサーション。 |
| `assertEnvelopeShape(value)` | `assertions.ts` | 共有`OUTPUT_SCHEMA`契約（`src/envelope.ts`）を満たすか検証する。contract/boundaryテスト向け。 |
| `resolveTsxLoaderUrl()` | `tsx-loader.ts` | `tsx`のESM loaderを、呼び出し元の`cwd`に関係なくこのモジュール自身の位置から絶対`file://` URLとして解決する。任意のblack-boxワークスペースから`src/index.ts`を起動するのに使う（後述のE2E参照）。 |

上記はすべて`src/test-support/index.ts`からもre-exportされている。個別ファイルから直接importしても問題なく、そちらの方がテストごとの依存関係が明示的になる。

`isolatedGitEnvironment`（`tmp-git-repo.ts`）と`env.ts`だけが、`scripts/architecture-check.mjs`の`environmentBoundaryFiles`allowlistに載っている`src/test-support/`配下のファイル — 隔離を組み立てるために正当に`process.env`を読み書きする箇所だけをそこに限定している。`src/test-support/`の他のファイルはこのallowlistの外に置く。新しいfixtureが`process.env`を必要とするなら、既存のエントリと同じ形式で一行の理由とともに追加する。

## Determinismと環境隔離

テストは以下に依存してはならない。

- 実`HOME`、developerの実`~/.gitconfig`/system git設定、周囲の`git` identity — `createTempGitRepo`/`runGit`は`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`を無効な宛先へ隔離し、固定のcommit identityを設定する。`isolatedHomeDir`はconfig/init/doctor系のコードパスに触れるテスト向けに`HOME`を隔離する。
- developerの実user config、npm/global installation、network — `buildTestConfig`/`writeTestConfig`は実upstream MCPサーバーや実networkエンドポイントを一切参照しない。`src/test-support/`のどこも`npm`/`pnpm`のglobal stateをshell outしない。
- 実行順・machine・timezone・locale — `TZ`/`LANG`/`LC_ALL`でアサーションが変わりうるテストでは`withDeterministicEnv`を使う。関数側がすでに注入を受け付ける場合（`src/state/paths.ts`の`env`/`platform`引数等）は、`process.env`に触れるより明示値をpure関数へ渡す方を優先する。
- current working directoryやbranch名 — `createTempDir`/`createTempGitRepo`は常に新規の一時パスと固定の既定branch（`main`、上書き可）を発行する。`process.cwd()`や周囲のbranch名に対してアサーションしない。

何かを作るfixture（一時dir、一時repo、in-memory store、env上書き）は、いずれも自分自身のcleanupを`t.after()`で登録する。テストが失敗してもこの中に状態を残すfixtureはない。

## E2E / black-box（`src/e2e/`）

`src/e2e/stdio-client.ts`は`startGatewayViaStdio({ cwd, configPath, env? })`をexportする: `node --import <解決済みtsx loader> src/index.ts serve --config <configPath>`を起動し、`StdioClientTransport`経由でMCP `Client`を接続する。`dist/`ビルドに依存しない — `tsx`経由で`src/index.ts`を直接実行し、`resolveTsxLoaderUrl()`で解決するので起動先プロセスの`cwd`に関係なく動く（`src/init.test.ts`のclient登録往復テストで既に実証済みのパターンを踏襲している）。`env`省略時はMCP SDK自身の安全な既定env（host環境全体ではなくフィルタ済みallowlist）を継承する。

`src/e2e/gateway.e2e.spec.ts`は単一のsmokeテスト: `writeTestConfig`のfixtureに対してgatewayを起動し、`listTools()`してから読み取り専用のlocal toolを1つ`callTool()`し、`assertEnvelopeShape`でstructured envelope契約をアサーションする。接続点が動くことを示すのが目的で、網羅的なblack-box suiteではない。

**#22のstdio black-box suiteは`startGatewayViaStdio`と`src/test-support/`のfixtureの上に組み立てる** — workspaceの`mottainai.config.json`には`writeTestConfig`、workspace自体には`createTempDir`/`createTempGitRepo`、tool結果のcontractアサーションには`assertEnvelopeShape`を使う。新規ケースは`src/e2e/`へ`*.e2e.spec.ts`として追加し、`pnpm test`ではなく`test:e2e`層に留める。

## テストの実行

```bash
pnpm test           # 高速層: unit + integration + contract/boundary (src/**/*.test.ts)
pnpm run test:e2e    # black-box層: src/e2e/**/*.spec.ts（実subprocess・実stdio）
pnpm run test:all    # 両方を順に実行
```

CIは同一jobの中で`pnpm test`と`pnpm run test:e2e`を別stepとして実行する（`.github/workflows/ci.yml`）。対応する両方のNodeバージョンで、build stepの直前に置く。分離しておくことで、black-box側の失敗と高速suite側の失敗が混同されず、`pnpm test`の実行時間もcontributorがローカルで体感するコストと一致し続ける。
