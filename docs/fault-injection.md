# 決定的 fault-injection 規約

Issue #23で導入した境界テストの正本。production defaultはNodeの直接実装を使い、テストだけが`BoundaryOperations`を差し替える。fault制御は設定ファイル、環境変数、MCP/CLI引数から到達不能。テストは`FaultInjector`へ操作名と失敗回数を指定し、sleep・乱数・実processの競合に依存しない。

## 境界

`src/boundary.ts`の3操作を使う。

| 種別      | 代表操作                                                                                                             | 主な対象                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `file`    | `config.temp.write`, `config.temp.permission`, `config.rename`, `logging.write`, `logging.rotate`, `telemetry.write` | 設定、ログ、telemetry、SQLiteのfilesystem/transaction boundary |
| `process` | `process.spawn`, `process.group.sigterm`, `process.group.sigkill`                                                    | 子process起動・終了                                            |
| `storage` | `artifact.id`, `artifact.insert`                                                                                     | artifact ID発行・単一commit                                    |

既存の`UpstreamConnector`、deferred promise、明示state transitionはprocess lifecycleの注入点として再利用する。timeoutを短くして競合を再現するテストは追加しない。

## 不変条件表

| 操作        | fault点                                                | 期待post-state                                                                                                   |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 設定replace | temp write / close / permission / backup copy / rename | original file不変、temporary directoryなし。cleanup failureが重なってもprimary errorとsecondary diagnosticを分離 |
| 設定replace | backup collision                                       | 既存`.bak`を上書きせず、番号付きbackupへ保存                                                                     |
| logging     | directory / write / rotate / retention                 | MCP processは継続、fallback diagnosticにraw error/secretを出さない                                               |
| telemetry   | read / directory / write                               | 集計APIは継続、失敗したsnapshotは参照不能なresultを作らない。`flush()`で決定的に排出                             |
| migration   | partial DDL / version record / commit / rollback       | transaction rollback、version未記録、handle close、後続retryでclean apply。primary causeを保持                   |
| artifact    | ID / insert / oversize                                 | insert失敗時に新規IDを返さず、既存entryとbyte/TTL/count limitを維持。markerは保存成功後だけ公開                  |
| process     | spawn / termination                                    | bounded structured result、失敗時のhandleなし、既存cleanupを阻害しない                                           |
| upstream    | connector / start-close race / client close            | ready handle復活なし、close失敗でprimary failureを隠さない、child/transportを再利用しない                        |

新しいcritical persistent/process-boundary codeは、成功ケースに加えて、失敗操作、pre-state、post-state、cleanup、retry可否を表にしたfault caseを同じintegration/process suiteへ追加する。fault testの終了処理は`finally`/`after`で行い、秘密値をエラーメッセージへ渡さない。
