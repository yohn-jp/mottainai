# stdio MCP black-box suite

Issue #22のsuiteは、Mottainaiの内部関数をimportせず、実processのstdin、stdout、stderr、終了状態、signal、cwd、environment、filesystemだけを観測する。

## 実行層

| suite                         | 対象                          | 実行順                               | 責務                                                                                |
| ----------------------------- | ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm run e2e:test`           | checkoutの`dist/index.js`     | `pnpm run build`後                   | handshake、protocol/lifecycle、設定エラー、malformed input、upstream fault、cleanup |
| `pnpm run e2e:package`        | `npm pack`で作ったartifact    | build後、`npm pack --ignore-scripts` | packed bin、shebang、runtime依存、最小handshake/list/call/EOF                       |
| `node scripts/smoke-test.mjs` | npm install済みpacked package | build後                              | install launcher、init、CLIのpackage smoke。stdio suiteと重複しない                 |

package suiteは依存解決を発生させないため、展開packageの`node_modules`へcheckoutの解決済み依存をjunction/symlinkする。したがって実npm installそのものの検証は`smoke-test.mjs`の責務。artifact内の`dist`とbin解決、MCP protocolはpackage suiteの責務。

`npm pack`は`prepack`を実行しない。buildを先に明示し、その時点の`dist`を検証する。pack中の暗黙再build、build失敗のpackエラー隠蔽を防ぐ。

## failure taxonomy

- protocol/input error: malformed JSON、unsupported method、unknown tool、invalid arguments。JSON-RPC errorを返し、後続requestを処理可能なまま維持。初期化前requestとduplicate initializationは使用SDKのresponse contract（現行SDKでは成功応答）を固定し、crash/desyncを許さない
- configuration error: missing/malformed config。stderrへ診断、non-zero exit、stdoutへprotocol外出力なし
- provider error: upstream immediate exit、`initialize`/`listTools`失敗、malformed result。gatewayのJSON-RPC errorへ変換し、gateway stdoutを汚染しない
- bounded timeout: startup hang。request単位deadlineでdiagnostics（method、request id、process state、stderr tail、stdout transcript）を返し、test processをCI timeoutまで残さない
- expected process exit: stdin EOF、client disconnect、SIGINT、SIGTERM。POSIX signalはgraceful shutdownを検証し、Windowsではsignal caseをskipしてEOF/disconnectを検証

stdout transcriptとstderrはbounded tail。改行なしstdout末尾は`close`後にflushし、空行と同じprotocol violationとして扱う。cleanupはgraceful close、timeout後のforced process-tree kill、process-exit safety netの順。

## local upstream fixture

`scripts/fixtures/mcp-upstream.mjs`はnetworkを使わない実subprocess fixture。mode:

- `normal`
- `exit-immediately`
- `hang-startup`
- `large-stderr`
- `fail-list`
- `malformed-result`
- `ignore-termination`

PID/ready markerを一時workspaceへ書き、テスト終了時にupstreamが消えたことを確認する。fixture自体はpackageへ含めない。
