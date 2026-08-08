# stdio MCP black-box suite

Issue #22は、Mottainai内部関数をimportせず、公開entrypointを実processとして起動する。観測対象はstdin、stdout、stderr、終了状態、signal、cwd、environment、filesystemだけ。

## 実行層

| suite               | 対象                  | command                        | 責務                                                                                      |
| ------------------- | --------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| E2E / black-box     | built `dist/index.js` | `pnpm run test:e2e`（build後） | MCP protocol、lifecycle、malformed input、config/provider fault、cleanup                  |
| Package             | 同一packed artifact   | `pnpm run test:package`        | explicit build、`npm pack --ignore-scripts`、package protocol subset、既存package smoke   |
| Harness integration | child fixture         | `pnpm run test:integration`    | stdout fragment/blank、partial response、timeout diagnostics、stderr tail、forced cleanup |

`test:e2e`は`src/e2e/mcp-stdio.e2e.spec.ts`を正式E2E tierで実行する。旧独自commandは廃止し、正式taxonomyへ統合した。

`test:package`はbuildを1回実行するrunnerがartifactを1回packし、同じtarballをpackage protocol subsetと`scripts/smoke-test.mjs`へ渡す。smokeはisolated consumerへの実install、launcher、init、missing-configを担当。package subsetは展開artifactのbinとMCP protocolを担当する。展開subsetの依存symlinkはprotocol観測用で、install correctnessの証拠ではない。

`npm pack`は`prepack`を使わない。buildを先に明示し、その時点の`dist`を`--ignore-scripts` artifactとして検証する。

## Black-box harness

共通`McpStdioClient`は次を担当する。

- child process spawn、request ID、newline JSON-RPC、notification
- raw string/Buffer、partial write、stdin EOF/disconnect
- response/process-close deadline、stdout/stderr capture、bounded transcript
- close時の未改行stdout fragment、blank line、JSON-RPC purity判定
- child tree cleanup、forced kill、spawn failure diagnostics

timeout diagnosticsはoperation/method、request id、process exit state、最近のstdout transcript、bounded stderr tailを含む。環境変数全量・secretは出力しない。upstream startup failureはprovider、phase、deadline、stderr tail、phase transcriptをJSON-RPC errorへ含める。

assertion pathはproduction server objectをimportしない。fixture upstreamもlocal processだけで、network、port、developer HOME/configへ依存しない。

## Protocol matrix

| case                                             | expected contract                                                |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| initialize / initialized                         | valid JSON-RPC handshake、stdout purity                          |
| tools/list / tools/call                          | deterministic catalog、representative local call、EOF shutdown   |
| malformed complete JSON                          | uncontrolled crashなし、後続request同期                          |
| partial JSON / partial then EOF                  | frame buffering、bounded shutdown                                |
| pre-init request                                 | SDK contract準拠のresponse、crash/desyncなし                     |
| duplicate initialize                             | SDK contract準拠のresponse、後続request継続                      |
| unsupported method / unknown tool / invalid args | deterministic JSON-RPC error、process継続                        |
| missing / malformed config                       | deterministic stderr、non-zero exit、stdout contaminationなし    |
| client disconnect / stdin EOF                    | bounded gateway shutdown、upstream cleanup                       |
| SIGINT / SIGTERM                                 | POSIX実signalでgraceful shutdown、Windowsはsignal semantics skip |
| unterminated stdout / blank stdout               | close後もprotocol violationとして保持                            |

## Upstream fault matrix

fixture modeは`normal`、`exit-immediately`、`hang-startup`、`large-stderr`、`fail-list`、`malformed-result`、`ignore-termination`。各caseでprovider identity、phase、cleanup、stdout purityを検証する。

- immediate exit: provider error、永久hangなし、child cleanup
- startup hang: initialize deadline `2_000ms`、provider/phase/stderr/transcript diagnostics、forced cleanup
- large stderr: `768KiB`をpipe drain、gateway stdoutへ混入なし、stderr tail bounded
- listTools failure: provider error、後続gateway requestとshutdown継続

## Failure taxonomy

| taxonomy                  | observable surface                                         | exit behavior                          | stdout/stderr                                  |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Protocol error            | JSON-RPC error response、後続request                       | process継続、EOFで正常終了             | stdoutはvalid protocolのみ、stderrは補助診断可 |
| Configuration error       | stderr、終了status                                         | non-zero、bounded exit                 | stdoutへ非protocol文字列を出さない             |
| Provider / upstream error | JSON-RPC provider error、runtime status、phase diagnostics | gatewayは継続可能、shutdownでchild終了 | stdoutはprotocolのみ、stderr tail bounded      |
| Expected process exit     | EOF、disconnect、signal、close                             | bounded graceful exit                  | stdout既存frameをclose時確定                   |
| Timeout                   | operation deadline、process state、transcript              | forced cleanup fallback                | stdout/stderr captureをbounded保持             |
| Forced cleanup            | graceful close deadline超過                                | process tree kill後に終了              | cleanup failureを元エラーへ付加                |

stderr自体はprotocol violationではない。protocol reservedはstdoutだけ。

## Time budgets

共通値は`scripts/lib/mcp-blackbox-timeouts.mjs`で管理する。

| operation                            | budget |
| ------------------------------------ | -----: |
| process startup                      |     3s |
| request                              |     5s |
| upstream initialize/listTools        |     2s |
| graceful shutdown                    |     5s |
| forced cleanup/process disappearance |     5s |
| fixture readiness                    |     3s |
| test case                            |    30s |

pollingはfixture filesystem stateの観測専用。arbitrary sleepでprotocol readinessを判定しない。

## Platform

CIはUbuntu/Windows × Node 22/24。EOF、disconnect、built-dist protocol、package subsetは全matrix。SIGINT/SIGTERMはPOSIXだけ実deliveryし、WindowsはNode `ChildProcess.kill`が同じsignal handler semanticsを提供しないためskip。Windowsではnode executable、path separator、launcher、junctionを実artifact経路で検証する。
