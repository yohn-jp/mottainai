# Artifact bounding benchmark

Issue #7 の判断用ベンチマーク。`InMemoryArtifactStore.putArtifact()` を通じて、artifact bounding の現行実装を測定する。

## Protocol

- 実行: `node --import tsx scripts/benchmark-artifact-bounding.mjs`
- Node: `v22.22.1`
- 入力: 決定論的生成文字列。ASCII、JSONエスケープ対象の引用符・バックスラッシュ、マルチバイトUTF-8
- 入力サイズ: 100 KiB、1 MiB、10 MiB（UTF-8 byte長）
- `maxBytes`: 64 KiB。全ケースで入力を超え、bounding/truncation を強制
- warm-up: 100 KiB 3回、1 MiB 2回、10 MiB 1回
- 測定: 100 KiB 20回、1 MiB 8回、10 MiB 3回。`performance.now()` の1操作時間中央値
- 出力: payload本文なし。各行にサイズ、shape、入力byte数、`maxBytes`、反復数、中央値を出力

## Baseline

2026-08-08、production最適化前。

| size | shape | input bytes | maxBytes | iterations | median ms/op |
| --- | --- | ---: | ---: | ---: | ---: |
| 100 KiB | ascii | 102400 | 65536 | 20 | 5.366 |
| 100 KiB | escaped | 102400 | 65536 | 20 | 7.283 |
| 100 KiB | utf8 | 102400 | 65536 | 20 | 5.297 |
| 1 MiB | ascii | 1048576 | 65536 | 8 | 32.900 |
| 1 MiB | escaped | 1048576 | 65536 | 8 | 51.862 |
| 1 MiB | utf8 | 1048576 | 65536 | 8 | 27.801 |
| 10 MiB | ascii | 10485760 | 65536 | 3 | 331.070 |
| 10 MiB | escaped | 10485760 | 65536 | 3 | 564.143 |
| 10 MiB | utf8 | 10485760 | 65536 | 3 | 277.080 |

ベンチマークは各ケースで入力byte数が `maxBytes` を超えること、保存後の本文に truncation footer があること、UTF-8 replacement character がないことを検証する。

## Benchmark Decision

### MATERIAL

10 MiB artifact の bounding は 277–564 ms/op。100 KiB から10 MiBへの増加は概ね線形で、escaping-heavy が最も遅い。大きなMottainai出力で現実的に発生するコストであり、局所的な最適化を測定する価値がある。

主なコスト機構は、fitting の各binary-search反復で `utf8Prefix` が候補全体の `Buffer` を作り、`payloadBytes` が候補payload全体を `JSON.stringify` してbyte長を再計算すること。
