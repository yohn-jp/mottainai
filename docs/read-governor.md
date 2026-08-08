# Read Governor

`mottainai_read` は、検索・symbol・outline・bounded raw・whole-file raw の順でソース開示を進める。
`mode: "raw"` は policy を省略できる抜け道ではない。

## 設定

`gateway.readGovernor` の既定 mode は `observe`。既存の読み取りを止めず、enforce 時の判定を telemetry に記録する。
strict な workspace では `enforce` を明示する。

```json
{
  "gateway": {
    "readGovernor": {
      "mode": "enforce",
      "maxRawLines": 400,
      "maxRawBytes": 16384,
      "allowWholeFileBelowLines": 120,
      "preferAuto": true,
      "allowWholeFile": false
    }
  }
}
```

| mode | 動作 |
| --- | --- |
| `off` | 従来どおり raw を許可。最終 response budget は適用 |
| `observe` | enforce なら対象になる read を許可し、判定 metadata を記録 |
| `warn` | read を許可し、bounded warning/diagnostic を返す |
| `enforce` | policy 外の broad raw を本文 read 前に deny |

`allowWholeFileBelowLines` 以下かつ `maxRawBytes` 以下の小さいファイルは whole-file raw を許可する。
大きいファイルでは `mode: "auto"` が bounded `outline` を選ぶ。`auto` は unrestricted raw に変換しない。
`allowWholeFile: true` は repository/user policy が明示的に whole-file raw を許可する場合だけ使う。

## 推奨される進行

```text
search / code symbol / outline
        ↓
exact symbol/range
        ↓
bounded raw: startLine + endLine
        ↓
whole-file raw: policy が許可した小さいファイルだけ
```

例:

```json
{"path":"src/local-tools.ts","mode":"symbols"}
{"path":"src/local-tools.ts","mode":"raw","startLine":332,"endLine":348}
```

enforce mode の broad raw deny は、本文を含めず、`file_line_count`、`file_bytes`、`policy_rule`、`policy_reason`、`next_actions` を structured result に返す。次の action は `auto`、`outline`、`symbols`、identifier search、bounded line range のいずれか。

outline/symbol extraction が失敗した場合も raw whole-file へ fallback しない。bounded diagnostics と最小の次 action を返し、許可済み範囲の artifact は `result_id` から取得できる。

## Telemetry

`MOTTAINAI_TELEMETRY=1` のとき、read governor は decision outcome、requested mode、返した raw line/byte 数、policy rule を集計する。source contents、excerpt、credentials、environment、secret は記録しない。

read result は Issue #71 の Context Runtime projection/final response budget を通る。warning、deny metadata、`result_id` も hard byte ceiling を超えない。
